//! Snapshot export planning, baking, and template injection (ADR 0024).

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
};

use crate::pyramid::Pyramid;
use crate::session::{LinkedTime, PanelMode, PanelState, Session};
use crate::store::{Signal, SignalId, SignalStore};
use scope_protocol::{BakedSignal, ExportFidelity, ExportRange, SignalSummary, SnapshotManifest};
use serde::Serialize;
use thiserror::Error;

#[must_use]
pub const fn ceiling(fidelity: ExportFidelity) -> Option<usize> {
    match fidelity {
        ExportFidelity::Preview => Some(512),
        ExportFidelity::Standard => Some(2_048),
        ExportFidelity::High => Some(16_384),
        ExportFidelity::Full => None,
    }
}

pub struct LevelPlan {
    pub index: usize,
    pub bin_count: usize,
}

pub struct SignalPlan<'a> {
    pub signal: &'a Signal,
    pub pyramid: &'a Pyramid,
    pub window: Option<(f64, f64)>,
    pub levels: Vec<LevelPlan>,
}

impl SignalPlan<'_> {
    #[must_use]
    pub fn finest_level(&self) -> usize {
        self.levels.first().map_or(0, |level| level.index)
    }
}

pub struct ExportPlan<'a> {
    pub signals: Vec<SignalPlan<'a>>,
    pub series_total: u64,
    pub series_decimated: u64,
    pub series_full_rate: u64,
    pub coarsest_ratio: u64,
}

#[derive(Debug, Error)]
pub enum SnapshotError {
    #[error("template is missing the #signalscope-baked-data slot")]
    MissingSlot,
    #[error("selected signal {0:?} is missing")]
    MissingSignal(SignalId),
    #[error("signal {0:?} is missing its pyramid")]
    MissingPyramid(SignalId),
    #[error("manifest serialization failed: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("manifest output is not UTF-8: {0}")]
    Utf8(#[from] std::string::FromUtf8Error),
}

fn effective_window(panel: &PanelState, linked: &LinkedTime) -> (f64, f64) {
    if linked.linked && panel.mode == PanelMode::Time {
        return (linked.t0, linked.t1);
    }
    match panel.time_window {
        Some([t0, t1]) => (t0, t1),
        None => (linked.t0, linked.t1),
    }
}

fn panel_signal_paths(panel: &PanelState) -> Vec<&str> {
    let mut paths: Vec<&str> = panel
        .series
        .iter()
        .map(|series| series.path.as_str())
        .collect();
    if panel.mode == PanelMode::Xy {
        if let Some(x) = panel.x_signal.as_deref() {
            paths.insert(0, x);
        }
        if let Some(color) = panel.color_signal.as_deref() {
            paths.push(color);
        }
    }
    paths
}

fn signal_plan<'a>(
    signal: &'a Signal,
    pyramid: &'a Pyramid,
    window: Option<(f64, f64)>,
    needs_raw: bool,
    fidelity: ExportFidelity,
) -> SignalPlan<'a> {
    // Sample-domain panels outrank fidelity because reconstructed envelope bins
    // are not valid XY, FFT, or histogram inputs. Otherwise the target is only
    // a ceiling: sparse signals stay raw, while Full explicitly selects level 0.
    let finest = match (needs_raw, ceiling(fidelity)) {
        (true, _) | (false, None) => 0,
        (false, Some(limit)) => (0..pyramid.level_count())
            .find(|index| {
                pyramid
                    .level_window_count(*index, window)
                    .is_some_and(|count| count <= limit)
            })
            .unwrap_or_else(|| pyramid.level_count().saturating_sub(1)),
    };
    let levels = (finest..pyramid.level_count())
        .map(|index| LevelPlan {
            index,
            bin_count: pyramid
                .level_window_count(index, window)
                .expect("planned pyramid level exists"),
        })
        .collect();
    SignalPlan {
        signal,
        pyramid,
        window,
        levels,
    }
}

fn export_plan(signals: Vec<SignalPlan<'_>>) -> ExportPlan<'_> {
    let series_total = signals.len() as u64;
    let series_decimated = signals
        .iter()
        .filter(|signal| signal.finest_level() > 0)
        .count() as u64;
    let coarsest_ratio = signals
        .iter()
        .map(|signal| {
            u32::try_from(signal.finest_level())
                .ok()
                .and_then(|level| 1_u64.checked_shl(level))
                .unwrap_or(u64::MAX)
        })
        .max()
        .unwrap_or(1);
    ExportPlan {
        signals,
        series_total,
        series_decimated,
        series_full_rate: series_total - series_decimated,
        coarsest_ratio,
    }
}

/// Resolves the selected signals, pyramids, levels, and exact clipped bin counts.
///
/// # Errors
///
/// Returns an error if a selected signal or its pyramid is missing.
pub fn plan<'a>(
    session: &Session,
    store: &'a SignalStore,
    pyramids: &'a BTreeMap<SignalId, Pyramid>,
    range: ExportRange,
    fidelity: ExportFidelity,
) -> Result<ExportPlan<'a>, SnapshotError> {
    let mut needs_raw = BTreeSet::new();
    for tab in &session.tabs {
        for panel in &tab.panels {
            if panel.mode != PanelMode::Time {
                for path in panel_signal_paths(panel) {
                    if let Some(signal) = store.signal_by_path(path) {
                        needs_raw.insert(signal.id);
                    }
                }
            }
        }
    }

    if range == ExportRange::All {
        return Ok(export_plan(
            store
                .signals()
                .map(|signal| {
                    let pyramid = pyramids
                        .get(&signal.id)
                        .ok_or(SnapshotError::MissingPyramid(signal.id))?;
                    Ok(signal_plan(
                        signal,
                        pyramid,
                        None,
                        needs_raw.contains(&signal.id),
                        fidelity,
                    ))
                })
                .collect::<Result<_, SnapshotError>>()?,
        ));
    }

    let mut window: Option<(f64, f64)> = None;
    let mut wanted = BTreeSet::new();
    for tab in &session.tabs {
        for panel in &tab.panels {
            let (t0, t1) = effective_window(panel, &session.linked_time);
            window = Some(match window {
                Some((start, end)) => (start.min(t0), end.max(t1)),
                None => (t0, t1),
            });
            for path in panel_signal_paths(panel) {
                if let Some(signal) = store.signal_by_path(path) {
                    wanted.insert(signal.id);
                }
            }
        }
    }
    let Some((t0, t1)) = window else {
        return Ok(export_plan(Vec::new()));
    };

    Ok(export_plan(
        wanted
            .into_iter()
            .map(|id| {
                let signal = store.signal(id).ok_or(SnapshotError::MissingSignal(id))?;
                let pyramid = pyramids.get(&id).ok_or(SnapshotError::MissingPyramid(id))?;
                Ok(signal_plan(
                    signal,
                    pyramid,
                    Some((t0, t1)),
                    needs_raw.contains(&id),
                    fidelity,
                ))
            })
            .collect::<Result<_, SnapshotError>>()?,
    ))
}

fn signal_summary(signal: &Signal) -> SignalSummary {
    let (t_min, t_max) = signal.time_bounds();
    SignalSummary {
        signal_id: signal.id.0,
        path: signal.path.clone(),
        unit: signal.unit.clone(),
        point_count: signal.len() as u64,
        t_min,
        t_max,
    }
}

/// Bakes a deterministic manifest from a previously selected export plan.
///
/// # Errors
///
/// Returns [`SnapshotError::Serialize`] when the session cannot be encoded.
pub fn bake(plan: &ExportPlan, session: &Session) -> Result<SnapshotManifest, SnapshotError> {
    let mut baked_session = session.clone();
    baked_session.source_paths.clear();

    let mut signals = Vec::new();
    for entry in &plan.signals {
        let levels = entry
            .levels
            .iter()
            .filter_map(|level| entry.pyramid.level_window(level.index, entry.window))
            .collect();
        signals.push(BakedSignal {
            summary: signal_summary(entry.signal),
            levels,
        });
    }
    signals.sort_by_key(|signal| signal.summary.signal_id);

    Ok(SnapshotManifest {
        session_json: serde_json::to_string(&baked_session)?,
        signals,
    })
}

const SLOT_MARKER: &str = "id=\"signalscope-baked-data\"";

struct HtmlSafeFormatter;

impl serde_json::ser::Formatter for HtmlSafeFormatter {
    fn write_string_fragment<W>(&mut self, writer: &mut W, fragment: &str) -> std::io::Result<()>
    where
        W: ?Sized + Write,
    {
        let mut remaining = fragment;
        while let Some(offset) = remaining.find('<') {
            writer.write_all(&remaining.as_bytes()[..offset])?;
            writer.write_all(b"\\u003c")?;
            remaining = &remaining[offset + 1..];
        }
        writer.write_all(remaining.as_bytes())
    }
}

/// Injects a sealed manifest into the snapshot template's inert JSON slot.
///
/// # Errors
///
/// Returns an error when the slot is absent or malformed, or encoding fails.
pub fn inject(template: &str, manifest: SnapshotManifest) -> Result<String, SnapshotError> {
    let marker = template
        .find(SLOT_MARKER)
        .ok_or(SnapshotError::MissingSlot)?;
    let open_end = template[marker..]
        .find('>')
        .map(|offset| marker + offset + 1)
        .ok_or(SnapshotError::MissingSlot)?;
    let close = template[open_end..]
        .find("</script")
        .map(|offset| open_end + offset)
        .ok_or(SnapshotError::MissingSlot)?;

    let mut html = Vec::with_capacity(template.len());
    html.extend_from_slice(&template.as_bytes()[..open_end]);
    scope_protocol::Envelope::new(manifest).serialize(
        &mut serde_json::Serializer::with_formatter(&mut html, HtmlSafeFormatter),
    )?;
    html.extend_from_slice(&template.as_bytes()[close..]);
    Ok(String::from_utf8(html)?)
}

const BYTES_PER_BIN: u64 = 200;

/// Estimates serialized data bytes from planned level metadata.
#[must_use]
pub fn estimated_bytes(plan: &ExportPlan) -> u64 {
    plan.signals
        .iter()
        .flat_map(|signal| &signal.levels)
        .map(|level| level.bin_count as u64)
        .sum::<u64>()
        * BYTES_PER_BIN
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::pyramid::Pyramid;
    use crate::session::{AxisStyle, DashStyle, PanelMode, PanelState, SeriesState, Session};
    use crate::store::{SignalId, SignalStore};
    use scope_protocol::{ExportFidelity, ExportRange};

    fn store_with(signals: &[(&str, usize)]) -> (SignalStore, BTreeMap<SignalId, Pyramid>) {
        let mut store = SignalStore::new();
        let source = store.register_source("test.csv");
        let mut pyramids = BTreeMap::new();
        for (path, count) in signals {
            let count = u32::try_from(*count).expect("test signal is small");
            let time: Vec<f64> = (0..count).map(f64::from).collect();
            let values: Vec<f64> = time.iter().map(|time| time * 0.5).collect();
            let id = store
                .insert_signal(source, (*path).to_owned(), None, time.into(), values)
                .expect("insert");
            let signal = store.signal(id).expect("signal");
            pyramids.insert(id, Pyramid::from_signal(signal));
        }
        (store, pyramids)
    }

    fn series(path: &str) -> SeriesState {
        SeriesState {
            path: path.to_owned(),
            color_slot: 0,
            dash: DashStyle::Solid,
            width: 1.5,
            visible: true,
        }
    }

    fn panel(mode: PanelMode, paths: &[&str]) -> PanelState {
        PanelState {
            id: "panel-1".to_owned(),
            title: "Panel".to_owned(),
            mode,
            axis_style: AxisStyle::Gutter,
            x_signal: None,
            color_signal: None,
            color_by_time: false,
            series: paths.iter().map(|path| series(path)).collect(),
            y_range: None,
            x_range: None,
            x_label: None,
            y_label: None,
            c_label: None,
            time_window: None,
            annotations: Vec::new(),
            show_stats: false,
        }
    }

    fn session_with(panels: Vec<PanelState>) -> Session {
        let mut session = Session::default();
        session.tabs[0].panels = panels;
        session
    }

    #[test]
    fn all_scope_bakes_every_signal_full_range_from_level_zero() {
        let (store, pyramids) = store_with(&[("a", 10), ("b", 10_000)]);
        let plan = plan(
            &Session::default(),
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .expect("plan");
        assert_eq!(plan.signals.len(), 2);
        assert!(plan.signals.iter().all(|signal| signal.finest_level() == 0));
        assert!(plan.signals.iter().all(|signal| signal.window.is_none()));
    }

    #[test]
    fn all_full_matches_the_pre_fidelity_manifest_bytes() {
        let (store, pyramids) = store_with(&[("a", 32)]);
        let session = Session::default();
        let plan = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .expect("plan");
        let actual = serde_json::to_vec(&bake(&plan, &session).expect("bake")).expect("serialize");
        let signal = store.signal_by_path("a").expect("signal");
        let pyramid = pyramids.get(&signal.id).expect("pyramid");
        let expected = SnapshotManifest {
            session_json: serde_json::to_string(&session).expect("session"),
            signals: vec![BakedSignal {
                summary: signal_summary(signal),
                levels: (0..pyramid.level_count())
                    .map(|level| pyramid.level(level).expect("level"))
                    .collect(),
            }],
        };
        assert_eq!(
            actual,
            serde_json::to_vec(&expected).expect("serialize expected")
        );
    }

    #[test]
    fn planning_rejects_a_signal_without_a_pyramid() {
        let (store, mut pyramids) = store_with(&[("a", 10)]);
        pyramids.clear();
        assert!(matches!(
            plan(
                &Session::default(),
                &store,
                &pyramids,
                ExportRange::All,
                ExportFidelity::Full
            ),
            Err(SnapshotError::MissingPyramid(SignalId(1)))
        ));
    }

    #[test]
    fn visible_scope_excludes_signals_on_no_panel() {
        let (store, pyramids) = store_with(&[("a", 10), ("b", 10)]);
        let session = session_with(vec![panel(PanelMode::Time, &["a"])]);
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::Visible,
            ExportFidelity::Standard,
        )
        .expect("plan");
        assert_eq!(export.signals.len(), 1);
        assert_eq!(export.signals[0].signal.path, "a");
    }

    #[test]
    fn visible_scope_decimates_dense_time_signals() {
        let (store, pyramids) = store_with(&[("a", 100_000)]);
        let mut session = session_with(vec![panel(PanelMode::Time, &["a"])]);
        session.linked_time.t1 = 99_999.0;
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::Visible,
            ExportFidelity::Standard,
        )
        .expect("plan");
        let entry = &export.signals[0];
        assert!(entry.finest_level() > 0);
        let level = entry
            .pyramid
            .level(entry.finest_level())
            .expect("planned level");
        let limit = ceiling(ExportFidelity::Standard).expect("standard ceiling");
        assert!(level.len() <= limit);
        if entry.finest_level() > 1 {
            assert!(
                entry
                    .pyramid
                    .level(entry.finest_level() - 1)
                    .expect("previous level")
                    .len()
                    > limit
            );
        }
    }

    #[test]
    fn honesty_rule_bakes_raw_when_sparse_at_every_fidelity() {
        let (store, pyramids) = store_with(&[("a", 500)]);
        let session = session_with(vec![panel(PanelMode::Time, &["a"])]);
        for fidelity in [
            ExportFidelity::Preview,
            ExportFidelity::Standard,
            ExportFidelity::High,
            ExportFidelity::Full,
        ] {
            let export =
                plan(&session, &store, &pyramids, ExportRange::Visible, fidelity).expect("plan");
            assert_eq!(export.signals[0].finest_level(), 0);
            assert_eq!(export.series_full_rate, 1);
        }
    }

    #[test]
    fn sample_mode_panels_force_level_zero_at_preview() {
        let (store, pyramids) = store_with(&[("a", 100_000)]);
        for mode in [PanelMode::Xy, PanelMode::Fft] {
            let session = session_with(vec![panel(mode, &["a"])]);
            let export = plan(
                &session,
                &store,
                &pyramids,
                ExportRange::Visible,
                ExportFidelity::Preview,
            )
            .expect("plan");
            assert_eq!(export.signals[0].finest_level(), 0);
            assert_eq!(export.series_decimated, 0);
            assert_eq!(export.coarsest_ratio, 1);
        }
    }

    #[test]
    fn fidelity_ceiling_is_monotone() {
        let (store, pyramids) = store_with(&[("a", 100_000)]);
        let session = session_with(vec![panel(PanelMode::Time, &["a"])]);
        let bins: Vec<usize> = [
            ExportFidelity::Preview,
            ExportFidelity::Standard,
            ExportFidelity::High,
            ExportFidelity::Full,
        ]
        .into_iter()
        .map(|fidelity| {
            plan(&session, &store, &pyramids, ExportRange::All, fidelity)
                .expect("plan")
                .signals
                .iter()
                .flat_map(|signal| &signal.levels)
                .map(|level| level.bin_count)
                .sum()
        })
        .collect();
        assert!(bins.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn xy_panels_pull_x_and_color_signals() {
        let (store, pyramids) = store_with(&[("x", 10), ("y", 10), ("c", 10), ("ignored", 10)]);
        let mut xy = panel(PanelMode::Xy, &["y"]);
        xy.x_signal = Some("x".to_owned());
        xy.color_signal = Some("c".to_owned());
        let mut time = panel(PanelMode::Time, &["ignored"]);
        time.x_signal = Some("x".to_owned());
        let session = session_with(vec![xy, time]);
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::Visible,
            ExportFidelity::Standard,
        )
        .expect("plan");
        let paths: Vec<&str> = export
            .signals
            .iter()
            .map(|entry| entry.signal.path.as_str())
            .collect();
        assert_eq!(paths, ["x", "y", "c", "ignored"]);
    }

    #[test]
    fn window_is_the_union_of_panel_windows() {
        let (store, pyramids) = store_with(&[("a", 100), ("b", 100)]);
        let mut session = Session::default();
        session.linked_time.t0 = 0.0;
        session.linked_time.t1 = 10.0;
        let linked = panel(PanelMode::Time, &["a"]);
        let mut unlinked = panel(PanelMode::Time, &["b"]);
        unlinked.time_window = Some([20.0, 30.0]);
        session.linked_time.linked = false;
        session.tabs[0].panels = vec![linked, unlinked];
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::Visible,
            ExportFidelity::Standard,
        )
        .expect("plan");
        assert!(
            export
                .signals
                .iter()
                .all(|signal| signal.window == Some((0.0, 30.0)))
        );
    }

    #[test]
    fn bake_clears_source_paths_and_orders_signals_by_id() {
        let (store, pyramids) = store_with(&[("b", 100), ("a", 100)]);
        let session = Session {
            source_paths: vec!["/home/user/secret.csv".to_owned()],
            ..Session::default()
        };
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .expect("plan");
        let manifest = bake(&export, &session).expect("bake");
        assert!(!manifest.session_json.contains("secret.csv"));
        let ids: Vec<u64> = manifest
            .signals
            .iter()
            .map(|signal| signal.summary.signal_id)
            .collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        assert_eq!(ids, sorted);
    }

    #[test]
    fn baked_levels_are_positional_from_the_finest_planned_level() {
        let (store, pyramids) = store_with(&[("a", 100_000)]);
        let mut session = session_with(vec![panel(PanelMode::Time, &["a"])]);
        session.linked_time.t1 = 99_999.0;
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::Visible,
            ExportFidelity::Standard,
        )
        .expect("plan");
        let entry = &export.signals[0];
        assert!(entry.finest_level() > 0);
        let pyramid = entry.pyramid;
        let finest_level = entry.finest_level();
        let manifest = bake(&export, &session).expect("bake");
        assert_eq!(
            manifest.signals[0].levels.len(),
            pyramid.level_count() - finest_level
        );
        assert_eq!(
            manifest.signals[0].levels[0],
            pyramid.level(finest_level).expect("planned level")
        );
    }

    #[test]
    fn clipping_retains_one_neighbor_bin_each_side() {
        let (store, pyramids) = store_with(&[("a", 1_000)]);
        let mut session = session_with(vec![panel(PanelMode::Time, &["a"])]);
        session.linked_time.t0 = 100.0;
        session.linked_time.t1 = 200.0;
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::Visible,
            ExportFidelity::Standard,
        )
        .expect("plan");
        let manifest = bake(&export, &session).expect("bake");
        let level = &manifest.signals[0].levels[0];
        assert_eq!(level.first().map(|bin| bin.t0), Some(99.0));
        assert_eq!(level.last().map(|bin| bin.t1), Some(201.0));
    }

    #[test]
    fn bake_serializes_deterministically() {
        let (store, pyramids) = store_with(&[("b", 100), ("a", 100)]);
        let session = Session::default();
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .expect("plan");
        let first = bake(&export, &session).expect("bake");
        let second = bake(&export, &session).expect("bake");
        assert_eq!(
            serde_json::to_string(&first).expect("serialize"),
            serde_json::to_string(&second).expect("serialize")
        );
    }

    #[test]
    fn inject_replaces_the_slot_atomically() {
        let template = "<html><script id=\"signalscope-baked-data\" type=\"application/json\">\n      null\n    </script></html>";
        let manifest = empty_manifest();
        let html = inject(template, manifest).expect("inject");
        assert!(!html.contains(">null<") && !html.contains("null\n"));
        assert!(html.contains("\"session_json\""));
        assert!(html.starts_with("<html><script id=\"signalscope-baked-data\""));
        assert!(html.ends_with("</script></html>"));
    }

    #[test]
    fn inject_escapes_case_insensitive_script_terminators() {
        let mut session = Session::default();
        session.tabs[0].title = "</ScRiPt><script>alert(1)</SCRIPT>".to_owned();
        let (store, pyramids) = store_with(&[]);
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .expect("plan");
        let manifest = bake(&export, &session).expect("bake");
        let html = inject(
            "<script id=\"signalscope-baked-data\">null</script>",
            manifest,
        )
        .expect("inject");
        assert_eq!(html.to_ascii_lowercase().matches("</script").count(), 1);
        assert!(html.contains("\\u003c/ScRiPt"));
    }

    #[test]
    fn inject_without_slot_errors() {
        assert!(matches!(
            inject("<html></html>", empty_manifest()),
            Err(SnapshotError::MissingSlot)
        ));
    }

    #[test]
    fn estimate_counts_planned_bins_without_serializing() {
        let (store, pyramids) = store_with(&[("a", 1_000)]);
        let export = plan(
            &Session::default(),
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .expect("plan");
        let expected_bins: usize = export.signals[0]
            .levels
            .iter()
            .map(|level| level.bin_count)
            .sum();
        assert_eq!(
            estimated_bytes(&export),
            expected_bins as u64 * BYTES_PER_BIN
        );
    }

    #[test]
    fn estimate_shrinks_with_visible_scope() {
        let (store, pyramids) = store_with(&[("a", 100_000)]);
        let mut session = session_with(vec![panel(PanelMode::Time, &["a"])]);
        session.linked_time.t0 = 40_000.0;
        session.linked_time.t1 = 40_100.0;
        let visible = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::Visible,
            ExportFidelity::Standard,
        )
        .expect("visible plan");
        let all = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .expect("all plan");
        assert!(estimated_bytes(&visible) < estimated_bytes(&all));
    }

    #[test]
    fn estimate_stays_within_two_times_the_serialized_manifest() {
        let mut store = SignalStore::new();
        let source = store.register_source("test.csv");
        let time: Vec<f64> = (0..10_000).map(|value| f64::from(value) / 7.0).collect();
        let values: Vec<f64> = time.iter().map(|time| time.sin() * 13.0).collect();
        let id = store
            .insert_signal(source, "a".to_owned(), None, time.into(), values)
            .expect("insert");
        let mut pyramids = BTreeMap::new();
        pyramids.insert(id, Pyramid::from_signal(store.signal(id).expect("signal")));
        let session = Session::default();
        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .expect("plan");
        let estimated = estimated_bytes(&export);
        let actual = serde_json::to_vec(&bake(&export, &session).expect("bake"))
            .expect("serialize")
            .len() as u64;
        assert!(estimated <= actual * 2);
        assert!(actual <= estimated * 2);
    }

    fn empty_manifest() -> scope_protocol::SnapshotManifest {
        scope_protocol::SnapshotManifest {
            session_json: "{}".to_owned(),
            signals: Vec::new(),
        }
    }
}

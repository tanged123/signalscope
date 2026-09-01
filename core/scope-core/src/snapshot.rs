//! Snapshot export planning, baking, and template injection (ADR 0024).

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
};

use crate::pyramid::Pyramid;
use crate::series_ref::path_from_ref;
use crate::session::{BindingKind, LinkedTime, NamedSetKind, PanelState, SeriesRef, Session};
use crate::store::{Signal, SignalId, SignalStore, SourceKey};
use scope_protocol::{
    BakedSignal, ExportFidelity, ExportRange, ExportSelection, SignalSummary, SnapshotManifest,
};
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
    pub source_key: SourceKey,
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
    #[error("signal {0:?} has no source")]
    MissingSource(SignalId),
    #[error("signal {signal:?} level {level} window is unavailable")]
    MissingLevel { signal: SignalId, level: usize },
    #[error("manifest serialization failed: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("manifest output is not UTF-8: {0}")]
    Utf8(#[from] std::string::FromUtf8Error),
}

fn effective_window(panel: &PanelState, linked: &LinkedTime) -> (f64, f64) {
    if linked.linked {
        return (linked.t0, linked.t1);
    }
    match panel.time_window {
        Some([t0, t1]) => (t0, t1),
        None => (linked.t0, linked.t1),
    }
}

fn panel_signal_ids(
    session: &Session,
    store: &SignalStore,
    panel: &PanelState,
) -> BTreeSet<SignalId> {
    let mut ids = BTreeSet::new();
    for binding in &panel.bindings {
        match binding.kind {
            BindingKind::Pick => insert_refs(&mut ids, session, store, &binding.refs),
            BindingKind::Query => {
                if let Some(selector) = &binding.selector {
                    if let Some(signals) = matching_signals(store, selector) {
                        ids.extend(signals.map(|signal| signal.id));
                    }
                }
            }
            BindingKind::Set => {
                let Some(set) = session
                    .named_sets
                    .iter()
                    .find(|set| Some(set.id.as_str()) == binding.set_id.as_deref())
                else {
                    continue;
                };
                match set.kind {
                    NamedSetKind::Pick => insert_refs(&mut ids, session, store, &set.refs),
                    NamedSetKind::Query => {
                        if let Some(selector) = &set.selector {
                            if let Some(signals) = matching_signals(store, selector) {
                                ids.extend(signals.map(|signal| signal.id));
                            }
                        }
                    }
                }
            }
        }
    }
    ids
}

fn insert_refs(
    ids: &mut BTreeSet<SignalId>,
    session: &Session,
    store: &SignalStore,
    refs: &[SeriesRef],
) {
    ids.extend(
        refs.iter()
            .filter_map(|reference| signal_from_ref(session, store, reference))
            .map(|signal| signal.id),
    );
}

fn signal_from_ref<'a>(
    session: &Session,
    store: &'a SignalStore,
    reference: &SeriesRef,
) -> Option<&'a Signal> {
    path_from_ref(&session.sources, reference)
        .and_then(|path| store.signal_by_path(&path))
        .or_else(|| {
            let source = store.sources().find(|source| {
                source.key.0.to_string() == reference.source_key
                    || source.prefix == reference.source_key
            })?;
            store
                .signals_of(source.id)
                .find(|signal| signal.local_path == reference.channel)
        })
}

fn matching_signals<'a>(
    store: &'a SignalStore,
    selector: &'a str,
) -> Option<impl Iterator<Item = &'a Signal>> {
    let selector = parse_selector(selector)?;
    Some(
        store
            .signals()
            .filter(move |signal| selector_matches(signal, &selector)),
    )
}

struct ParsedSelector<'a> {
    channel: ParsedGlob,
    source: Option<ParsedGlob>,
    attrs: Vec<(&'a str, &'a str)>,
}

struct ParsedGlob {
    branches: Vec<Vec<char>>,
}

fn parse_selector(selector: &str) -> Option<ParsedSelector<'_>> {
    let mut tokens = selector.split_whitespace();
    let channel = parse_glob(tokens.next()?)?;
    let mut source = None;
    let mut attrs = Vec::new();
    while let Some(token) = tokens.next() {
        if token == "@" || token.starts_with('@') {
            if source.is_some() {
                return None;
            }
            let pattern = if token == "@" {
                tokens.next()
            } else {
                token.get(1..)
            }?;
            if pattern.is_empty() {
                return None;
            }
            source = Some(parse_glob(pattern)?);
        } else {
            let (key, value) = token.split_once(':')?;
            if value.is_empty() || !matches!(key, "unit" | "kind") {
                return None;
            }
            if key == "kind" && !matches!(value, "derived" | "signal") {
                return None;
            }
            attrs.push((key, value));
        }
    }
    Some(ParsedSelector {
        channel,
        source,
        attrs,
    })
}

fn parse_glob(pattern: &str) -> Option<ParsedGlob> {
    let branches = pattern
        .split('|')
        .map(|branch| {
            let branch = branch.chars().collect::<Vec<_>>();
            let mut index = 0;
            while index < branch.len() {
                if branch[index] != '[' {
                    index += 1;
                    continue;
                }
                let end = branch[index + 1..]
                    .iter()
                    .position(|character| *character == ']')
                    .map(|offset| index + 1 + offset)?;
                let body = &branch[index + 1..end];
                let valid = body.len() == 1 && body[0].is_ascii_alphanumeric()
                    || body.len() == 3
                        && body[0].is_ascii_alphanumeric()
                        && body[1] == '-'
                        && body[2].is_ascii_alphanumeric();
                if !valid {
                    return None;
                }
                index = end + 1;
            }
            Some(branch)
        })
        .collect::<Option<Vec<_>>>()?;
    Some(ParsedGlob { branches })
}

fn selector_matches(signal: &Signal, selector: &ParsedSelector<'_>) -> bool {
    let channel = signal
        .path
        .strip_prefix("derived/")
        .unwrap_or(&signal.local_path);
    if !glob_matches(&selector.channel, channel) {
        return false;
    }

    if let Some(pattern) = &selector.source {
        let source_name = signal
            .path
            .split_once('/')
            .map_or("derived", |(source, _)| source);
        if !glob_matches(pattern, source_name) {
            return false;
        }
    }
    selector.attrs.iter().all(|(key, value)| match *key {
        "unit" => signal.unit.as_deref() == Some(value),
        "kind" => match *value {
            "derived" => signal.path.starts_with("derived/"),
            "signal" => !signal.path.starts_with("derived/"),
            _ => false,
        },
        _ => false,
    })
}

fn glob_matches(pattern: &ParsedGlob, value: &str) -> bool {
    let value = value.chars().collect::<Vec<_>>();
    pattern
        .branches
        .iter()
        .any(|branch| glob_branch_matches(branch, &value))
}

fn glob_branch_matches(pattern: &[char], value: &[char]) -> bool {
    fn matches_at(
        pattern: &[char],
        value: &[char],
        pattern_at: usize,
        value_at: usize,
        memo: &mut [Vec<Option<bool>>],
    ) -> bool {
        if let Some(matched) = memo[pattern_at][value_at] {
            return matched;
        }
        let matched = if pattern_at == pattern.len() {
            value_at == value.len()
        } else {
            match pattern[pattern_at] {
                '*' => {
                    matches_at(pattern, value, pattern_at + 1, value_at, memo)
                        || (value_at < value.len()
                            && matches_at(pattern, value, pattern_at, value_at + 1, memo))
                }
                '?' => {
                    value_at < value.len()
                        && matches_at(pattern, value, pattern_at + 1, value_at + 1, memo)
                }
                '[' => {
                    let Some(end) = pattern[pattern_at + 1..]
                        .iter()
                        .position(|character| *character == ']')
                        .map(|offset| pattern_at + 1 + offset)
                    else {
                        memo[pattern_at][value_at] = Some(false);
                        return false;
                    };
                    let body = &pattern[pattern_at + 1..end];
                    let valid = body.len() == 1 && body[0].is_ascii_alphanumeric()
                        || body.len() == 3
                            && body[0].is_ascii_alphanumeric()
                            && body[1] == '-'
                            && body[2].is_ascii_alphanumeric();
                    if !valid || value_at == value.len() {
                        false
                    } else {
                        let class_matches = if body.len() == 1 {
                            value[value_at] == body[0]
                        } else {
                            (body[0]..=body[2]).contains(&value[value_at])
                        };
                        class_matches && matches_at(pattern, value, end + 1, value_at + 1, memo)
                    }
                }
                character => {
                    value.get(value_at) == Some(&character)
                        && matches_at(pattern, value, pattern_at + 1, value_at + 1, memo)
                }
            }
        };
        memo[pattern_at][value_at] = Some(matched);
        matched
    }

    let mut memo = vec![vec![None; value.len() + 1]; pattern.len() + 1];
    matches_at(pattern, value, 0, 0, &mut memo)
}

fn signal_plan<'a>(
    signal: &'a Signal,
    source_key: SourceKey,
    pyramid: &'a Pyramid,
    window: Option<(f64, f64)>,
    fidelity: ExportFidelity,
) -> SignalPlan<'a> {
    // The target is only a ceiling: sparse signals stay raw, while Full
    // explicitly selects level 0.
    let finest = match ceiling(fidelity) {
        None => 0,
        Some(limit) => (0..pyramid.level_count())
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
        source_key,
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
    let selection = ExportSelection {
        source_keys: store
            .sources()
            .map(|source| source.key.0.to_string())
            .collect(),
    };
    plan_selected(session, store, pyramids, &selection, range, fidelity)
}

/// Plans only explicitly selected sources.
///
/// # Errors
///
/// Returns an error when selected data or an exact set generation is absent.
pub fn plan_selected<'a>(
    session: &Session,
    store: &'a SignalStore,
    pyramids: &'a BTreeMap<SignalId, Pyramid>,
    selection: &ExportSelection,
    range: ExportRange,
    fidelity: ExportFidelity,
) -> Result<ExportPlan<'a>, SnapshotError> {
    let selected_sources = selection.source_keys.iter().collect::<BTreeSet<_>>();
    if range == ExportRange::All {
        let plan = export_plan(
            store
                .signals()
                .filter(|signal| {
                    source_key(store, signal)
                        .is_ok_and(|key| selected_sources.contains(&key.0.to_string()))
                })
                .map(|signal| {
                    let pyramid = pyramids
                        .get(&signal.id)
                        .ok_or(SnapshotError::MissingPyramid(signal.id))?;
                    Ok(signal_plan(
                        signal,
                        source_key(store, signal)?,
                        pyramid,
                        None,
                        fidelity,
                    ))
                })
                .collect::<Result<_, SnapshotError>>()?,
        );
        return Ok(plan);
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
            wanted.extend(panel_signal_ids(session, store, panel));
        }
    }
    let (t0, t1) = window.unwrap_or((session.linked_time.t0, session.linked_time.t1));

    let plan = export_plan(
        wanted
            .into_iter()
            .filter(|id| {
                store.signal(*id).is_some_and(|signal| {
                    source_key(store, signal)
                        .is_ok_and(|key| selected_sources.contains(&key.0.to_string()))
                })
            })
            .map(|id| {
                let signal = store.signal(id).ok_or(SnapshotError::MissingSignal(id))?;
                let pyramid = pyramids.get(&id).ok_or(SnapshotError::MissingPyramid(id))?;
                Ok(signal_plan(
                    signal,
                    source_key(store, signal)?,
                    pyramid,
                    Some((t0, t1)),
                    fidelity,
                ))
            })
            .collect::<Result<_, SnapshotError>>()?,
    );
    Ok(plan)
}

fn source_key(store: &SignalStore, signal: &Signal) -> Result<SourceKey, SnapshotError> {
    store
        .sources()
        .find(|source| source.id == signal.source_id)
        .map(|source| source.key)
        .ok_or(SnapshotError::MissingSource(signal.id))
}

fn signal_summary(
    signal: &Signal,
    source_key: SourceKey,
    last_value: Option<f64>,
) -> SignalSummary {
    let (t_min, t_max) = signal.time_bounds();
    SignalSummary {
        signal_id: signal.id.0,
        source_id: signal.source_id.0,
        source_key: source_key.0.to_string(),
        local_path: signal.local_path.clone(),
        path: signal.path.clone(),
        unit: signal.unit.clone(),
        point_count: signal.len() as u64,
        t_min,
        t_max,
        last_value,
    }
}

/// Bakes a deterministic manifest from a previously selected export plan.
///
/// # Errors
///
/// Returns [`SnapshotError::Serialize`] when the session cannot be encoded and
/// [`SnapshotError::MissingLevel`] when a planned level window cannot be
/// decoded; levels are positional, so a missing level fails the bake instead
/// of silently shifting later levels toward the finest slot.
pub fn bake(plan: &ExportPlan, session: &Session) -> Result<SnapshotManifest, SnapshotError> {
    let mut baked_session = session.clone();
    baked_session.sources.clear();

    let mut signals = Vec::new();
    for entry in &plan.signals {
        let levels = entry
            .levels
            .iter()
            .map(|level| {
                entry
                    .pyramid
                    .level_window(level.index, entry.window)
                    .map(|window| window.to_wire_vec())
                    .ok_or(SnapshotError::MissingLevel {
                        signal: entry.signal.id,
                        level: level.index,
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        signals.push(BakedSignal {
            summary: signal_summary(
                entry.signal,
                entry.source_key,
                entry.pyramid.last_finite_value(),
            ),
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
    use crate::session::{
        AxisStyle, Binding, BindingKind, NamedSet, NamedSetKind, PanelState, SeriesRef, Session,
    };
    use crate::store::{SignalId, SignalStore, SourceKey};
    use scope_protocol::{ExportFidelity, ExportRange};

    fn store_with(signals: &[(&str, usize)]) -> (SignalStore, BTreeMap<SignalId, Pyramid>) {
        let mut store = SignalStore::new();
        let source = store
            .register_source("test.csv", SourceKey(uuid::Uuid::from_bytes([1; 16])), "")
            .unwrap();
        let mut pyramids = BTreeMap::new();
        for (path, count) in signals {
            let count = u32::try_from(*count).expect("test signal is small");
            let time: Vec<f64> = (0..count).map(f64::from).collect();
            let values: Vec<f64> = time.iter().map(|time| time * 0.5).collect();
            let id = store
                .insert_signal(source, (*path).to_owned(), None, time, values)
                .expect("insert");
            let signal = store.signal(id).expect("signal");
            pyramids.insert(id, Pyramid::from_signal(signal));
        }
        (store, pyramids)
    }

    fn panel(id: &str, paths: &[&str]) -> PanelState {
        PanelState {
            id: id.to_owned(),
            title: "Panel".to_owned(),
            axis_style: AxisStyle::Gutter,
            bindings: vec![Binding {
                kind: BindingKind::Pick,
                selector: None,
                refs: paths
                    .iter()
                    .map(|path| SeriesRef {
                        source_key: uuid::Uuid::from_bytes([1; 16]).to_string(),
                        channel: (*path).to_owned(),
                    })
                    .collect(),
                set_id: None,
            }],
            color_by: Some(crate::session::StyleDimension::Source),
            dash_by: None,
            width_by: None,
            line_width: 1.4,
            ghost_opacity: 0.5,
            overrides: Vec::new(),
            focus: Vec::new(),
            ghost_mode: crate::session::GhostMode::All,
            legend_state: crate::session::LegendState::Keys,
            legend_position: None,
            legend_size: None,
            legend_anchor: None,
            legend_hint_dismissed: false,
            y_range: None,
            x_range: None,
            x_label: None,
            y_label: None,
            time_window: None,
            annotations: Vec::new(),
            show_stats: false,
            stat_columns: vec![
                crate::session::StatColumn::Min,
                crate::session::StatColumn::Max,
                crate::session::StatColumn::Mean,
                crate::session::StatColumn::Rms,
                crate::session::StatColumn::Cursor,
            ],
            stats_sort: None,
            stats_sort_descending: false,
        }
    }

    fn session_with(panels: Vec<PanelState>) -> Session {
        let mut session = Session::default();
        session.sources.push(crate::session::SourceRecord {
            key: uuid::Uuid::from_bytes([1; 16]).to_string(),
            path: "/data/test.csv".into(),
            prefix: String::new(),
            provider_id: None,
            decode_provenance: None,
            recipe_id: None,
            recipe_digest: None,
        });
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
                summary: signal_summary(
                    signal,
                    source_key(&store, signal).expect("source"),
                    pyramid.last_finite_value(),
                ),
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
        let session = session_with(vec![panel("panel-1", &["a"])]);
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
    fn visible_scope_resolves_query_and_saved_set_bindings() {
        let (store, pyramids) = store_with(&[("alpha", 10), ("beta", 10), ("ignored", 10)]);
        let mut panel = panel("panel-1", &[]);
        panel.bindings = vec![
            Binding {
                kind: BindingKind::Query,
                selector: Some("alpha".into()),
                refs: Vec::new(),
                set_id: None,
            },
            Binding {
                kind: BindingKind::Set,
                selector: None,
                refs: Vec::new(),
                set_id: Some("saved".into()),
            },
        ];
        let mut session = session_with(vec![panel]);
        session.named_sets.push(NamedSet {
            id: "saved".into(),
            name: "Saved".into(),
            kind: NamedSetKind::Pick,
            selector: None,
            refs: vec![SeriesRef {
                source_key: uuid::Uuid::from_bytes([1; 16]).to_string(),
                channel: "beta".into(),
            }],
        });

        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::Visible,
            ExportFidelity::Standard,
        )
        .expect("plan");
        let paths = export
            .signals
            .iter()
            .map(|entry| entry.signal.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, ["alpha", "beta"]);
    }

    #[test]
    fn visible_scope_query_matcher_handles_globs_kinds_and_empty_results() {
        let (store, pyramids) = store_with(&[("alpha", 10), ("beta", 10), ("derived/score", 10)]);
        let cases: &[(&str, &[&str])] = &[
            ("alpha*", &["alpha"]),
            ("alpha|beta", &["alpha", "beta"]),
            ("alpha[", &[]),
            ("* kind:derived", &["derived/score"]),
            ("missing*", &[]),
        ];

        for (selector, expected) in cases {
            let mut query_panel = panel("panel-query", &[]);
            query_panel.bindings = vec![Binding {
                kind: BindingKind::Query,
                selector: Some((*selector).into()),
                refs: Vec::new(),
                set_id: None,
            }];
            let session = session_with(vec![query_panel]);

            let export = plan(
                &session,
                &store,
                &pyramids,
                ExportRange::Visible,
                ExportFidelity::Standard,
            )
            .expect("plan");
            let paths = export
                .signals
                .iter()
                .map(|entry| entry.signal.path.as_str())
                .collect::<Vec<_>>();
            assert_eq!(paths, *expected, "selector: {selector}");
        }
    }

    #[test]
    fn visible_scope_decimates_dense_time_signals() {
        let (store, pyramids) = store_with(&[("a", 100_000)]);
        let mut session = session_with(vec![panel("panel-1", &["a"])]);
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
        let session = session_with(vec![panel("panel-1", &["a"])]);
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
    fn fidelity_ceiling_is_monotone() {
        let (store, pyramids) = store_with(&[("a", 100_000)]);
        let session = session_with(vec![panel("panel-1", &["a"])]);
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
    fn window_is_the_union_of_panel_windows() {
        let (store, pyramids) = store_with(&[("a", 100), ("b", 100)]);
        let mut session = Session::default();
        session.linked_time.t0 = 0.0;
        session.linked_time.t1 = 10.0;
        let linked = panel("panel-linked", &["a"]);
        let mut unlinked = panel("panel-unlinked", &["b"]);
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
    fn bake_clears_sources_and_orders_signals_by_id() {
        let (store, pyramids) = store_with(&[("b", 100), ("a", 100)]);
        let session = Session {
            sources: vec![crate::session::SourceRecord {
                key: uuid::Uuid::nil().to_string(),
                path: "/home/user/secret.csv".into(),
                prefix: "secret".into(),
                provider_id: None,
                decode_provenance: None,
                recipe_id: None,
                recipe_digest: None,
            }],
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
        let mut session = session_with(vec![panel("panel-1", &["a"])]);
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
        let mut session = session_with(vec![panel("panel-1", &["a"])]);
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
        let mut session = session_with(vec![panel("panel-1", &["a"])]);
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
        let source = store
            .register_source("test.csv", SourceKey(uuid::Uuid::from_bytes([2; 16])), "")
            .unwrap();
        let time: Vec<f64> = (0..10_000).map(|value| f64::from(value) / 7.0).collect();
        let values: Vec<f64> = time.iter().map(|time| time.sin() * 13.0).collect();
        let id = store
            .insert_signal(source, "a".to_owned(), None, time, values)
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

    #[test]
    fn export_selection_filters_all_range_before_level_planning() {
        let mut store = SignalStore::new();
        let mut pyramids = BTreeMap::new();
        for key in [1_u8, 2] {
            let source = store
                .register_source(
                    format!("run-{key}.csv"),
                    SourceKey(uuid::Uuid::from_bytes([key; 16])),
                    format!("run-{key}"),
                )
                .unwrap();
            let signal = store
                .insert_signal(source, "a", None, vec![0.0, 1.0], vec![0.0, 1.0])
                .unwrap();
            pyramids.insert(signal, Pyramid::from_signal(store.signal(signal).unwrap()));
        }
        let selected = store.sources().next().unwrap().key.0.to_string();
        let selection = ExportSelection {
            source_keys: vec![selected],
        };
        let plan = plan_selected(
            &Session::default(),
            &store,
            &pyramids,
            &selection,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .unwrap();
        assert_eq!(plan.series_total, 1);
    }

    fn empty_manifest() -> scope_protocol::SnapshotManifest {
        scope_protocol::SnapshotManifest {
            session_json: "{}".to_owned(),
            signals: Vec::new(),
        }
    }
}

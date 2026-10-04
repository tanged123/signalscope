//! Snapshot export planning, baking, and template injection (ADR 0024).

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
};

use crate::line2d::{Line2dError, LinePyramid};
use crate::pyramid::Pyramid;
use crate::session::{LinkedTime, PanelState, Session};
mod bindings;
mod histogram;
mod payload;
use crate::store::{Signal, SignalId, SignalStore, SourceKey};
use bindings::{line_combinations, panel_signal_ids};
use histogram::HistogramPlan;
use payload::PayloadWriter;
use scope_protocol::{
    BakedLine2D, BakedLine2DLevel, BakedSignal, ExportFidelity, ExportRange, ExportSelection,
    SignalSummary, SnapshotManifest,
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

pub struct LineLevelPlan {
    pub index: usize,
    pub point_count: usize,
}

pub struct LinePlan<'a> {
    pub x_signal: &'a Signal,
    pub y_signals: Vec<&'a Signal>,
    pub pyramid: LinePyramid,
    pub window: Option<(f64, f64)>,
    pub levels: Vec<LineLevelPlan>,
}

pub use histogram::HistogramCapture;

pub use histogram::bake_owned as bake_histograms_owned;

#[must_use]
pub fn clone_histogram_captures(plan: &ExportPlan) -> Vec<HistogramCapture> {
    histogram::clone_captures(&plan.histograms)
}

impl SignalPlan<'_> {
    #[must_use]
    pub fn finest_level(&self) -> usize {
        self.levels.first().map_or(0, |level| level.index)
    }
}

pub struct ExportPlan<'a> {
    pub signals: Vec<SignalPlan<'a>>,
    pub lines: Vec<LinePlan<'a>>,
    pub histograms: Vec<HistogramPlan<'a>>,
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
    #[error("Line2D X signal {0:?} is missing")]
    MissingLineXSignal(SignalId),
    #[error("Line2D X signal reference {0} is missing")]
    MissingLineXReference(String),
    #[error("Line2D panel has no Y signals")]
    EmptyLineYSignals,
    #[error("Line2D signals do not share an exact timebase")]
    LineTimebaseMismatch,
    #[error("Line2D signal {0:?} could not be read")]
    LineColumnRead(SignalId),
    #[error("histogram could not be prepared: {0}")]
    Histogram(String),
    #[error("manifest serialization failed: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("manifest output is not UTF-8: {0}")]
    Utf8(#[from] std::string::FromUtf8Error),
    #[error("snapshot payload could not be compressed: {0}")]
    Payload(#[from] std::io::Error),
    #[error("snapshot payload exceeds the u32 column table limits")]
    PayloadTooLarge,
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

fn line_plan<'a>(
    x_signal: &'a Signal,
    y_signals: Vec<&'a Signal>,
    window: Option<(f64, f64)>,
    fidelity: ExportFidelity,
) -> Result<LinePlan<'a>, SnapshotError> {
    if y_signals.is_empty() {
        return Err(SnapshotError::EmptyLineYSignals);
    }
    let effective_window = window.unwrap_or_else(|| x_signal.time_bounds());
    let pyramid = match window {
        Some((t0, t1)) => LinePyramid::from_signals_window(x_signal, &y_signals, t0, t1),
        None => LinePyramid::from_signals(x_signal, &y_signals),
    }
    .map_err(|error| match error {
        Line2dError::EmptyYSignals => SnapshotError::EmptyLineYSignals,
        Line2dError::TimebaseMismatch => SnapshotError::LineTimebaseMismatch,
        Line2dError::ColumnRead => SnapshotError::LineColumnRead(x_signal.id),
    })?;
    let finest = match ceiling(fidelity) {
        None => 0,
        Some(limit) => (0..pyramid.level_count())
            .find(|index| {
                pyramid
                    .level_window_count(*index, effective_window.0, effective_window.1)
                    .is_some_and(|count| count <= limit)
            })
            .unwrap_or_else(|| pyramid.level_count().saturating_sub(1)),
    };
    let levels = (finest..pyramid.level_count())
        .map(|index| LineLevelPlan {
            index,
            point_count: pyramid
                .level_window_count(index, effective_window.0, effective_window.1)
                .expect("planned Line2D level exists"),
        })
        .collect();
    Ok(LinePlan {
        x_signal,
        y_signals,
        pyramid,
        window,
        levels,
    })
}

fn export_plan<'a>(
    signals: Vec<SignalPlan<'a>>,
    lines: Vec<LinePlan<'a>>,
    histograms: Vec<HistogramPlan<'a>>,
) -> ExportPlan<'a> {
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
        lines,
        histograms,
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
        let signals = store
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
            .collect::<Result<_, SnapshotError>>()?;
        let lines = line_plans(session, store, &selected_sources, None, fidelity)?;
        let histograms = histogram::plans(session, store, &selected_sources)?;
        let plan = export_plan(signals, lines, histograms);
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

    let signals = wanted
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
        .collect::<Result<_, SnapshotError>>()?;
    let lines = line_plans(session, store, &selected_sources, Some((t0, t1)), fidelity)?;
    let histograms = histogram::plans(session, store, &selected_sources)?;
    let plan = export_plan(signals, lines, histograms);
    Ok(plan)
}

fn line_plans<'a>(
    session: &Session,
    store: &'a SignalStore,
    selected_sources: &BTreeSet<&String>,
    window: Option<(f64, f64)>,
    fidelity: ExportFidelity,
) -> Result<Vec<LinePlan<'a>>, SnapshotError> {
    line_combinations(session, store)?
        .into_iter()
        .filter(|(x_id, y_ids)| {
            std::iter::once(x_id).chain(y_ids.iter()).all(|id| {
                store.signal(*id).is_some_and(|signal| {
                    source_key(store, signal)
                        .is_ok_and(|key| selected_sources.contains(&key.0.to_string()))
                })
            })
        })
        .map(|(x_id, y_ids)| {
            let x_signal = store
                .signal(x_id)
                .ok_or(SnapshotError::MissingLineXSignal(x_id))?;
            let y_signals = y_ids
                .into_iter()
                .map(|id| store.signal(id).ok_or(SnapshotError::MissingSignal(id)))
                .collect::<Result<Vec<_>, _>>()?;
            line_plan(x_signal, y_signals, window, fidelity)
        })
        .collect()
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
/// of silently shifting later levels toward the finest slot. Histogram capture
/// errors are returned after the session and line payload have been prepared.
pub fn bake(plan: &ExportPlan, session: &Session) -> Result<SnapshotManifest, SnapshotError> {
    let mut manifest = bake_without_histograms(plan, session)?;
    if !plan.histograms.is_empty() {
        manifest.histograms = Some(histogram::bake_plan(&plan.histograms)?);
    }
    Ok(manifest)
}

/// Bakes session, source tiles, and `Line2D` data without scanning histogram
/// source values. Server export uses this portion while holding its state lock,
/// then computes histogram captures after the lock is released.
///
/// # Errors
///
/// Returns [`SnapshotError::Serialize`] when the session cannot be encoded and
/// [`SnapshotError::MissingLevel`] when a planned level window cannot be
/// decoded.
pub fn bake_without_histograms(
    plan: &ExportPlan,
    session: &Session,
) -> Result<SnapshotManifest, SnapshotError> {
    let mut baked_session = session.clone();
    baked_session.sources.clear();

    let mut payload = PayloadWriter::new();
    let mut signals = Vec::new();
    // Column order follows output order so identical inputs give identical bytes.
    let mut signal_plans = plan.signals.iter().collect::<Vec<_>>();
    signal_plans.sort_by_key(|entry| entry.signal.id);
    for entry in signal_plans {
        let levels = entry
            .levels
            .iter()
            .map(|level| {
                let window = entry
                    .pyramid
                    .level_window(level.index, entry.window)
                    .ok_or(SnapshotError::MissingLevel {
                        signal: entry.signal.id,
                        level: level.index,
                    })?;
                payload.level(&window)
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

    let mut line_plans = plan.lines.iter().collect::<Vec<_>>();
    line_plans.sort_by(|left, right| {
        left.x_signal.id.cmp(&right.x_signal.id).then_with(|| {
            let ids = |line: &LinePlan| {
                line.y_signals
                    .iter()
                    .map(|signal| signal.id)
                    .collect::<Vec<_>>()
            };
            ids(left).cmp(&ids(right))
        })
    });
    let line2d = line_plans
        .into_iter()
        .map(|entry| {
            let effective_window = entry.window.unwrap_or_else(|| entry.x_signal.time_bounds());
            let levels = entry
                .levels
                .iter()
                .map(|level| {
                    let query = entry
                        .pyramid
                        .level_window(level.index, effective_window.0, effective_window.1)
                        .ok_or(SnapshotError::MissingLevel {
                            signal: entry.x_signal.id,
                            level: level.index,
                        })?;
                    let mut ys =
                        vec![Vec::with_capacity(query.points.len()); entry.y_signals.len()];
                    let anchor = query
                        .points
                        .iter()
                        .map(|point| point.anchor)
                        .collect::<Vec<_>>();
                    let x = query.points.iter().map(|point| point.x).collect::<Vec<_>>();
                    for point in query.points {
                        for (values, value) in ys.iter_mut().zip(point.ys) {
                            values.push(value);
                        }
                    }
                    Ok(BakedLine2DLevel {
                        level: u32::try_from(level.index).unwrap_or(u32::MAX),
                        anchor: payload.f64_column(&anchor)?,
                        x: payload.finite_f64_column(&x)?,
                        ys: ys
                            .iter()
                            .map(|values| payload.finite_f64_column(values))
                            .collect::<Result<_, _>>()?,
                    })
                })
                .collect::<Result<Vec<_>, SnapshotError>>()?;
            Ok(BakedLine2D {
                x_signal_id: entry.x_signal.id.0,
                y_signal_ids: entry.y_signals.iter().map(|signal| signal.id.0).collect(),
                levels,
            })
        })
        .collect::<Result<Vec<_>, SnapshotError>>()?;
    let payload = payload.finish()?;

    Ok(SnapshotManifest {
        session_json: serde_json::to_string(&baked_session)?,
        preferences_json: None,
        payload,
        signals,
        line2d: Some(line2d),
        histograms: None,
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

/// Base64 bytes of an uncompressed single-sample bin: time and value.
const BYTES_PER_SAMPLE: u64 = 22;
/// Base64 bytes of an uncompressed merged bin: eight f64, two u32, one u8.
const BYTES_PER_BIN: u64 = 98;

/// Estimates serialized data bytes from planned level metadata as uncompressed
/// base64 columns. Compression and deduplication usually make real payloads
/// several times smaller.
#[must_use]
pub fn estimated_bytes(plan: &ExportPlan) -> u64 {
    let signal_bytes = plan
        .signals
        .iter()
        .flat_map(|signal| &signal.levels)
        .map(|level| {
            let per_bin = if level.index == 0 {
                BYTES_PER_SAMPLE
            } else {
                BYTES_PER_BIN
            };
            (level.bin_count as u64).saturating_mul(per_bin)
        })
        .fold(0_u64, u64::saturating_add);
    let line_bytes = plan
        .lines
        .iter()
        .map(|line| {
            line.levels
                .iter()
                .map(|level| {
                    (level.point_count as u64)
                        .saturating_mul(
                            u64::try_from(11 * (line.y_signals.len() + 2)).unwrap_or(u64::MAX),
                        )
                        .saturating_add(128)
                })
                .sum::<u64>()
        })
        .sum::<u64>();
    let histogram_bytes = histogram::estimated_bytes(&plan.histograms);
    signal_bytes
        .saturating_add(line_bytes)
        .saturating_add(histogram_bytes)
}

#[cfg(test)]
mod tests;

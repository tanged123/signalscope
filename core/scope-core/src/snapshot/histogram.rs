//! Exact histogram capture for native and baked snapshots.

use std::collections::BTreeSet;

use super::bindings::panel_histogram_signal_ids;
use crate::{
    session::{PanelContent, Session},
    snapshot::{SnapshotError, effective_window, source_key},
    store::{Signal, SignalStore},
};
use scope_protocol::{BakedHistogram, HistogramResponse, HistogramSeries, TimeWindow};

pub struct HistogramPlan<'a> {
    pub(super) panel_id: String,
    pub(super) bin_count: u32,
    pub(super) signals: Vec<&'a Signal>,
    pub(super) window: TimeWindow,
}

/// Owned histogram inputs retained after the state lock is released. Signal
/// clones hold their paged column handles, so capture can perform the exact
/// reduction without borrowing mutable server state.
#[derive(Clone)]
pub struct HistogramCapture {
    pub panel_id: String,
    pub bin_count: u32,
    pub signals: Vec<Signal>,
    pub window: TimeWindow,
}

pub(super) fn plans<'a>(
    session: &Session,
    store: &'a SignalStore,
    selected_sources: &BTreeSet<&String>,
) -> Result<Vec<HistogramPlan<'a>>, SnapshotError> {
    let mut plans = Vec::new();
    for tab in &session.tabs {
        for panel in &tab.panels {
            let PanelContent::Histogram { bin_count } = panel.content else {
                continue;
            };
            let (t0, t1) = effective_window(panel, &session.linked_time);
            let window = TimeWindow { t0, t1 };
            let signals = panel_histogram_signal_ids(session, store, panel)?
                .into_iter()
                .filter_map(|id| store.signal(id))
                .filter(|signal| {
                    source_key(store, signal)
                        .is_ok_and(|key| selected_sources.contains(&key.0.to_string()))
                })
                .collect::<Vec<_>>();
            let unit = signals.first().map(|signal| &signal.unit);
            if unit.is_some_and(|unit| signals.iter().skip(1).any(|signal| &signal.unit != unit)) {
                return Err(SnapshotError::Histogram(format!(
                    "panel {} contains signals with incompatible units",
                    panel.id
                )));
            }
            plans.push(HistogramPlan {
                panel_id: panel.id.clone(),
                bin_count,
                signals,
                window,
            });
        }
    }
    plans.sort_by(|left, right| left.panel_id.cmp(&right.panel_id));
    Ok(plans)
}

#[must_use]
pub(super) fn clone_captures(plan: &[HistogramPlan<'_>]) -> Vec<HistogramCapture> {
    plan.iter()
        .map(|entry| HistogramCapture {
            panel_id: entry.panel_id.clone(),
            bin_count: entry.bin_count,
            signals: entry
                .signals
                .iter()
                .map(|signal| (*signal).clone())
                .collect(),
            window: entry.window.clone(),
        })
        .collect()
}

pub(super) fn bake_plan(plan: &[HistogramPlan<'_>]) -> Result<Vec<BakedHistogram>, SnapshotError> {
    let captures = clone_captures(plan);
    bake_owned(&captures)
}

/// Bakes owned histogram captures into snapshot payloads.
///
/// # Errors
///
/// Returns [`SnapshotError::Histogram`] when a capture cannot be reduced.
pub fn bake_owned(captures: &[HistogramCapture]) -> Result<Vec<BakedHistogram>, SnapshotError> {
    captures
        .iter()
        .map(|entry| {
            if entry.signals.is_empty() {
                return Ok(BakedHistogram {
                    panel_id: entry.panel_id.clone(),
                    bin_count: entry.bin_count,
                    response: HistogramResponse {
                        request_id: format!("snapshot:{}", entry.panel_id),
                        window: entry.window.clone(),
                        edges: Vec::new(),
                        series: Vec::new(),
                    },
                });
            }
            let references = entry.signals.iter().collect::<Vec<_>>();
            let result = crate::compute::histogram::histogram(
                &references,
                entry.window.clone(),
                entry.bin_count,
            )
            .map_err(|error| {
                SnapshotError::Histogram(format!("panel {}: {error}", entry.panel_id))
            })?;
            let series = result
                .series
                .into_iter()
                .map(|series| HistogramSeries {
                    signal_id: series.signal_id.0,
                    signal_path: series.path,
                    unit: series.unit,
                    counts: series.counts,
                    finite_count: series.finite_count,
                    excluded_count: series.excluded_count,
                })
                .collect();
            Ok(BakedHistogram {
                panel_id: entry.panel_id.clone(),
                bin_count: entry.bin_count,
                response: HistogramResponse {
                    request_id: format!("snapshot:{}", entry.panel_id),
                    window: entry.window.clone(),
                    edges: result.edges,
                    series,
                },
            })
        })
        .collect()
}

pub(super) fn estimated_bytes(plan: &[HistogramPlan<'_>]) -> u64 {
    plan.iter()
        .map(|histogram| {
            if histogram.signals.is_empty() {
                return 128;
            }
            let bins = u64::from(histogram.bin_count);
            let series = u64::try_from(histogram.signals.len()).unwrap_or(u64::MAX);
            // Counts are decimal strings on the wire (u64 exactness), so
            // account for their textual width rather than the Rust payload.
            bins.saturating_mul(series)
                .saturating_mul(24)
                .saturating_add(bins.saturating_add(1).saturating_mul(16))
                .saturating_add(series.saturating_mul(128))
        })
        .sum()
}

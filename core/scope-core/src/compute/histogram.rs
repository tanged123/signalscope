//! Exact, bounded-memory value histograms over source-time windows.
//!
//! Histogram reduction deliberately reads source values in chunks. A sampled
//! query or an extrema tile cannot provide exact distribution counts, and a
//! paged column must not be turned into a resident copy merely to compute a
//! small result.

use std::ops::Range;

use scope_protocol::TimeWindow;
use thiserror::Error;

use crate::store::{Signal, SignalId};

/// Initial histogram bin count used by callers that do not expose a control.
pub const DEFAULT_BIN_COUNT: u32 = 32;
/// Maximum number of equal-width bins accepted by the reducer.
pub const MAX_BIN_COUNT: u32 = 256;
const READ_CHUNK: usize = 8192;

/// One signal's exact histogram counts and quality totals.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistogramSeries {
    pub signal_id: SignalId,
    pub path: String,
    pub unit: Option<String>,
    pub counts: Vec<u64>,
    pub finite_count: u64,
    pub excluded_count: u64,
}

/// Exact histogram output for all requested signals.
#[derive(Clone, Debug, PartialEq)]
pub struct HistogramResult {
    /// Equal-width bin boundaries. There are `counts.len() + 1` edges when
    /// at least one finite source value exists; all-excluded and empty input
    /// has no value domain and therefore returns no edges.
    pub edges: Vec<f64>,
    pub series: Vec<HistogramSeries>,
}

/// Failures that prevent an exact histogram from being produced.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum HistogramError {
    #[error("histogram window must be finite and ordered")]
    InvalidWindow,
    #[error("histogram bin count must be between 1 and {MAX_BIN_COUNT}, got {requested}")]
    InvalidBinCount { requested: u32 },
    #[error("histogram signals must have identical units (signal {signal:?} differs)")]
    IncompatibleUnits { signal: SignalId },
    #[error("histogram edges cannot represent {bin_count} distinct bins for the requested range")]
    UnrepresentableEdges { bin_count: u32 },
    #[error("could not read signal {signal:?}")]
    ColumnRead { signal: SignalId },
    #[error("histogram count exceeds u64")]
    CountOverflow,
}

/// Computes exact sample counts for `signals` whose timestamps lie in the
/// inclusive source-time interval `[window.t0, window.t1]`.
///
/// The first pass finds one finite range shared by all signals and records
/// each signal's finite and excluded (non-finite value) totals. The second
/// pass assigns every finite value to a bin. Both passes read at most
/// [`READ_CHUNK`] values from a column at once, including for page-backed
/// signals. Samples are never silently dropped or subsampled.
/// When the selected input has no finite values, the result has empty edges
/// and empty counts while retaining each signal's excluded total.
/// An empty signal list is also a valid empty result.
///
/// Signals must use the same optional unit. An absent unit is only compatible
/// with another absent unit; this reducer does not perform unit conversion.
///
/// # Errors
///
/// Returns an error for an invalid window or bin count, incompatible units,
/// unreadable columns, an unrepresentable requested range, or a count that
/// cannot fit in `u64`.
///
/// # Panics
///
/// Panics only if a validated bin count cannot fit in `usize`, which is
/// impossible on supported targets because the maximum is 256.
#[allow(clippy::needless_pass_by_value)]
pub fn histogram(
    signals: &[&Signal],
    window: TimeWindow,
    bin_count: u32,
) -> Result<HistogramResult, HistogramError> {
    validate_inputs(signals, &window, bin_count)?;

    if signals.is_empty() {
        return Ok(HistogramResult {
            edges: Vec::new(),
            series: Vec::new(),
        });
    }

    let mut summaries = Vec::with_capacity(signals.len());
    let mut global_min = f64::INFINITY;
    let mut global_max = f64::NEG_INFINITY;
    let mut has_finite = false;

    for signal in signals {
        let range = signal_window_range(signal, &window)?;
        let mut summary = SignalSummary::default();
        if let Some(range) = range {
            scan_values(signal, range, |value| {
                if value.is_finite() {
                    has_finite = true;
                    global_min = global_min.min(value);
                    global_max = global_max.max(value);
                    summary.finite_count = summary
                        .finite_count
                        .checked_add(1)
                        .ok_or(HistogramError::CountOverflow)?;
                } else {
                    summary.excluded_count = summary
                        .excluded_count
                        .checked_add(1)
                        .ok_or(HistogramError::CountOverflow)?;
                }
                Ok(())
            })?;
        }
        summaries.push(summary);
    }

    let edges = if has_finite {
        make_edges(global_min, global_max, bin_count)?
    } else {
        // An empty domain lets presentation show its explicit empty state. It
        // also avoids inventing a value range for all-excluded inputs.
        Vec::new()
    };

    let mut series = Vec::with_capacity(signals.len());
    for (signal, summary) in signals.iter().zip(summaries) {
        let mut counts = if has_finite {
            vec![0_u64; usize::try_from(bin_count).expect("bin count fits usize")]
        } else {
            Vec::new()
        };
        if has_finite && summary.finite_count > 0 {
            if let Some(range) = signal_window_range(signal, &window)? {
                scan_values(signal, range, |value| {
                    if value.is_finite() {
                        let bin = bin_for(value, &edges);
                        counts[bin] = counts[bin]
                            .checked_add(1)
                            .ok_or(HistogramError::CountOverflow)?;
                    }
                    Ok(())
                })?;
            }
        }
        series.push(HistogramSeries {
            signal_id: signal.id,
            path: signal.path.clone(),
            unit: signal.unit.clone(),
            counts,
            finite_count: summary.finite_count,
            excluded_count: summary.excluded_count,
        });
    }

    Ok(HistogramResult { edges, series })
}

#[derive(Clone, Copy, Debug, Default)]
struct SignalSummary {
    finite_count: u64,
    excluded_count: u64,
}

fn validate_inputs(
    signals: &[&Signal],
    window: &TimeWindow,
    bin_count: u32,
) -> Result<(), HistogramError> {
    if !window.t0.is_finite() || !window.t1.is_finite() || window.t0 > window.t1 {
        return Err(HistogramError::InvalidWindow);
    }
    if !(1..=MAX_BIN_COUNT).contains(&bin_count) {
        return Err(HistogramError::InvalidBinCount {
            requested: bin_count,
        });
    }
    if signals.len() > 1 {
        let unit = &signals[0].unit;
        if signals.iter().skip(1).any(|signal| signal.unit != *unit) {
            let signal = signals
                .iter()
                .skip(1)
                .find(|signal| signal.unit != *unit)
                .expect("incompatible signal exists");
            return Err(HistogramError::IncompatibleUnits { signal: signal.id });
        }
    }
    Ok(())
}

fn signal_window_range(
    signal: &Signal,
    window: &TimeWindow,
) -> Result<Option<Range<usize>>, HistogramError> {
    let time = signal.time_column();
    if time.is_empty() {
        return Ok(None);
    }
    let first = time
        .value(0)
        .map_err(|_| HistogramError::ColumnRead { signal: signal.id })?;
    let last = time
        .value(time.len() - 1)
        .map_err(|_| HistogramError::ColumnRead { signal: signal.id })?;
    if window.t1 < first || window.t0 > last {
        return Ok(None);
    }
    let start = time
        .partition_point(|value| value < window.t0)
        .map_err(|_| HistogramError::ColumnRead { signal: signal.id })?;
    let end = time
        .partition_point(|value| value <= window.t1)
        .map_err(|_| HistogramError::ColumnRead { signal: signal.id })?;
    Ok((start < end).then_some(start..end))
}

fn scan_values(
    signal: &Signal,
    range: Range<usize>,
    mut visit: impl FnMut(f64) -> Result<(), HistogramError>,
) -> Result<(), HistogramError> {
    let mut start = range.start;
    while start < range.end {
        let end = start.saturating_add(READ_CHUNK).min(range.end);
        let values = signal
            .values_column()
            .range(start..end)
            .map_err(|_| HistogramError::ColumnRead { signal: signal.id })?;
        for value in values.iter().copied() {
            visit(value)?;
        }
        start = end;
    }
    Ok(())
}

#[allow(clippy::float_cmp)] // Exact equality intentionally detects constants.
fn make_edges(minimum: f64, maximum: f64, bin_count: u32) -> Result<Vec<f64>, HistogramError> {
    let (minimum, maximum) = if minimum == maximum {
        constant_range(minimum)
    } else {
        (minimum, maximum)
    };
    if bin_count == 1 {
        // Normalising first can round adjacent large values to the same
        // quotient. The endpoints themselves are already valid edges.
        return Ok(vec![minimum, maximum]);
    }
    let scale = minimum.abs().max(maximum.abs()).max(1.0);
    let normalized_minimum = minimum / scale;
    let normalized_span = maximum / scale - normalized_minimum;
    if !normalized_span.is_finite() || normalized_span <= 0.0 {
        return Err(HistogramError::UnrepresentableEdges { bin_count });
    }

    let count = usize::try_from(bin_count).expect("bin count fits usize");
    let mut edges = Vec::with_capacity(count + 1);
    for index in 0..=bin_count {
        let edge = match index {
            0 => minimum,
            value if value == bin_count => maximum,
            value => {
                let fraction = f64::from(value) / f64::from(bin_count);
                let normalized = normalized_minimum + normalized_span * fraction;
                normalized * scale
            }
        };
        if !edge.is_finite() || edges.last().is_some_and(|previous| edge <= *previous) {
            return Err(HistogramError::UnrepresentableEdges { bin_count });
        }
        edges.push(edge);
    }
    Ok(edges)
}

fn constant_range(value: f64) -> (f64, f64) {
    debug_assert!(value.is_finite());
    let magnitude = value.abs();
    if magnitude < 1.0 {
        (value - 0.5, value + 0.5)
    } else if value.is_sign_positive() {
        (
            value * 0.5,
            if value <= f64::MAX / 1.5 {
                value * 1.5
            } else {
                f64::MAX
            },
        )
    } else {
        (
            if value >= -f64::MAX / 1.5 {
                value * 1.5
            } else {
                -f64::MAX
            },
            value * 0.5,
        )
    }
}

fn bin_for(value: f64, edges: &[f64]) -> usize {
    debug_assert!(value.is_finite());
    let bin_count = edges.len() - 1;
    if value >= edges[bin_count] {
        return bin_count - 1;
    }
    edges.partition_point(|edge| *edge <= value) - 1
}

#[cfg(test)]
mod tests {
    use std::{
        fs::File,
        io::{BufWriter, Write},
        sync::Arc,
        time::Instant,
    };

    use crate::{
        columns::Column,
        paging::{PageCache, PageHandle},
        store::{Signal, SignalId, SourceId},
    };

    use super::*;

    fn signal(id: u64, time: Vec<f64>, values: Vec<f64>, unit: Option<&str>) -> Signal {
        Signal::new(
            SignalId(id),
            SourceId(1),
            format!("value/{id}"),
            format!("source/value/{id}"),
            unit.map(str::to_owned),
            time,
            values,
        )
        .expect("valid signal")
    }

    fn window(t0: f64, t1: f64) -> TimeWindow {
        TimeWindow { t0, t1 }
    }

    fn fixture_f64(index: usize) -> f64 {
        f64::from(u32::try_from(index).expect("fixture index fits u32"))
    }

    #[test]
    fn edge_values_use_left_closed_bins_and_include_the_final_edge() {
        let values = signal(
            1,
            vec![0.0, 1.0, 2.0, 3.0],
            vec![0.0, 1.0, 2.0, 3.0],
            Some("V"),
        );
        let result = histogram(&[&values], window(0.0, 3.0), 3).expect("histogram");

        assert_eq!(result.edges, vec![0.0, 1.0, 2.0, 3.0]);
        assert_eq!(result.series[0].counts, vec![1, 1, 2]);
        assert_eq!(result.series[0].finite_count, 4);
        assert_eq!(result.series[0].excluded_count, 0);
    }

    #[test]
    fn window_is_inclusive_without_time_padding_and_counts_nonfinite_values() {
        let values = signal(
            7,
            vec![0.0, 0.0, 1.0, 2.0],
            vec![10.0, f64::NAN, 20.0, 30.0],
            None,
        );
        let result = histogram(&[&values], window(0.0, 0.0), 4).expect("histogram");

        assert_eq!(result.series[0].finite_count, 1);
        assert_eq!(result.series[0].excluded_count, 1);
        assert_eq!(result.series[0].counts.iter().sum::<u64>(), 1);
    }

    #[test]
    fn empty_and_nonfinite_windows_keep_a_stable_empty_domain() {
        let values = signal(1, vec![0.0, 1.0], vec![f64::NAN, f64::INFINITY], None);
        let outside = histogram(&[&values], window(5.0, 6.0), 2).expect("histogram");
        assert!(outside.edges.is_empty());
        assert!(outside.series[0].counts.is_empty());
        assert_eq!(outside.series[0].finite_count, 0);
        assert_eq!(outside.series[0].excluded_count, 0);

        let nonfinite = histogram(&[&values], window(0.0, 1.0), 2).expect("histogram");
        assert!(nonfinite.edges.is_empty());
        assert!(nonfinite.series[0].counts.is_empty());
        assert_eq!(nonfinite.series[0].finite_count, 0);
        assert_eq!(nonfinite.series[0].excluded_count, 2);
    }

    #[test]
    fn constants_and_extreme_ranges_have_finite_edges() {
        for value in [0.0, 0.75, -0.75, 4.0, -4.0, f64::MAX, -f64::MAX] {
            let values = signal(1, vec![0.0], vec![value], None);
            let result = histogram(&[&values], window(0.0, 0.0), 8).expect("histogram");
            assert!(result.edges.iter().all(|edge| edge.is_finite()));
            assert!(result.edges.windows(2).all(|pair| pair[0] < pair[1]));
            assert!(result.edges[0] <= value);
            assert!(value <= *result.edges.last().expect("edge"));
            assert_eq!(result.series[0].counts.iter().sum::<u64>(), 1);
        }

        let values = signal(1, vec![0.0, 1.0], vec![-f64::MAX, f64::MAX], None);
        let result = histogram(&[&values], window(0.0, 1.0), 8).expect("histogram");
        assert!(result.edges.iter().all(|edge| edge.is_finite()));
        assert_eq!(result.series[0].counts.iter().sum::<u64>(), 2);

        let lower: f64 = 1.0e308;
        let upper = f64::from_bits(lower.to_bits() + 1);
        let adjacent = signal(1, vec![0.0, 1.0], vec![lower, upper], None);
        let result = histogram(&[&adjacent], window(0.0, 1.0), 1).expect("histogram");
        assert_eq!(result.edges, vec![lower, upper]);
        assert_eq!(result.series[0].counts, vec![2]);
    }

    #[test]
    fn overlaid_series_share_edges_and_reject_unlike_units() {
        let left = signal(1, vec![0.0, 1.0], vec![0.0, 2.0], Some("V"));
        let right = signal(2, vec![0.0, 1.0], vec![1.0, 3.0], Some("V"));
        let result = histogram(&[&left, &right], window(0.0, 1.0), 3).expect("histogram");
        assert_eq!(result.series.len(), 2);
        assert_eq!(result.series[0].unit.as_deref(), Some("V"));
        assert_eq!(result.series[0].counts.iter().sum::<u64>(), 2);
        assert_eq!(result.series[1].counts.iter().sum::<u64>(), 2);

        let unlike = signal(3, vec![0.0, 1.0], vec![1.0, 3.0], Some("A"));
        assert_eq!(
            histogram(&[&left, &unlike], window(0.0, 1.0), 3),
            Err(HistogramError::IncompatibleUnits {
                signal: SignalId(3)
            })
        );
    }

    #[test]
    fn validates_window_and_bin_count() {
        let values = signal(1, vec![0.0], vec![1.0], None);
        assert_eq!(
            histogram(&[&values], window(1.0, 0.0), 1),
            Err(HistogramError::InvalidWindow)
        );
        assert_eq!(
            histogram(&[&values], window(0.0, 1.0), 0),
            Err(HistogramError::InvalidBinCount { requested: 0 })
        );
        assert_eq!(
            histogram(&[&values], window(0.0, 1.0), MAX_BIN_COUNT + 1),
            Err(HistogramError::InvalidBinCount {
                requested: MAX_BIN_COUNT + 1,
            })
        );
    }

    #[test]
    fn paged_columns_match_resident_columns() {
        let count = 10_000;
        let time: Vec<f64> = (0..count).map(|index| fixture_f64(index) * 0.25).collect();
        let values: Vec<f64> = (0..count)
            .map(|index| fixture_f64(index % 17) - 8.0)
            .collect();
        let resident = signal(1, time.clone(), values.clone(), Some("V"));

        let directory = tempfile::tempdir().expect("temporary directory");
        let write_column = |name: &str, values: &[f64]| {
            let path = directory.path().join(name);
            let mut file = File::create(&path).expect("column file");
            for value in values {
                file.write_all(&value.to_le_bytes()).expect("column value");
            }
            path
        };
        let time_path = write_column("time", &time);
        let values_path = write_column("values", &values);
        let cache = PageCache::new(directory.path(), 256 * 1024);
        let paged = Signal::new(
            SignalId(1),
            SourceId(1),
            "value/1",
            "source/value/1",
            Some("V".to_owned()),
            Column::paged(PageHandle::cached(
                cache.clone(),
                time_path,
                0,
                count * size_of::<f64>(),
            )),
            Column::paged(PageHandle::cached(
                cache,
                values_path,
                0,
                count * size_of::<f64>(),
            )),
        )
        .expect("paged signal");

        let resident_result =
            histogram(&[&resident], window(250.0, 2_249.75), 32).expect("resident histogram");
        let paged_result =
            histogram(&[&paged], window(250.0, 2_249.75), 32).expect("paged histogram");
        assert_eq!(paged_result, resident_result);
    }

    #[test]
    fn empty_signal_list_is_a_valid_empty_response() {
        assert_eq!(
            histogram(&[], window(0.0, 1.0), DEFAULT_BIN_COUNT),
            Ok(HistogramResult {
                edges: Vec::new(),
                series: Vec::new(),
            })
        );
    }

    #[test]
    fn owned_signal_constructor_accepts_shared_columns() {
        let signal = Signal::new(
            SignalId(1),
            SourceId(1),
            "value",
            "source/value",
            None,
            Column::owned(Arc::from(vec![0.0, 1.0])),
            Column::owned(Arc::from(vec![2.0, 3.0])),
        )
        .expect("signal");
        let result = histogram(&[&signal], window(0.0, 1.0), 1).expect("histogram");
        assert_eq!(result.series[0].counts, vec![2]);
    }

    #[test]
    #[ignore = "release benchmark"]
    fn bench_histogram_resident_and_paged_scan_scaling() {
        const CACHE_BYTES: usize = 2 * 1024 * 1024;
        for count in [1_000_000_usize, 10_000_000] {
            let time: Vec<f64> = (0..count).map(fixture_f64).collect();
            let values: Vec<f64> = (0..count)
                .map(|index| fixture_f64(index % 257) - 128.0)
                .collect();

            let directory = tempfile::tempdir().expect("temporary directory");
            let write_column = |name: &str, column: &[f64]| {
                let path = directory.path().join(name);
                let mut file = BufWriter::new(File::create(&path).expect("column file"));
                for value in column {
                    file.write_all(&value.to_le_bytes()).expect("column value");
                }
                file.flush().expect("column flush");
                path
            };
            let time_path = write_column("time", &time);
            let values_path = write_column("values", &values);
            let cache = PageCache::new(directory.path(), CACHE_BYTES);
            let paged = Signal::new(
                SignalId(1),
                SourceId(1),
                "value/1",
                "source/value/1",
                Some("V".to_owned()),
                Column::paged(PageHandle::cached(
                    cache.clone(),
                    time_path,
                    0,
                    count * size_of::<f64>(),
                )),
                Column::paged(PageHandle::cached(
                    cache,
                    values_path,
                    0,
                    count * size_of::<f64>(),
                )),
            )
            .expect("paged signal");

            let resident = signal(1, time, values, Some("V"));
            let resident_started = Instant::now();
            let resident_result = histogram(&[&resident], window(0.0, fixture_f64(count - 1)), 64)
                .expect("resident histogram");
            let resident_elapsed = resident_started.elapsed();

            let paged_started = Instant::now();
            let paged_result = histogram(&[&paged], window(0.0, fixture_f64(count - 1)), 64)
                .expect("paged histogram");
            let paged_elapsed = paged_started.elapsed();

            assert_eq!(paged_result, resident_result);
            println!(
                "bench_histogram rows={count} resident_ms={:.1} paged_ms={:.1} scan_chunk_values={READ_CHUNK} scan_chunk_bytes={} page_cache_capacity_bytes={CACHE_BYTES}",
                resident_elapsed.as_secs_f64() * 1_000.0,
                paged_elapsed.as_secs_f64() * 1_000.0,
                READ_CHUNK * size_of::<f64>(),
            );
        }
    }
}

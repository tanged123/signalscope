//! Correspondence-preserving reduction for ordered Cartesian 2D lines.
//!
//! A query returns rows, rather than independently reduced columns. Every
//! value in a row is copied from one source index, so multiple Y traces stay
//! aligned with X and with one another. The pyramid is an in-memory,
//! on-demand presentation cache; it is not a persisted protocol tile.

use std::{ops::Range, sync::Arc};

use thiserror::Error;

use crate::store::Signal;

const MISSING_INDEX: u64 = u64::MAX;
const POINTS_PER_PIXEL: usize = 2;

/// One source row emitted by a line query.
#[derive(Clone, Debug, PartialEq)]
pub struct LinePoint {
    /// Index in the original, shared sample table.
    pub source_index: usize,
    pub anchor: f64,
    pub x: f64,
    /// Y values in the same order as the Y columns passed to the pyramid.
    pub ys: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LineQuery {
    /// Zero means un-reduced source rows. Positive values identify a pyramid
    /// level used to choose the shared source-index set.
    pub level: u32,
    pub points: Vec<LinePoint>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum Line2dError {
    #[error("line plot requires at least one y signal")]
    EmptyYSignals,
    #[error("x and y signals do not share an exact timebase")]
    TimebaseMismatch,
    #[error("line plot column could not be read")]
    ColumnRead,
}

#[derive(Clone, Debug)]
struct LineBin {
    start: u64,
    end: u64,
    min_x: u64,
    max_x: u64,
    min_y: Vec<u64>,
    max_y: Vec<u64>,
}

/// A correspondence-preserving presentation pyramid for one X and one or
/// more Y columns. `from_signals` validates timestamps bit-for-bit; callers
/// using raw slices are responsible for supplying the common anchor.
#[derive(Clone, Debug)]
pub struct LinePyramid {
    anchor: Arc<[f64]>,
    x: Arc<[f64]>,
    ys: Vec<Arc<[f64]>>,
    levels: Vec<Vec<LineBin>>,
    gap_starts: Arc<[u64]>,
}

impl LinePyramid {
    /// Builds a pyramid from one shared anchor, one X column, and Y columns.
    ///
    /// X and every Y column must have the anchor's length. Non-finite X/Y
    /// values remain attached to their source rows and are emitted as gap
    /// breaks; they are excluded from finite extrema.
    ///
    /// # Panics
    ///
    /// Panics when there is no Y column, column lengths differ, or the anchor
    /// is non-finite or decreasing. Store-backed callers should use
    /// [`Self::from_signals`] for structured binding errors.
    #[must_use]
    pub fn from_samples(anchor: &[f64], x: &[f64], ys: &[&[f64]]) -> Self {
        assert!(!ys.is_empty(), "line plot requires at least one y column");
        assert_eq!(anchor.len(), x.len(), "anchor/x lengths differ");
        assert!(anchor.iter().all(|value| value.is_finite()));
        assert!(anchor.windows(2).all(|pair| pair[0] <= pair[1]));
        for y in ys {
            assert_eq!(anchor.len(), y.len(), "anchor/y lengths differ");
        }

        Self::from_shared_samples(
            anchor.to_vec().into(),
            x.to_vec().into(),
            ys.iter().map(|values| values.to_vec().into()).collect(),
        )
    }

    fn from_shared_samples(anchor: Arc<[f64]>, x: Arc<[f64]>, ys: Vec<Arc<[f64]>>) -> Self {
        let mut levels: Vec<Vec<LineBin>> = Vec::new();
        if anchor.len() > 1 {
            levels.push(
                (0..anchor.len())
                    .step_by(2)
                    .map(|left_index| {
                        let left = sample_bin(left_index, &x, &ys);
                        match left_index
                            .checked_add(1)
                            .filter(|right_index| *right_index < anchor.len())
                        {
                            Some(right_index) => {
                                let right = sample_bin(right_index, &x, &ys);
                                merge_bins(&left, &right, &x, &ys)
                            }
                            None => left,
                        }
                    })
                    .collect(),
            );
        }
        while levels.last().is_some_and(|level| level.len() > 1) {
            let merged = levels
                .last()
                .expect("non-empty levels")
                .chunks(2)
                .map(|pair| {
                    pair.get(1).map_or_else(
                        || pair[0].clone(),
                        |right| merge_bins(&pair[0], right, &x, &ys),
                    )
                })
                .collect::<Vec<_>>();
            levels.push(merged);
        }

        let mut gap_starts = Vec::new();
        append_gap_starts(&x, &mut gap_starts);
        for y in &ys {
            append_gap_starts(y, &mut gap_starts);
        }
        gap_starts.sort_unstable();
        gap_starts.dedup();

        Self {
            anchor,
            x,
            ys,
            levels,
            gap_starts: gap_starts.into(),
        }
    }

    /// Convenience constructor for the common one-Y case.
    #[must_use]
    pub fn from_single_samples(anchor: &[f64], x: &[f64], y: &[f64]) -> Self {
        Self::from_samples(anchor, x, &[y])
    }

    /// Builds a pyramid after checking every signal against X's exact
    /// timestamp sequence. Signal timebase identifiers are only a fast hint;
    /// the bitwise comparison below is the authoritative check.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty Y set, a mismatched timebase, or an
    /// unreadable page-backed column.
    pub fn from_signals(x: &Signal, ys: &[&Signal]) -> Result<Self, Line2dError> {
        if ys.is_empty() {
            return Err(Line2dError::EmptyYSignals);
        }
        for y in ys {
            if !same_timebase(x, y)? {
                return Err(Line2dError::TimebaseMismatch);
            }
        }
        Ok(Self::from_shared_samples(
            x.time_shared(),
            x.values_shared(),
            ys.iter().map(|y| y.values_shared()).collect(),
        ))
    }

    /// Builds a paired pyramid from only the source-time rows needed by one
    /// viewport. Exact timebase validation remains global, but page-backed
    /// columns are compared in bounded chunks and only the selected range is
    /// materialized for reduction.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty Y set, a mismatched timebase, or an
    /// unreadable page-backed column.
    pub fn from_signals_window(
        x: &Signal,
        ys: &[&Signal],
        t0: f64,
        t1: f64,
    ) -> Result<Self, Line2dError> {
        if ys.is_empty() {
            return Err(Line2dError::EmptyYSignals);
        }
        for y in ys {
            if !same_timebase(x, y)? {
                return Err(Line2dError::TimebaseMismatch);
            }
        }
        let Some(range) = signal_window_range(x, t0, t1)? else {
            return Ok(Self::from_shared_samples(
                Arc::from([]),
                Arc::from([]),
                ys.iter().map(|_| Arc::from([])).collect(),
            ));
        };
        let anchor = shared_range(x.time_column(), range.clone())?;
        let x_values = shared_range(x.values_column(), range.clone())?;
        let y_values = ys
            .iter()
            .map(|y| shared_range(y.values_column(), range.clone()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self::from_shared_samples(anchor, x_values, y_values))
    }

    /// Convenience constructor for one Y signal.
    ///
    /// # Errors
    ///
    /// Returns an error for a mismatched timebase or unreadable page-backed
    /// column.
    pub fn from_signal(x: &Signal, y: &Signal) -> Result<Self, Line2dError> {
        Self::from_signals(x, &[y])
    }

    /// Uses a signal's time column as X's implicit linked time coordinate.
    #[must_use]
    pub fn from_time_signal(y: &Signal) -> Self {
        let time = y.time();
        let values = y.values();
        Self::from_samples(&time, &time, &[&values])
    }

    /// Number of logical levels, including level zero's source rows.
    #[must_use]
    pub fn level_count(&self) -> usize {
        self.levels.len() + 1
    }

    /// Returns correspondence-preserving rows from one logical level.
    ///
    /// Level zero contains source rows. Higher levels contain the source rows
    /// needed for each paired X/Y extremum, endpoints, and gap starts in the
    /// selected bins. The returned columns therefore remain aligned even
    /// when a trace has a different extremum or gap pattern from its peers.
    #[must_use]
    pub fn level_window(&self, level: usize, t0: f64, t1: f64) -> Option<LineQuery> {
        if level >= self.level_count() {
            return None;
        }
        let Some((start, end)) = window_bounds(&self.anchor, t0, t1) else {
            return Some(LineQuery {
                level: u32::try_from(level).unwrap_or(u32::MAX),
                points: Vec::new(),
            });
        };
        let source_indices = self.level_indices(level, start, end, t0, t1)?;
        Some(LineQuery {
            level: u32::try_from(level).unwrap_or(u32::MAX),
            points: self.make_points(source_indices),
        })
    }

    /// Counts rows that [`Self::level_window`] would emit.
    #[must_use]
    pub fn level_window_count(&self, level: usize, t0: f64, t1: f64) -> Option<usize> {
        if level >= self.level_count() {
            return None;
        }
        let Some((start, end)) = window_bounds(&self.anchor, t0, t1) else {
            return Some(0);
        };
        self.level_indices(level, start, end, t0, t1)
            .map(|indices| indices.len())
    }

    /// Selects at most a pixel-scaled number of source rows, plus rows needed
    /// to preserve extrema and gap starts. Gap-heavy input may exceed this
    /// soft bound because dropping a gap start would reconnect a stroke.
    #[must_use]
    pub fn query(&self, t0: f64, t1: f64, pixel_width: u32) -> LineQuery {
        let Some((start, end)) = window_bounds(&self.anchor, t0, t1) else {
            return LineQuery {
                level: 0,
                points: Vec::new(),
            };
        };
        let target = (pixel_width as usize)
            .saturating_mul(POINTS_PER_PIXEL)
            .max(1);
        let span = end - start;
        if span <= target || self.levels.is_empty() {
            return self.make_query(
                0,
                self.level_indices(0, start, end, t0, t1)
                    .unwrap_or_default(),
            );
        }

        let ratio = span.div_ceil(target).next_power_of_two();
        let logical_level = ratio.trailing_zeros().max(1) as usize;
        let level_index = logical_level.saturating_sub(1).min(self.levels.len() - 1);
        let logical_level = level_index + 1;
        self.make_query(
            u32::try_from(logical_level).unwrap_or(u32::MAX),
            self.level_indices(logical_level, start, end, t0, t1)
                .unwrap_or_default(),
        )
    }

    fn level_indices(
        &self,
        level: usize,
        start: usize,
        end: usize,
        t0: f64,
        t1: f64,
    ) -> Option<Vec<usize>> {
        if level == 0 {
            return Some((start..end).collect());
        }
        let bins = self.levels.get(level - 1)?;
        let first = bins.partition_point(|bin| self.anchor[index(bin.end)] < t0);
        let last = bins.partition_point(|bin| self.anchor[index(bin.start)] <= t1);
        let mut source_indices =
            Vec::with_capacity((last - first).saturating_mul(4 + self.ys.len() * 2));
        for bin in &bins[first..last] {
            push_index(&mut source_indices, bin.start, start, end);
            push_index(&mut source_indices, bin.end, start, end);
            push_index(&mut source_indices, bin.min_x, start, end);
            push_index(&mut source_indices, bin.max_x, start, end);
            for (&min_y, &max_y) in bin.min_y.iter().zip(&bin.max_y) {
                push_index(&mut source_indices, min_y, start, end);
                push_index(&mut source_indices, max_y, start, end);
            }
        }
        self.push_gap_indices(&mut source_indices, start, end);
        source_indices.push(start);
        source_indices.push(end - 1);
        source_indices.sort_unstable();
        source_indices.dedup();
        Some(source_indices)
    }

    fn make_query(&self, level: u32, source_indices: Vec<usize>) -> LineQuery {
        LineQuery {
            level,
            points: self.make_points(source_indices),
        }
    }

    fn make_points(&self, source_indices: Vec<usize>) -> Vec<LinePoint> {
        source_indices
            .into_iter()
            .map(|source_index| LinePoint {
                source_index,
                anchor: self.anchor[source_index],
                x: self.x[source_index],
                ys: self.ys.iter().map(|values| values[source_index]).collect(),
            })
            .collect()
    }

    fn push_gap_indices(&self, source_indices: &mut Vec<usize>, start: usize, end: usize) {
        let first_gap = self.gap_starts.partition_point(|gap| index(*gap) < start);
        let last_gap = self.gap_starts.partition_point(|gap| index(*gap) < end);
        source_indices.extend(
            self.gap_starts[first_gap..last_gap]
                .iter()
                .map(|gap| index(*gap)),
        );
    }
}

fn same_timebase(x: &Signal, y: &Signal) -> Result<bool, Line2dError> {
    if x.len() != y.len() {
        return Ok(false);
    }
    if x.timebase_id().0 != 0 && x.timebase_id() == y.timebase_id() {
        return Ok(true);
    }
    for start in (0..x.len()).step_by(8192) {
        let end = start.saturating_add(8192).min(x.len());
        let left = x
            .time_column()
            .range(start..end)
            .map_err(|_| Line2dError::ColumnRead)?;
        let right = y
            .time_column()
            .range(start..end)
            .map_err(|_| Line2dError::ColumnRead)?;
        if left
            .iter()
            .zip(right.iter())
            .any(|(left, right)| left.to_bits() != right.to_bits())
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn signal_window_range(
    signal: &Signal,
    t0: f64,
    t1: f64,
) -> Result<Option<Range<usize>>, Line2dError> {
    let time = signal.time_column();
    if time.is_empty() {
        return Ok(None);
    }
    let first = time.value(0).map_err(|_| Line2dError::ColumnRead)?;
    let last = time
        .value(time.len() - 1)
        .map_err(|_| Line2dError::ColumnRead)?;
    if t1 < first || t0 > last {
        return Ok(None);
    }
    let start = time
        .partition_point(|value| value < t0)
        .map_err(|_| Line2dError::ColumnRead)?
        .saturating_sub(1);
    let end = (time
        .partition_point(|value| value <= t1)
        .map_err(|_| Line2dError::ColumnRead)?
        + 1)
    .min(time.len());
    Ok((start < end).then_some(start..end))
}

fn shared_range(
    column: &crate::columns::Column,
    range: Range<usize>,
) -> Result<Arc<[f64]>, Line2dError> {
    column
        .range(range)
        .map(|values| values.shared())
        .map_err(|_| Line2dError::ColumnRead)
}

fn sample_bin(index: usize, x: &[f64], ys: &[Arc<[f64]>]) -> LineBin {
    let source_index = u64::try_from(index).expect("sample index fits in u64");
    LineBin {
        start: source_index,
        end: source_index,
        min_x: finite_index(x[index], source_index),
        max_x: finite_index(x[index], source_index),
        min_y: ys
            .iter()
            .map(|y| finite_index(y[index], source_index))
            .collect(),
        max_y: ys
            .iter()
            .map(|y| finite_index(y[index], source_index))
            .collect(),
    }
}

fn merge_bins(left: &LineBin, right: &LineBin, x: &[f64], ys: &[Arc<[f64]>]) -> LineBin {
    LineBin {
        start: left.start,
        end: right.end,
        min_x: extremum(left.min_x, right.min_x, x, |a, b| a < b),
        max_x: extremum(left.max_x, right.max_x, x, |a, b| a > b),
        min_y: left
            .min_y
            .iter()
            .zip(&right.min_y)
            .zip(ys)
            .map(|((&left, &right), values)| extremum(left, right, values, |a, b| a < b))
            .collect(),
        max_y: left
            .max_y
            .iter()
            .zip(&right.max_y)
            .zip(ys)
            .map(|((&left, &right), values)| extremum(left, right, values, |a, b| a > b))
            .collect(),
    }
}

fn finite_index(value: f64, source_index: u64) -> u64 {
    if value.is_finite() {
        source_index
    } else {
        MISSING_INDEX
    }
}

fn extremum(
    left: u64,
    right: u64,
    values: &[f64],
    choose_right: impl FnOnce(f64, f64) -> bool,
) -> u64 {
    if left == MISSING_INDEX {
        return right;
    }
    if right == MISSING_INDEX {
        return left;
    }
    if choose_right(values[index(right)], values[index(left)]) {
        right
    } else {
        left
    }
}

fn append_gap_starts(values: &[f64], gap_starts: &mut Vec<u64>) {
    let mut previous_valid = true;
    for (index, value) in values.iter().copied().enumerate() {
        let valid = value.is_finite();
        if !valid && previous_valid {
            gap_starts.push(u64::try_from(index).expect("sample index fits in u64"));
        }
        previous_valid = valid;
    }
}

fn push_index(indices: &mut Vec<usize>, value: u64, start: usize, end: usize) {
    if value != MISSING_INDEX {
        let value = index(value);
        if (start..end).contains(&value) {
            indices.push(value);
        }
    }
}

fn index(value: u64) -> usize {
    usize::try_from(value).expect("sample index fits in usize")
}

fn window_bounds(anchor: &[f64], t0: f64, t1: f64) -> Option<(usize, usize)> {
    if anchor.is_empty() || t1 < anchor[0] || t0 > anchor[anchor.len() - 1] {
        return None;
    }
    let start = anchor
        .partition_point(|value| *value < t0)
        .saturating_sub(1);
    let end = (anchor.partition_point(|value| *value <= t1) + 1).min(anchor.len());
    (start < end).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{SignalId, SourceId};

    #[test]
    fn level_zero_returns_exact_shared_rows_and_gaps() {
        let line = LinePyramid::from_samples(
            &[0.0, 1.0, 2.0, 3.0],
            &[10.0, 11.0, f64::NAN, 13.0],
            &[&[20.0, 21.0, 22.0, 23.0], &[30.0, 31.0, 32.0, 33.0]],
        );
        let query = line.query(0.0, 3.0, 8);
        assert_eq!(query.level, 0);
        assert_eq!(query.points.len(), 4);
        assert_eq!(query.points[2].source_index, 2);
        assert!(query.points[2].x.is_nan());
        assert_eq!(query.points[2].ys, [22.0, 32.0]);
        assert_eq!(query.points[3].ys, [23.0, 33.0]);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn reduction_preserves_paired_extrema_in_one_source_order() {
        let anchor = (0..32).map(f64::from).collect::<Vec<_>>();
        let x = [
            0.0, 1.0, -9.0, 3.0, 4.0, 12.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 10.0, 9.0, 8.0, 7.0,
            6.0, 5.0, 4.0, 3.0, 2.0, 1.0, 0.0, -1.0, -2.0, -3.0, -4.0, -5.0, -6.0, -7.0, -8.0,
            -9.0,
        ];
        let y0 = [
            0.0, 1.0, 2.0, 20.0, 4.0, 5.0, -8.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0,
            16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0,
            30.0, 31.0,
        ];
        let y1 = (0..32).map(|value| -f64::from(value)).collect::<Vec<_>>();
        let pyramid = LinePyramid::from_samples(&anchor, &x, &[&y0, &y1]);
        let query = pyramid.query(0.0, 31.0, 1);
        assert!(query.level > 0);
        assert!(
            query
                .points
                .windows(2)
                .all(|pair| pair[0].source_index < pair[1].source_index)
        );
        let at = |source_index| {
            query
                .points
                .iter()
                .find(|point| point.source_index == source_index)
        };
        assert_eq!(at(2).map(|point| (point.x, point.ys[0])), Some((-9.0, 2.0)));
        assert_eq!(at(5).map(|point| (point.x, point.ys[0])), Some((12.0, 5.0)));
        assert_eq!(at(3).map(|point| (point.x, point.ys[0])), Some((3.0, 20.0)));
        assert_eq!(at(6).map(|point| (point.x, point.ys[0])), Some((6.0, -8.0)));
        assert!(query.points.iter().all(|point| point.ys.len() == 2));
        assert!(
            query
                .points
                .iter()
                .all(|point| point.x == x[point.source_index])
        );
        assert!(
            query
                .points
                .iter()
                .all(|point| point.ys[0] == y0[point.source_index])
        );
        assert!(
            query
                .points
                .iter()
                .all(|point| point.ys[1] == y1[point.source_index])
        );
    }

    #[test]
    fn reduction_preserves_each_trace_gap_start() {
        let anchor = (0..32).map(f64::from).collect::<Vec<_>>();
        let mut y0 = (0..32).map(f64::from).collect::<Vec<_>>();
        let mut y1 = y0.clone();
        y0[3] = f64::NAN;
        y0[4] = f64::NAN;
        y1[6] = f64::NAN;
        let query = LinePyramid::from_samples(&anchor, &anchor, &[&y0, &y1]).query(0.0, 31.0, 1);
        assert!(
            query
                .points
                .iter()
                .any(|point| point.source_index == 3 && point.ys[0].is_nan())
        );
        assert!(
            query
                .points
                .iter()
                .any(|point| point.source_index == 6 && point.ys[1].is_nan())
        );
    }

    #[test]
    fn reduction_keeps_window_endpoints_and_has_a_pixel_bound_without_gaps() {
        let anchor = (0..1024).map(f64::from).collect::<Vec<_>>();
        let line = LinePyramid::from_samples(&anchor, &anchor, &[&anchor, &anchor]);
        let query = line.query(100.0, 900.0, 4);
        assert_eq!(
            query.points.first().map(|point| point.source_index),
            Some(99)
        );
        assert_eq!(
            query.points.last().map(|point| point.source_index),
            Some(901)
        );
        assert!(query.points.len() <= 2 * (4 + 2) * 2);
    }

    #[test]
    fn signal_constructor_requires_exact_bitwise_timebase() {
        let signal = |id, time: Vec<f64>| {
            Signal::new(
                SignalId(id),
                SourceId(1),
                format!("value{id}"),
                format!("source/value{id}"),
                None,
                time,
                vec![1.0, 2.0],
            )
            .unwrap()
        };
        let x = signal(1, vec![0.0, 1.0]);
        let y = signal(2, vec![0.0, -0.0]);
        assert!(matches!(
            LinePyramid::from_signal(&x, &y),
            Err(Line2dError::TimebaseMismatch)
        ));
        let y = signal(3, vec![0.0, 1.0]);
        assert!(LinePyramid::from_signal(&x, &y).is_ok());
    }

    #[test]
    fn signal_window_constructor_reads_only_the_viewport_rows() {
        let time = (0..100).map(f64::from).collect::<Vec<_>>();
        let paged = |values: Vec<f64>| {
            crate::columns::Column::paged(crate::columns::PageHandle::memory(Arc::from(values)))
        };
        let x = Signal::new(
            SignalId(1),
            SourceId(1),
            "x",
            "source/x",
            None,
            paged(time.clone()),
            paged(time.iter().map(|value| value * 2.0).collect()),
        )
        .unwrap();
        let y = Signal::new(
            SignalId(2),
            SourceId(1),
            "y",
            "source/y",
            None,
            paged(time.clone()),
            paged(time.iter().map(|value| -value).collect()),
        )
        .unwrap();

        let line = LinePyramid::from_signals_window(&x, &[&y], 40.0, 50.0).unwrap();
        let query = line.query(40.0, 50.0, 100);

        assert_eq!(query.points.len(), 13);
        assert_eq!(query.points.first().map(|point| point.anchor), Some(39.0));
        assert_eq!(query.points.last().map(|point| point.anchor), Some(51.0));
    }
}

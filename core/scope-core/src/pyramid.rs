//! Multi-resolution min/max envelopes for bounded-cost viewport queries.

use std::sync::Arc;

use crate::{
    bins::BinLevel,
    columns::{Column, WeakColumn},
    paging::PageHandle,
    store::Signal,
};
use scope_protocol::EnvelopeBin;

pub const FINEST_STORED_LEVEL: usize = 3;

fn sample_bin(time: f64, value: f64) -> EnvelopeBin {
    let finite = value.is_finite().then_some(value);
    EnvelopeBin {
        t0: time,
        t1: time,
        first: finite,
        last: finite,
        min: finite,
        max: finite,
        sum: finite.unwrap_or(0.0),
        sum_sq: finite.map_or(0.0, |value| value * value),
        finite_count: u64::from(value.is_finite()),
        sample_count: 1,
        has_gap: !value.is_finite(),
    }
}

fn merge_bins(left: &EnvelopeBin, right: &EnvelopeBin) -> EnvelopeBin {
    EnvelopeBin {
        t0: left.t0,
        t1: right.t1,
        first: left.first.or(right.first),
        last: right.last.or(left.last),
        min: min_option(left.min, right.min),
        max: max_option(left.max, right.max),
        sum: left.sum + right.sum,
        sum_sq: left.sum_sq + right.sum_sq,
        finite_count: left.finite_count + right.finite_count,
        sample_count: left.sample_count + right.sample_count,
        has_gap: left.has_gap || right.has_gap,
    }
}

#[derive(Clone, Debug)]
pub struct Pyramid {
    columns: PyramidColumns,
    sample_count: usize,
    first_stored_level: usize,
    merged: Vec<CachedBinLevel>,
}

#[derive(Clone, Debug)]
pub(crate) enum CachedBinLevel {
    Resident(BinLevel),
    Paged(PagedBinLevel),
}

#[derive(Clone, Debug)]
pub(crate) struct PagedBinLevel {
    handle: PageHandle,
    len: usize,
}

impl PagedBinLevel {
    pub(crate) fn new(handle: PageHandle, len: usize) -> Option<Self> {
        (BinLevel::cache_len(len)? == handle.byte_len()).then_some(Self { handle, len })
    }

    fn value(&self, field: usize, index: usize) -> Option<f64> {
        if field >= 8 || index >= self.len {
            return None;
        }
        let base = 8_usize.checked_add(field.checked_mul(self.len)?.checked_mul(8)?)?;
        let offset = base.checked_add(index.checked_mul(8)?)?;
        let bytes = self
            .handle
            .bytes_range(offset..offset.checked_add(8)?)
            .ok()?;
        Some(f64::from_le_bytes(bytes.as_ref().try_into().ok()?))
    }

    fn partition_point(
        &self,
        field: usize,
        mut predicate: impl FnMut(f64) -> bool,
    ) -> Option<usize> {
        let mut left = 0;
        let mut right = self.len;
        while left < right {
            let middle = left + (right - left) / 2;
            if predicate(self.value(field, middle)?) {
                left = middle + 1;
            } else {
                right = middle;
            }
        }
        Some(left)
    }

    fn range(&self, range: std::ops::Range<usize>) -> Option<BinLevel> {
        BinLevel::decode_cache_range(&self.handle, self.len, range)
    }
}

impl CachedBinLevel {
    pub(crate) fn materialize(&self) -> Option<BinLevel> {
        match self {
            Self::Resident(level) => Some(level.clone()),
            Self::Paged(level) => level.range(0..level.len),
        }
    }

    pub(crate) fn len(&self) -> usize {
        match self {
            Self::Resident(level) => level.len(),
            Self::Paged(level) => level.len,
        }
    }

    fn range(&self, range: std::ops::Range<usize>) -> Option<BinLevel> {
        match self {
            Self::Resident(level) => Some(level.slice(range)),
            Self::Paged(level) => level.range(range),
        }
    }

    fn window_range(&self, t0: f64, t1: f64) -> Option<std::ops::Range<usize>> {
        let len = self.len();
        match self {
            Self::Resident(level) => {
                if level.t0s().first().is_none_or(|first| t1 < *first)
                    || level.t1s().last().is_none_or(|last| t0 > *last)
                {
                    return Some(0..0);
                }
                let start = level
                    .t1s()
                    .partition_point(|time| *time < t0)
                    .saturating_sub(1);
                let end = level
                    .t0s()
                    .partition_point(|time| *time <= t1)
                    .saturating_add(1)
                    .min(len);
                Some(start..end)
            }
            Self::Paged(level) => {
                if level.value(0, 0).is_none_or(|first| t1 < first)
                    || level
                        .value(1, len.saturating_sub(1))
                        .is_none_or(|last| t0 > last)
                {
                    return Some(0..0);
                }
                let start = level
                    .partition_point(1, |time| time < t0)?
                    .saturating_sub(1);
                let end = level
                    .partition_point(0, |time| time <= t1)?
                    .saturating_add(1)
                    .min(len);
                Some(start..end)
            }
        }
    }
}

#[derive(Clone, Debug)]
enum PyramidColumns {
    Retained {
        time: Column,
        values: Column,
    },
    Weak {
        time: WeakColumn,
        values: WeakColumn,
    },
}

impl Pyramid {
    #[must_use]
    pub fn from_signal(signal: &Signal) -> Self {
        let time = signal.time();
        let values = signal.values();
        Self::build(
            &time,
            &values,
            FINEST_STORED_LEVEL,
            PyramidColumns::Weak {
                time: signal.time_column().downgrade(),
                values: signal.values_column().downgrade(),
            },
        )
    }

    #[must_use]
    /// Builds an envelope pyramid from equal-length time and value columns.
    ///
    /// # Panics
    ///
    /// Panics when `time` and `values` have different lengths.
    pub fn from_samples(time: &[f64], values: &[f64]) -> Self {
        let time = Arc::from(time.to_vec());
        let values = Arc::from(values.to_vec());
        Self::from_columns(&time, &values)
    }

    fn from_columns(time: &Arc<[f64]>, values: &Arc<[f64]>) -> Self {
        Self::from_columns_with_cutoff(time, values, FINEST_STORED_LEVEL)
    }

    fn from_columns_with_cutoff(
        time: &Arc<[f64]>,
        values: &Arc<[f64]>,
        first_stored_level: usize,
    ) -> Self {
        let columns = PyramidColumns::Retained {
            time: Column::owned(Arc::clone(time)),
            values: Column::owned(Arc::clone(values)),
        };
        Self::build(time, values, first_stored_level, columns)
    }

    fn build(
        time: &[f64],
        values: &[f64],
        first_stored_level: usize,
        columns: PyramidColumns,
    ) -> Self {
        assert_eq!(time.len(), values.len(), "time/value lengths differ");
        let level_one: Vec<EnvelopeBin> = time
            .chunks(2)
            .zip(values.chunks(2))
            .map(|(chunk_time, chunk_values)| {
                let first = sample_bin(chunk_time[0], chunk_values[0]);
                if chunk_time.len() == 2 {
                    merge_bins(&first, &sample_bin(chunk_time[1], chunk_values[1]))
                } else {
                    first
                }
            })
            .collect();
        let mut merged = Vec::new();
        let mut logical_level = 1;
        let mut previous = BinLevel::from_wire(&level_one);
        while !previous.is_empty() {
            if logical_level >= first_stored_level {
                merged.push(CachedBinLevel::Resident(previous.clone()));
            }
            if previous.len() == 1 {
                break;
            }
            previous = merge_level(&previous);
            logical_level += 1;
        }
        Self {
            columns,
            sample_count: time.len(),
            first_stored_level,
            merged,
        }
    }

    #[cfg(test)]
    fn from_samples_storing_every_level(time: &[f64], values: &[f64]) -> Self {
        let time = Arc::from(time.to_vec());
        let values = Arc::from(values.to_vec());
        Self::from_columns_with_cutoff(&time, &values, 1)
    }

    /// Reassembles a pyramid from previously built parts (the sidecar cache).
    ///
    /// # Panics
    ///
    /// Panics when the columns differ in length or the first merged level
    /// does not pair the raw samples. Callers deserializing untrusted bytes
    /// must validate shapes first and treat mismatches as cache misses.
    #[must_use]
    pub fn from_parts(time: Arc<[f64]>, values: Arc<[f64]>, merged: Vec<BinLevel>) -> Self {
        assert_eq!(time.len(), values.len(), "time/value lengths differ");
        let sample_count = time.len();
        validate_merged(sample_count, &merged);
        Self {
            columns: PyramidColumns::Retained {
                time: Column::owned(time),
                values: Column::owned(values),
            },
            sample_count,
            first_stored_level: FINEST_STORED_LEVEL,
            merged: merged.into_iter().map(CachedBinLevel::Resident).collect(),
        }
    }

    pub(crate) fn from_signal_cached_parts(signal: &Signal, merged: Vec<CachedBinLevel>) -> Self {
        Self {
            columns: PyramidColumns::Weak {
                time: signal.time_column().downgrade(),
                values: signal.values_column().downgrade(),
            },
            sample_count: signal.len(),
            first_stored_level: FINEST_STORED_LEVEL,
            merged,
        }
    }

    /// Stored merged levels; index zero is [`FINEST_STORED_LEVEL`].
    #[must_use]
    pub fn merged_levels(&self) -> Vec<BinLevel> {
        self.merged
            .iter()
            .filter_map(CachedBinLevel::materialize)
            .collect()
    }

    #[must_use]
    pub fn level_count(&self) -> usize {
        level_count(self.sample_count)
    }

    /// Returns the final value recorded by the coarsest resident envelope bin.
    #[must_use]
    pub fn last_finite_value(&self) -> Option<f64> {
        self.level(self.level_count().saturating_sub(1))?
            .last()?
            .last
            .filter(|value| value.is_finite())
    }

    #[must_use]
    pub fn stored_bin_count(&self) -> usize {
        self.merged.iter().map(CachedBinLevel::len).sum()
    }

    #[must_use]
    pub fn paged_level_count(&self) -> usize {
        self.merged
            .iter()
            .filter(|level| matches!(level, CachedBinLevel::Paged(_)))
            .count()
    }

    /// Materializes one complete logical level. Level 0 is synthesized from
    /// the raw columns.
    #[must_use]
    pub fn level(&self, index: usize) -> Option<Vec<EnvelopeBin>> {
        if index >= self.level_count() {
            None
        } else if index < self.first_stored_level {
            Some(
                self.synthesize_level(index, 0..level_len(self.sample_count, index))
                    .to_wire_vec(),
            )
        } else {
            self.merged
                .get(index - self.first_stored_level)
                .and_then(CachedBinLevel::materialize)
                .map(|level| level.to_wire_vec())
        }
    }

    /// Materializes one logical level, bounded to a time window when present.
    #[must_use]
    pub fn level_window(&self, index: usize, window: Option<(f64, f64)>) -> Option<BinLevel> {
        let range = self.level_window_range(index, window)?;
        if index < self.first_stored_level {
            Some(self.synthesize_level(index, range))
        } else {
            Some(self.merged[index - self.first_stored_level].range(range)?)
        }
    }

    /// Counts the bins [`Pyramid::level_window`] would materialize.
    #[must_use]
    pub fn level_window_count(&self, index: usize, window: Option<(f64, f64)>) -> Option<usize> {
        self.level_window_range(index, window)
            .map(|range| range.len())
    }

    fn level_window_range(
        &self,
        index: usize,
        window: Option<(f64, f64)>,
    ) -> Option<std::ops::Range<usize>> {
        let len = if index < self.first_stored_level {
            if index >= self.level_count() {
                return None;
            }
            level_len(self.sample_count, index)
        } else {
            self.merged.get(index - self.first_stored_level)?.len()
        };
        let Some((t0, t1)) = window else {
            return Some(0..len);
        };
        if !t0.is_finite() || !t1.is_finite() || t0 > t1 {
            return Some(0..0);
        }
        if index < self.first_stored_level {
            let (time, _) = self.columns()?;
            if time.value(0).ok().is_none_or(|first| t1 < first)
                || time
                    .value(time.len().saturating_sub(1))
                    .ok()
                    .is_none_or(|last| t0 > last)
            {
                return Some(0..0);
            }
            let width = 1 << index;
            let start = (time.partition_point(|time| time < t0).ok()? / width).saturating_sub(1);
            let end = time
                .partition_point(|time| time <= t1)
                .ok()?
                .div_ceil(width)
                .saturating_add(1)
                .min(len);
            return Some(start..end);
        }
        self.merged[index - self.first_stored_level].window_range(t0, t1)
    }

    #[must_use]
    pub fn query(&self, t0: f64, t1: f64, pixel_width: u32) -> PyramidQuery {
        let Some((time, _)) = self.columns() else {
            return PyramidQuery {
                level: 0,
                bins: BinLevel::default(),
            };
        };
        if time.value(0).ok().is_none_or(|first| t1 < first)
            || time
                .value(time.len().saturating_sub(1))
                .ok()
                .is_none_or(|last| t0 > last)
        {
            return PyramidQuery {
                level: 0,
                bins: BinLevel::default(),
            };
        }
        let target = usize::try_from(pixel_width.max(1))
            .unwrap_or(usize::MAX)
            .saturating_mul(2);
        let raw_start = time.partition_point(|time| time < t0).unwrap_or(0);
        let raw_end = time.partition_point(|time| time <= t1).unwrap_or(0);
        if raw_end.saturating_sub(raw_start) <= target || self.merged.is_empty() {
            return PyramidQuery {
                level: 0,
                bins: self.level_window(0, Some((t0, t1))).unwrap_or_default(),
            };
        }

        let mut level_index = self.level_count().saturating_sub(1);
        for index in 1..self.level_count() {
            let width = 1 << index;
            let count = if index < self.first_stored_level {
                raw_end.div_ceil(width).saturating_sub(raw_start / width)
            } else {
                let start = (raw_start >> index).saturating_sub(1);
                let end = raw_end
                    .div_ceil(width)
                    .saturating_add(1)
                    .min(level_len(self.sample_count, index));
                end.saturating_sub(start)
            };
            if count <= target {
                level_index = index;
                break;
            }
        }
        PyramidQuery {
            level: u32::try_from(level_index).unwrap_or(u32::MAX),
            bins: self
                .level_window(level_index, Some((t0, t1)))
                .unwrap_or_default(),
        }
    }

    #[cfg(test)]
    fn query_reference(&self, t0: f64, t1: f64, pixel_width: u32) -> PyramidQuery {
        let Some((time, _)) = self.columns() else {
            return PyramidQuery {
                level: 0,
                bins: BinLevel::default(),
            };
        };
        if time.value(0).ok().is_none_or(|first| t1 < first)
            || time
                .value(time.len().saturating_sub(1))
                .ok()
                .is_none_or(|last| t0 > last)
        {
            return PyramidQuery {
                level: 0,
                bins: BinLevel::default(),
            };
        }
        let target = usize::try_from(pixel_width.max(1))
            .unwrap_or(usize::MAX)
            .saturating_mul(2);
        let raw_start = time.partition_point(|time| time < t0).unwrap_or(0);
        let raw_end = time.partition_point(|time| time <= t1).unwrap_or(0);
        if raw_end.saturating_sub(raw_start) <= target || self.merged.is_empty() {
            return PyramidQuery {
                level: 0,
                bins: self.level_window(0, Some((t0, t1))).unwrap_or_default(),
            };
        }

        let level_index = (1..self.level_count())
            .find(|index| self.overlap_count(*index, t0, t1) <= target)
            .unwrap_or_else(|| self.level_count().saturating_sub(1));
        PyramidQuery {
            level: u32::try_from(level_index).unwrap_or(u32::MAX),
            bins: self
                .level_window(level_index, Some((t0, t1)))
                .unwrap_or_default(),
        }
    }

    #[must_use]
    /// # Panics
    ///
    /// Panics when `index` cannot be represented as a sample stride.
    pub fn synthesize_level(&self, index: usize, range: std::ops::Range<usize>) -> BinLevel {
        let Some((time, values)) = self.columns() else {
            return BinLevel::default();
        };
        let width = 1 << index;
        let sample_start = range.start.saturating_mul(width).min(self.sample_count);
        let sample_end = range.end.saturating_mul(width).min(self.sample_count);
        let Ok(time) = time.range(sample_start..sample_end) else {
            return BinLevel::default();
        };
        let Ok(values) = values.range(sample_start..sample_end) else {
            return BinLevel::default();
        };
        let mut level = BinLevel::with_capacity(range.len());
        for bin in 0..range.len() {
            let start = bin.saturating_mul(width);
            if start >= time.len() {
                break;
            }
            let merged = fold_bin(&time, &values, start, width);
            level.push(&merged);
        }
        level
    }

    #[cfg(test)]
    fn overlap_count(&self, index: usize, t0: f64, t1: f64) -> usize {
        if index < self.first_stored_level {
            let Some((time, _)) = self.columns() else {
                return 0;
            };
            let width = 1 << index;
            let start = time.partition_point(|time| time < t0).unwrap_or(0) / width;
            let end = time
                .partition_point(|time| time <= t1)
                .unwrap_or(0)
                .div_ceil(width);
            end.saturating_sub(start)
        } else {
            self.merged[index - self.first_stored_level]
                .window_range(t0, t1)
                .map_or(0, |range| range.len())
        }
    }

    #[must_use]
    pub fn retained_column_bytes(&self) -> usize {
        match self.columns {
            PyramidColumns::Retained { .. } => self.sample_count.saturating_mul(16),
            PyramidColumns::Weak { .. } => 0,
        }
    }

    fn columns(&self) -> Option<(Column, Column)> {
        match &self.columns {
            PyramidColumns::Retained { time, values } => Some((time.clone(), values.clone())),
            PyramidColumns::Weak { time, values } => {
                Some((time.upgrade_column()?, values.upgrade_column()?))
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct PyramidQuery {
    pub level: u32,
    pub bins: BinLevel,
}

fn fold_bin(time: &[f64], values: &[f64], start: usize, width: usize) -> EnvelopeBin {
    let end = (start + width).min(time.len());
    let mut stack: Vec<(u32, EnvelopeBin)> =
        Vec::with_capacity(width.trailing_zeros() as usize + 2);
    for index in start..end {
        let mut rank = 0_u32;
        let mut bin = sample_bin(time[index], values[index]);
        while stack
            .last()
            .is_some_and(|(stored_rank, _)| *stored_rank == rank)
        {
            let (_, left) = stack.pop().expect("checked");
            bin = merge_bins(&left, &bin);
            rank += 1;
        }
        stack.push((rank, bin));
    }
    let (_, mut bin) = stack.pop().expect("non-empty bin");
    while let Some((_, left)) = stack.pop() {
        bin = merge_bins(&left, &bin);
    }
    bin
}

fn merge_level(previous: &BinLevel) -> BinLevel {
    let mut next = BinLevel::with_capacity(previous.len().div_ceil(2));
    for index in (0..previous.len()).step_by(2) {
        let left = previous.to_wire(index);
        let bin = previous
            .get(index + 1)
            .map_or(left.clone(), |right| merge_bins(&left, &right.to_wire()));
        next.push(&bin);
    }
    next
}

fn level_count(samples: usize) -> usize {
    let mut count = 1;
    let mut bins = samples;
    while bins > 1 {
        bins = bins.div_ceil(2);
        count += 1;
    }
    count
}

fn level_len(samples: usize, index: usize) -> usize {
    samples.div_ceil(1 << index)
}

fn validate_merged(sample_count: usize, merged: &[BinLevel]) {
    let expected = if level_count(sample_count) > FINEST_STORED_LEVEL {
        sample_count.div_ceil(1 << FINEST_STORED_LEVEL)
    } else {
        0
    };
    assert_eq!(
        merged.first().map_or(0, BinLevel::len),
        expected,
        "first stored level has the wrong length"
    );
}

fn min_option(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    }
}

fn max_option(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    use super::*;

    #[test]
    fn last_value_uses_the_coarsest_bin_tail_without_scanning_for_a_fallback() {
        assert_eq!(
            Pyramid::from_samples(&[0.0, 1.0, 2.0], &[1.0, 2.0, f64::NAN]).last_finite_value(),
            Some(2.0)
        );
        assert_eq!(
            Pyramid::from_samples(&[0.0, 1.0, 2.0], &[1.0, f64::NAN, 3.0]).last_finite_value(),
            Some(3.0)
        );
        assert_eq!(Pyramid::from_samples(&[], &[]).last_finite_value(), None);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn every_level_preserves_global_envelope() {
        let values = [2.0, -8.0, 4.0, 21.0, -3.0];
        let time = [0.0, 1.0, 2.0, 3.0, 4.0];
        let pyramid = Pyramid::from_samples(&time, &values);

        for level in (0..pyramid.level_count()).map(|index| pyramid.level(index).unwrap()) {
            let min = level
                .iter()
                .filter_map(|bin| bin.min)
                .fold(f64::INFINITY, f64::min);
            let max = level
                .iter()
                .filter_map(|bin| bin.max)
                .fold(f64::NEG_INFINITY, f64::max);
            assert_eq!(min, -8.0);
            assert_eq!(max, 21.0);
        }
    }

    #[test]
    fn nan_gap_survives_every_parent() {
        let pyramid = Pyramid::from_samples(&[0.0, 1.0, 2.0, 3.0], &[1.0, f64::NAN, 2.0, 3.0]);

        assert!(pyramid.level(0).unwrap()[1].has_gap);
        assert!(pyramid.level(1).unwrap()[0].has_gap);
        assert!(pyramid.level(2).unwrap()[0].has_gap);
        assert_eq!(pyramid.level(2).unwrap()[0].min, Some(1.0));
        assert_eq!(pyramid.level(2).unwrap()[0].max, Some(3.0));
    }

    #[test]
    fn bins_accumulate_finite_sums() {
        let pyramid = Pyramid::from_samples(&[0.0, 1.0, 2.0, 3.0], &[1.0, f64::NAN, 2.0, 3.0]);
        let top = pyramid.level(2).unwrap()[0].clone();
        assert_eq!(top.sample_count, 4);
        assert_eq!(top.finite_count, 3);
        assert!((top.sum - 6.0).abs() < 1e-12);
        assert!((top.sum_sq - 14.0).abs() < 1e-12);

        let raw = pyramid.level(0).unwrap();
        assert_eq!(raw[1].finite_count, 0);
        assert!(raw[1].sum.abs() < f64::EPSILON);
    }

    #[test]
    fn query_is_bounded_by_display_density() {
        let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
        let values = time.iter().map(|value| value.sin()).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &values);
        let query = pyramid.query(0.0, 9_999.0, 200);

        assert!(query.bins.len() <= 402);
        assert!(query.level > 0);
    }

    #[test]
    fn query_returns_columnar_bins_identical_to_wire() {
        let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
        let values = time.iter().map(|value| value.sin()).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &values);
        let query = pyramid.query(0.0, 9_999.0, 200);
        assert!(query.bins.len() <= 402);
        assert_eq!(query.bins.to_wire_vec().len(), query.bins.len());
    }

    #[test]
    fn iterative_synthesis_is_bit_identical_to_reference() {
        let mut state = 0x2545_F491_4F6C_DD1D_u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 11) as f64 / (1_u64 << 53) as f64
        };
        for len in [1_usize, 2, 3, 7, 8, 1000, 10_001] {
            let time: Vec<f64> = (0..len).map(|i| i as f64).collect();
            let values: Vec<f64> = (0..len)
                .map(|i| {
                    if i % 97 == 0 {
                        f64::NAN
                    } else {
                        next() * 100.0 - 50.0
                    }
                })
                .collect();
            let pyramid = Pyramid::from_samples(&time, &values);
            let reference = Pyramid::from_samples_storing_every_level(&time, &values);
            for index in 0..pyramid.level_count() {
                assert_eq!(
                    pyramid.level(index),
                    reference.level(index),
                    "level {index} len {len}"
                );
            }
        }
    }

    #[test]
    fn direct_level_selection_matches_probe_walk() {
        for len in [5_usize, 100, 1000, 10_001, 100_000] {
            let time: Vec<f64> = (0..len).map(|i| i as f64).collect();
            let values = time.clone();
            let pyramid = Pyramid::from_samples(&time, &values);
            for &(t0, t1) in &[
                (0.0, len as f64),
                (0.3 * len as f64, 0.31 * len as f64),
                (0.0, 1.0),
                (len as f64 * 0.9, len as f64 * 2.0),
            ] {
                for width in [64_u32, 200, 800, 1920] {
                    let expected = pyramid.query_reference(t0, t1, width);
                    let actual = pyramid.query(t0, t1, width);
                    assert_eq!(
                        expected.level, actual.level,
                        "len {len} w {width} [{t0},{t1}]"
                    );
                    assert_eq!(expected.bins, actual.bins);
                }
            }
        }
    }

    #[test]
    fn query_includes_neighbor_bins_for_viewport_edge_strokes() {
        let pyramid =
            Pyramid::from_samples(&[0.0, 1.0, 2.0, 3.0, 4.0], &[0.0, 1.0, 4.0, 9.0, 16.0]);
        let query = pyramid.query(1.5, 2.5, 100);

        assert_eq!(query.level, 0);
        assert_eq!(
            query
                .bins
                .to_wire_vec()
                .iter()
                .map(|bin| bin.t0)
                .collect::<Vec<_>>(),
            [1.0, 2.0, 3.0]
        );
    }

    #[test]
    fn windowed_levels_materialize_only_the_window_and_neighbors() {
        let time = (0..100_000).map(f64::from).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &time);
        let levels = (0..pyramid.level_count())
            .map(|index| {
                pyramid
                    .level_window(index, Some((50_000.0, 50_010.0)))
                    .expect("logical level")
            })
            .collect::<Vec<_>>();

        assert_eq!(levels[0].len(), 13);
        assert_eq!(levels[0].to_wire(0).t0, 49_999.0);
        assert_eq!(levels[0].to_wire(levels[0].len() - 1).t1, 50_011.0);
        assert!(levels.iter().all(|level| level.len() <= 13));
    }

    #[test]
    fn windowed_level_counts_match_materialized_bins() {
        let time = (0..100_000).map(f64::from).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &time);
        let window = Some((50_000.0, 50_010.0));

        for index in 0..pyramid.level_count() {
            assert_eq!(
                pyramid.level_window_count(index, window),
                pyramid.level_window(index, window).map(|bins| bins.len())
            );
        }
    }

    #[test]
    fn invalid_windows_are_empty() {
        let pyramid = Pyramid::from_samples(&[0.0, 1.0, 2.0], &[0.0, 1.0, 2.0]);

        for window in [
            Some((2.0, 1.0)),
            Some((f64::NAN, 1.0)),
            Some((0.0, f64::INFINITY)),
        ] {
            for index in 0..pyramid.level_count() {
                assert_eq!(pyramid.level_window_count(index, window), Some(0));
                assert_eq!(
                    pyramid.level_window(index, window),
                    Some(BinLevel::default())
                );
            }
        }
    }

    #[test]
    fn level_zero_is_synthesized_not_stored() {
        let time = (0..1_000).map(f64::from).collect::<Vec<_>>();
        let values = time.iter().map(|value| value.cos()).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &values);

        assert_eq!(pyramid.level_count(), 11);

        let query = pyramid.query(0.0, 999.0, 600);
        assert_eq!(query.level, 0);
        assert_eq!(query.bins.len(), 1_000);
        assert_eq!(query.bins.to_wire(3).min, Some(3.0_f64.cos()));
    }

    #[test]
    fn levels_below_the_cutoff_are_synthesized_not_stored() {
        let time = (0..100_000).map(f64::from).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &time);

        assert!(pyramid.stored_bin_count() < time.len() / 3);
        assert_eq!(pyramid.level_count(), 18);
    }

    #[test]
    fn synthesized_levels_match_stored_reference_levels() {
        let time = (0..4_096).map(f64::from).collect::<Vec<_>>();
        let values = time
            .iter()
            .map(|time| (time * 0.7).sin())
            .collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &values);
        let reference = Pyramid::from_samples_storing_every_level(&time, &values);

        for index in 0..pyramid.level_count() {
            assert_eq!(pyramid.level(index), reference.level(index));
        }
    }

    #[test]
    fn queries_selecting_an_elided_level_stay_viewport_bounded() {
        let time = (0..1_000_000).map(f64::from).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &time);
        let query = pyramid.query(0.0, 4_000.0, 800);

        assert!(usize::try_from(query.level).unwrap() <= FINEST_STORED_LEVEL);
        assert!(query.bins.len() <= 1_602);
    }

    #[test]
    fn a_signal_pyramid_does_not_retain_its_columns() {
        let signal = Signal::new(
            crate::store::SignalId(1),
            crate::store::SourceId(1),
            "x",
            "run/x",
            None,
            Arc::from((0..1_024).map(f64::from).collect::<Vec<_>>()),
            Arc::from((0..1_024).map(f64::from).collect::<Vec<_>>()),
        )
        .unwrap();

        assert_eq!(Pyramid::from_signal(&signal).retained_column_bytes(), 0);
    }

    #[test]
    fn from_parts_reproduces_the_original_queries() {
        let time = (0..1_000).map(f64::from).collect::<Vec<_>>();
        let values = time.iter().map(|value| value.sin()).collect::<Vec<_>>();
        let original = Pyramid::from_samples(&time, &values);
        let rebuilt = Pyramid::from_parts(
            Arc::from(time.clone()),
            Arc::from(values),
            original.merged_levels(),
        );
        for &(t0, t1, width) in &[(0.0, 999.0, 100_u32), (10.0, 40.0, 600)] {
            let expected = original.query(t0, t1, width);
            let actual = rebuilt.query(t0, t1, width);
            assert_eq!(expected.level, actual.level);
            assert_eq!(expected.bins, actual.bins);
        }
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Fixture {
        levels: Vec<Vec<EnvelopeBin>>,
        queries: Vec<FixtureQuery>,
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct FixtureQuery {
        t0: f64,
        t1: f64,
        pixel_width: u32,
        level: u32,
        bins: Vec<EnvelopeBin>,
    }

    const FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/pyramid-conformance.json"
    );

    fn conformance_pyramid() -> Pyramid {
        let time: Vec<f64> = (0..500).map(f64::from).collect();
        let values: Vec<f64> = time
            .iter()
            .enumerate()
            .map(|(index, time)| {
                if (97..=103).contains(&index) {
                    f64::NAN
                } else {
                    (time * 1.3).sin() * 10.0 + time * 0.5
                }
            })
            .collect();
        Pyramid::from_samples(&time, &values)
    }

    #[test]
    fn conformance_fixture_matches_rust_query() {
        let pyramid = conformance_pyramid();
        let windows = [
            (0.0, 499.0, 400_u32),
            (0.0, 499.0, 100),
            (90.0, 120.0, 64),
            (2_000.0, 3_000.0, 100),
        ];
        let current = Fixture {
            levels: (0..pyramid.level_count())
                .map(|index| pyramid.level(index).expect("level exists"))
                .collect(),
            queries: windows
                .iter()
                .map(|&(t0, t1, pixel_width)| {
                    let query = pyramid.query(t0, t1, pixel_width);
                    FixtureQuery {
                        t0,
                        t1,
                        pixel_width,
                        level: query.level,
                        bins: query.bins.to_wire_vec(),
                    }
                })
                .collect(),
        };

        if std::env::var("REGENERATE_FIXTURES").is_ok() {
            std::fs::write(
                FIXTURE_PATH,
                serde_json::to_string_pretty(&current).expect("serializable"),
            )
            .expect("fixture written");
            return;
        }

        let stored: Fixture = serde_json::from_str(
            &std::fs::read_to_string(FIXTURE_PATH)
                .expect("fixture exists; regenerate with REGENERATE_FIXTURES=1"),
        )
        .expect("fixture parses");
        assert_fixture_matches(&current, &stored);
    }

    fn assert_fixture_matches(current: &Fixture, stored: &Fixture) {
        assert_eq!(current.levels.len(), stored.levels.len());
        for (current_level, stored_level) in current.levels.iter().zip(&stored.levels) {
            assert_eq!(current_level.len(), stored_level.len());
            for (current_bin, stored_bin) in current_level.iter().zip(stored_level) {
                assert_bin_matches(current_bin, stored_bin);
            }
        }

        assert_eq!(current.queries.len(), stored.queries.len());
        for (current_query, stored_query) in current.queries.iter().zip(&stored.queries) {
            assert_close(current_query.t0, stored_query.t0);
            assert_close(current_query.t1, stored_query.t1);
            assert_eq!(current_query.pixel_width, stored_query.pixel_width);
            assert_eq!(current_query.level, stored_query.level);
            assert_eq!(current_query.bins.len(), stored_query.bins.len());
            for (current_bin, stored_bin) in current_query.bins.iter().zip(&stored_query.bins) {
                assert_bin_matches(current_bin, stored_bin);
            }
        }
    }

    fn assert_bin_matches(current: &EnvelopeBin, stored: &EnvelopeBin) {
        assert_close(current.t0, stored.t0);
        assert_close(current.t1, stored.t1);
        assert_option_close(current.first, stored.first);
        assert_option_close(current.last, stored.last);
        assert_option_close(current.min, stored.min);
        assert_option_close(current.max, stored.max);
        assert_close(current.sum, stored.sum);
        assert_close(current.sum_sq, stored.sum_sq);
        assert_eq!(current.finite_count, stored.finite_count);
        assert_eq!(current.sample_count, stored.sample_count);
        assert_eq!(current.has_gap, stored.has_gap);
    }

    fn assert_option_close(current: Option<f64>, stored: Option<f64>) {
        match (current, stored) {
            (Some(current), Some(stored)) => assert_close(current, stored),
            (None, None) => {}
            (current, stored) => panic!("envelope value mismatch: {current:?} != {stored:?}"),
        }
    }

    fn assert_close(current: f64, stored: f64) {
        let tolerance = current.abs().max(stored.abs()).max(1.0) * 1e-12;
        assert!(
            (current - stored).abs() <= tolerance,
            "envelope value mismatch: {current} != {stored}"
        );
    }
}

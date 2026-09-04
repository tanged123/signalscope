//! Multi-resolution min/max envelopes for bounded-cost viewport queries.

use std::sync::{Arc, OnceLock};

use crate::{
    bins::{BinLevel, HAS_FIRST, HAS_GAP, HAS_LAST, HAS_MAX, HAS_MIN},
    columns::{Column, WeakColumn},
    paging::PageHandle,
    store::Signal,
};

type ColumnPair = (Column, Column);
use scope_protocol::EnvelopeBin;

pub const FINEST_STORED_LEVEL: usize = 3;

mod build;
mod query;
mod synthesize;

#[derive(Clone, Debug)]
pub struct Pyramid {
    columns: PyramidColumns,
    sample_count: usize,
    first_stored_level: usize,
    merged: Vec<CachedBinLevel>,
    column_cache: Arc<OnceLock<Option<ColumnPair>>>,
    synthesized_level: Arc<OnceLock<Option<BinLevel>>>,
}

#[derive(Clone, Debug)]
pub(crate) enum CachedBinLevel {
    Resident(Box<BinLevel>),
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

    fn partition_point(&self, field: usize, predicate: impl FnMut(f64) -> bool) -> Option<usize> {
        let base = 8_usize.checked_add(field.checked_mul(self.len)?.checked_mul(8)?)?;
        self.handle.partition_point(base, self.len, predicate).ok()
    }

    fn range(&self, range: std::ops::Range<usize>) -> Option<BinLevel> {
        BinLevel::decode_cache_range(&self.handle, self.len, range)
    }
}

impl CachedBinLevel {
    pub(crate) fn materialize(&self) -> Option<BinLevel> {
        match self {
            Self::Resident(level) => Some((**level).clone()),
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

#[cfg(test)]
mod tests {
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
    fn adaptive_query_stays_above_one_bin_per_pixel() {
        let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &time);
        let query = pyramid.query(0.0, 9_999.0, 200);

        assert!(query.level > 0);
        assert!(query.bins.len() > 200);
        assert!(query.bins.len() <= 402);
        let pixel_span = 9_999.0 / 200.0;
        assert!(
            query
                .bins
                .t0_column()
                .iter()
                .zip(query.bins.t1_column())
                .all(|(start, end)| end - start <= pixel_span)
        );
    }

    #[test]
    fn adaptive_query_stays_bounded_across_large_time_gaps() {
        let mut time = (0..100_000).map(f64::from).collect::<Vec<_>>();
        for value in &mut time[50_001..] {
            *value += 10_000.0;
        }
        let pyramid = Pyramid::from_samples(&time, &time);
        let query = pyramid.query(0.0, 109_999.0, 256);

        assert!(query.level > 0);
        assert!(query.bins.len() <= 514);
        let bins = query.bins.to_wire_vec();
        let min = bins
            .iter()
            .filter_map(|bin| bin.min)
            .fold(f64::INFINITY, f64::min);
        let max = bins
            .iter()
            .filter_map(|bin| bin.max)
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(min.abs() <= f64::EPSILON);
        assert!((max - 109_999.0).abs() <= f64::EPSILON);
    }

    #[test]
    fn adaptive_query_reaches_level_zero_when_raw_fits() {
        let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &time);
        let query = pyramid.query(4_900.0, 5_100.0, 400);

        assert_eq!(query.level, 0);
        assert!(
            query
                .bins
                .to_wire_vec()
                .iter()
                .all(|bin| bin.sample_count == 1)
        );
    }

    #[test]
    fn raw_query_returns_every_window_sample_at_level_zero() {
        let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &time);
        let query = pyramid.query_raw(2_000.0, 7_999.0);

        assert_eq!(query.level, 0);
        assert_eq!(query.bins.len(), 6_002); // one neighbour on each edge
        assert!(
            query
                .bins
                .to_wire_vec()
                .iter()
                .all(|bin| bin.sample_count == 1)
        );
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
    #[allow(clippy::cast_precision_loss)]
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
    #[allow(clippy::cast_precision_loss)]
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
    fn bin_budget_selects_a_coarser_level() {
        let time = (0..100_000).map(f64::from).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &time);
        let unbudgeted = pyramid.query(0.0, 99_999.0, 1920);
        let budgeted = pyramid.query_with_target(0.0, 99_999.0, 1920, Some(256));
        assert!(budgeted.level > unbudgeted.level);
        assert!(budgeted.bins.len() <= 258);
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
    #[allow(clippy::float_cmp)]
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
    fn conformance_queries_preserve_extrema_and_gaps() {
        let pyramid = conformance_pyramid();
        let full = pyramid.query(0.0, 499.0, 400);
        let full_bins = full.bins.to_wire_vec();
        assert_eq!(full.level, 0);
        assert_eq!(full_bins.len(), 500);
        assert_eq!(full_bins.first().and_then(|bin| bin.min), Some(0.0));
        assert!(full_bins[97..=103].iter().all(|bin| bin.has_gap));

        let window = pyramid.query(90.0, 120.0, 64);
        assert_eq!(window.level, 0);
        assert!(window.bins.to_wire_vec().iter().any(|bin| bin.has_gap));
        assert!(
            window
                .bins
                .to_wire_vec()
                .iter()
                .any(|bin| bin.min.is_some() && bin.max.is_some())
        );

        let outside = pyramid.query(2_000.0, 3_000.0, 100);
        assert!(outside.bins.is_empty());
    }
}

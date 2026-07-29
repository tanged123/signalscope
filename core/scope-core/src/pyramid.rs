//! Multi-resolution min/max envelopes for bounded-cost viewport queries.

use std::sync::Arc;

use crate::store::Signal;
use scope_protocol::EnvelopeBin;

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
    time: Arc<[f64]>,
    values: Arc<[f64]>,
    /// `merged[0]` covers two raw samples per bin (logical level 1).
    /// Logical level 0 is the raw columns, synthesized per query and never
    /// stored: materializing it would cost ~96 bytes per raw sample on top
    /// of the 16 the store already holds.
    merged: Vec<Vec<EnvelopeBin>>,
}

impl Pyramid {
    #[must_use]
    pub fn from_signal(signal: &Signal) -> Self {
        Self::from_columns(signal.time_shared(), signal.values_shared())
    }

    #[must_use]
    /// Builds an envelope pyramid from equal-length time and value columns.
    ///
    /// # Panics
    ///
    /// Panics when `time` and `values` have different lengths.
    pub fn from_samples(time: &[f64], values: &[f64]) -> Self {
        Self::from_columns(Arc::from(time.to_vec()), Arc::from(values.to_vec()))
    }

    fn from_columns(time: Arc<[f64]>, values: Arc<[f64]>) -> Self {
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
        let mut merged = (!level_one.is_empty())
            .then_some(level_one)
            .into_iter()
            .collect::<Vec<_>>();
        while merged.last().is_some_and(|level| level.len() > 1) {
            let previous = merged.last().expect("level exists");
            let next = previous
                .chunks(2)
                .map(|chunk| {
                    if chunk.len() == 2 {
                        merge_bins(&chunk[0], &chunk[1])
                    } else {
                        chunk[0].clone()
                    }
                })
                .collect();
            merged.push(next);
        }
        Self {
            time,
            values,
            merged,
        }
    }

    /// Reassembles a pyramid from previously built parts (the sidecar cache).
    ///
    /// # Panics
    ///
    /// Panics when the columns differ in length or the first merged level
    /// does not pair the raw samples. Callers deserializing untrusted bytes
    /// must validate shapes first and treat mismatches as cache misses.
    #[must_use]
    pub fn from_parts(time: Arc<[f64]>, values: Arc<[f64]>, merged: Vec<Vec<EnvelopeBin>>) -> Self {
        assert_eq!(time.len(), values.len(), "time/value lengths differ");
        assert_eq!(
            merged.first().map_or(0, Vec::len),
            time.len().div_ceil(2),
            "first merged level must pair raw samples"
        );
        Self {
            time,
            values,
            merged,
        }
    }

    /// Stored merged levels; `merged_levels()[0]` is logical level 1.
    #[must_use]
    pub fn merged_levels(&self) -> &[Vec<EnvelopeBin>] {
        &self.merged
    }

    #[must_use]
    pub fn level_count(&self) -> usize {
        self.merged.len() + 1
    }

    /// Materializes one complete logical level. Level 0 is synthesized from
    /// the raw columns.
    #[must_use]
    pub fn level(&self, index: usize) -> Option<Vec<EnvelopeBin>> {
        if index == 0 {
            Some(self.synthesize_raw(0, self.time.len()))
        } else {
            self.merged.get(index - 1).cloned()
        }
    }

    /// Materializes one logical level, bounded to a time window when present.
    #[must_use]
    pub fn level_window(
        &self,
        index: usize,
        window: Option<(f64, f64)>,
    ) -> Option<Vec<EnvelopeBin>> {
        let range = self.level_window_range(index, window)?;
        if index == 0 {
            Some(self.synthesize_raw(range.start, range.end))
        } else {
            Some(self.merged[index - 1][range].to_vec())
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
        let len = if index == 0 {
            self.time.len()
        } else {
            self.merged.get(index - 1)?.len()
        };
        let Some((t0, t1)) = window else {
            return Some(0..len);
        };
        if !t0.is_finite() || !t1.is_finite() || t0 > t1 {
            return Some(0..0);
        }
        if index == 0 {
            if self.time.first().is_none_or(|first| t1 < *first)
                || self.time.last().is_none_or(|last| t0 > *last)
            {
                return Some(0..0);
            }
            let start = self
                .time
                .partition_point(|time| *time < t0)
                .saturating_sub(1);
            let end = self
                .time
                .partition_point(|time| *time <= t1)
                .saturating_add(1)
                .min(len);
            return Some(start..end);
        }
        let level = &self.merged[index - 1];
        if level.first().is_none_or(|first| t1 < first.t0)
            || level.last().is_none_or(|last| t0 > last.t1)
        {
            return Some(0..0);
        }
        let start = level.partition_point(|bin| bin.t1 < t0).saturating_sub(1);
        let end = level
            .partition_point(|bin| bin.t0 <= t1)
            .saturating_add(1)
            .min(len);
        Some(start..end)
    }

    #[must_use]
    pub fn query(&self, t0: f64, t1: f64, pixel_width: u32) -> PyramidQuery {
        if self.time.first().is_none_or(|first| t1 < *first)
            || self.time.last().is_none_or(|last| t0 > *last)
        {
            return PyramidQuery {
                level: 0,
                bins: Vec::new(),
            };
        }
        let target = usize::try_from(pixel_width.max(1))
            .unwrap_or(usize::MAX)
            .saturating_mul(2);
        let raw_start = self.time.partition_point(|time| *time < t0);
        let raw_end = self.time.partition_point(|time| *time <= t1);
        if raw_end.saturating_sub(raw_start) <= target || self.merged.is_empty() {
            return PyramidQuery {
                level: 0,
                bins: self.level_window(0, Some((t0, t1))).unwrap_or_default(),
            };
        }

        let level_index = self
            .merged
            .iter()
            .position(|level| count_overlapping(level, t0, t1) <= target)
            .unwrap_or_else(|| self.merged.len().saturating_sub(1));
        PyramidQuery {
            level: u32::try_from(level_index + 1).unwrap_or(u32::MAX),
            bins: self
                .level_window(level_index + 1, Some((t0, t1)))
                .unwrap_or_default(),
        }
    }

    fn synthesize_raw(&self, start: usize, end: usize) -> Vec<EnvelopeBin> {
        self.time[start..end]
            .iter()
            .copied()
            .zip(self.values[start..end].iter().copied())
            .map(|(time, value)| sample_bin(time, value))
            .collect()
    }
}

#[derive(Clone, Debug)]
pub struct PyramidQuery {
    pub level: u32,
    pub bins: Vec<EnvelopeBin>,
}

fn count_overlapping(level: &[EnvelopeBin], t0: f64, t1: f64) -> usize {
    let start = level.partition_point(|bin| bin.t1 < t0);
    let end = level.partition_point(|bin| bin.t0 <= t1);
    end.saturating_sub(start)
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
    fn query_includes_neighbor_bins_for_viewport_edge_strokes() {
        let pyramid =
            Pyramid::from_samples(&[0.0, 1.0, 2.0, 3.0, 4.0], &[0.0, 1.0, 4.0, 9.0, 16.0]);
        let query = pyramid.query(1.5, 2.5, 100);

        assert_eq!(query.level, 0);
        assert_eq!(
            query.bins.iter().map(|bin| bin.t0).collect::<Vec<_>>(),
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
        assert_eq!(levels[0].first().map(|bin| bin.t0), Some(49_999.0));
        assert_eq!(levels[0].last().map(|bin| bin.t1), Some(50_011.0));
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
                assert_eq!(pyramid.level_window(index, window), Some(Vec::new()));
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
        assert_eq!(query.bins[3].min, Some(3.0_f64.cos()));
    }

    #[test]
    fn from_parts_reproduces_the_original_queries() {
        let time = (0..1_000).map(f64::from).collect::<Vec<_>>();
        let values = time.iter().map(|value| value.sin()).collect::<Vec<_>>();
        let original = Pyramid::from_samples(&time, &values);
        let rebuilt = Pyramid::from_parts(
            Arc::from(time.clone()),
            Arc::from(values),
            original.merged_levels().to_vec(),
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
                        bins: query.bins,
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

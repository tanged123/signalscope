//! Multi-resolution min/max envelopes for bounded-cost viewport queries.

use crate::store::Signal;
use scope_protocol::EnvelopeBin;

pub const TILE_BINS: usize = 256;

fn sample_bin(time: f64, value: f64) -> EnvelopeBin {
    let finite = value.is_finite().then_some(value);
    EnvelopeBin {
        t0: time,
        t1: time,
        first: finite,
        last: finite,
        min: finite,
        max: finite,
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
        sample_count: left.sample_count + right.sample_count,
        has_gap: left.has_gap || right.has_gap,
    }
}

#[derive(Clone, Debug)]
pub struct Pyramid {
    levels: Vec<Vec<EnvelopeBin>>,
}

impl Pyramid {
    #[must_use]
    pub fn from_signal(signal: &Signal) -> Self {
        Self::from_samples(signal.time(), signal.values())
    }

    #[must_use]
    /// Builds an envelope pyramid from equal-length time and value columns.
    ///
    /// # Panics
    ///
    /// Panics when `time` and `values` have different lengths.
    pub fn from_samples(time: &[f64], values: &[f64]) -> Self {
        assert_eq!(time.len(), values.len(), "time/value lengths differ");
        let level_zero = time
            .iter()
            .copied()
            .zip(values.iter().copied())
            .map(|(time, value)| sample_bin(time, value))
            .collect();
        Self::from_level_zero(level_zero)
    }

    fn from_level_zero(level_zero: Vec<EnvelopeBin>) -> Self {
        let mut levels = vec![level_zero];
        while levels.last().is_some_and(|level| level.len() > 1) {
            let previous = levels.last().expect("level exists");
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
            levels.push(next);
        }
        Self { levels }
    }

    #[must_use]
    pub fn level_count(&self) -> usize {
        self.levels.len()
    }

    #[must_use]
    pub fn level(&self, index: usize) -> Option<&[EnvelopeBin]> {
        self.levels.get(index).map(Vec::as_slice)
    }

    #[must_use]
    pub fn query(&self, t0: f64, t1: f64, pixel_width: u32) -> PyramidQuery<'_> {
        let target = usize::try_from(pixel_width.max(1))
            .unwrap_or(usize::MAX)
            .saturating_mul(2);
        let level_index = self
            .levels
            .iter()
            .position(|level| count_overlapping(level, t0, t1) <= target)
            .unwrap_or_else(|| self.levels.len().saturating_sub(1));
        let level = &self.levels[level_index];
        let start = level.partition_point(|bin| bin.t1 < t0);
        let end = level.partition_point(|bin| bin.t0 <= t1);
        PyramidQuery {
            level: u32::try_from(level_index).unwrap_or(u32::MAX),
            bins: &level[start..end],
        }
    }
}

#[derive(Clone, Debug)]
pub struct PyramidQuery<'a> {
    pub level: u32,
    pub bins: &'a [EnvelopeBin],
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
    use super::*;

    #[test]
    #[allow(clippy::float_cmp)]
    fn every_level_preserves_global_envelope() {
        let values = [2.0, -8.0, 4.0, 21.0, -3.0];
        let time = [0.0, 1.0, 2.0, 3.0, 4.0];
        let pyramid = Pyramid::from_samples(&time, &values);

        for level in &pyramid.levels {
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
    fn query_is_bounded_by_display_density() {
        let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
        let values = time.iter().map(|value| value.sin()).collect::<Vec<_>>();
        let pyramid = Pyramid::from_samples(&time, &values);
        let query = pyramid.query(0.0, 9_999.0, 200);

        assert!(query.bins.len() <= 400);
        assert!(query.level > 0);
    }
}

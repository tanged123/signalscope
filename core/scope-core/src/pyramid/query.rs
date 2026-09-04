use super::build::level_len;
use super::{BinLevel, CachedBinLevel, EnvelopeBin, Pyramid};

impl Pyramid {
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
            let (time, _) = self.cached_columns()?;
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
        self.query_with_target(t0, t1, pixel_width, None)
    }

    #[must_use]
    pub fn query_raw(&self, t0: f64, t1: f64) -> PyramidQuery {
        PyramidQuery {
            level: 0,
            bins: self.level_window(0, Some((t0, t1))).unwrap_or_default(),
        }
    }

    #[must_use]
    pub fn query_with_target(
        &self,
        t0: f64,
        t1: f64,
        pixel_width: u32,
        max_bins: Option<u32>,
    ) -> PyramidQuery {
        let Some((time, _)) = self.cached_columns() else {
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
            .saturating_mul(2)
            .min(
                max_bins
                    .and_then(|max_bins| usize::try_from(max_bins).ok())
                    .unwrap_or(usize::MAX),
            );
        let (Ok(raw_start), Ok(raw_end)) = (
            time.partition_point(|time| time < t0),
            time.partition_point(|time| time <= t1),
        ) else {
            return PyramidQuery {
                level: 0,
                bins: BinLevel::default(),
            };
        };
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
        let mut bins = self
            .level_window(level_index, Some((t0, t1)))
            .unwrap_or_default();
        if max_bins.is_none() {
            while level_index > 0 && !meets_pixel_floor(&bins, t0, t1, pixel_width) {
                let finer = self
                    .level_window(level_index - 1, Some((t0, t1)))
                    .unwrap_or_default();
                if finer.len() > target {
                    break;
                }
                level_index -= 1;
                bins = finer;
            }
        }
        PyramidQuery {
            level: u32::try_from(level_index).unwrap_or(u32::MAX),
            bins,
        }
    }

    #[cfg(test)]
    pub(super) fn query_reference(&self, t0: f64, t1: f64, pixel_width: u32) -> PyramidQuery {
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

        let mut level_index = (1..self.level_count())
            .find(|index| self.overlap_count(*index, t0, t1) <= target)
            .unwrap_or_else(|| self.level_count().saturating_sub(1));
        let mut bins = self
            .level_window(level_index, Some((t0, t1)))
            .unwrap_or_default();
        while level_index > 0 && !meets_pixel_floor(&bins, t0, t1, pixel_width) {
            let finer = self
                .level_window(level_index - 1, Some((t0, t1)))
                .unwrap_or_default();
            if finer.len() > target {
                break;
            }
            level_index -= 1;
            bins = finer;
        }
        PyramidQuery {
            level: u32::try_from(level_index).unwrap_or(u32::MAX),
            bins,
        }
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
}

#[derive(Clone, Debug)]
pub struct PyramidQuery {
    pub level: u32,
    pub bins: BinLevel,
}

fn meets_pixel_floor(bins: &BinLevel, t0: f64, t1: f64, pixel_width: u32) -> bool {
    let pixels = usize::try_from(pixel_width.max(1)).unwrap_or(usize::MAX);
    if bins.len() <= pixels {
        return false;
    }
    let pixel_span = (t1 - t0) / f64::from(pixel_width.max(1));
    pixel_span.is_finite()
        && pixel_span > 0.0
        && bins
            .t0_column()
            .iter()
            .zip(bins.t1_column())
            .all(|(start, end)| end - start <= pixel_span)
}

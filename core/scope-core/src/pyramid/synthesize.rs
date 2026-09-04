use super::build::{level_len, merge_bins, sample_bin};
use super::*;

impl Pyramid {
    #[must_use]
    /// # Panics
    ///
    /// Panics when `index` cannot be represented as a sample stride.
    pub fn synthesize_level(&self, index: usize, range: std::ops::Range<usize>) -> BinLevel {
        let full_len = level_len(self.sample_count, index);
        if index.saturating_add(1) == self.first_stored_level
            && range.start == 0
            && range.end >= full_len
        {
            if let Some(level) = self.cached_synthesized_level(index) {
                return level.slice(0..range.end.min(level.len()));
            }
        }
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
        synthesize_level_from_columns(&time, &values, index, 0..range.len())
    }

    fn cached_synthesized_level(&self, index: usize) -> Option<&BinLevel> {
        let full_range = 0..level_len(self.sample_count, index);
        self.synthesized_level
            .get_or_init(|| {
                let (time, values) = self.cached_columns()?;
                let time = time.range(0..time.len()).ok()?;
                let values = values.range(0..values.len()).ok()?;
                Some(synthesize_level_from_columns(&time, &values, index, full_range).into_shared())
            })
            .as_ref()
    }
}

fn synthesize_level_from_columns(
    time: &[f64],
    values: &[f64],
    index: usize,
    range: std::ops::Range<usize>,
) -> BinLevel {
    let width = 1 << index;
    let mut level = BinLevel::with_capacity(range.len());
    if index == 0 {
        let start = range.start.min(time.len());
        let end = range.end.min(time.len()).min(values.len());
        let time = &time[start..end];
        let values = &values[start..end];
        level.t0.extend_from_slice(time);
        level.t1.extend_from_slice(time);
        level.first.extend_from_slice(values);
        level.last.extend_from_slice(values);
        level.min.extend_from_slice(values);
        level.max.extend_from_slice(values);
        level.sum.extend(
            values
                .iter()
                .map(|value| if value.is_finite() { *value } else { 0.0 }),
        );
        level.sum_sq.extend(values.iter().map(|value| {
            if value.is_finite() {
                *value * *value
            } else {
                0.0
            }
        }));
        level.sample_count.resize(values.len(), 1);
        level
            .finite_count
            .extend(values.iter().map(|value| u32::from(value.is_finite())));
        level.flags.extend(values.iter().map(|value| {
            if value.is_finite() {
                HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX
            } else {
                HAS_GAP
            }
        }));
        return level;
    }
    let mut stack = Vec::with_capacity(index + 2);
    for bin in 0..range.len() {
        let start = bin.saturating_mul(width);
        if start >= time.len() {
            break;
        }
        let merged = fold_bin(time, values, start, width, &mut stack);
        level.push(&merged);
    }
    level
}

fn fold_bin(
    time: &[f64],
    values: &[f64],
    start: usize,
    width: usize,
    stack: &mut Vec<(u32, EnvelopeBin)>,
) -> EnvelopeBin {
    let end = (start + width).min(time.len());
    stack.clear();
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

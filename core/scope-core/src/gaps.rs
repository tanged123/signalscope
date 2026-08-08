use std::sync::Arc;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GapRuns(Arc<[(u64, u64)]>);

#[derive(Debug, Default)]
pub struct GapRunBuilder {
    open_start: Option<u64>,
    next_index: u64,
    ranges: Vec<(u64, u64)>,
}

impl GapRunBuilder {
    pub fn push(&mut self, value: f64) {
        if value.is_nan() {
            self.open_start.get_or_insert(self.next_index);
        } else if let Some(start) = self.open_start.take() {
            self.ranges.push((start, self.next_index));
        }
        self.next_index = self.next_index.saturating_add(1);
    }

    pub fn extend(&mut self, values: &[f64]) {
        values.iter().copied().for_each(|value| self.push(value));
    }

    #[must_use]
    pub fn finish(mut self) -> GapRuns {
        if let Some(start) = self.open_start.take() {
            self.ranges.push((start, self.next_index));
        }
        GapRuns::from_ranges(self.ranges).expect("gap builder emits valid runs")
    }
}

impl GapRuns {
    #[must_use]
    pub fn from_values(values: &[f64]) -> Self {
        let mut builder = GapRunBuilder::default();
        builder.extend(values);
        builder.finish()
    }

    #[must_use]
    pub fn from_ranges(ranges: Vec<(u64, u64)>) -> Option<Self> {
        if ranges.iter().any(|(start, end)| start >= end)
            || ranges.windows(2).any(|pair| pair[0].1 >= pair[1].0)
        {
            return None;
        }
        Some(Self(Arc::from(ranges)))
    }

    #[must_use]
    pub fn as_slice(&self) -> &[(u64, u64)] {
        &self.0
    }

    #[must_use]
    pub fn breaks_between(&self, left: u64, right: u64) -> bool {
        if right <= left.saturating_add(1) {
            return false;
        }
        let first = self
            .0
            .partition_point(|(_, end)| *end <= left.saturating_add(1));
        self.0.get(first..).is_some_and(|runs| {
            runs.iter()
                .any(|(start, end)| *start < right && *end > left + 1)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_carries_gap_runs_across_chunks_and_closes_trailing_nan() {
        let mut builder = GapRunBuilder::default();
        builder.extend(&[1.0, f64::NAN]);
        builder.extend(&[f64::NAN, 2.0, f64::NAN]);
        assert_eq!(builder.finish().as_slice(), &[(1, 3), (4, 5)]);
    }

    #[test]
    fn builder_keeps_all_finite_input_empty() {
        let mut builder = GapRunBuilder::default();
        builder.extend(&[1.0, 2.0, 3.0]);
        assert!(builder.finish().as_slice().is_empty());
    }

    #[test]
    fn gap_runs_are_sorted_disjoint_and_half_open() {
        let runs = GapRuns::from_values(&[1.0, f64::NAN, f64::NAN, 2.0, f64::NAN, 3.0]);
        assert_eq!(runs.as_slice(), &[(1, 3), (4, 5)]);
        assert!(runs.breaks_between(0, 3));
        assert!(!runs.breaks_between(3, 3));
        assert!(runs.breaks_between(3, 5));
    }
}

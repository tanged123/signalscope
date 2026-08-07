use std::sync::Arc;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GapRuns(Arc<[(u64, u64)]>);

impl GapRuns {
    #[must_use]
    pub fn from_values(values: &[f64]) -> Self {
        let mut ranges = Vec::new();
        let mut start = None;
        for (index, value) in values.iter().enumerate() {
            if value.is_nan() {
                start.get_or_insert(index as u64);
            } else if let Some(start) = start.take() {
                ranges.push((start, index as u64));
            }
        }
        if let Some(start) = start {
            ranges.push((start, values.len() as u64));
        }
        Self(Arc::from(ranges))
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
    fn gap_runs_are_sorted_disjoint_and_half_open() {
        let runs = GapRuns::from_values(&[1.0, f64::NAN, f64::NAN, 2.0, f64::NAN, 3.0]);
        assert_eq!(runs.as_slice(), &[(1, 3), (4, 5)]);
        assert!(runs.breaks_between(0, 3));
        assert!(!runs.breaks_between(3, 3));
        assert!(runs.breaks_between(3, 5));
    }
}

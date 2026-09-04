//! Host-independent signal transforms.

/// Sample-wise central-difference derivative, matching MATLAB's `gradient`
/// for non-uniform spacing: one-sided at the two ends, centered elsewhere.
///
/// # Panics
///
/// Panics when `time` and `values` have different lengths.
#[must_use]
pub fn gradient(time: &[f64], values: &[f64]) -> Vec<f64> {
    assert_eq!(time.len(), values.len(), "time/value lengths differ");
    if time.is_empty() {
        return Vec::new();
    }

    (0..time.len())
        .map(|index| {
            let left = index.saturating_sub(1);
            let right = (index + 1).min(time.len() - 1);
            let dt = time[right] - time[left];
            if dt == 0.0 {
                f64::NAN
            } else {
                (values[right] - values[left]) / dt
            }
        })
        .collect()
}

/// Cumulative trapezoidal integral, matching MATLAB's `cumtrapz`. Pairs
/// containing a non-finite value contribute nothing rather than poisoning
/// the running total.
///
/// # Panics
///
/// Panics when `time` and `values` have different lengths.
#[must_use]
pub fn cumtrapz(time: &[f64], values: &[f64]) -> Vec<f64> {
    assert_eq!(time.len(), values.len(), "time/value lengths differ");
    let mut result = vec![0.0; time.len()];
    for index in 1..time.len() {
        let left = values[index - 1];
        let right = values[index];
        result[index] = result[index - 1];
        if left.is_finite() && right.is_finite() {
            result[index] += (left + right) * 0.5 * (time[index] - time[index - 1]);
        }
    }
    result
}

/// Centered moving mean over `window` samples, matching MATLAB's
/// `movmean(values, window, 'omitnan')` for odd windows. Even windows differ:
/// MATLAB spans `[i-k/2, i+k/2-1]` while this spans `half = k/2` on both
/// sides, giving `k+1` samples. The UI only generates odd windows.
#[must_use]
pub fn movmean(values: &[f64], window: usize) -> Vec<f64> {
    let window = window.max(1);
    let half = window / 2;
    (0..values.len())
        .map(|index| {
            let start = index.saturating_sub(half);
            let end = (index + half + 1).min(values.len());
            let (sum, count) = values[start..end]
                .iter()
                .filter(|value| value.is_finite())
                .fold((0.0, 0_u32), |(sum, count), value| (sum + value, count + 1));
            if count == 0 {
                f64::NAN
            } else {
                sum / f64::from(count)
            }
        })
        .collect()
}

/// Linearly interpolates `values` at `query`, returning NaN outside the
/// sample range rather than holding the endpoints flat.
///
/// This mirrors `lerpSample` in `frontend/src/app/samples.ts` exactly;
/// `protocol/testdata/lerp-conformance.json` locks the two together.
#[must_use]
#[allow(clippy::float_cmp)]
pub fn lerp_at(time: &[f64], values: &[f64], query: f64) -> f64 {
    let count = time.len();
    if count == 0 || query < time[0] || query > time[count - 1] {
        return f64::NAN;
    }
    let mut low = 0;
    let mut high = count - 1;
    while low < high {
        let mid = low + (high - low) / 2;
        if time[mid] < query {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    if time[low] == query {
        return values[low];
    }
    let previous = low.saturating_sub(1);
    let span = time[low] - time[previous];
    if span == 0.0 {
        return values[low];
    }
    let alpha = (query - time[previous]) / span;
    values[previous] + (values[low] - values[previous]) * alpha
}

/// A decimated slice of a signal restricted to a time window.
#[derive(Clone, Debug, PartialEq)]
pub struct SampleSlice {
    pub time: Vec<f64>,
    pub values: Vec<f64>,
    /// The index step applied while decimating; 1 when nothing was dropped.
    pub stride: u32,
}

/// Selects at most `max_points` samples inside `[t0, t1]`, plus one
/// neighbour past each edge so strokes reach the plot border.
///
/// The index arithmetic here is protocol surface: `BakedPlane` mirrors it in
/// TypeScript and `protocol/testdata/sample-conformance.json` locks the two
/// together.
///
/// # Panics
///
/// Panics when `time` and `values` have different lengths.
#[must_use]
pub fn sample_window(
    time: &[f64],
    values: &[f64],
    t0: f64,
    t1: f64,
    max_points: u32,
) -> SampleSlice {
    assert_eq!(time.len(), values.len(), "time/value lengths differ");
    let Some((start, end)) = crate::time_window::padded_time_window(time, t0, t1) else {
        return SampleSlice {
            time: Vec::new(),
            values: Vec::new(),
            stride: 1,
        };
    };
    let span = end - start;
    let cap = max_points.max(1) as usize;
    let stride = span.div_ceil(cap).max(1);
    let mut picked_time = Vec::with_capacity(span / stride + 2);
    let mut picked_values = Vec::with_capacity(span / stride + 2);
    let mut index = start;
    while index < end {
        picked_time.push(time[index]);
        picked_values.push(values[index]);
        index += stride;
    }
    if picked_time.last() != Some(&time[end - 1]) {
        picked_time.push(time[end - 1]);
        picked_values.push(values[end - 1]);
    }
    SampleSlice {
        time: picked_time,
        values: picked_values,
        stride: u32::try_from(stride).unwrap_or(u32::MAX),
    }
}

/// Returns every sample inside `[t0, t1]`, plus one neighbour past each edge.
///
/// `max_points` remains on the wire for protocol compatibility, but callers
/// use this helper when a sample-mode panel needs the full window.
///
/// # Panics
///
/// Panics when `time` and `values` have different lengths.
#[must_use]
pub fn sample_window_full(time: &[f64], values: &[f64], t0: f64, t1: f64) -> SampleSlice {
    assert_eq!(time.len(), values.len(), "time/value lengths differ");
    let Some((start, end)) = crate::time_window::padded_time_window(time, t0, t1) else {
        return SampleSlice {
            time: Vec::new(),
            values: Vec::new(),
            stride: 1,
        };
    };
    SampleSlice {
        time: time[start..end].to_vec(),
        values: values[start..end].to_vec(),
        stride: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::float_cmp)]
    fn transforms_match_prototype_semantics() {
        let time = [0.0, 1.0, 2.0];
        let values = [0.0, 2.0, 4.0];

        assert_eq!(gradient(&time, &values), [2.0, 2.0, 2.0]);
        assert_eq!(cumtrapz(&time, &values), [0.0, 1.0, 4.0]);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn lerp_at_interpolates_and_refuses_to_extrapolate() {
        let time = [0.0, 1.0, 3.0];
        let values = [0.0, 10.0, 30.0];

        assert_eq!(lerp_at(&time, &values, 0.0), 0.0);
        assert_eq!(lerp_at(&time, &values, 1.0), 10.0);
        assert_eq!(lerp_at(&time, &values, 2.0), 20.0);
        assert_eq!(lerp_at(&time, &values, 3.0), 30.0);
        assert!(lerp_at(&time, &values, -0.5).is_nan());
        assert!(lerp_at(&time, &values, 3.5).is_nan());
        assert!(lerp_at(&[], &[], 0.0).is_nan());
    }

    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct LerpFixture {
        time: Vec<f64>,
        values: Vec<f64>,
        queries: Vec<f64>,
        results: Vec<f64>,
    }

    const LERP_FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/lerp-conformance.json"
    );

    #[test]
    fn lerp_conformance_fixture_matches_rust() {
        let time: Vec<f64> = (0..64).map(|index| f64::from(index) * 0.375).collect();
        let values: Vec<f64> = time
            .iter()
            .enumerate()
            .map(|(index, value)| value * 2.5 - f64::from(u32::try_from(index % 7).unwrap()))
            .collect();
        let queries = vec![0.0, 0.1, 0.375, 1.0, 5.5, 11.812_5, 23.624_9, 23.625];
        let current = LerpFixture {
            time: time.clone(),
            values: values.clone(),
            results: queries
                .iter()
                .map(|query| lerp_at(&time, &values, *query))
                .collect(),
            queries,
        };
        if std::env::var("REGENERATE_FIXTURES").is_ok() {
            std::fs::write(
                LERP_FIXTURE_PATH,
                format!("{}\n", serde_json::to_string_pretty(&current).unwrap()),
            )
            .expect("write fixture");
            return;
        }
        let stored: LerpFixture = serde_json::from_str(
            &std::fs::read_to_string(LERP_FIXTURE_PATH).expect("read fixture"),
        )
        .expect("parse fixture");
        assert_eq!(stored, current, "regenerate with REGENERATE_FIXTURES=1");
    }

    #[test]
    fn sample_window_includes_one_neighbour_past_each_edge() {
        let time: Vec<f64> = (0..10).map(f64::from).collect();
        let values: Vec<f64> = time.iter().map(|value| value * 2.0).collect();
        let slice = sample_window(&time, &values, 3.0, 5.0, 100);
        assert_eq!(slice.stride, 1);
        assert_eq!(slice.time, vec![2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(slice.values, vec![4.0, 6.0, 8.0, 10.0, 12.0]);
    }

    #[test]
    fn sample_window_full_ignores_compatibility_cap() {
        let time: Vec<f64> = (0..100).map(f64::from).collect();
        let values = time.clone();
        let slice = sample_window_full(&time, &values, 20.0, 79.0);

        assert_eq!(slice.stride, 1);
        assert_eq!(slice.time.len(), 62);
        assert_eq!(slice.time.first(), Some(&19.0));
        assert_eq!(slice.time.last(), Some(&80.0));
        assert_eq!(slice.time, (19..=80).map(f64::from).collect::<Vec<_>>());
        assert_eq!(slice.values, slice.time);
    }

    #[test]
    fn sample_window_strides_to_the_cap_and_keeps_the_last_sample() {
        let time: Vec<f64> = (0..100).map(f64::from).collect();
        let values = time.clone();
        let slice = sample_window(&time, &values, 0.0, 99.0, 10);
        assert_eq!(slice.stride, 10);
        assert_eq!(slice.time.first(), Some(&0.0));
        assert_eq!(slice.time.last(), Some(&99.0));
        assert!(slice.time.len() <= 11, "cap plus the retained last sample");
        assert_eq!(slice.time.len(), slice.values.len());
    }

    #[test]
    fn sample_window_outside_the_data_is_empty() {
        let time: Vec<f64> = (0..10).map(f64::from).collect();
        let values = time.clone();
        for (t0, t1) in [(100.0, 200.0), (-200.0, -100.0)] {
            let slice = sample_window(&time, &values, t0, t1, 64);
            assert!(slice.time.is_empty());
            assert!(slice.values.is_empty());
            assert_eq!(slice.stride, 1);
        }
    }

    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct SampleFixture {
        time: Vec<f64>,
        values: Vec<f64>,
        queries: Vec<SampleFixtureQuery>,
    }

    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct SampleFixtureQuery {
        t0: f64,
        t1: f64,
        max_points: u32,
        stride: u32,
        time: Vec<f64>,
        values: Vec<f64>,
    }

    const SAMPLE_FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/sample-conformance.json"
    );

    #[test]
    fn sample_conformance_fixture_matches_rust() {
        let time: Vec<f64> = (0..500).map(|index| f64::from(index) * 0.25).collect();
        let values: Vec<f64> = time
            .iter()
            .enumerate()
            .map(|(index, value)| {
                value * 1.25 + f64::from(u32::try_from(index % 17).unwrap()) * 0.5
            })
            .collect();
        let windows = [
            (0.0, 124.75, 4_096_u32),
            (0.0, 124.75, 64),
            (30.0, 40.0, 32),
            (-1_000.0, -900.0, 64),
            (900.0, 1_000.0, 64),
        ];
        let current = SampleFixture {
            time: time.clone(),
            values: values.clone(),
            queries: windows
                .iter()
                .map(|&(t0, t1, max_points)| {
                    let slice = sample_window(&time, &values, t0, t1, max_points);
                    SampleFixtureQuery {
                        t0,
                        t1,
                        max_points,
                        stride: slice.stride,
                        time: slice.time,
                        values: slice.values,
                    }
                })
                .collect(),
        };
        if std::env::var("REGENERATE_FIXTURES").is_ok() {
            std::fs::write(
                SAMPLE_FIXTURE_PATH,
                format!("{}\n", serde_json::to_string_pretty(&current).unwrap()),
            )
            .expect("write fixture");
            return;
        }
        let stored: SampleFixture = serde_json::from_str(
            &std::fs::read_to_string(SAMPLE_FIXTURE_PATH).expect("read fixture"),
        )
        .expect("parse fixture");
        assert_eq!(stored, current, "regenerate with REGENERATE_FIXTURES=1");
    }
}

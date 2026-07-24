//! Host-independent signal transforms.

/// Calculates the sample-wise derivative.
///
/// # Panics
///
/// Panics when `time` and `values` have different lengths.
#[must_use]
pub fn derivative(time: &[f64], values: &[f64]) -> Vec<f64> {
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

/// Calculates the cumulative trapezoidal integral.
///
/// # Panics
///
/// Panics when `time` and `values` have different lengths.
#[must_use]
pub fn integrate(time: &[f64], values: &[f64]) -> Vec<f64> {
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

#[must_use]
pub fn smooth(values: &[f64], window: usize) -> Vec<f64> {
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

/// Linearly interpolates a value at `query`.
///
/// # Panics
///
/// Panics when `time` and `values` have different lengths.
#[must_use]
pub fn lerp_at(time: &[f64], values: &[f64], query: f64) -> f64 {
    assert_eq!(time.len(), values.len(), "time/value lengths differ");
    if time.is_empty() || query < time[0] || query > time[time.len() - 1] {
        return f64::NAN;
    }
    match time.binary_search_by(|value| value.total_cmp(&query)) {
        Ok(index) => values[index],
        Err(0) => values[0],
        Err(index) if index == time.len() => values[index - 1],
        Err(index) => {
            let left = index - 1;
            let fraction = (query - time[left]) / (time[index] - time[left]);
            values[left] + (values[index] - values[left]) * fraction
        }
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

        assert_eq!(derivative(&time, &values), [2.0, 2.0, 2.0]);
        assert_eq!(integrate(&time, &values), [0.0, 1.0, 4.0]);
        assert_eq!(lerp_at(&time, &values, 0.5), 1.0);
    }
}

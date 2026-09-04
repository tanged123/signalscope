/// Returns the indices covering `[t0, t1]` with one neighboring sample on
/// each side when available.
#[must_use]
pub fn padded_time_window(time: &[f64], t0: f64, t1: f64) -> Option<(usize, usize)> {
    if time.is_empty() || t1 < time[0] || t0 > time[time.len() - 1] {
        return None;
    }
    let start = time.partition_point(|value| *value < t0).saturating_sub(1);
    let end = (time.partition_point(|value| *value <= t1) + 1).min(time.len());
    (start < end).then_some((start, end))
}

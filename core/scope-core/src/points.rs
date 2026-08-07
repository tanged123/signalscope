use crate::{bins::BinLevel, columns::Column, gaps::GapRuns};

pub type RenderPoint = scope_protocol::TilePoint;

pub(crate) fn ordered_points(
    time: &Column,
    values: &Column,
    gaps: &GapRuns,
    bins: &BinLevel,
) -> Option<Vec<RenderPoint>> {
    let mut indexes = Vec::with_capacity(bins.len().saturating_mul(4));
    for index in 0..bins.len() {
        let bin = bins.get(index)?;
        indexes.extend(
            [
                bin.first_index(),
                bin.min_index(),
                bin.max_index(),
                bin.last_index(),
            ]
            .into_iter()
            .flatten(),
        );
    }
    indexes.sort_unstable();
    indexes.dedup();
    let times = time.gather(&indexes).ok()?;
    let values = values.gather(&indexes).ok()?;
    let mut points = indexes
        .into_iter()
        .zip(times)
        .zip(values)
        .map(|((source_index, time), value)| RenderPoint {
            time,
            value,
            source_index,
            break_before: false,
        })
        .collect::<Vec<_>>();
    mark_breaks(&mut points, gaps);
    Some(points)
}

fn mark_breaks(points: &mut [RenderPoint], gaps: &GapRuns) {
    if let Some(first) = points.first_mut() {
        first.break_before = true;
    }
    for index in 1..points.len() {
        let left = points[index - 1].source_index;
        let right = points[index].source_index;
        points[index].break_before = gaps.breaks_between(left, right);
    }
}

#[cfg(test)]
mod tests {
    use crate::pyramid::Pyramid;

    #[test]
    fn extrema_are_sorted_and_duplicate_indices_are_removed() {
        let query = Pyramid::from_samples(&[0.0, 1.0, 2.0, 3.0], &[4.0, -2.0, 9.0, 7.0])
            .query_with_target(0.0, 3.0, 1, Some(1));
        assert_eq!(
            query
                .points
                .iter()
                .map(|point| point.source_index)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3],
        );
    }

    #[test]
    fn level_zero_is_raw_passthrough_with_gap_breaks() {
        let query = Pyramid::from_samples(&[10.0, 11.0, 12.0, 13.0], &[1.0, f64::NAN, 3.0, 4.0])
            .query_with_target(10.0, 13.0, 100, None);
        assert_eq!(query.points.len(), 3);
        assert_eq!(query.points[1].source_index, 2);
        assert!(query.points[1].break_before);
    }
}

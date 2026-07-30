//! Across-run ensemble statistics.
//!
//! Each grid cell reduces every run to one overlap-weighted mean, then gives
//! those means equal weight. Bin overlap assumes uniform in-bin spacing.

use scope_protocol::EnvelopeBin;

use crate::sets::AffineTransform;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub t0: f64,
    pub t1: f64,
    pub cells: u32,
}

impl Grid {
    #[must_use]
    pub fn new(t0: f64, t1: f64, cells: u32) -> Self {
        Self {
            t0,
            t1,
            cells: cells.max(1),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MemberBins {
    pub bins: Vec<EnvelopeBin>,
    pub transform: AffineTransform,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EnsembleCell {
    pub t0: f64,
    pub t1: f64,
    pub min_run_mean: f64,
    pub max_run_mean: f64,
    pub mean_of_run_means: f64,
    pub sigma: f64,
    pub run_count: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum EnsembleError {
    #[error("source set requires time alignment")]
    AlignmentRequired,
}

#[must_use]
pub fn ensemble_cells(members: &[MemberBins], grid: &Grid) -> Vec<EnsembleCell> {
    let width = (grid.t1 - grid.t0) / f64::from(grid.cells);
    (0..grid.cells)
        .map(|index| {
            let t0 = width.mul_add(f64::from(index), grid.t0);
            let t1 = if index + 1 == grid.cells {
                grid.t1
            } else {
                t0 + width
            };
            aggregate_cell(
                members.iter().filter_map(|member| run_mean(member, t0, t1)),
                t0,
                t1,
            )
        })
        .collect()
}

#[allow(clippy::cast_precision_loss, clippy::float_cmp)]
fn run_mean(member: &MemberBins, cell_t0: f64, cell_t1: f64) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0.0;
    for bin in &member.bins {
        if bin.finite_count == 0 {
            continue;
        }
        let t0 = member.transform.apply(bin.t0);
        let t1 = member.transform.apply(bin.t1);
        let (t0, t1) = (t0.min(t1), t0.max(t1));
        let fraction = if t0 == t1 {
            f64::from(t0 >= cell_t0 && t0 < cell_t1)
        } else {
            ((t1.min(cell_t1) - t0.max(cell_t0)) / (t1 - t0)).clamp(0.0, 1.0)
        };
        if fraction > 0.0 {
            sum += fraction * bin.sum;
            count += fraction * bin.finite_count as f64;
        }
    }
    (count > 0.0).then_some(sum / count)
}

#[allow(clippy::cast_precision_loss)]
fn aggregate_cell(means: impl Iterator<Item = f64>, t0: f64, t1: f64) -> EnsembleCell {
    let means = means.collect::<Vec<_>>();
    if means.is_empty() {
        return EnsembleCell {
            t0,
            t1,
            min_run_mean: f64::NAN,
            max_run_mean: f64::NAN,
            mean_of_run_means: f64::NAN,
            sigma: f64::NAN,
            run_count: 0,
        };
    }
    let count = means.len() as f64;
    let mean = means.iter().sum::<f64>() / count;
    let variance = means
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / count;
    EnsembleCell {
        t0,
        t1,
        min_run_mean: means.iter().copied().fold(f64::INFINITY, f64::min),
        max_run_mean: means.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        mean_of_run_means: mean,
        sigma: variance.sqrt(),
        run_count: u32::try_from(means.len()).unwrap_or(u32::MAX),
    }
}

/// Ensemble cells discard run identity and cannot be merged.
#[cfg(debug_assertions)]
pub fn assert_not_merged(cells: &[EnsembleCell]) {
    debug_assert!(cells.is_empty(), "ensemble cells cannot be merged");
}

#[cfg(test)]
mod tests {
    use scope_protocol::EnvelopeBin;

    use super::*;
    use crate::sets::AffineTransform;

    #[allow(clippy::cast_precision_loss)]
    fn bin(t0: f64, t1: f64, sum: f64, count: u64) -> EnvelopeBin {
        EnvelopeBin {
            t0,
            t1,
            first: Some(sum / count as f64),
            last: Some(sum / count as f64),
            min: Some(sum / count as f64),
            max: Some(sum / count as f64),
            sum,
            sum_sq: 0.0,
            finite_count: count,
            sample_count: count,
            has_gap: false,
        }
    }

    fn member(bins: Vec<EnvelopeBin>) -> MemberBins {
        MemberBins {
            bins,
            transform: AffineTransform {
                scale: 1.0,
                offset: 0.0,
            },
        }
    }

    fn constant_member(value: f64) -> MemberBins {
        member(vec![bin(0.0, 10.0, value * 10.0, 10)])
    }

    #[test]
    fn runs_are_weighted_equally_regardless_of_sample_count() {
        let cells = ensemble_cells(
            &[
                member(vec![bin(0.0, 1.0, 100.0, 100)]),
                member(vec![bin(0.0, 1.0, 3.0, 1)]),
            ],
            &Grid::new(0.0, 1.0, 1),
        );
        let cell = &cells[0];
        assert!((cell.mean_of_run_means - 2.0).abs() < 1e-12);
        assert!((cell.min_run_mean - 1.0).abs() < 1e-12);
        assert!((cell.max_run_mean - 3.0).abs() < 1e-12);
        assert_eq!(cell.run_count, 2);
        assert!((cell.sigma - 1.0).abs() < 1e-12);
    }

    #[test]
    fn the_band_is_run_scatter_not_within_bin_variance() {
        let oscillating = || member(vec![bin(0.0, 1.0, 50.0, 10)]);
        let cells = ensemble_cells(&[oscillating(), oscillating()], &Grid::new(0.0, 1.0, 1));
        assert!(cells[0].sigma.abs() < 1e-12);
        assert!((cells[0].max_run_mean - cells[0].min_run_mean).abs() < 1e-12);
    }

    #[test]
    fn a_dropout_thins_the_band_instead_of_gapping_it() {
        let full = member(vec![
            bin(0.0, 1.0, 1.0, 1),
            bin(1.0, 2.0, 1.0, 1),
            bin(2.0, 3.0, 1.0, 1),
        ]);
        let dropout = member(vec![bin(0.0, 1.0, 1.0, 1), bin(2.0, 3.0, 1.0, 1)]);
        let cells = ensemble_cells(&[full, dropout], &Grid::new(0.0, 3.0, 3));
        assert_eq!(
            cells.iter().map(|cell| cell.run_count).collect::<Vec<_>>(),
            vec![2, 1, 2]
        );
    }

    #[test]
    fn known_distributions_reproduce_their_statistics_at_every_grid_width() {
        let members = (0..10)
            .map(|index| constant_member(f64::from(index)))
            .collect::<Vec<_>>();
        for pixels in [1, 4, 16, 64] {
            for cell in ensemble_cells(&members, &Grid::new(0.0, 10.0, pixels)) {
                assert!((cell.mean_of_run_means - 4.5).abs() < 1e-9);
                assert!((cell.sigma - 2.872_281_323_269_014).abs() < 1e-9);
                assert_eq!(cell.run_count, 10);
            }
        }
    }

    #[test]
    fn partially_overlapping_member_bins_apportion_by_time_overlap() {
        let cells = ensemble_cells(
            &[member(vec![bin(0.0, 2.0, 4.0, 2)])],
            &Grid::new(0.0, 1.0, 1),
        );
        assert!((cells[0].mean_of_run_means - 2.0).abs() < 1e-12);
    }
}

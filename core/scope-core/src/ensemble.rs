//! Across-run ensemble statistics.
//!
//! Each grid cell reduces every run to one overlap-weighted mean, then gives
//! those means equal weight. Bin overlap assumes uniform in-bin spacing.

use std::collections::{BTreeMap, BTreeSet};

use scope_protocol::EnvelopeBin;
use sha2::{Digest, Sha256};

use crate::{
    cache::{self, CACHE_VERSION, CacheRoot},
    paging::{PageCache, PageError, PageHandle},
    pyramid::Pyramid,
    sets::{AffineTransform, SetKey, SourceSet},
    store::{SignalId, SignalStore, SourceKey},
};

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
    #[error("ensemble requested {requested} members; limit is {limit}")]
    TooManyMembers { requested: usize, limit: usize },
    #[error("a set member does not contain the requested signal")]
    MissingSignal,
    #[error("materialized generation {materialized} does not match set generation {current}")]
    StaleGeneration { materialized: u64, current: u64 },
    #[error(transparent)]
    Page(#[from] PageError),
    #[error(transparent)]
    Cache(#[from] cache::CacheError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub max_members: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_members: 64 }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EnsembleTile {
    pub cells: Vec<EnsembleCell>,
    pub generation: u64,
    pub set_key: SetKey,
    pub member_keys: Vec<SourceKey>,
    pub level: u32,
    pub source: TileSource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TileSource {
    QueryTimeMerge,
    Materialized,
}

#[derive(Clone, Debug)]
pub struct MaterializedSet {
    set_key: SetKey,
    generation: u64,
    member_keys: Vec<SourceKey>,
    signals: BTreeMap<String, Vec<MaterializedLevel>>,
    windows: BTreeMap<String, (f64, f64)>,
}

#[derive(Clone, Debug)]
struct MaterializedLevel {
    handle: PageHandle,
    cells: usize,
}

impl MaterializedSet {
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    #[must_use]
    pub fn level_count(&self, local_path: &str) -> usize {
        self.signals.get(local_path).map_or(0, Vec::len)
    }

    /// # Errors
    ///
    /// Returns an error when the backing page cannot be read.
    pub fn level(
        &self,
        local_path: &str,
        index: usize,
    ) -> Result<Vec<EnsembleCell>, EnsembleError> {
        let level = self
            .signals
            .get(local_path)
            .and_then(|levels| levels.get(index))
            .ok_or(EnsembleError::MissingSignal)?;
        decode_cells(&level.handle.values()?).ok_or(EnsembleError::MissingSignal)
    }

    /// # Errors
    ///
    /// Returns an error when the signal is absent or its page cannot be read.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::cast_sign_loss
    )]
    pub fn level_window(
        &self,
        local_path: &str,
        window: (f64, f64),
        pixel_width: u32,
    ) -> Result<(u32, Vec<EnsembleCell>), EnsembleError> {
        let levels = self
            .signals
            .get(local_path)
            .ok_or(EnsembleError::MissingSignal)?;
        let full = self
            .windows
            .get(local_path)
            .ok_or(EnsembleError::MissingSignal)?;
        let target = usize::try_from(pixel_width.max(1))
            .unwrap_or(usize::MAX)
            .saturating_mul(2);
        let fraction = if full.1 > full.0 {
            ((window.1.min(full.1) - window.0.max(full.0)) / (full.1 - full.0)).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let index = levels
            .iter()
            .position(|level| {
                ((level.cells as f64 * fraction).ceil() as usize).saturating_add(2) <= target
            })
            .unwrap_or_else(|| levels.len().saturating_sub(1));
        let cells = self
            .level(local_path, index)?
            .into_iter()
            .filter(|cell| cell.t1 >= window.0 && cell.t0 <= window.1)
            .collect();
        Ok((u32::try_from(index).unwrap_or(u32::MAX), cells))
    }
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

/// Builds independently queryable levels for every complete set signal.
///
/// # Errors
///
/// Returns an error for invalid alignment, missing member data, or cache IO.
pub fn materialize(
    set: &SourceSet,
    store: &SignalStore,
    pyramids: &BTreeMap<SignalId, Pyramid>,
    root: &CacheRoot,
) -> Result<MaterializedSet, EnsembleError> {
    set.alignment()
        .map_err(|_| EnsembleError::AlignmentRequired)?;
    let directory = root.directory().join("ensemble").join(format!(
        "{}-{}-v{}",
        set.key.0, set.generation, CACHE_VERSION
    ));
    let capacity = set
        .members
        .keys()
        .filter_map(|key| store.sources().find(|source| source.key == *key))
        .flat_map(|source| store.signals_of(source.id))
        .map(|signal| signal.len().saturating_mul(7 * size_of::<f64>()))
        .max()
        .unwrap_or(1)
        .max(64 * 1024 * 1024);
    let pages = PageCache::new(&directory, capacity);
    let page_root = CacheRoot::app_owned(&directory);
    let mut signals = BTreeMap::new();
    let mut windows = BTreeMap::new();

    for local_path in &set.fingerprint.local_paths {
        let members = member_pyramids(set, local_path, store, pyramids)?;
        let level_count = members
            .iter()
            .map(|(_, pyramid)| pyramid.level_count())
            .min()
            .unwrap_or(0);
        let window = aligned_window(set, local_path, store)?;
        let mut levels = Vec::with_capacity(level_count);
        for index in 0..level_count {
            let bins = members
                .iter()
                .map(|(transform, pyramid)| MemberBins {
                    bins: pyramid.level(index).unwrap_or_default(),
                    transform: *transform,
                })
                .collect::<Vec<_>>();
            let cells = bins
                .iter()
                .map(|member| member.bins.len())
                .max()
                .unwrap_or(1);
            let cells = u32::try_from(cells).unwrap_or(u32::MAX).max(1);
            let cells = ensemble_cells(&bins, &Grid::new(window.0, window.1, cells));
            let mut hash = Sha256::new();
            hash.update(local_path.as_bytes());
            let name = format!("{:x}-{index}.ssens", hash.finalize());
            let handle = cache::write_page(&page_root, &name, &encode_cells(&cells), &pages)?;
            levels.push(MaterializedLevel {
                handle,
                cells: cells.len(),
            });
        }
        windows.insert(local_path.clone(), window);
        signals.insert(local_path.clone(), levels);
    }

    Ok(MaterializedSet {
        set_key: set.key,
        generation: set.generation,
        member_keys: set.members.keys().copied().collect(),
        signals,
        windows,
    })
}

/// # Errors
///
/// Returns an error for unaligned, oversized, or incomplete member queries.
#[allow(clippy::too_many_arguments)]
pub fn query(
    set: &SourceSet,
    local_path: &str,
    store: &SignalStore,
    pyramids: &BTreeMap<SignalId, Pyramid>,
    window: (f64, f64),
    pixel_width: u32,
    member_filter: Option<&BTreeSet<SourceKey>>,
    limits: Limits,
) -> Result<EnsembleTile, EnsembleError> {
    query_with_materialization(
        set,
        local_path,
        store,
        pyramids,
        window,
        pixel_width,
        member_filter,
        limits,
        None,
    )
}

/// # Errors
///
/// Returns an error for stale materialization or invalid query inputs.
#[allow(clippy::too_many_arguments)]
pub fn query_with_materialization(
    set: &SourceSet,
    local_path: &str,
    store: &SignalStore,
    pyramids: &BTreeMap<SignalId, Pyramid>,
    window: (f64, f64),
    pixel_width: u32,
    member_filter: Option<&BTreeSet<SourceKey>>,
    limits: Limits,
    materialized: Option<&MaterializedSet>,
) -> Result<EnsembleTile, EnsembleError> {
    set.alignment()
        .map_err(|_| EnsembleError::AlignmentRequired)?;
    if let Some(materialized) = materialized.filter(|_| member_filter.is_none()) {
        if materialized.set_key != set.key {
            return Err(EnsembleError::MissingSignal);
        }
        if materialized.generation != set.generation {
            return Err(EnsembleError::StaleGeneration {
                materialized: materialized.generation,
                current: set.generation,
            });
        }
        let (level, cells) = materialized.level_window(local_path, window, pixel_width)?;
        return Ok(EnsembleTile {
            cells,
            generation: set.generation,
            set_key: set.key,
            member_keys: materialized.member_keys.clone(),
            level,
            source: TileSource::Materialized,
        });
    }
    let member_keys = set
        .members
        .keys()
        .filter(|key| member_filter.is_none_or(|filter| filter.contains(key)))
        .copied()
        .collect::<Vec<_>>();
    if member_keys.len() > limits.max_members {
        return Err(EnsembleError::TooManyMembers {
            requested: member_keys.len(),
            limit: limits.max_members,
        });
    }

    let mut level = 0;
    let mut members = Vec::with_capacity(member_keys.len());
    for key in &member_keys {
        let transform = set
            .transform(*key)
            .ok_or(EnsembleError::AlignmentRequired)?;
        if !transform.scale.is_finite() || transform.scale == 0.0 {
            return Err(EnsembleError::AlignmentRequired);
        }
        let native_window = inverse_window(window, transform);
        let source = store
            .sources()
            .find(|source| source.key == *key)
            .ok_or(EnsembleError::MissingSignal)?;
        let signal = store
            .signals_of(source.id)
            .find(|signal| signal.local_path == local_path)
            .ok_or(EnsembleError::MissingSignal)?;
        let pyramid = pyramids
            .get(&signal.id)
            .ok_or(EnsembleError::MissingSignal)?;
        let selected = pyramid.query(native_window.0, native_window.1, pixel_width);
        level = level.max(selected.level);
        members.push(MemberBins {
            bins: selected.bins,
            transform,
        });
    }
    let grid = Grid::new(window.0, window.1, pixel_width.saturating_mul(2).max(1));
    Ok(EnsembleTile {
        cells: ensemble_cells(&members, &grid),
        generation: set.generation,
        set_key: set.key,
        member_keys,
        level,
        source: TileSource::QueryTimeMerge,
    })
}

fn member_pyramids<'a>(
    set: &SourceSet,
    local_path: &str,
    store: &SignalStore,
    pyramids: &'a BTreeMap<SignalId, Pyramid>,
) -> Result<Vec<(AffineTransform, &'a Pyramid)>, EnsembleError> {
    set.members
        .keys()
        .map(|key| {
            let transform = set
                .transform(*key)
                .ok_or(EnsembleError::AlignmentRequired)?;
            let source = store
                .sources()
                .find(|source| source.key == *key)
                .ok_or(EnsembleError::MissingSignal)?;
            let signal = store
                .signals_of(source.id)
                .find(|signal| signal.local_path == local_path)
                .ok_or(EnsembleError::MissingSignal)?;
            let pyramid = pyramids
                .get(&signal.id)
                .ok_or(EnsembleError::MissingSignal)?;
            Ok((transform, pyramid))
        })
        .collect()
}

fn aligned_window(
    set: &SourceSet,
    local_path: &str,
    store: &SignalStore,
) -> Result<(f64, f64), EnsembleError> {
    let mut window = (f64::INFINITY, f64::NEG_INFINITY);
    for key in set.members.keys() {
        let transform = set
            .transform(*key)
            .ok_or(EnsembleError::AlignmentRequired)?;
        let source = store
            .sources()
            .find(|source| source.key == *key)
            .ok_or(EnsembleError::MissingSignal)?;
        let signal = store
            .signals_of(source.id)
            .find(|signal| signal.local_path == local_path)
            .ok_or(EnsembleError::MissingSignal)?;
        let bounds = signal.time_bounds();
        let left = transform.apply(bounds.0);
        let right = transform.apply(bounds.1);
        window.0 = window.0.min(left).min(right);
        window.1 = window.1.max(left).max(right);
    }
    (window.0.is_finite() && window.1.is_finite())
        .then_some(window)
        .ok_or(EnsembleError::MissingSignal)
}

fn encode_cells(cells: &[EnsembleCell]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(cells.len() * 7 * size_of::<f64>());
    for cell in cells {
        for value in [
            cell.t0,
            cell.t1,
            cell.min_run_mean,
            cell.max_run_mean,
            cell.mean_of_run_means,
            cell.sigma,
            f64::from(cell.run_count),
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    bytes
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn decode_cells(bytes: &[f64]) -> Option<Vec<EnsembleCell>> {
    if bytes.len() % 7 != 0 {
        return None;
    }
    bytes
        .chunks_exact(7)
        .map(|values| {
            let run_count = values[6];
            if !run_count.is_finite()
                || run_count < 0.0
                || run_count > f64::from(u32::MAX)
                || run_count.fract() != 0.0
            {
                return None;
            }
            Some(EnsembleCell {
                t0: values[0],
                t1: values[1],
                min_run_mean: values[2],
                max_run_mean: values[3],
                mean_of_run_means: values[4],
                sigma: values[5],
                run_count: run_count as u32,
            })
        })
        .collect()
}

fn inverse_window(window: (f64, f64), transform: AffineTransform) -> (f64, f64) {
    let left = (window.0 - transform.offset) / transform.scale;
    let right = (window.1 - transform.offset) / transform.scale;
    (left.min(right), left.max(right))
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
    use std::{collections::BTreeMap, sync::Arc};

    use scope_protocol::EnvelopeBin;

    use super::*;
    use crate::{
        pyramid::Pyramid,
        sets::{AffineTransform, OriginKind, SourceSet, propose_sets},
        store::{SignalId, SignalStore, SourceKey},
    };

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

    fn key(index: u8) -> SourceKey {
        SourceKey(uuid::Uuid::from_bytes([index; 16]))
    }

    fn set_with(count: u8) -> SourceSet {
        propose_sets(
            &(1..=count)
                .map(|index| (key(index), vec!["value".to_owned()]))
                .collect::<Vec<_>>(),
        )
        .pop()
        .unwrap()
    }

    fn stored(count: u8) -> (SignalStore, BTreeMap<SignalId, Pyramid>) {
        let mut store = SignalStore::new();
        let mut pyramids = BTreeMap::new();
        for index in 1..=count {
            let source = store
                .register_source(format!("{index}.csv"), key(index), format!("r{index}"))
                .unwrap();
            let signal = store
                .insert_signal(
                    source,
                    "value",
                    None,
                    Arc::from([0.0, 0.5, 1.0]),
                    Arc::from([f64::from(index); 3]),
                )
                .unwrap();
            pyramids.insert(signal, Pyramid::from_signal(store.signal(signal).unwrap()));
        }
        (store, pyramids)
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

    #[test]
    fn an_unaligned_set_fails_closed() {
        let mut set = set_with(2);
        set.set_member_origin(key(1), OriginKind::AbsoluteEpoch);
        let (store, pyramids) = stored(2);
        assert!(matches!(
            query(
                &set,
                "value",
                &store,
                &pyramids,
                (0.0, 1.0),
                100,
                None,
                Limits::default()
            ),
            Err(EnsembleError::AlignmentRequired)
        ));
    }

    #[test]
    fn requests_above_the_member_limit_fail_with_an_actionable_error() {
        let set = set_with(200);
        let (store, pyramids) = stored(1);
        let error = query(
            &set,
            "value",
            &store,
            &pyramids,
            (0.0, 1.0),
            100,
            None,
            Limits { max_members: 64 },
        )
        .unwrap_err();
        assert!(matches!(
            error,
            EnsembleError::TooManyMembers {
                requested: 200,
                limit: 64
            }
        ));
    }

    #[test]
    fn a_filter_restricts_contributing_runs_and_is_reported_back() {
        let set = set_with(4);
        let (store, pyramids) = stored(4);
        let filter = BTreeSet::from([key(1), key(2)]);
        let tile = query(
            &set,
            "value",
            &store,
            &pyramids,
            (0.0, 1.0),
            8,
            Some(&filter),
            Limits::default(),
        )
        .unwrap();
        assert!(tile.cells.iter().all(|cell| cell.run_count <= 2));
        assert_eq!(tile.member_keys, vec![key(1), key(2)]);
        assert_eq!(tile.generation, set.generation);
    }

    #[test]
    fn cells_are_bounded_by_pixel_width() {
        let set = set_with(4);
        let (store, pyramids) = stored(4);
        let tile = query(
            &set,
            "value",
            &store,
            &pyramids,
            (0.0, 1_000.0),
            200,
            None,
            Limits::default(),
        )
        .unwrap();
        assert!(tile.cells.len() <= 402);
    }

    #[test]
    fn materialized_levels_are_built_from_runs_not_ensemble_children() {
        let set = set_with(2);
        let mut store = SignalStore::new();
        let mut pyramids = BTreeMap::new();
        for (index, values) in [[0.0, 100.0, 0.0, 100.0], [100.0, 0.0, 100.0, 0.0]]
            .into_iter()
            .enumerate()
        {
            let index = u8::try_from(index).unwrap();
            let source = store
                .register_source(format!("{index}.csv"), key(index + 1), format!("r{index}"))
                .unwrap();
            let signal = store
                .insert_signal(
                    source,
                    "value",
                    None,
                    Arc::from([0.0, 1.0, 2.0, 3.0]),
                    values.to_vec(),
                )
                .unwrap();
            pyramids.insert(signal, Pyramid::from_signal(store.signal(signal).unwrap()));
        }
        let root = tempfile::tempdir().unwrap();
        let materialized = materialize(
            &set,
            &store,
            &pyramids,
            &crate::cache::CacheRoot::app_owned(root.path()),
        )
        .unwrap();

        let fine = materialized.level("value", 0).unwrap();
        let coarse = materialized.level("value", 1).unwrap();
        assert!((fine[0].min_run_mean - coarse[0].min_run_mean).abs() > 1.0);
        assert!((coarse[0].min_run_mean - 50.0).abs() < 1e-12);
        assert!((coarse[0].max_run_mean - 50.0).abs() < 1e-12);
    }

    #[test]
    fn membership_changes_invalidate_materialized_levels() {
        let mut set = set_with(4);
        let (store, pyramids) = stored(4);
        let root = tempfile::tempdir().unwrap();
        let materialized = materialize(
            &set,
            &store,
            &pyramids,
            &crate::cache::CacheRoot::app_owned(root.path()),
        )
        .unwrap();
        set.remove_member(key(3));

        assert!(matches!(
            query_with_materialization(
                &set,
                "value",
                &store,
                &pyramids,
                (0.0, 1.0),
                8,
                None,
                Limits::default(),
                Some(&materialized),
            ),
            Err(EnsembleError::StaleGeneration { .. })
        ));
    }

    #[test]
    fn filtered_queries_bypass_full_set_materialization() {
        let set = set_with(4);
        let (store, pyramids) = stored(4);
        let root = tempfile::tempdir().unwrap();
        let materialized = materialize(
            &set,
            &store,
            &pyramids,
            &crate::cache::CacheRoot::app_owned(root.path()),
        )
        .unwrap();
        let filter = BTreeSet::from([key(1)]);
        let tile = query_with_materialization(
            &set,
            "value",
            &store,
            &pyramids,
            (0.0, 1.0),
            8,
            Some(&filter),
            Limits::default(),
            Some(&materialized),
        )
        .unwrap();

        assert_eq!(tile.source, TileSource::QueryTimeMerge);
    }
}

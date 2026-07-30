//! Signal and source registry for the native data plane.
//!
//! Phase 0 stores columns in owned memory while keeping the public boundary
//! compatible with future mmap-backed columns.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Stable identifier for a loaded source.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct SourceId(pub u64);

/// Durable workspace identity for a source.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct SourceKey(pub uuid::Uuid);

/// Stable identifier for a registered signal.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct SignalId(pub u64);

/// Metadata shared by all signals originating in one file or stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Source {
    pub id: SourceId,
    pub key: SourceKey,
    pub path: PathBuf,
    pub prefix: String,
    pub point_count: usize,
}

/// A time/value column pair. Both columns always have identical lengths.
#[derive(Clone, Debug)]
pub struct Signal {
    pub id: SignalId,
    pub source_id: SourceId,
    pub local_path: String,
    pub path: String,
    pub unit: Option<String>,
    time: Arc<[f64]>,
    values: Arc<[f64]>,
}

impl Signal {
    /// Creates a signal whose time and value columns share one length.
    ///
    /// # Errors
    ///
    /// Returns an error when the columns have different lengths or the time
    /// column is not finite and nondecreasing.
    pub fn new(
        id: SignalId,
        source_id: SourceId,
        local_path: impl Into<String>,
        path: impl Into<String>,
        unit: Option<String>,
        time: Arc<[f64]>,
        values: Arc<[f64]>,
    ) -> Result<Self, StoreError> {
        if time.len() != values.len() {
            return Err(StoreError::ColumnLengthMismatch {
                time: time.len(),
                values: values.len(),
            });
        }
        if let Some(index) = time.iter().position(|value| !value.is_finite()) {
            return Err(StoreError::NonFiniteTime { index });
        }
        if let Some(index) = time.windows(2).position(|pair| pair[0] > pair[1]) {
            return Err(StoreError::DecreasingTime { index: index + 1 });
        }

        Ok(Self {
            id,
            source_id,
            local_path: local_path.into(),
            path: path.into(),
            unit,
            time,
            values,
        })
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.time.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.time.is_empty()
    }

    #[must_use]
    pub fn time(&self) -> &[f64] {
        &self.time
    }

    #[must_use]
    pub fn values(&self) -> &[f64] {
        &self.values
    }

    /// The finite min/max of the time column, or `(0.0, 1.0)` when no
    /// finite samples exist, so presentation windows stay well-formed.
    #[must_use]
    pub fn time_bounds(&self) -> (f64, f64) {
        let mut finite = self.time.iter().copied().filter(|value| value.is_finite());
        let Some(first) = finite.next() else {
            return (0.0, 1.0);
        };
        finite.fold((first, first), |(min, max), value| {
            (min.min(value), max.max(value))
        })
    }

    #[must_use]
    pub fn time_shared(&self) -> Arc<[f64]> {
        Arc::clone(&self.time)
    }

    #[must_use]
    pub fn values_shared(&self) -> Arc<[f64]> {
        Arc::clone(&self.values)
    }
}

#[derive(Clone, Debug)]
pub struct SignalStore {
    next_source_id: u64,
    next_signal_id: u64,
    sources: BTreeMap<SourceId, Source>,
    signals: BTreeMap<SignalId, Signal>,
    prefixes: BTreeMap<String, SourceId>,
    by_storage: BTreeMap<(SourceId, String), SignalId>,
    signal_paths: BTreeMap<String, SignalId>,
}

impl SignalStore {
    #[must_use]
    pub fn new() -> Self {
        Self {
            next_source_id: 1,
            next_signal_id: 1,
            sources: BTreeMap::new(),
            signals: BTreeMap::new(),
            prefixes: BTreeMap::new(),
            by_storage: BTreeMap::new(),
            signal_paths: BTreeMap::new(),
        }
    }

    /// Registers a source under a unique display prefix.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::DuplicatePrefix`] when `prefix` is taken.
    pub fn register_source(
        &mut self,
        path: impl AsRef<Path>,
        key: SourceKey,
        prefix: impl Into<String>,
    ) -> Result<SourceId, StoreError> {
        let prefix = prefix.into();
        if self.prefixes.contains_key(&prefix) {
            return Err(StoreError::DuplicatePrefix(prefix));
        }
        let id = SourceId(self.next_source_id);
        self.next_source_id += 1;
        self.prefixes.insert(prefix.clone(), id);
        self.sources.insert(
            id,
            Source {
                id,
                key,
                path: path.as_ref().to_owned(),
                prefix,
                point_count: 0,
            },
        );
        Ok(id)
    }

    /// Registers a signal under an existing source.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::UnknownSource`] when `source_id` is not
    /// registered or the storage/display identity is already taken.
    pub fn insert_signal(
        &mut self,
        source_id: SourceId,
        local_path: impl Into<String>,
        unit: Option<String>,
        time: Arc<[f64]>,
        values: impl Into<Arc<[f64]>>,
    ) -> Result<SignalId, StoreError> {
        let source = self
            .sources
            .get(&source_id)
            .ok_or(StoreError::UnknownSource(source_id))?;

        let local_path = local_path.into();
        let storage = (source_id, local_path.clone());
        if self.by_storage.contains_key(&storage) {
            return Err(StoreError::DuplicateSignal {
                source_id,
                local_path,
            });
        }
        let path = if source.prefix.is_empty() {
            local_path.clone()
        } else {
            format!("{}/{local_path}", source.prefix)
        };
        if self.signal_paths.contains_key(&path) {
            return Err(StoreError::DisplayPathCollision(path));
        }

        let values: Arc<[f64]> = values.into();
        let id = SignalId(self.next_signal_id);
        let point_count = values.len();
        let signal = Signal::new(id, source_id, local_path, path.clone(), unit, time, values)?;
        self.next_signal_id += 1;
        self.signals.insert(id, signal);
        self.signal_paths.insert(path, id);
        self.by_storage.insert(storage, id);
        self.sources
            .get_mut(&source_id)
            .expect("source checked above")
            .point_count += point_count;
        Ok(id)
    }

    /// Runs `f` atomically with respect to registrations: when `f` returns
    /// `Err`, every source and signal it inserted is removed and the id
    /// counters are restored.
    ///
    /// The store's mutating surface is insert-only (`register_source`,
    /// `insert_signal`), so rolling back insertions restores the exact prior
    /// state, including point counts on pre-existing sources. `remove_signal`
    /// is the one mutation that is not covered and must never be called inside
    /// `f`; any other future in-place mutation must extend this rollback.
    ///
    /// # Errors
    ///
    /// Returns whatever error `f` returns, after rolling back.
    pub fn transaction<T, E>(&mut self, f: impl FnOnce(&mut Self) -> Result<T, E>) -> Result<T, E> {
        let source_watermark = self.next_source_id;
        let signal_watermark = self.next_signal_id;
        let source_point_counts = self
            .sources
            .iter()
            .map(|(id, source)| (*id, source.point_count))
            .collect::<BTreeMap<_, _>>();
        let result = f(self);
        if result.is_err() {
            self.sources.retain(|id, _| id.0 < source_watermark);
            self.signals.retain(|id, _| id.0 < signal_watermark);
            self.prefixes.retain(|_, id| id.0 < source_watermark);
            self.by_storage.retain(|_, id| id.0 < signal_watermark);
            self.signal_paths.retain(|_, id| id.0 < signal_watermark);
            for (id, point_count) in source_point_counts {
                if let Some(source) = self.sources.get_mut(&id) {
                    source.point_count = point_count;
                }
            }
            self.next_source_id = source_watermark;
            self.next_signal_id = signal_watermark;
        }
        result
    }

    /// Removes the signal at `path`, freeing the path for reuse and
    /// decrementing its source's point count.
    ///
    /// This is **not** transactional: [`SignalStore::transaction`] rolls back
    /// insertions by id watermark and cannot restore a removed signal. Never
    /// call this inside a transaction closure. Derived signals — the only
    /// caller — are recreated from their expression instead.
    pub fn remove_signal(&mut self, path: &str) -> Option<SignalId> {
        let id = self.signal_paths.remove(path)?;
        let signal = self.signals.remove(&id)?;
        self.by_storage
            .remove(&(signal.source_id, signal.local_path.clone()));
        if let Some(source) = self.sources.get_mut(&signal.source_id) {
            source.point_count = source.point_count.saturating_sub(signal.len());
        }
        Some(id)
    }

    #[must_use]
    pub fn signal(&self, id: SignalId) -> Option<&Signal> {
        self.signals.get(&id)
    }

    #[must_use]
    pub fn signal_by_path(&self, path: &str) -> Option<&Signal> {
        self.signal_paths
            .get(path)
            .and_then(|id| self.signals.get(id))
    }

    pub fn signals(&self) -> impl Iterator<Item = &Signal> {
        self.signals.values()
    }

    pub fn sources(&self) -> impl Iterator<Item = &Source> {
        self.sources.values()
    }

    pub fn signals_of(&self, source_id: SourceId) -> impl Iterator<Item = &Signal> {
        self.signals
            .values()
            .filter(move |signal| signal.source_id == source_id)
    }
}

impl Default for SignalStore {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Error, PartialEq)]
pub enum StoreError {
    #[error("time/value column length mismatch: {time} != {values}")]
    ColumnLengthMismatch { time: usize, values: usize },
    #[error("time column contains a non-finite value at index {index}")]
    NonFiniteTime { index: usize },
    #[error("time column decreases at index {index}")]
    DecreasingTime { index: usize },
    #[error("source {0:?} is not registered")]
    UnknownSource(SourceId),
    #[error("signal is already registered in source {source_id:?}: {local_path}")]
    DuplicateSignal {
        source_id: SourceId,
        local_path: String,
    },
    #[error("display path is already registered: {0}")]
    DisplayPathCollision(String),
    #[error("source prefix is already registered: {0}")]
    DuplicatePrefix(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> SourceKey {
        SourceKey(uuid::Uuid::from_bytes([byte; 16]))
    }

    #[test]
    fn identical_local_paths_coexist_under_distinct_prefixes() {
        let mut store = SignalStore::new();
        let left = store
            .register_source("/a/run.csv", key(1), "run_a")
            .unwrap();
        let right = store
            .register_source("/b/run.csv", key(2), "run_b")
            .unwrap();
        let time: Arc<[f64]> = Arc::from(vec![0.0, 1.0]);
        store
            .insert_signal(left, "imu/ax", None, Arc::clone(&time), vec![1.0, 2.0])
            .unwrap();
        store
            .insert_signal(right, "imu/ax", None, Arc::clone(&time), vec![3.0, 4.0])
            .unwrap();

        assert_eq!(
            store.signal_by_path("run_a/imu/ax").unwrap().values(),
            &[1.0, 2.0]
        );
        assert_eq!(
            store.signal_by_path("run_b/imu/ax").unwrap().values(),
            &[3.0, 4.0]
        );
        assert_eq!(
            store.signal_by_path("run_b/imu/ax").unwrap().local_path,
            "imu/ax"
        );
    }

    #[test]
    fn duplicates_inside_one_source_and_prefix_reuse_are_rejected() {
        let mut store = SignalStore::new();
        let source = store.register_source("/a/run.csv", key(1), "run").unwrap();
        let time: Arc<[f64]> = Arc::from(vec![0.0]);
        store
            .insert_signal(source, "imu/ax", None, Arc::clone(&time), vec![1.0])
            .unwrap();

        assert!(matches!(
            store.insert_signal(source, "imu/ax", None, Arc::clone(&time), vec![2.0]),
            Err(StoreError::DuplicateSignal { .. })
        ));
        assert!(matches!(
            store.register_source("/b/run.csv", key(2), "run"),
            Err(StoreError::DuplicatePrefix(_))
        ));
    }

    #[test]
    fn rollback_clears_both_indexes() {
        let mut store = SignalStore::new();
        let result: Result<(), &str> = store.transaction(|store| {
            let source = store.register_source("/a/run.csv", key(1), "run").unwrap();
            store
                .insert_signal(source, "imu/ax", None, Arc::from(vec![0.0]), vec![1.0])
                .unwrap();
            Err("decode failed")
        });
        assert!(result.is_err());
        assert!(store.signal_by_path("run/imu/ax").is_none());
        assert!(store.register_source("/b/run.csv", key(2), "run").is_ok());
    }

    #[test]
    fn removing_a_signal_frees_its_path_and_updates_the_source_count() {
        let mut store = SignalStore::new();
        let source = store.register_source("test", key(10), "").unwrap();
        let time: Arc<[f64]> = Arc::from(vec![0.0, 1.0]);
        store
            .insert_signal(source, "a/x", None, Arc::clone(&time), vec![1.0, 2.0])
            .expect("inserts");
        let before = store.sources().next().expect("source").point_count;

        let removed = store.remove_signal("a/x").expect("removes");
        assert!(store.signal(removed).is_none());
        assert!(store.signal_by_path("a/x").is_none());
        assert_eq!(
            store.sources().next().expect("source").point_count,
            before - 2
        );
        assert!(store.remove_signal("a/x").is_none());

        store
            .insert_signal(source, "a/x", None, time, vec![3.0, 4.0])
            .expect("path is free again");
    }

    #[test]
    fn registers_source_and_signal() {
        let mut store = SignalStore::new();
        let source = store.register_source("flight.csv", key(11), "imu").unwrap();
        let signal = store
            .insert_signal(
                source,
                "ax",
                Some("m/s²".into()),
                Arc::from(vec![0.0, 1.0]),
                vec![2.0, 3.0],
            )
            .unwrap();

        assert_eq!(store.signal(signal).unwrap().values(), &[2.0, 3.0]);
        assert_eq!(store.sources().next().unwrap().point_count, 2);
    }

    #[test]
    fn transaction_rolls_back_insertions_on_error() {
        let mut store = SignalStore::new();
        let keep = store.register_source("keep.csv", key(12), "keep").unwrap();
        store
            .insert_signal(keep, "keep/a", None, Arc::from(vec![0.0]), vec![1.0])
            .unwrap();

        let result: Result<(), &str> = store.transaction(|store| {
            let source = store
                .register_source("rollback.csv", key(13), "rollback")
                .unwrap();
            store
                .insert_signal(source, "rollback/a", None, Arc::from(vec![0.0]), vec![1.0])
                .unwrap();
            Err("decode failed")
        });

        assert!(result.is_err());
        assert_eq!(store.sources().count(), 1);
        assert_eq!(store.signals().count(), 1);
        assert!(store.signal_by_path("rollback/a").is_none());
        assert_eq!(
            store.register_source("next.csv", key(14), "next").unwrap(),
            SourceId(2)
        );
    }

    #[test]
    fn transaction_restores_existing_source_metadata_on_error() {
        let mut store = SignalStore::new();
        let source = store.register_source("keep.csv", key(15), "keep").unwrap();
        store
            .insert_signal(source, "keep/a", None, Arc::from(vec![0.0]), vec![1.0])
            .unwrap();

        let result: Result<(), &str> = store.transaction(|store| {
            store
                .insert_signal(
                    source,
                    "rollback/a",
                    None,
                    Arc::from(vec![0.0, 1.0]),
                    vec![1.0, 2.0],
                )
                .unwrap();
            Err("decode failed")
        });

        assert!(result.is_err());
        assert_eq!(store.sources().next().unwrap().point_count, 1);
        assert_eq!(store.signals().count(), 1);
        assert!(store.signal_by_path("rollback/a").is_none());
    }

    #[test]
    fn invalid_time_columns_are_rejected() {
        let non_finite = Signal::new(
            SignalId(1),
            SourceId(1),
            "value",
            "source/value",
            None,
            Arc::from(vec![0.0, f64::NAN]),
            Arc::from(vec![0.0; 2]),
        );
        assert!(matches!(
            non_finite,
            Err(StoreError::NonFiniteTime { index: 1 })
        ));

        let decreasing = Signal::new(
            SignalId(1),
            SourceId(1),
            "value",
            "source/value",
            None,
            Arc::from(vec![0.0, 2.0, 1.0]),
            Arc::from(vec![0.0; 3]),
        );
        assert!(matches!(
            decreasing,
            Err(StoreError::DecreasingTime { index: 2 })
        ));
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn empty_time_bounds_use_safe_fallback() {
        let empty = Signal::new(
            SignalId(2),
            SourceId(1),
            "empty",
            "source/empty",
            None,
            Arc::from(Vec::new()),
            Arc::from(Vec::new()),
        )
        .unwrap();
        assert_eq!(empty.time_bounds(), (0.0, 1.0));
    }

    #[test]
    fn default_store_matches_new() {
        let mut store = SignalStore::default();
        assert_eq!(
            store.register_source("a.csv", key(16), "a").unwrap(),
            SourceId(1)
        );
    }
}

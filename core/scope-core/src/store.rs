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

/// Stable identifier for a registered signal.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct SignalId(pub u64);

/// Metadata shared by all signals originating in one file or stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Source {
    pub id: SourceId,
    pub path: PathBuf,
    pub point_count: usize,
}

/// A time/value column pair. Both columns always have identical lengths.
#[derive(Clone, Debug)]
pub struct Signal {
    pub id: SignalId,
    pub source_id: SourceId,
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
    /// Returns [`StoreError::ColumnLengthMismatch`] when the columns have
    /// different lengths.
    pub fn new(
        id: SignalId,
        source_id: SourceId,
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

        Ok(Self {
            id,
            source_id,
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
}

#[derive(Clone, Debug)]
pub struct SignalStore {
    next_source_id: u64,
    next_signal_id: u64,
    sources: BTreeMap<SourceId, Source>,
    signals: BTreeMap<SignalId, Signal>,
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
            signal_paths: BTreeMap::new(),
        }
    }

    pub fn register_source(&mut self, path: impl AsRef<Path>) -> SourceId {
        let id = SourceId(self.next_source_id);
        self.next_source_id += 1;
        self.sources.insert(
            id,
            Source {
                id,
                path: path.as_ref().to_owned(),
                point_count: 0,
            },
        );
        id
    }

    /// Registers a signal under an existing source.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::UnknownSource`] when `source_id` is not
    /// registered, [`StoreError::DuplicateSignal`] when `path` already exists,
    /// or [`StoreError::ColumnLengthMismatch`] when the columns differ in
    /// length.
    pub fn insert_signal(
        &mut self,
        source_id: SourceId,
        path: impl Into<String>,
        unit: Option<String>,
        time: Arc<[f64]>,
        values: Vec<f64>,
    ) -> Result<SignalId, StoreError> {
        let source = self
            .sources
            .get_mut(&source_id)
            .ok_or(StoreError::UnknownSource(source_id))?;

        let path = path.into();
        if self.signal_paths.contains_key(&path) {
            return Err(StoreError::DuplicateSignal(path));
        }

        let id = SignalId(self.next_signal_id);
        let point_count = values.len();
        let signal = Signal::new(id, source_id, path.clone(), unit, time, values.into())?;
        self.next_signal_id += 1;
        self.signals.insert(id, signal);
        self.signal_paths.insert(path, id);
        source.point_count += point_count;
        Ok(id)
    }

    /// Runs `f` atomically with respect to registrations: when `f` returns
    /// `Err`, every source and signal it inserted is removed and the id
    /// counters are restored.
    ///
    /// The store's mutating surface is insert-only (`register_source`,
    /// `insert_signal`), so rolling back insertions restores the exact prior
    /// state, including point counts on pre-existing sources. Any future
    /// in-place mutation must extend this rollback.
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
    #[error("source {0:?} is not registered")]
    UnknownSource(SourceId),
    #[error("signal path is already registered: {0}")]
    DuplicateSignal(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_source_and_signal() {
        let mut store = SignalStore::new();
        let source = store.register_source("flight.csv");
        let signal = store
            .insert_signal(
                source,
                "imu/ax",
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
        let keep = store.register_source("keep.csv");
        store
            .insert_signal(keep, "keep/a", None, Arc::from(vec![0.0]), vec![1.0])
            .unwrap();

        let result: Result<(), &str> = store.transaction(|store| {
            let source = store.register_source("rollback.csv");
            store
                .insert_signal(source, "rollback/a", None, Arc::from(vec![0.0]), vec![1.0])
                .unwrap();
            Err("decode failed")
        });

        assert!(result.is_err());
        assert_eq!(store.sources().count(), 1);
        assert_eq!(store.signals().count(), 1);
        assert!(store.signal_by_path("rollback/a").is_none());
        assert_eq!(store.register_source("next.csv"), SourceId(2));
    }

    #[test]
    fn transaction_restores_existing_source_metadata_on_error() {
        let mut store = SignalStore::new();
        let source = store.register_source("keep.csv");
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
    fn default_store_matches_new() {
        let mut store = SignalStore::default();
        assert_eq!(store.register_source("a.csv"), SourceId(1));
    }
}

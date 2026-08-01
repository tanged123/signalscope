//! Decoded columns and their atomic store commit.

use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

use super::{IngestError, IngestSummary};
use crate::{
    columns::Column,
    store::{SignalStore, SourceKey},
};

#[derive(Clone, Debug)]
pub struct DecodedSignal {
    pub local_path: String,
    pub unit: Option<String>,
    pub time: Column,
    pub values: Column,
}

#[derive(Clone, Debug, Default)]
pub struct DecodedSource {
    pub row_count: usize,
    pub signals: Vec<DecodedSignal>,
}

impl DecodedSource {
    #[must_use]
    pub fn column_bytes(&self) -> usize {
        self.signals
            .iter()
            .map(|signal| (signal.time.len() + signal.values.len()) * size_of::<f64>())
            .sum()
    }
}

#[derive(Debug, Default)]
pub struct CancelToken(AtomicBool);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

pub struct DecodeContext<'a> {
    pub progress: &'a mut dyn FnMut(f64),
    pub cancel: &'a CancelToken,
}

impl DecodeContext<'_> {
    /// # Errors
    ///
    /// Returns [`IngestError::Cancelled`] after cancellation.
    pub fn check(&self) -> Result<(), IngestError> {
        if self.cancel.is_cancelled() {
            return Err(IngestError::Cancelled);
        }
        Ok(())
    }

    pub fn report(&mut self, fraction: f64) {
        (self.progress)(fraction.clamp(0.0, 1.0));
    }
}

/// # Errors
///
/// Returns a store error without leaving partial registrations.
pub fn commit(
    store: &mut SignalStore,
    key: SourceKey,
    prefix: &str,
    path: &Path,
    decoded: DecodedSource,
) -> Result<IngestSummary, IngestError> {
    store.transaction(|store| {
        let source_id = store.register_source(path, key, prefix)?;
        let mut signals = Vec::with_capacity(decoded.signals.len());
        for signal in decoded.signals {
            signals.push(store.insert_signal(
                source_id,
                signal.local_path,
                signal.unit,
                signal.time,
                signal.values,
            )?);
        }
        Ok(IngestSummary {
            source_id,
            row_count: decoded.row_count,
            signals,
        })
    })
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use super::*;
    use crate::store::{SignalStore, SourceKey};

    fn decoded() -> DecodedSource {
        let time: Arc<[f64]> = Arc::from(vec![0.0, 1.0]);
        DecodedSource {
            row_count: 2,
            signals: vec![
                DecodedSignal {
                    local_path: "imu/ax".into(),
                    unit: None,
                    time: Arc::clone(&time).into(),
                    values: vec![1.0, 2.0].into(),
                },
                DecodedSignal {
                    local_path: "imu/ay".into(),
                    unit: Some("m/s2".into()),
                    time: time.into(),
                    values: vec![3.0, 4.0].into(),
                },
            ],
        }
    }

    #[test]
    fn commit_registers_under_the_pre_assigned_key_and_prefix() {
        let mut store = SignalStore::new();
        let key = SourceKey(uuid::Uuid::from_bytes([7; 16]));
        let summary = commit(&mut store, key, "run", Path::new("/a/run.csv"), decoded()).unwrap();

        assert_eq!(summary.row_count, 2);
        assert_eq!(summary.signals.len(), 2);
        assert_eq!(
            store.signal_by_path("run/imu/ay").unwrap().unit.as_deref(),
            Some("m/s2")
        );
        assert_eq!(store.sources().next().unwrap().key, key);
    }

    #[test]
    fn a_failed_commit_leaves_no_source_or_partial_signals() {
        let mut store = SignalStore::new();
        let key = SourceKey(uuid::Uuid::from_bytes([7; 16]));
        let mut broken = decoded();
        broken.signals[1].local_path = "imu/ax".into();

        assert!(commit(&mut store, key, "run", Path::new("/a/run.csv"), broken).is_err());
        assert_eq!(store.sources().count(), 0);
        assert_eq!(store.signals().count(), 0);
    }

    #[test]
    fn a_cancelled_context_stops_at_the_next_check() {
        let cancel = CancelToken::default();
        let mut progress = |_: f64| {};
        let context = DecodeContext {
            progress: &mut progress,
            cancel: &cancel,
        };
        assert!(context.check().is_ok());
        cancel.cancel();
        assert!(matches!(context.check(), Err(IngestError::Cancelled)));
    }
}

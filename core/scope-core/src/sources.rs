//! Workspace-scoped source identity and path aliases.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{naming, store::SourceKey};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceRecord {
    pub key: SourceKey,
    pub path: PathBuf,
    pub prefix: String,
    pub provider_id: Option<String>,
    pub decode_provenance: Option<String>,
    pub reconcile_legacy: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Admission {
    Existing(SourceKey),
    New(SourceRecord),
}

#[derive(Debug, Error)]
pub enum SourceError {
    #[error("source path cannot be canonicalized: {0}")]
    Io(#[from] std::io::Error),
    #[error("no free display prefix for {0}")]
    PrefixExhausted(String),
    #[error("unknown source key")]
    UnknownKey,
    #[error("batch ingest is still running")]
    Busy,
}

#[derive(Clone, Debug, Default)]
pub struct SourceRegistry {
    by_key: BTreeMap<SourceKey, SourceRecord>,
    by_path: BTreeMap<PathBuf, SourceKey>,
    prefixes: BTreeSet<String>,
}

impl SourceRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Canonicalizes local aliases before minting identity.
    ///
    /// # Errors
    ///
    /// Returns an IO error or [`SourceError::PrefixExhausted`].
    pub fn admit(&mut self, path: &Path) -> Result<Admission, SourceError> {
        let canonical = path.canonicalize()?;
        if let Some(key) = self.by_path.get(&canonical) {
            return Ok(Admission::Existing(*key));
        }

        let key = SourceKey(Uuid::new_v4());
        let prefix = naming::allocate_prefix(&self.prefixes, &canonical, key.0)
            .ok_or_else(|| SourceError::PrefixExhausted(canonical.display().to_string()))?;
        let record = SourceRecord {
            key,
            path: canonical.clone(),
            prefix: prefix.clone(),
            provider_id: None,
            decode_provenance: None,
            reconcile_legacy: false,
        };
        self.prefixes.insert(prefix);
        self.by_path.insert(canonical, key);
        self.by_key.insert(key, record.clone());
        Ok(Admission::New(record))
    }

    /// Restores durable identity without requiring the source to exist.
    ///
    /// # Errors
    ///
    /// Returns [`SourceError::PrefixExhausted`] for a conflicting prefix.
    pub fn restore(&mut self, mut record: SourceRecord) -> Result<(), SourceError> {
        if let Ok(canonical) = record.path.canonicalize() {
            record.path = canonical;
        }
        let prefix_owner = self.prefixes.contains(&record.prefix);
        let same_record = self
            .by_key
            .get(&record.key)
            .is_some_and(|existing| existing.prefix == record.prefix);
        if prefix_owner && !same_record {
            return Err(SourceError::PrefixExhausted(record.prefix));
        }
        self.prefixes.insert(record.prefix.clone());
        self.by_path.insert(record.path.clone(), record.key);
        self.by_key.insert(record.key, record);
        Ok(())
    }

    /// # Errors
    ///
    /// Returns an IO error or [`SourceError::UnknownKey`].
    pub fn relocate(&mut self, key: SourceKey, path: &Path) -> Result<(), SourceError> {
        let canonical = path.canonicalize()?;
        let record = self.by_key.get_mut(&key).ok_or(SourceError::UnknownKey)?;
        self.by_path.remove(&record.path);
        record.path.clone_from(&canonical);
        self.by_path.insert(canonical, key);
        Ok(())
    }

    #[must_use]
    pub fn record(&self, key: SourceKey) -> Option<&SourceRecord> {
        self.by_key.get(&key)
    }

    pub fn set_provenance(&mut self, key: SourceKey, provider_id: String, digest: String) {
        if let Some(record) = self.by_key.get_mut(&key) {
            record.provider_id = Some(provider_id);
            record.decode_provenance = Some(digest);
            record.reconcile_legacy = false;
        }
    }

    pub fn records(&self) -> impl Iterator<Item = &SourceRecord> {
        self.by_key.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeating_a_path_is_idempotent_but_new_files_get_new_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run.csv");
        std::fs::write(&path, "time,v\n0,1\n").unwrap();
        let twin = dir.path().join("twin.csv");
        std::fs::write(&twin, "time,v\n0,1\n").unwrap();

        let mut registry = SourceRegistry::new();
        let Admission::New(record) = registry.admit(&path).unwrap() else {
            panic!("first admission is new");
        };
        assert_eq!(record.prefix, "run");
        assert!(record.provider_id.is_none());

        assert_eq!(
            registry.admit(&path).unwrap(),
            Admission::Existing(record.key)
        );
        let Admission::New(other) = registry.admit(&twin).unwrap() else {
            panic!("a different path is a different source");
        };
        assert_ne!(other.key, record.key);
    }

    #[test]
    fn same_stem_in_two_directories_gets_distinct_stable_prefixes() {
        let dir = tempfile::tempdir().unwrap();
        let (left, right) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&left).unwrap();
        std::fs::create_dir_all(&right).unwrap();
        for parent in [&left, &right] {
            std::fs::write(parent.join("run.csv"), "time,v\n0,1\n").unwrap();
        }

        let mut registry = SourceRegistry::new();
        let Admission::New(first) = registry.admit(&left.join("run.csv")).unwrap() else {
            panic!()
        };
        let Admission::New(second) = registry.admit(&right.join("run.csv")).unwrap() else {
            panic!()
        };
        assert_eq!(first.prefix, "run");
        assert!(second.prefix.starts_with("run_"));
        assert_eq!(second.prefix.len(), 8);
        assert!(
            second.prefix[4..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        );
        assert_eq!(registry.record(first.key).unwrap().prefix, "run");
    }

    #[test]
    fn relocation_keeps_the_key_and_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("run.csv");
        let new = dir.path().join("moved.csv");
        std::fs::write(&old, "time,v\n0,1\n").unwrap();
        std::fs::write(&new, "time,v\n0,1\n").unwrap();
        let mut registry = SourceRegistry::new();
        let Admission::New(record) = registry.admit(&old).unwrap() else {
            panic!()
        };

        registry.relocate(record.key, &new).unwrap();
        assert_eq!(
            registry.record(record.key).unwrap().path,
            new.canonicalize().unwrap()
        );
        assert_eq!(registry.record(record.key).unwrap().prefix, "run");
        assert_eq!(
            registry.admit(&new).unwrap(),
            Admission::Existing(record.key)
        );
    }
}

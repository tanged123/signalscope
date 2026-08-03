use std::path::Path;

use thiserror::Error;

/// Canonical path of a dataset inside a container.
pub type DatasetPath = str;

/// Maximum group nesting walked during listing. HDF5 links can point at an
/// ancestor, so an unbounded walk on an untrusted file overflows the stack.
pub const MAX_GROUP_DEPTH: usize = 64;

/// Maximum datasets listed from one container.
pub const MAX_DATASET_ENTRIES: usize = 50_000;

/// Largest column a container reader will materialize, in bytes.
pub const MAX_DATASET_BYTES: usize = 1024 * 1024 * 1024;

/// Checks the declared materialized size before a container allocates it.
///
/// # Errors
///
/// Returns [`ContainerError::Unsupported`] when the declared size exceeds the
/// materialization ceiling.
pub fn check_declared_size(entry: &DatasetEntry) -> Result<(), ContainerError> {
    let declared = entry.len.saturating_mul(std::mem::size_of::<f64>());
    if declared > MAX_DATASET_BYTES {
        return Err(ContainerError::Unsupported(format!(
            "dataset {} declares {declared} bytes, above the {MAX_DATASET_BYTES} byte ceiling",
            entry.path
        )));
    }
    Ok(())
}

pub mod hdf5;
pub mod parquet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DatasetKind {
    Numeric,
    Text,
    Compound,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DatasetEntry {
    pub path: String,
    pub kind: DatasetKind,
    pub len: usize,
    pub shape: Vec<usize>,
}

#[derive(Debug, Error)]
pub enum ContainerError {
    #[error("container IO failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("no such dataset: {0}")]
    NoSuchDataset(String),
    #[error("dataset is not numeric: {0}")]
    NotNumeric(String),
    #[error("unsupported container data: {0}")]
    Unsupported(String),
    #[error("container backend failed: {0}")]
    Backend(String),
}

/// Read-only, object-safe boundary shared by container-specific readers and
/// the declarative recipe decoder.
pub trait ContainerReader: Send + Sync {
    /// Opens a container without decoding its signal columns.
    ///
    /// # Errors
    ///
    /// Returns a [`ContainerError`] when the file cannot be opened or its
    /// metadata is invalid.
    fn open(path: &Path) -> Result<Self, ContainerError>
    where
        Self: Sized;

    fn datasets(&self) -> &[DatasetEntry];

    /// Reads one numeric dataset as a row-major `f64` column.
    ///
    /// # Errors
    ///
    /// Returns a [`ContainerError`] when the dataset is absent, non-numeric,
    /// or cannot be decoded.
    fn read_f64(&self, path: &DatasetPath) -> Result<Vec<f64>, ContainerError>;

    /// Reads at most `limit` numeric values for an introspection preview.
    ///
    /// # Errors
    ///
    /// Returns a [`ContainerError`] when the dataset is absent, non-numeric,
    /// or cannot be decoded.
    fn read_preview_f64(
        &self,
        path: &DatasetPath,
        limit: usize,
    ) -> Result<Vec<f64>, ContainerError>;

    fn attribute(&self, path: &DatasetPath, name: &str) -> Option<String>;
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn the_dataset_ceiling_is_below_a_plausible_working_budget() {
        const {
            assert!(MAX_DATASET_BYTES <= 2 * 1024 * 1024 * 1024);
        }
    }

    #[derive(Default)]
    pub(crate) struct FakeContainer {
        entries: Vec<DatasetEntry>,
        columns: BTreeMap<String, Vec<f64>>,
        attributes: BTreeMap<(String, String), String>,
    }

    impl ContainerReader for FakeContainer {
        fn open(_path: &std::path::Path) -> Result<Self, ContainerError> {
            Ok(Self::default())
        }

        fn datasets(&self) -> &[DatasetEntry] {
            &self.entries
        }

        fn read_f64(&self, path: &DatasetPath) -> Result<Vec<f64>, ContainerError> {
            let entry = self
                .entries
                .iter()
                .find(|entry| entry.path == path)
                .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))?;
            if entry.kind != DatasetKind::Numeric {
                return Err(ContainerError::NotNumeric(path.to_owned()));
            }
            self.columns
                .get(path)
                .cloned()
                .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))
        }

        fn read_preview_f64(
            &self,
            path: &DatasetPath,
            limit: usize,
        ) -> Result<Vec<f64>, ContainerError> {
            Ok(self.read_f64(path)?.into_iter().take(limit).collect())
        }

        fn attribute(&self, path: &DatasetPath, name: &str) -> Option<String> {
            self.attributes
                .get(&(path.to_owned(), name.to_owned()))
                .cloned()
        }
    }

    fn fake_container(columns: &[(&str, Vec<f64>)]) -> FakeContainer {
        let mut container = FakeContainer::default();
        for (path, values) in columns {
            container.entries.push(DatasetEntry {
                path: (*path).into(),
                kind: DatasetKind::Numeric,
                len: values.len(),
                shape: vec![values.len()],
            });
            container.columns.insert((*path).into(), values.clone());
        }
        container
            .entries
            .sort_by(|left, right| left.path.cmp(&right.path));
        container
    }

    fn fake_container_with_text(path: &str) -> FakeContainer {
        let mut container = FakeContainer::default();
        container.entries.push(DatasetEntry {
            path: path.into(),
            kind: DatasetKind::Text,
            len: 1,
            shape: vec![1],
        });
        container
    }

    #[test]
    fn numeric_datasets_are_listed_with_their_shape_and_length() {
        let container = fake_container(&[
            ("run/time", vec![0.0, 1.0, 2.0]),
            ("run/ax", vec![1.0, 2.0, 3.0]),
        ]);
        let entries = container.datasets();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "run/ax", "listing is sorted and stable");
        assert_eq!(entries[0].kind, DatasetKind::Numeric);
        assert_eq!(entries[0].len, 3);
    }

    #[test]
    fn reading_an_absent_dataset_is_an_error_not_an_empty_column() {
        let container = fake_container(&[("run/time", vec![0.0])]);
        assert!(matches!(
            container.read_f64("run/missing"),
            Err(ContainerError::NoSuchDataset(_))
        ));
    }

    #[test]
    fn non_numeric_datasets_are_listed_but_refuse_f64_reads() {
        let container = fake_container_with_text("run/label");
        assert_eq!(container.datasets()[0].kind, DatasetKind::Text);
        assert!(matches!(
            container.read_f64("run/label"),
            Err(ContainerError::NotNumeric(_))
        ));
    }
}

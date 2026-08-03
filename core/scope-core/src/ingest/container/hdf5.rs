use std::path::{Path, PathBuf};

use hdf5_metno::{File, Group, LinkType};

use crate::ingest::{
    DecodeContext, DecodedSource, Decoder, IngestError,
    provenance::CACHE_ABI_HDF5,
    registry::{Confidence, FormatProvider},
};

use super::{
    ContainerError, ContainerReader, DatasetEntry, DatasetKind, DatasetPath, MAX_DATASET_ENTRIES,
    MAX_GROUP_DEPTH, check_declared_size,
};

const HDF5_MAGIC: &[u8] = b"\x89HDF\r\n\x1a\n";

pub fn is_hdf5_magic(probe: &[u8]) -> bool {
    probe.starts_with(HDF5_MAGIC)
}

pub(crate) fn provider() -> FormatProvider {
    FormatProvider::new(
        "hdf5",
        "HDF5 containers (H5, HDF5, MATLAB v7.3)",
        &["h5", "hdf5", "mat"],
        0,
        CACHE_ABI_HDF5,
        |probe| {
            if is_hdf5_magic(probe) {
                Confidence::Certain
            } else {
                Confidence::No
            }
        },
        || Box::new(Hdf5Decoder),
    )
}

#[derive(Clone, Copy, Debug, Default)]
struct Hdf5Decoder;

impl Decoder for Hdf5Decoder {
    fn decode(
        &self,
        _path: &Path,
        _context: &mut DecodeContext<'_>,
    ) -> Result<DecodedSource, IngestError> {
        Err(IngestError::RecipeRequired {
            container: "HDF5".into(),
        })
    }
}

pub struct Hdf5Container {
    path: PathBuf,
    entries: Vec<DatasetEntry>,
}

impl ContainerReader for Hdf5Container {
    fn open(path: &Path) -> Result<Self, ContainerError> {
        let file = File::open(path).map_err(backend_error)?;
        let mut entries = Vec::new();
        collect_datasets(&file, "", 0, &mut entries)?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(Self {
            path: path.to_owned(),
            entries,
        })
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
        check_declared_size(entry)?;
        File::open(&self.path)
            .map_err(backend_error)?
            .dataset(path)
            .map_err(backend_error)?
            .read_raw::<f64>()
            .map_err(backend_error)
    }

    fn read_preview_f64(
        &self,
        path: &DatasetPath,
        limit: usize,
    ) -> Result<Vec<f64>, ContainerError> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.path == path)
            .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))?;
        if entry.kind != DatasetKind::Numeric {
            return Err(ContainerError::NotNumeric(path.to_owned()));
        }
        if entry.shape.len() != 1 {
            return Ok(Vec::new());
        }
        let values = File::open(&self.path)
            .map_err(backend_error)?
            .dataset(path)
            .map_err(backend_error)?
            .read_slice_1d::<f64, _>(0..limit.min(entry.len))
            .map_err(backend_error)?;
        Ok(values.iter().copied().collect())
    }

    fn attribute(&self, path: &DatasetPath, name: &str) -> Option<String> {
        let file = File::open(&self.path).ok()?;
        let dataset = file.dataset(path).ok()?;
        let mut names = vec![name];
        if name == "units" {
            names.extend(["unit", "Units"]);
        }
        for name in names {
            let Ok(attribute) = dataset.attr(name) else {
                continue;
            };
            if let Ok(value) = attribute
                .as_reader()
                .read_scalar::<hdf5_metno::types::VarLenUnicode>()
            {
                return Some(value.to_string());
            }
            if let Ok(value) = attribute
                .as_reader()
                .read_scalar::<hdf5_metno::types::VarLenAscii>()
            {
                return Some(value.to_string());
            }
        }
        None
    }
}

fn backend_error(error: impl std::fmt::Display) -> ContainerError {
    ContainerError::Backend(error.to_string())
}

fn collect_datasets(
    group: &Group,
    prefix: &str,
    depth: usize,
    entries: &mut Vec<DatasetEntry>,
) -> Result<(), ContainerError> {
    if depth > MAX_GROUP_DEPTH {
        return Err(ContainerError::Unsupported(format!(
            "container nests deeper than {MAX_GROUP_DEPTH} groups"
        )));
    }
    let members = group
        .iter_visit_default(Vec::new(), |_, name, info, names: &mut Vec<String>| {
            if info.link_type == LinkType::Hard {
                names.push(name.to_owned());
            }
            true
        })
        .map_err(backend_error)?;
    for name in members {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if let Ok(dataset) = group.dataset(&name) {
            let shape = dataset.shape();
            let kind = match dataset
                .dtype()
                .and_then(|dtype| dtype.to_descriptor())
                .map_err(backend_error)?
            {
                hdf5_metno::types::TypeDescriptor::Integer(_)
                | hdf5_metno::types::TypeDescriptor::Unsigned(_)
                | hdf5_metno::types::TypeDescriptor::Float(_) => DatasetKind::Numeric,
                hdf5_metno::types::TypeDescriptor::FixedAscii(_)
                | hdf5_metno::types::TypeDescriptor::FixedUnicode(_)
                | hdf5_metno::types::TypeDescriptor::VarLenAscii
                | hdf5_metno::types::TypeDescriptor::VarLenUnicode => DatasetKind::Text,
                hdf5_metno::types::TypeDescriptor::Compound(_) => DatasetKind::Compound,
                _ => DatasetKind::Unsupported,
            };
            if entries.len() >= MAX_DATASET_ENTRIES {
                return Err(ContainerError::Unsupported(format!(
                    "container lists more than {MAX_DATASET_ENTRIES} datasets"
                )));
            }
            entries.push(DatasetEntry {
                path,
                kind,
                len: dataset.size(),
                shape,
            });
        } else if let Ok(child) = group.group(&name) {
            collect_datasets(&child, &path, depth + 1, entries)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use crate::ingest::container::MAX_DATASET_BYTES;

    use super::*;

    #[test]
    fn a_nested_group_layout_lists_leaf_datasets_by_full_path() {
        let file = write_hdf5(&[
            ("/run/time", &[0.0, 1.0, 2.0]),
            ("/run/imu/ax", &[1.0, 2.0, 3.0]),
        ]);
        let container = Hdf5Container::open(file.path()).unwrap();
        let paths: Vec<_> = container
            .datasets()
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(paths, ["run/imu/ax", "run/time"]);
        assert_eq!(
            container.read_f64("run/imu/ax").unwrap(),
            vec![1.0, 2.0, 3.0]
        );
    }

    #[test]
    fn integer_and_float_datasets_both_read_as_f64() {
        let file = write_hdf5_mixed();
        let container = Hdf5Container::open(file.path()).unwrap();
        assert_eq!(container.read_f64("counts").unwrap(), vec![1.0, 2.0, 3.0]);
        assert!((container.read_f64("volts").unwrap()[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_matlab_v7_3_file_opens_as_hdf5() {
        let file = write_hdf5(&[("/signal", &[1.0, 2.0])]);
        let container = Hdf5Container::open(file.path()).unwrap();
        assert!(
            container
                .datasets()
                .iter()
                .any(|entry| entry.path.ends_with("signal"))
        );
    }

    #[test]
    fn units_come_from_the_conventional_attribute() {
        let file = write_hdf5_with_units("volts", "V");
        let container = Hdf5Container::open(file.path()).unwrap();
        assert_eq!(container.attribute("volts", "units").as_deref(), Some("V"));
    }

    #[test]
    fn a_truncated_container_is_an_error_not_a_panic() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"\x89HDF\r\n\x1a\ntruncated").unwrap();
        assert!(Hdf5Container::open(file.path()).is_err());
    }

    #[test]
    fn an_hdf5_file_without_a_recipe_reports_that_a_recipe_is_required() {
        let progress: &'static mut dyn FnMut(f64) = Box::leak(Box::new(|_| {}));
        let cancel = Box::leak(Box::new(crate::ingest::CancelToken::default()));
        let mut context = DecodeContext { progress, cancel };
        let error = Hdf5Decoder
            .decode(Path::new("flight.h5"), &mut context)
            .unwrap_err();
        assert!(matches!(error, IngestError::RecipeRequired { .. }));
    }

    #[test]
    fn a_cyclic_group_link_is_an_error_not_a_stack_overflow() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cycle.h5");
        let file = File::create(&path).unwrap();
        let outer = file.create_group("a").unwrap();
        let inner = outer.create_group("b").unwrap();
        inner.link_hard("/a", "loop").unwrap();
        drop(file);

        let error = Hdf5Container::open(&path).err().unwrap();
        assert!(matches!(error, ContainerError::Unsupported(_)));
    }

    #[test]
    fn a_deeply_nested_container_is_rejected_at_the_depth_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("deep.h5");
        let file = File::create(&path).unwrap();
        let mut group = file.create_group("g0").unwrap();
        for level in 1..(MAX_GROUP_DEPTH + 8) {
            group = group.create_group(&format!("g{level}")).unwrap();
        }
        drop(file);

        assert!(matches!(
            Hdf5Container::open(&path).err().unwrap(),
            ContainerError::Unsupported(_)
        ));
    }

    #[test]
    fn an_external_link_never_reads_outside_the_container() {
        let directory = tempfile::tempdir().unwrap();
        let secret = directory.path().join("secret.h5");
        write_hdf5_at(&secret, &[("private", &[1.0, 2.0, 3.0])]);
        let path = directory.path().join("host.h5");
        let file = File::create(&path).unwrap();
        file.link_external(&secret.display().to_string(), "/", "elsewhere")
            .unwrap();
        drop(file);

        let container = Hdf5Container::open(&path).unwrap();
        assert!(
            container.datasets().is_empty(),
            "external link contents must not be listed: {:?}",
            container.datasets()
        );
    }

    #[test]
    fn a_dataset_declaring_more_than_the_ceiling_is_refused_before_allocating() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("huge.h5");
        let file = File::create(&path).unwrap();
        file.new_dataset::<f64>()
            .shape([MAX_DATASET_BYTES / 8 + 1024])
            .chunk([1])
            .create("huge")
            .unwrap();
        drop(file);

        let container = Hdf5Container::open(&path).unwrap();
        assert!(matches!(
            container.read_f64("huge"),
            Err(ContainerError::Unsupported(_))
        ));
    }

    fn write_hdf5(datasets: &[(&str, &[f64])]) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        write_hdf5_at(file.path(), datasets);
        file
    }

    fn write_hdf5_at(path: &Path, datasets: &[(&str, &[f64])]) {
        {
            let hdf5 = File::create(path).unwrap();
            for (path, values) in datasets {
                let dataset = hdf5
                    .new_dataset::<f64>()
                    .shape(values.len())
                    .create(*path)
                    .unwrap();
                dataset.write(*values).unwrap();
            }
        }
    }

    fn write_hdf5_mixed() -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        {
            let hdf5 = File::create(file.path()).unwrap();
            hdf5.new_dataset::<i32>()
                .shape(3)
                .create("counts")
                .unwrap()
                .write(&[1, 2, 3])
                .unwrap();
            hdf5.new_dataset::<f32>()
                .shape(2)
                .create("volts")
                .unwrap()
                .write(&[0.5, 1.5])
                .unwrap();
        }
        file
    }

    fn write_hdf5_with_units(path: &str, units: &str) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        {
            let hdf5 = File::create(file.path()).unwrap();
            let dataset = hdf5.new_dataset::<f64>().shape(1).create(path).unwrap();
            dataset.write(&[1.0]).unwrap();
            let attribute = dataset
                .new_attr::<hdf5_metno::types::VarLenUnicode>()
                .create("units")
                .unwrap();
            let value = hdf5_metno::types::VarLenUnicode::from_str(units).unwrap();
            attribute.as_writer().write_scalar(&value).unwrap();
        }
        file
    }
}

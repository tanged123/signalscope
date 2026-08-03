use std::{collections::BTreeMap, fs::File, path::Path, sync::Arc};

use arrow_array::{Array, Float64Array};
use arrow_cast::cast;
use arrow_schema::{DataType, Schema};
use parquet::arrow::{ProjectionMask, arrow_reader::ParquetRecordBatchReaderBuilder};

use crate::ingest::{
    DecodeContext, DecodedSource, Decoder, IngestError,
    provenance::CACHE_ABI_PARQUET,
    registry::{Confidence, FormatProvider},
};

use super::{
    ContainerError, ContainerReader, DatasetEntry, DatasetKind, DatasetPath, check_declared_size,
};

const PARQUET_MAGIC: &[u8] = b"PAR1";

pub fn is_parquet_magic(probe: &[u8]) -> bool {
    probe.starts_with(PARQUET_MAGIC)
}

pub(crate) fn provider() -> FormatProvider {
    FormatProvider::new(
        "parquet",
        "Parquet columns (PARQUET, PQ)",
        &["parquet", "pq"],
        0,
        CACHE_ABI_PARQUET,
        |probe| {
            if is_parquet_magic(probe) {
                Confidence::Certain
            } else {
                Confidence::No
            }
        },
        || Box::new(ParquetDecoder),
    )
}

#[derive(Clone, Copy, Debug, Default)]
struct ParquetDecoder;

impl Decoder for ParquetDecoder {
    fn decode(
        &self,
        _path: &Path,
        _context: &mut DecodeContext<'_>,
    ) -> Result<DecodedSource, IngestError> {
        Err(IngestError::RecipeRequired {
            container: "Parquet".into(),
        })
    }
}

pub struct ParquetContainer {
    path: std::path::PathBuf,
    entries: Vec<DatasetEntry>,
    columns: BTreeMap<String, usize>,
    schema: Arc<Schema>,
}

impl ContainerReader for ParquetContainer {
    fn open(path: &Path) -> Result<Self, ContainerError> {
        let file = File::open(path)?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file).map_err(backend_error)?;
        let schema = builder.schema().clone();
        let row_count = usize::try_from(builder.metadata().file_metadata().num_rows())
            .map_err(|_| ContainerError::Backend("Parquet row count is negative".into()))?;
        let mut names = std::collections::BTreeSet::new();
        for field in schema.fields() {
            if !names.insert(field.name().clone()) {
                return Err(ContainerError::Unsupported(format!(
                    "Parquet schema contains duplicate top-level field name: {}",
                    field.name()
                )));
            }
        }
        let columns = schema
            .fields()
            .iter()
            .enumerate()
            .filter(|(_, field)| is_numeric(field.data_type()))
            .map(|(index, field)| (field.name().clone(), index))
            .collect::<BTreeMap<_, _>>();
        let mut entries = schema
            .fields()
            .iter()
            .map(|field| DatasetEntry {
                path: field.name().clone(),
                kind: if is_numeric(field.data_type()) {
                    DatasetKind::Numeric
                } else {
                    DatasetKind::Text
                },
                len: row_count,
                shape: vec![row_count],
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(Self {
            path: path.to_owned(),
            entries,
            columns,
            schema,
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
        self.columns
            .get(path)
            .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))?;
        let file = File::open(&self.path)?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file).map_err(backend_error)?;
        let index = builder
            .metadata()
            .file_metadata()
            .schema_descr()
            .root_schema()
            .get_fields()
            .iter()
            .position(|field| field.name() == path)
            .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))?;
        let projection =
            ProjectionMask::roots(builder.metadata().file_metadata().schema_descr(), [index]);
        read_projected_column(builder, projection, entry.len, None)
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
        self.columns
            .get(path)
            .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))?;
        let file = File::open(&self.path)?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file).map_err(backend_error)?;
        let index = builder
            .metadata()
            .file_metadata()
            .schema_descr()
            .root_schema()
            .get_fields()
            .iter()
            .position(|field| field.name() == path)
            .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))?;
        let projection =
            ProjectionMask::roots(builder.metadata().file_metadata().schema_descr(), [index]);
        read_projected_column(builder, projection, limit, Some(limit))
    }

    fn attribute(&self, path: &DatasetPath, name: &str) -> Option<String> {
        let field = self.schema.field_with_name(path).ok()?;
        if name == "units" {
            ["units", "unit", "Units"]
                .into_iter()
                .find_map(|name| field.metadata().get(name).cloned())
        } else {
            field.metadata().get(name).cloned()
        }
    }
}

fn read_projected_column(
    builder: ParquetRecordBatchReaderBuilder<File>,
    projection: ProjectionMask,
    capacity: usize,
    limit: Option<usize>,
) -> Result<Vec<f64>, ContainerError> {
    let batch_size = limit.unwrap_or(4096).max(1);
    let reader = builder
        .with_projection(projection)
        .with_batch_size(batch_size)
        .build()
        .map_err(backend_error)?;
    let mut output = Vec::with_capacity(capacity.min(limit.unwrap_or(capacity)));
    for batch in reader {
        let batch = batch.map_err(backend_error)?;
        let array = batch.columns().first().ok_or_else(|| {
            ContainerError::Backend("Parquet projection returned no column".into())
        })?;
        let cast = cast(array.as_ref(), &DataType::Float64).map_err(backend_error)?;
        let values = cast
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or_else(|| ContainerError::Backend("numeric column was not float64".into()))?;
        output.extend((0..values.len()).map(|row| {
            if values.is_null(row) {
                f64::NAN
            } else {
                values.value(row)
            }
        }));
        if let Some(limit) = limit {
            if output.len() >= limit {
                output.truncate(limit);
                break;
            }
        }
    }
    Ok(output)
}

fn is_numeric(data_type: &DataType) -> bool {
    matches!(
        data_type,
        DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Float16
            | DataType::Float32
            | DataType::Float64
    )
}

fn backend_error(error: impl std::fmt::Display) -> ContainerError {
    ContainerError::Backend(error.to_string())
}

#[cfg(test)]
mod tests {
    use crate::ingest::container::MAX_DATASET_BYTES;

    use super::*;
    use arrow_array::{Float64Array, RecordBatch, StringArray};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    use std::{collections::HashMap, sync::Arc};

    #[test]
    fn columns_are_listed_by_name_and_read_as_f64() {
        let file = write_parquet(&[("time", &[0.0, 1.0]), ("ax", &[2.0, 3.0])]);
        let container = ParquetContainer::open(file.path()).unwrap();
        assert_eq!(
            container
                .datasets()
                .iter()
                .map(|entry| entry.path.clone())
                .collect::<Vec<_>>(),
            ["ax", "time"]
        );
        assert_eq!(container.read_f64("time").unwrap(), vec![0.0, 1.0]);
    }

    #[test]
    fn nulls_read_as_nan_so_they_surface_as_pyramid_gaps() {
        let file = write_parquet_with_nulls();
        let container = ParquetContainer::open(file.path()).unwrap();
        assert!(container.read_f64("ax").unwrap()[1].is_nan());
    }

    #[test]
    fn units_are_read_from_arrow_field_metadata() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let field = Field::new("ax", DataType::Float64, false)
            .with_metadata(HashMap::from([("unit".into(), "m/s".into())]));
        write_batch(
            file.path(),
            vec![field],
            vec![Arc::new(Float64Array::from(vec![1.0]))],
        );

        let container = ParquetContainer::open(file.path()).unwrap();
        assert_eq!(container.attribute("ax", "units").as_deref(), Some("m/s"));
    }

    #[test]
    fn non_numeric_columns_are_listed_but_not_readable_as_f64() {
        let file = write_parquet_with_strings();
        let container = ParquetContainer::open(file.path()).unwrap();
        assert!(matches!(
            container.read_f64("label"),
            Err(ContainerError::NotNumeric(_))
        ));
    }

    #[test]
    fn duplicate_top_level_names_are_rejected() {
        let file = tempfile::NamedTempFile::new().unwrap();
        write_batch(
            file.path(),
            vec![
                Field::new("value", DataType::Float64, false),
                Field::new("value", DataType::Float64, false),
            ],
            vec![
                Arc::new(Float64Array::from(vec![1.0])) as Arc<dyn Array>,
                Arc::new(Float64Array::from(vec![2.0])) as Arc<dyn Array>,
            ],
        );
        assert!(matches!(
            ParquetContainer::open(file.path()),
            Err(ContainerError::Unsupported(message)) if message.contains("duplicate")
        ));
    }

    #[test]
    fn only_a_leading_magic_claims_a_probe_window() {
        assert!(is_parquet_magic(b"PAR1\x00\x00"));
        assert!(
            !is_parquet_magic(b"\x00\x00PAR1"),
            "a trailing match inside the probe window is not a Parquet header"
        );
        assert!(!is_parquet_magic(b"PAR2\x00\x00"));
    }

    #[test]
    fn a_file_whose_probe_window_ends_in_the_magic_is_not_claimed() {
        let mut probe = vec![b'x'; crate::ingest::registry::PROBE_BYTES - 4];
        probe.extend_from_slice(b"PAR1");
        let registry = crate::ingest::registry::ProviderRegistry::builtin();
        let selected = registry.select_bytes(&probe);
        assert!(
            selected.is_err() || selected.unwrap().id() != "parquet",
            "parquet must not claim a file merely because the probe ends in PAR1"
        );
    }

    #[test]
    fn a_column_longer_than_the_ceiling_is_refused() {
        let entry = DatasetEntry {
            path: "ax".into(),
            kind: DatasetKind::Numeric,
            len: MAX_DATASET_BYTES / 8 + 1,
            shape: vec![MAX_DATASET_BYTES / 8 + 1],
        };
        assert!(matches!(
            check_declared_size(&entry),
            Err(ContainerError::Unsupported(_))
        ));
    }

    fn write_parquet(columns: &[(&str, &[f64])]) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        let fields = columns
            .iter()
            .map(|(name, _)| Field::new(*name, DataType::Float64, true))
            .collect::<Vec<_>>();
        let arrays = columns
            .iter()
            .map(|(_, values)| Arc::new(Float64Array::from(values.to_vec())) as Arc<dyn Array>)
            .collect::<Vec<_>>();
        write_batch(file.path(), fields, arrays);
        file
    }

    fn write_parquet_with_nulls() -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        write_batch(
            file.path(),
            vec![Field::new("ax", DataType::Float64, true)],
            vec![Arc::new(Float64Array::from(vec![
                Some(1.0),
                None,
                Some(3.0),
            ]))],
        );
        file
    }

    fn write_parquet_with_strings() -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        write_batch(
            file.path(),
            vec![Field::new("label", DataType::Utf8, false)],
            vec![Arc::new(StringArray::from(vec!["a", "b"]))],
        );
        file
    }

    fn write_batch(path: &Path, fields: Vec<Field>, arrays: Vec<Arc<dyn Array>>) {
        let schema = Arc::new(Schema::new(fields));
        let batch = RecordBatch::try_new(schema.clone(), arrays).unwrap();
        let output = File::create(path).unwrap();
        let mut writer = ArrowWriter::try_new(output, schema, None).unwrap();
        writer.write(&batch).unwrap();
        writer.close().unwrap();
    }
}

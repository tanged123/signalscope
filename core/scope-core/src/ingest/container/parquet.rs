use std::{collections::BTreeMap, fs::File, path::Path};

use arrow_array::{Array, Float64Array};
use arrow_cast::cast;
use arrow_schema::DataType;
use parquet::arrow::{ProjectionMask, arrow_reader::ParquetRecordBatchReaderBuilder};

use crate::ingest::{
    DecodeContext, DecodedSource, Decoder, IngestError,
    provenance::CACHE_ABI_PARQUET,
    registry::{Confidence, FormatProvider},
};

use super::{ContainerError, ContainerReader, DatasetEntry, DatasetKind, DatasetPath};

const PARQUET_MAGIC: &[u8] = b"PAR1";

pub fn is_parquet_magic(probe: &[u8]) -> bool {
    probe.starts_with(PARQUET_MAGIC) || probe.ends_with(PARQUET_MAGIC)
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
        Err(IngestError::UnsupportedFormat(
            "Parquet input requires a validated container recipe".into(),
        ))
    }
}

pub struct ParquetContainer {
    path: std::path::PathBuf,
    entries: Vec<DatasetEntry>,
    columns: BTreeMap<String, usize>,
}

impl ContainerReader for ParquetContainer {
    fn open(path: &Path) -> Result<Self, ContainerError> {
        let file = File::open(path)?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file).map_err(backend_error)?;
        let schema = builder.schema().clone();
        let row_count = usize::try_from(builder.metadata().file_metadata().num_rows())
            .map_err(|_| ContainerError::Backend("Parquet row count is negative".into()))?;
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
        let index = *self
            .columns
            .get(path)
            .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))?;
        let file = File::open(&self.path)?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file).map_err(backend_error)?;
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
        let index = *self
            .columns
            .get(path)
            .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))?;
        let file = File::open(&self.path)?;
        let builder = ParquetRecordBatchReaderBuilder::try_new(file).map_err(backend_error)?;
        let projection =
            ProjectionMask::roots(builder.metadata().file_metadata().schema_descr(), [index]);
        read_projected_column(builder, projection, limit, Some(limit))
    }

    fn attribute(&self, _path: &DatasetPath, _name: &str) -> Option<String> {
        None
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
    use super::*;
    use arrow_array::{Float64Array, RecordBatch, StringArray};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;
    use std::sync::Arc;

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
    fn non_numeric_columns_are_listed_but_not_readable_as_f64() {
        let file = write_parquet_with_strings();
        let container = ParquetContainer::open(file.path()).unwrap();
        assert!(matches!(
            container.read_f64("label"),
            Err(ContainerError::NotNumeric(_))
        ));
    }

    #[test]
    fn the_magic_is_recognized_at_both_ends_of_the_file() {
        assert!(is_parquet_magic(b"PAR1\x00\x00"));
        assert!(is_parquet_magic(b"\x00\x00PAR1"));
        assert!(!is_parquet_magic(b"PAR2\x00\x00"));
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

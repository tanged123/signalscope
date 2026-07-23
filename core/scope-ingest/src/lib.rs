//! Streaming source decoders.

use std::{
    fs::File,
    io::{BufRead, BufReader, Seek},
    path::{Path, PathBuf},
};

use scope_store::{SignalId, SignalStore, SourceId, StoreError};
use thiserror::Error;

const TIME_NAMES: &[&str] = &[
    "t",
    "time",
    "timestamp",
    "time_s",
    "stamp",
    "ts",
    "sec",
    "secs",
    "seconds",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IngestSummary {
    pub source_id: SourceId,
    pub source_path: PathBuf,
    pub row_count: usize,
    pub signals: Vec<SignalId>,
}

/// Common boundary for file and future live decoders.
pub trait Decoder {
    fn ingest(&self, path: &Path, store: &mut SignalStore) -> Result<IngestSummary, IngestError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CsvDecoder;

impl Decoder for CsvDecoder {
    fn ingest(&self, path: &Path, store: &mut SignalStore) -> Result<IngestSummary, IngestError> {
        let mut file = File::open(path)?;
        let probe = probe_first_data_line(&mut file)?;
        file.rewind()?;

        let delimiter = detect_delimiter(&probe);
        let has_headers = detect_header(&probe, delimiter);
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(delimiter)
            .has_headers(has_headers)
            .comment(Some(b'#'))
            .flexible(true)
            .trim(csv::Trim::All)
            .from_reader(file);

        let headers = if has_headers {
            reader
                .headers()?
                .iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        } else {
            let count = split_probe(&probe, delimiter).len();
            (1..=count).map(|index| format!("col{index}")).collect()
        };

        if headers.len() < 2 {
            return Err(IngestError::TooFewColumns);
        }

        let mut columns = vec![Vec::<f64>::new(); headers.len()];
        for record in reader.records() {
            let record = record?;
            if record.len() < 2 {
                continue;
            }
            for (index, column) in columns.iter_mut().enumerate() {
                let value = record
                    .get(index)
                    .map(str::trim)
                    .filter(|cell| !cell.is_empty())
                    .and_then(|cell| cell.parse::<f64>().ok())
                    .unwrap_or(f64::NAN);
                column.push(value);
            }
        }

        let row_count = columns.first().map_or(0, Vec::len);
        if row_count == 0 {
            return Err(IngestError::NoDataRows);
        }

        let time_index = select_time_column(&headers, &columns);
        let time = time_index.map_or_else(
            || (0..row_count).map(|index| index as f64).collect(),
            |index| columns[index].clone(),
        );

        let source_id = store.register_source(path);
        let base = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("source");
        let mut signals = Vec::new();
        for (index, (header, values)) in headers.into_iter().zip(columns).enumerate() {
            if Some(index) == time_index || !values.iter().any(|value| value.is_finite()) {
                continue;
            }
            let path = normalize_signal_path(base, &header);
            signals.push(store.insert_signal(source_id, path, None, time.clone(), values)?);
        }

        Ok(IngestSummary {
            source_id,
            source_path: path.to_owned(),
            row_count,
            signals,
        })
    }
}

pub fn ingest_csv_path(
    path: impl AsRef<Path>,
    store: &mut SignalStore,
) -> Result<IngestSummary, IngestError> {
    CsvDecoder.ingest(path.as_ref(), store)
}

fn probe_first_data_line(file: &mut File) -> Result<String, IngestError> {
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Err(IngestError::NoDataRows);
        }
        let trimmed = line.trim();
        if !trimmed.is_empty() && !matches!(trimmed.as_bytes().first(), Some(b'#' | b'%' | b';')) {
            return Ok(trimmed.to_owned());
        }
    }
}

fn detect_delimiter(probe: &str) -> u8 {
    [b'\t', b',', b';', b'|']
        .into_iter()
        .max_by_key(|delimiter| {
            probe
                .as_bytes()
                .iter()
                .filter(|byte| *byte == delimiter)
                .count()
        })
        .filter(|delimiter| probe.as_bytes().contains(delimiter))
        .unwrap_or(b',')
}

fn split_probe(probe: &str, delimiter: u8) -> Vec<&str> {
    probe.split(char::from(delimiter)).map(str::trim).collect()
}

fn detect_header(probe: &str, delimiter: u8) -> bool {
    split_probe(probe, delimiter)
        .into_iter()
        .any(|cell| !cell.is_empty() && cell.trim_matches('"').parse::<f64>().is_err())
}

fn select_time_column(headers: &[String], columns: &[Vec<f64>]) -> Option<usize> {
    headers
        .iter()
        .position(|header| {
            TIME_NAMES
                .iter()
                .any(|name| header.trim().eq_ignore_ascii_case(name))
        })
        .or_else(|| {
            columns
                .iter()
                .position(|column| column.windows(2).all(|pair| pair[1] >= pair[0]))
        })
}

fn normalize_signal_path(base: &str, header: &str) -> String {
    let clean = header
        .trim()
        .trim_matches('"')
        .replace([' ', '.'], "_")
        .to_lowercase();
    format!("{base}/{clean}")
}

#[derive(Debug, Error)]
pub enum IngestError {
    #[error("source has fewer than two columns")]
    TooFewColumns,
    #[error("source has no data rows")]
    NoDataRows,
    #[error(transparent)]
    Csv(#[from] csv::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn detects_header_delimiter_and_time_column() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "# exported telemetry").unwrap();
        writeln!(file, "time_s;Motor.Left RPM;current").unwrap();
        writeln!(file, "0.0;10;2.5").unwrap();
        writeln!(file, "0.1;11;").unwrap();

        let mut store = SignalStore::new();
        let summary = ingest_csv_path(file.path(), &mut store).unwrap();
        let paths = store
            .signals()
            .map(|signal| signal.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(summary.row_count, 2);
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with("/motor_left_rpm"));
        assert!(store.signals().nth(1).unwrap().values()[1].is_nan());
    }

    #[test]
    fn creates_index_time_without_time_column() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "a,b").unwrap();
        writeln!(file, "3,8").unwrap();
        writeln!(file, "2,7").unwrap();

        let mut store = SignalStore::new();
        ingest_csv_path(file.path(), &mut store).unwrap();

        assert_eq!(store.signals().next().unwrap().time(), &[0.0, 1.0]);
    }
}

//! CSV decoding with delimiter, header, and time-column autodetection.

use std::{
    fs::File,
    io::{BufRead, BufReader, Cursor},
    path::Path,
    sync::Arc,
};

use super::{
    Decoder, IngestError, IngestSummary, apply_permutation, normalize_segment, sort_permutation,
};
use crate::{
    naming,
    store::{SignalStore, SourceKey},
};
use uuid::Uuid;

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

#[derive(Clone, Copy, Debug, Default)]
pub struct CsvDecoder;

impl CsvDecoder {
    #[allow(clippy::cast_precision_loss)] // progress fractions tolerate rounding
    fn ingest_unchecked(
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError> {
        let input = filter_comment_lines(File::open(path)?)?;
        let probe = probe_first_data_line(&input)?;

        let delimiter = detect_delimiter(&probe);
        let has_headers = detect_header(&probe, delimiter);
        let mut reader = ::csv::ReaderBuilder::new()
            .delimiter(delimiter)
            .has_headers(has_headers)
            .flexible(true)
            .trim(::csv::Trim::All)
            .from_reader(Cursor::new(input));

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

        let total = reader.get_ref().get_ref().len().max(1) as f64;
        let mut columns = vec![Vec::<f64>::new(); headers.len()];
        let mut records_seen = 0_usize;
        for record in reader.records() {
            let record = record?;
            records_seen += 1;
            if records_seen % 4096 == 0 {
                let byte = record.position().map_or(0, ::csv::Position::byte);
                progress((byte as f64 / total).min(1.0));
            }
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
        progress(1.0);

        let row_count = columns.first().map_or(0, Vec::len);
        if row_count == 0 {
            return Err(IngestError::NoDataRows);
        }

        let time_index = select_time_column(&headers, &columns);
        if let Some(index) = time_index {
            sort_columns_by_time(&mut columns, index);
        }
        let time = time_index.map_or_else(
            || {
                std::iter::successors(Some(0.0), |value| Some(value + 1.0))
                    .take(row_count)
                    .collect()
            },
            |index| columns[index].clone(),
        );

        let source_id = store.register_source(
            path,
            SourceKey(Uuid::new_v4()),
            naming::default_prefix(path),
        )?;
        let time: Arc<[f64]> = time.into();
        let mut signals = Vec::new();
        for (index, (header, values)) in headers.into_iter().zip(columns).enumerate() {
            if Some(index) == time_index || !values.iter().any(|value| value.is_finite()) {
                continue;
            }
            let path = normalize_segment(&header);
            signals.push(store.insert_signal(source_id, path, None, Arc::clone(&time), values)?);
        }

        Ok(IngestSummary {
            source_id,
            row_count,
            signals,
        })
    }
}

impl Decoder for CsvDecoder {
    fn decode(
        &self,
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError> {
        Self::ingest_unchecked(path, store, progress)
    }
}

fn filter_comment_lines(file: File) -> Result<Vec<u8>, IngestError> {
    let mut filtered = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() || matches!(trimmed.as_bytes().first(), Some(b'#' | b'%' | b';')) {
            continue;
        }
        filtered.extend_from_slice(line.as_bytes());
        filtered.push(b'\n');
    }
    if filtered.is_empty() {
        return Err(IngestError::NoDataRows);
    }
    Ok(filtered)
}

fn probe_first_data_line(input: &[u8]) -> Result<String, IngestError> {
    let mut reader = BufReader::new(input);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Err(IngestError::NoDataRows);
        }
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_owned());
        }
    }
}

fn detect_delimiter(probe: &str) -> u8 {
    [b'\t', b',', b';', b'|']
        .into_iter()
        .max_by_key(|delimiter| probe.matches(char::from(*delimiter)).count())
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
        .enumerate()
        .find_map(|(index, header)| {
            let matches_name = TIME_NAMES
                .iter()
                .any(|name| header.trim().eq_ignore_ascii_case(name));
            (matches_name && columns[index].iter().all(|value| value.is_finite())).then_some(index)
        })
        .or_else(|| {
            columns
                .iter()
                .position(|column| is_monotonic_finite(column))
        })
}

fn sort_columns_by_time(columns: &mut [Vec<f64>], time_index: usize) {
    let Some(order) = columns
        .get(time_index)
        .and_then(|time| sort_permutation(time))
    else {
        return;
    };
    for column in columns {
        *column = apply_permutation(&order, column);
    }
}

fn is_monotonic_finite(column: &[f64]) -> bool {
    column.iter().all(|value| value.is_finite()) && column.windows(2).all(|pair| pair[1] >= pair[0])
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::ingest::ingest_path;

    #[test]
    fn detects_header_delimiter_and_time_column() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "# exported telemetry").unwrap();
        writeln!(file, "time_s;Motor.Left RPM;current").unwrap();
        writeln!(file, "0.0;10;2.5").unwrap();
        writeln!(file, "0.1;11;").unwrap();

        let mut store = SignalStore::new();
        let summary = ingest_path(file.path(), &mut store, &mut |_| {}).unwrap();
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
        ingest_path(file.path(), &mut store, &mut |_| {}).unwrap();

        assert_eq!(store.signals().next().unwrap().time(), &[0.0, 1.0]);
    }

    #[test]
    fn sorts_named_time_with_all_value_columns_aligned() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "time,value,other").unwrap();
        writeln!(file, "2,20,200").unwrap();
        writeln!(file, "0,0,100").unwrap();
        writeln!(file, "1,10,150").unwrap();

        let mut store = SignalStore::new();
        ingest_path(file.path(), &mut store, &mut |_| {}).unwrap();

        let value = store
            .signals()
            .find(|signal| signal.path.ends_with("/value"))
            .unwrap();
        let other = store
            .signals()
            .find(|signal| signal.path.ends_with("/other"))
            .unwrap();
        assert_eq!(value.time(), &[0.0, 1.0, 2.0]);
        assert_eq!(value.values(), &[0.0, 10.0, 20.0]);
        assert_eq!(other.values(), &[100.0, 150.0, 200.0]);
    }

    #[test]
    fn filters_all_probe_comment_markers_before_parsing() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "% exported by matlab").unwrap();
        writeln!(file, "; another comment").unwrap();
        writeln!(file, "time,value").unwrap();
        writeln!(file, "0,4").unwrap();

        let mut store = SignalStore::new();
        let summary = ingest_path(file.path(), &mut store, &mut |_| {}).unwrap();

        assert_eq!(summary.row_count, 1);
        assert_eq!(summary.signals.len(), 1);
        assert_eq!(store.signals().next().unwrap().values(), &[4.0]);
    }

    #[test]
    fn rolls_back_source_and_signals_when_registration_fails() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "time,value,value").unwrap();
        writeln!(file, "0,4,5").unwrap();

        let mut store = SignalStore::new();
        assert!(ingest_path(file.path(), &mut store, &mut |_| {}).is_err());

        assert_eq!(store.sources().count(), 0);
        assert_eq!(store.signals().count(), 0);
    }
}

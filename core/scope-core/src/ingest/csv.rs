//! CSV decoding with delimiter, header, and time-column autodetection.

use std::{
    fs::File,
    io::{BufRead, BufReader, Cursor, Read},
    path::Path,
    sync::Arc,
};

use super::{
    DecodeContext, DecodedSignal, DecodedSource, Decoder, IngestError, apply_permutation_in_place,
    normalize_segment, sort_permutation,
};

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
    fn decode_reader_with_total<R: BufRead>(
        reader: R,
        total: Option<u64>,
        context: &mut DecodeContext<'_>,
    ) -> Result<DecodedSource, IngestError> {
        let mut filtered = BufReader::new(CommentFilter::new(reader));
        let mut probe = String::new();
        if filtered.read_line(&mut probe)? == 0 {
            return Err(IngestError::NoDataRows);
        }
        let probe = probe.trim().to_owned();
        let delimiter = detect_delimiter(&probe);
        let has_headers = detect_header(&probe, delimiter);
        let headers = if has_headers {
            split_probe(&probe, delimiter)
                .into_iter()
                .map(|header| header.trim_matches('"').to_owned())
                .collect::<Vec<_>>()
        } else {
            (1..=split_probe(&probe, delimiter).len())
                .map(|index| format!("col{index}"))
                .collect()
        };
        if headers.len() < 2 {
            return Err(IngestError::TooFewColumns);
        }

        let prefix = if has_headers {
            Vec::new()
        } else {
            let mut bytes = probe.into_bytes();
            bytes.push(b'\n');
            bytes
        };
        let mut reader = ::csv::ReaderBuilder::new()
            .delimiter(delimiter)
            .has_headers(false)
            .flexible(true)
            .comment(None)
            .trim(::csv::Trim::All)
            .from_reader(Cursor::new(prefix).chain(filtered));
        let mut columns = vec![Vec::<f64>::new(); headers.len()];
        let mut records_seen = 0_usize;
        let mut record = ::csv::StringRecord::new();
        while reader.read_record(&mut record)? {
            records_seen += 1;
            if records_seen % 4096 == 0 {
                context.check()?;
                let fraction = total.map_or(0.0, |total| {
                    reader.position().byte() as f64 / total.max(1) as f64
                });
                context.report(fraction);
            }
            if record.len() < 2 {
                continue;
            }
            for (index, column) in columns.iter_mut().enumerate() {
                column.push(parse_cell(record.get(index)));
            }
        }
        context.check()?;
        context.report(1.0);
        finish(headers, columns)
    }

    /// # Errors
    ///
    /// Returns a decode or cancellation error.
    pub fn decode_reader<R: BufRead>(
        &self,
        reader: R,
        context: &mut DecodeContext<'_>,
    ) -> Result<DecodedSource, IngestError> {
        Self::decode_reader_with_total(reader, None, context)
    }
}

impl Decoder for CsvDecoder {
    fn decode(
        &self,
        path: &Path,
        context: &mut DecodeContext<'_>,
    ) -> Result<DecodedSource, IngestError> {
        let file = File::open(path)?;
        let total = file.metadata().ok().map(|metadata| metadata.len());
        Self::decode_reader_with_total(BufReader::new(file), total, context)
    }
}

struct CommentFilter<R> {
    inner: R,
    pending: Vec<u8>,
    offset: usize,
}

impl<R> CommentFilter<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            pending: Vec::new(),
            offset: 0,
        }
    }
}

impl<R: BufRead> Read for CommentFilter<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        while self.offset == self.pending.len() {
            self.pending.clear();
            self.offset = 0;
            if self.inner.read_until(b'\n', &mut self.pending)? == 0 {
                return Ok(0);
            }
            let trimmed = self.pending.trim_ascii();
            if trimmed.is_empty() || matches!(trimmed.first().copied(), Some(b'#' | b'%' | b';')) {
                self.pending.clear();
            }
        }
        let count = output.len().min(self.pending.len() - self.offset);
        output[..count].copy_from_slice(&self.pending[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

fn parse_cell(cell: Option<&str>) -> f64 {
    cell.map(str::trim)
        .filter(|cell| !cell.is_empty())
        .and_then(|cell| cell.parse::<f64>().ok())
        .unwrap_or(f64::NAN)
}

fn finish(headers: Vec<String>, mut columns: Vec<Vec<f64>>) -> Result<DecodedSource, IngestError> {
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
    let time: Arc<[f64]> = time.into();
    let mut signals = Vec::new();
    for (index, (header, values)) in headers.into_iter().zip(columns).enumerate() {
        if Some(index) == time_index || !values.iter().any(|value| value.is_finite()) {
            continue;
        }
        signals.push(DecodedSignal {
            local_path: normalize_segment(&header),
            unit: None,
            time: Arc::clone(&time),
            values: values.into(),
        });
    }
    Ok(DecodedSource { row_count, signals })
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
    let mut scratch = Vec::new();
    for column in columns {
        apply_permutation_in_place(&order, column, &mut scratch);
    }
}

fn is_monotonic_finite(column: &[f64]) -> bool {
    column.iter().all(|value| value.is_finite()) && column.windows(2).all(|pair| pair[1] >= pair[0])
}

#[cfg(test)]
mod tests {
    use std::{
        cell::RefCell,
        io::{Read, Write},
        rc::Rc,
    };

    use super::*;
    use crate::{
        ingest::{CancelToken, ingest_for_test},
        store::SignalStore,
    };

    struct LoggingReader<'a> {
        inner: std::io::Cursor<Vec<u8>>,
        log: Rc<RefCell<Vec<&'a str>>>,
    }

    impl Read for LoggingReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.inner.read(buffer)?;
            if read > 0 {
                self.log.borrow_mut().push("read");
            }
            Ok(read)
        }
    }

    #[test]
    fn decoding_is_interleaved_with_reading() {
        let mut bytes = b"time,value\n".to_vec();
        for row in 0..40_000 {
            bytes.extend_from_slice(format!("{row},{}\n", row * 2).as_bytes());
        }
        let log = Rc::new(RefCell::new(Vec::new()));
        let reader = std::io::BufReader::with_capacity(
            8 * 1024,
            LoggingReader {
                inner: std::io::Cursor::new(bytes),
                log: Rc::clone(&log),
            },
        );
        let cancel = CancelToken::default();
        let sink = Rc::clone(&log);
        let mut progress = move |_: f64| sink.borrow_mut().push("progress");
        let mut context = DecodeContext {
            progress: &mut progress,
            cancel: &cancel,
        };

        let decoded = CsvDecoder.decode_reader(reader, &mut context).unwrap();
        assert_eq!(decoded.row_count, 40_000);
        let entries = log.borrow();
        let first_progress = entries
            .iter()
            .position(|entry| *entry == "progress")
            .unwrap();
        let last_read = entries.iter().rposition(|entry| *entry == "read").unwrap();
        assert!(first_progress < last_read);
    }

    #[test]
    fn cancellation_stops_a_long_decode() {
        let mut bytes = b"time,value\n".to_vec();
        for row in 0..40_000 {
            bytes.extend_from_slice(format!("{row},{row}\n").as_bytes());
        }
        let cancel = CancelToken::default();
        let mut progress = |_: f64| cancel.cancel();
        let mut context = DecodeContext {
            progress: &mut progress,
            cancel: &cancel,
        };
        let error = CsvDecoder
            .decode_reader(
                std::io::BufReader::new(std::io::Cursor::new(bytes)),
                &mut context,
            )
            .unwrap_err();
        assert!(matches!(error, IngestError::Cancelled));
    }

    #[test]
    fn detects_header_delimiter_and_time_column() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "# exported telemetry").unwrap();
        writeln!(file, "time_s;Motor.Left RPM;current").unwrap();
        writeln!(file, "0.0;10;2.5").unwrap();
        writeln!(file, "0.1;11;").unwrap();

        let mut store = SignalStore::new();
        let summary = ingest_for_test(file.path(), &mut store, &mut |_| {}).unwrap();
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
        ingest_for_test(file.path(), &mut store, &mut |_| {}).unwrap();

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
        ingest_for_test(file.path(), &mut store, &mut |_| {}).unwrap();

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
        let summary = ingest_for_test(file.path(), &mut store, &mut |_| {}).unwrap();

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
        assert!(ingest_for_test(file.path(), &mut store, &mut |_| {}).is_err());

        assert_eq!(store.sources().count(), 0);
        assert_eq!(store.signals().count(), 0);
    }
}

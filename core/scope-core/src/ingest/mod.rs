//! Streaming source decoders and format dispatch.

mod csv;
mod mcap;

pub use self::csv::CsvDecoder;
pub use self::mcap::McapDecoder;

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use crate::store::{SignalId, SignalStore, SourceId, StoreError};
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IngestSummary {
    pub source_id: SourceId,
    pub source_path: PathBuf,
    pub row_count: usize,
    pub signals: Vec<SignalId>,
}

/// Common boundary for file and future live decoders.
pub trait Decoder {
    /// Decodes `path` and registers its signals in `store`, reporting decode
    /// progress as fractions in `0.0..=1.0`. Formats without a byte-accurate
    /// total may report only `0.0` and `1.0`.
    ///
    /// Implementations may leave partial registrations behind on error;
    /// callers get atomicity from [`Decoder::ingest`].
    ///
    /// # Errors
    ///
    /// Returns [`IngestError`] when the source cannot be read, decoded, or
    /// registered.
    fn decode(
        &self,
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError>;

    /// Decodes `path` atomically: on error the store is unchanged.
    ///
    /// # Errors
    ///
    /// Returns [`IngestError`] when the source cannot be read, decoded, or
    /// registered.
    fn ingest(
        &self,
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError> {
        store.transaction(|store| self.decode(path, store, progress))
    }
}

const MCAP_MAGIC: [u8; 8] = *b"\x89MCAP0\r\n";

/// Ingestible formats as (label, extensions), for hosts building file
/// pickers. Actual dispatch sniffs content, not extensions.
pub const SUPPORTED_FORMATS: &[(&str, &[&str])] = &[
    (
        "Delimited text (CSV, TSV, TXT, DAT)",
        &["csv", "tsv", "txt", "dat"],
    ),
    ("MCAP recordings (MCAP)", &["mcap"]),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceFormat {
    Csv,
    Mcap,
}

fn sniff_format(path: &Path) -> Result<SourceFormat, IngestError> {
    let mut magic = Vec::with_capacity(MCAP_MAGIC.len());
    File::open(path)?
        .take(MCAP_MAGIC.len() as u64)
        .read_to_end(&mut magic)?;
    Ok(if magic == MCAP_MAGIC {
        SourceFormat::Mcap
    } else {
        SourceFormat::Csv
    })
}

/// Ingests a source file atomically, selecting the decoder by content.
///
/// # Errors
///
/// Returns [`IngestError`] when the source cannot be read, decoded, or
/// registered.
pub fn ingest_path(
    path: impl AsRef<Path>,
    store: &mut SignalStore,
    progress: &mut dyn FnMut(f64),
) -> Result<IngestSummary, IngestError> {
    let path = path.as_ref();
    match sniff_format(path)? {
        SourceFormat::Csv => CsvDecoder.ingest(path, store, progress),
        SourceFormat::Mcap => McapDecoder.ingest(path, store, progress),
    }
}

/// Returns the permutation that sorts `time` ascending (`total_cmp`), or
/// `None` when the column is already in order.
pub(crate) fn sort_permutation(time: &[f64]) -> Option<Vec<usize>> {
    let mut order: Vec<usize> = (0..time.len()).collect();
    order.sort_by(|&left, &right| time[left].total_cmp(&time[right]));
    order
        .iter()
        .enumerate()
        .any(|(position, index)| position != *index)
        .then_some(order)
}

pub(crate) fn apply_permutation(order: &[usize], column: &[f64]) -> Vec<f64> {
    order.iter().map(|&index| column[index]).collect()
}

/// Lowercases a path segment and folds spaces/dots to underscores.
pub(crate) fn normalize_segment(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .replace([' ', '.'], "_")
        .to_lowercase()
}

#[derive(Debug, Error)]
pub enum IngestError {
    #[error("source has fewer than two columns")]
    TooFewColumns,
    #[error("source has no data rows")]
    NoDataRows,
    #[error(transparent)]
    Csv(#[from] ::csv::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Mcap(#[from] ::mcap::McapError),
    #[error("no ingestible channels; message encodings present: {0}")]
    NoSupportedChannels(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn dispatch_treats_short_files_as_csv() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"a,b\n1,2\n").unwrap();
        let mut store = SignalStore::new();
        let summary = ingest_path(file.path(), &mut store, &mut |_| {}).unwrap();
        assert_eq!(summary.row_count, 1);
    }

    #[test]
    fn bundled_demo_csv_stays_ingestible() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/demo_flight.csv");
        let mut store = SignalStore::new();
        let summary = ingest_path(path, &mut store, &mut |_| {}).unwrap();

        assert_eq!(summary.row_count, 201);
        assert_eq!(summary.signals.len(), 16);
        assert!(
            store.signals().all(|signal| signal.values().len() >= 64),
            "every bundled signal must have enough samples for FFT mode"
        );
        let paths = store
            .signals()
            .map(|signal| signal.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"demo_flight/navigation/position_east_m"));
        assert!(paths.contains(&"demo_flight/events/engine_on"));
        let gps = store
            .signals()
            .find(|signal| signal.path.ends_with("/sensor/gps_altitude_m"))
            .unwrap();
        assert_eq!(
            gps.values().iter().filter(|value| value.is_nan()).count(),
            2
        );
    }

    #[test]
    fn csv_decode_reports_monotonic_progress_ending_at_one() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "time,value").unwrap();
        for row in 0..20_000 {
            writeln!(file, "{row},{}", row * 2).unwrap();
        }
        let mut store = SignalStore::new();
        let mut fractions = Vec::new();
        ingest_path(file.path(), &mut store, &mut |fraction| {
            fractions.push(fraction);
        })
        .unwrap();
        assert!(fractions.len() >= 2, "expected intermediate progress");
        assert!(fractions.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!((fractions.last().copied().unwrap() - 1.0).abs() < f64::EPSILON);
        assert!(fractions.iter().all(|f| (0.0..=1.0).contains(f)));
    }
}

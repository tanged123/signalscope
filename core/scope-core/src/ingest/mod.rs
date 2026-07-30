//! Streaming source decoders and format dispatch.

pub mod admission;
pub mod batch;
mod csv;
mod decoded;
mod mcap;
pub mod provenance;

pub use self::csv::CsvDecoder;
pub use self::decoded::*;
pub use self::mcap::McapDecoder;

use std::{fs::File, io::Read, path::Path};

use crate::{
    naming::normalize_segment,
    store::{SignalId, SignalStore, SourceId, SourceKey, StoreError},
};
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IngestSummary {
    pub source_id: SourceId,
    pub row_count: usize,
    pub signals: Vec<SignalId>,
}

/// Common boundary for file and future live decoders.
pub trait Decoder {
    /// # Errors
    ///
    /// Returns a decode or cancellation error.
    fn decode(
        &self,
        path: &Path,
        context: &mut DecodeContext<'_>,
    ) -> Result<DecodedSource, IngestError>;
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
pub enum SourceFormat {
    Csv,
    Mcap,
}

pub(crate) fn sniff_format(path: &Path) -> Result<SourceFormat, IngestError> {
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

#[must_use]
pub fn provider_for(format: SourceFormat) -> provenance::ProviderInfo {
    match format {
        SourceFormat::Csv => provenance::ProviderInfo {
            id: "csv",
            cache_abi: provenance::CACHE_ABI_CSV,
        },
        SourceFormat::Mcap => provenance::ProviderInfo {
            id: "mcap",
            cache_abi: provenance::CACHE_ABI_MCAP,
        },
    }
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
    key: SourceKey,
    prefix: &str,
    context: &mut DecodeContext<'_>,
) -> Result<IngestSummary, IngestError> {
    let path = path.as_ref();
    let decoded = match sniff_format(path)? {
        SourceFormat::Csv => CsvDecoder.decode(path, context)?,
        SourceFormat::Mcap => McapDecoder.decode(path, context)?,
    };
    commit(store, key, prefix, path, decoded)
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

pub(crate) fn apply_permutation_in_place(
    order: &[usize],
    column: &mut Vec<f64>,
    scratch: &mut Vec<f64>,
) {
    scratch.clear();
    scratch.extend(order.iter().map(|&index| column[index]));
    std::mem::swap(column, scratch);
}

#[derive(Debug, Error)]
pub enum IngestError {
    #[error("source has fewer than two columns")]
    TooFewColumns,
    #[error("source has no data rows")]
    NoDataRows,
    #[error("ingest was cancelled")]
    Cancelled,
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
    #[error(transparent)]
    Source(#[from] crate::sources::SourceError),
}

#[cfg(test)]
pub(crate) fn ingest_for_test(
    path: &Path,
    store: &mut SignalStore,
    progress: &mut dyn FnMut(f64),
) -> Result<IngestSummary, IngestError> {
    let cancel = CancelToken::default();
    let mut context = DecodeContext {
        progress,
        cancel: &cancel,
    };
    ingest_path(
        path,
        store,
        SourceKey(uuid::Uuid::new_v4()),
        &crate::naming::default_prefix(path),
        &mut context,
    )
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
        let summary = ingest_for_test(file.path(), &mut store, &mut |_| {}).unwrap();
        assert_eq!(summary.row_count, 1);
    }

    #[test]
    fn bundled_demo_csv_stays_ingestible() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/demo_flight.csv");
        let mut store = SignalStore::new();
        let summary = ingest_for_test(&path, &mut store, &mut |_| {}).unwrap();

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
    fn monte_carlo_demo_forms_one_partial_set() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/monte_carlo");
        let mut files = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        files.sort();
        let cancel = CancelToken::default();
        let candidates = files
            .iter()
            .enumerate()
            .map(|(index, path)| {
                let mut progress = |_| {};
                let mut context = DecodeContext {
                    progress: &mut progress,
                    cancel: &cancel,
                };
                let decoded = CsvDecoder.decode(path, &mut context).unwrap();
                (
                    SourceKey(uuid::Uuid::from_u128(index as u128 + 1)),
                    decoded
                        .signals
                        .into_iter()
                        .map(|signal| signal.local_path)
                        .collect(),
                )
            })
            .collect::<Vec<_>>();

        let sets = crate::sets::propose_sets(&candidates);

        assert_eq!(files.len(), 8);
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].members.len(), 8);
        assert_eq!(
            sets[0].missing_for(candidates[7].0),
            &std::collections::BTreeSet::from(["temperature".to_owned()])
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
        ingest_for_test(file.path(), &mut store, &mut |fraction| {
            fractions.push(fraction);
        })
        .unwrap();
        assert!(fractions.len() >= 2, "expected intermediate progress");
        assert!(fractions.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!((fractions.last().copied().unwrap() - 1.0).abs() < f64::EPSILON);
        assert!(fractions.iter().all(|f| (0.0..=1.0).contains(f)));
    }
}

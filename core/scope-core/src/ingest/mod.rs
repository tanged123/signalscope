//! Streaming source decoders and format dispatch.

pub mod admission;
pub mod batch;
pub mod container;
mod csv;
mod decoded;
mod mcap;
pub mod provenance;
pub mod recipe;
pub mod registry;

pub use self::csv::CsvDecoder;
pub use self::decoded::*;
pub use self::mcap::McapDecoder;

use std::path::Path;

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

use self::registry::{ProviderRegistry, SelectionError};

/// Selects a provider by content and decodes a source without committing it.
///
/// # Errors
///
/// Returns an unsupported-format, IO, cancellation, or decoder error.
pub fn dispatch(
    registry: &ProviderRegistry,
    path: &Path,
    context: &mut DecodeContext<'_>,
) -> Result<(provenance::ProviderInfo, DecodedSource), IngestError> {
    let provider = registry.select(path).map_err(selection_error)?;
    decode_with_provider(provider, path, context)
}

/// Decodes a source using its recorded provider id.
///
/// # Errors
///
/// Returns a provider-unavailable, IO, cancellation, or decoder error.
pub fn dispatch_with_provider(
    registry: &ProviderRegistry,
    provider_id: &str,
    path: &Path,
    context: &mut DecodeContext<'_>,
) -> Result<(provenance::ProviderInfo, DecodedSource), IngestError> {
    let provider =
        registry
            .provider(provider_id)
            .ok_or_else(|| IngestError::ProviderUnavailable {
                provider_id: provider_id.to_owned(),
            })?;
    decode_with_provider(provider, path, context)
}

fn decode_with_provider(
    provider: &registry::FormatProvider,
    path: &Path,
    context: &mut DecodeContext<'_>,
) -> Result<(provenance::ProviderInfo, DecodedSource), IngestError> {
    let info = provider_info(provider);
    let decoded = provider.decoder().decode(path, context)?;
    Ok((info, decoded))
}

pub(crate) fn provider_for_path(
    registry: &ProviderRegistry,
    path: &Path,
) -> Result<provenance::ProviderInfo, IngestError> {
    registry
        .select(path)
        .map(provider_info)
        .map_err(selection_error)
}

pub(crate) fn provider_for_id(
    registry: &ProviderRegistry,
    provider_id: &str,
) -> Result<provenance::ProviderInfo, IngestError> {
    registry
        .provider(provider_id)
        .map(provider_info)
        .ok_or_else(|| IngestError::ProviderUnavailable {
            provider_id: provider_id.to_owned(),
        })
}

fn provider_info(provider: &registry::FormatProvider) -> provenance::ProviderInfo {
    provenance::ProviderInfo {
        id: provider.id().to_owned(),
        cache_abi: provider.cache_abi(),
    }
}

fn selection_error(error: SelectionError) -> IngestError {
    match error {
        SelectionError::Io { source, .. } => IngestError::Io(source),
        SelectionError::Unsupported { path, known } => IngestError::UnsupportedFormat(format!(
            "unsupported input {path}; known formats: {known}"
        )),
    }
}

/// Ingests a source file atomically, selecting the decoder by content.
///
/// # Errors
///
/// Returns [`IngestError`] when the source cannot be read, decoded, or
/// registered.
pub fn ingest_path(
    registry: &ProviderRegistry,
    path: impl AsRef<Path>,
    store: &mut SignalStore,
    key: SourceKey,
    prefix: &str,
    context: &mut DecodeContext<'_>,
) -> Result<IngestSummary, IngestError> {
    let path = path.as_ref();
    let (_, decoded) = dispatch(registry, path, context)?;
    commit(store, key, prefix, path, decoded)
}

pub(crate) fn ingest_path_with_provider(
    registry: &ProviderRegistry,
    provider_id: Option<&str>,
    path: impl AsRef<Path>,
    store: &mut SignalStore,
    key: SourceKey,
    prefix: &str,
    context: &mut DecodeContext<'_>,
) -> Result<IngestSummary, IngestError> {
    let path = path.as_ref();
    let (_, decoded) = match provider_id {
        Some(provider_id) => dispatch_with_provider(registry, provider_id, path, context)?,
        None => dispatch(registry, path, context)?,
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
    #[error("unsupported format: {0}")]
    UnsupportedFormat(String),
    #[error("{container} input requires a validated container recipe")]
    RecipeRequired { container: String },
    #[error("recorded provider is unavailable: {provider_id}")]
    ProviderUnavailable { provider_id: String },
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
    #[error(transparent)]
    Recipe(#[from] recipe::RecipeError),
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
        &ProviderRegistry::builtin(),
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
    fn reopen_uses_the_recorded_provider_and_never_sniffs_another() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "time,value\n0,1\n1,2").unwrap();
        let mut registry = ProviderRegistry::builtin();
        registry.register(registry::FormatProvider::new(
            "greedy",
            "Greedy",
            &["csv"],
            100,
            1,
            |_| registry::Confidence::Likely,
            || Box::new(CsvDecoder),
        ));
        let cancel = CancelToken::default();
        let mut progress = |_| {};
        let mut context = DecodeContext {
            progress: &mut progress,
            cancel: &cancel,
        };

        let (info, _) =
            dispatch_with_provider(&registry, "csv", file.path(), &mut context).unwrap();
        assert_eq!(info.id, "csv");
    }

    #[test]
    fn a_missing_provider_reports_instead_of_falling_back() {
        let registry = ProviderRegistry::builtin();
        let cancel = CancelToken::default();
        let mut progress = |_| {};
        let mut context = DecodeContext {
            progress: &mut progress,
            cancel: &cancel,
        };
        let error = dispatch_with_provider(
            &registry,
            "acme-lab-format",
            Path::new("missing.data"),
            &mut context,
        )
        .unwrap_err();
        assert!(matches!(error, IngestError::ProviderUnavailable { .. }));
        assert!(error.to_string().contains("acme-lab-format"));
    }

    #[test]
    fn a_provider_change_invalidates_the_cache_for_that_source() {
        let fingerprint = provenance::Fingerprint {
            source_len: 1,
            mtime_ns: 2,
            head_crc: 3,
        };
        let first = provenance::ProviderInfo {
            id: "csv".into(),
            cache_abi: provenance::CACHE_ABI_CSV,
        };
        let second = provenance::ProviderInfo {
            id: "csv-v2".into(),
            cache_abi: provenance::CACHE_ABI_CSV,
        };
        assert_ne!(
            provenance::provenance_digest(&first, &fingerprint, &[]),
            provenance::provenance_digest(&second, &fingerprint, &[])
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

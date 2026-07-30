//! Versioned pyramid sidecar cache (ADR 0003).
//!
//! Layout, all integers little-endian:
//!
//! ```text
//! 0..8    magic  b"\x89SSPYR\r\n"
//! 8..12   cache_version u32
//! 12..44  decode provenance SHA-256
//! 44..52  directory JSON length u64
//! 52..    directory JSON, then zero padding to an 8-byte boundary
//! ...     payload sections, each 8-byte aligned
//! ```
//!
//! The JSON directory lists per-signal metadata and each payload section's
//! (offset, len, crc32), offsets relative to the payload base. Sections per
//! signal, in order: time column, values column, then one section per merged
//! pyramid level. Levels are arrays of 88-byte bin records; `first`/`last`/
//! `min`/`max` encode `None` as NaN, which is lossless because stored
//! envelope values are always finite by construction.
//!
//! Any structural mismatch is a cache miss (`Ok(None)`), never an error:
//! the caller rebuilds and rewrites.

use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use scope_protocol::{EnvelopeBin, IngestStage};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    ingest::{
        self, DecodeContext, IngestError, IngestSummary,
        provenance::{fingerprint, provenance_digest},
    },
    pyramid::Pyramid,
    store::{Signal, SignalId, SignalStore, SourceKey, StoreError},
};

pub const CACHE_VERSION: u32 = 3;
const MAGIC: [u8; 8] = *b"\x89SSPYR\r\n";
const HEADER_LEN: usize = 52;
const BIN_RECORD_LEN: usize = 88;

/// The sidecar file beside `source`: `<file name>.sspyr`.
#[must_use]
pub fn sidecar_path(source: &Path) -> PathBuf {
    let mut name = source.file_name().unwrap_or_default().to_os_string();
    name.push(".sspyr");
    source.with_file_name(name)
}

#[derive(Debug, Deserialize, Serialize)]
struct CacheDirectory {
    row_count: u64,
    signals: Vec<CacheSignal>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CacheSignal {
    local_path: String,
    unit: Option<String>,
    point_count: u64,
    sections: Vec<CacheSection>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct CacheSection {
    offset: u64,
    len: u64,
    crc32: u32,
}

#[derive(Debug, Error)]
pub enum CacheError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Ingest(#[from] IngestError),
    #[error("invalid provenance digest: {0}")]
    InvalidProvenance(String),
}

pub struct LoadedCache {
    pub summary: IngestSummary,
    pub pyramids: Vec<(SignalId, Pyramid)>,
}

pub struct IngestOutcome {
    pub loaded: LoadedCache,
    pub provider_id: String,
    pub provenance: String,
    /// `Some` when the freshly built sidecar could not be written. Sidecar
    /// write failures are non-fatal; callers may log and continue.
    pub sidecar_error: Option<CacheError>,
}

/// Loads `source` from a fingerprint-valid sidecar, or ingests it, builds
/// per-signal pyramids, and writes a fresh sidecar beside it. Progress is
/// reported per stage: `Cache` while loading or writing the sidecar,
/// `Decode` and `Pyramid` on the rebuild path.
///
/// # Errors
///
/// Returns [`CacheError`] when the source cannot be read, decoded, or
/// registered. Sidecar *write* failures are non-fatal and surface through
/// [`IngestOutcome::sidecar_error`] instead.
pub fn ingest_or_load(
    source: &Path,
    store: &mut SignalStore,
    key: SourceKey,
    prefix: &str,
    context: &mut DecodeContext<'_>,
    progress: &mut dyn FnMut(IngestStage, f64),
) -> Result<IngestOutcome, CacheError> {
    let provider = ingest::provider_for(ingest::sniff_format(source)?);
    let provenance = provenance_digest(&provider, &fingerprint(source)?, &[]);
    let mut on_cache = |fraction| progress(IngestStage::Cache, fraction);
    if let Some(loaded) =
        try_load_with_provenance(source, store, key, prefix, &provenance, &mut on_cache)?
    {
        return Ok(IngestOutcome {
            loaded,
            provider_id: provider.id.to_owned(),
            provenance,
            sidecar_error: None,
        });
    }

    let summary = ingest::ingest_path(source, store, key, prefix, context)?;
    let total = summary.signals.len().max(1);
    let mut pyramids = Vec::new();
    for (index, id) in summary.signals.iter().enumerate() {
        if let Some(signal) = store.signal(*id) {
            pyramids.push((*id, Pyramid::from_signal(signal)));
        }
        progress(IngestStage::Pyramid, fraction(index + 1, total));
    }

    let entries: Vec<(&Signal, &Pyramid)> = pyramids
        .iter()
        .filter_map(|(id, pyramid)| Some((store.signal(*id)?, pyramid)))
        .collect();
    let mut on_write = |fraction| progress(IngestStage::Cache, fraction);
    let sidecar_error = write(
        source,
        &provenance,
        summary.row_count as u64,
        &entries,
        &mut on_write,
    )
    .err();
    Ok(IngestOutcome {
        loaded: LoadedCache { summary, pyramids },
        provider_id: provider.id.to_owned(),
        provenance,
        sidecar_error,
    })
}

/// Writes the sidecar beside `source` atomically (temp file + rename).
///
/// # Errors
///
/// Returns [`CacheError`] when fingerprinting the source or writing the
/// sidecar fails. Callers should treat write failures as non-fatal.
pub fn write(
    source: &Path,
    provenance: &str,
    row_count: u64,
    signals: &[(&Signal, &Pyramid)],
    progress: &mut dyn FnMut(f64),
) -> Result<PathBuf, CacheError> {
    let provenance =
        digest_bytes(provenance).ok_or_else(|| CacheError::InvalidProvenance(provenance.into()))?;
    let mut payload: Vec<u8> = Vec::new();
    let mut directory = CacheDirectory {
        row_count,
        signals: Vec::new(),
    };
    let total = signals.len().max(1);
    for (index, (signal, pyramid)) in signals.iter().enumerate() {
        let mut sections = Vec::new();
        sections.push(append_section(&mut payload, &encode_column(signal.time())));
        sections.push(append_section(
            &mut payload,
            &encode_column(signal.values()),
        ));
        for level in pyramid.merged_levels() {
            sections.push(append_section(&mut payload, &encode_bins(level)));
        }
        directory.signals.push(CacheSignal {
            local_path: signal.local_path.clone(),
            unit: signal.unit.clone(),
            point_count: signal.len() as u64,
            sections,
        });
        progress(fraction(index + 1, total));
    }

    let directory_json = serde_json::to_vec(&directory)?;
    let mut header = Vec::with_capacity(HEADER_LEN + directory_json.len() + 8);
    header.extend_from_slice(&MAGIC);
    header.extend_from_slice(&CACHE_VERSION.to_le_bytes());
    header.extend_from_slice(&provenance);
    header.extend_from_slice(&(directory_json.len() as u64).to_le_bytes());
    header.extend_from_slice(&directory_json);
    pad_to_8(&mut header);

    let target = sidecar_path(source);
    let temporary = target.with_extension("sspyr.tmp");
    let mut file = File::create(&temporary)?;
    file.write_all(&header)?;
    file.write_all(&payload)?;
    file.sync_all()?;
    fs::rename(&temporary, &target)?;
    Ok(target)
}

/// Loads a fingerprint-valid sidecar into `store`; `Ok(None)` is a miss.
///
/// # Errors
///
/// Returns [`CacheError`] when the *source* cannot be fingerprinted or when
/// registration conflicts with signals already in the store. Corrupt or
/// stale sidecar content is a miss, not an error.
pub fn try_load(
    source: &Path,
    store: &mut SignalStore,
    key: SourceKey,
    prefix: &str,
    progress: &mut dyn FnMut(f64),
) -> Result<Option<LoadedCache>, CacheError> {
    let provider = ingest::provider_for(ingest::sniff_format(source)?);
    let provenance = provenance_digest(&provider, &fingerprint(source)?, &[]);
    try_load_with_provenance(source, store, key, prefix, &provenance, progress)
}

fn try_load_with_provenance(
    source: &Path,
    store: &mut SignalStore,
    key: SourceKey,
    prefix: &str,
    provenance: &str,
    progress: &mut dyn FnMut(f64),
) -> Result<Option<LoadedCache>, CacheError> {
    let path = sidecar_path(source);
    let Ok(bytes) = fs::read(&path) else {
        return Ok(None);
    };
    let Some((directory, payload)) = parse(&bytes, provenance) else {
        return Ok(None);
    };

    let mut decoded = Vec::new();
    let total = directory.signals.len().max(1);
    for (index, entry) in directory.signals.iter().enumerate() {
        let Some(signal) = decode_signal(entry, payload) else {
            return Ok(None);
        };
        decoded.push(signal);
        progress(fraction(index + 1, total));
    }

    let loaded = store.transaction(|store| {
        let source_id = store.register_source(source, key, prefix)?;
        let mut pyramids = Vec::new();
        let mut signals = Vec::new();
        for entry in decoded {
            let id = store.insert_signal(
                source_id,
                entry.local_path,
                entry.unit,
                Arc::clone(&entry.time),
                Arc::clone(&entry.values),
            )?;
            pyramids.push((
                id,
                Pyramid::from_parts(entry.time, entry.values, entry.merged),
            ));
            signals.push(id);
        }
        Ok::<_, CacheError>(LoadedCache {
            summary: IngestSummary {
                source_id,
                row_count: usize::try_from(directory.row_count).unwrap_or(usize::MAX),
                signals,
            },
            pyramids,
        })
    })?;
    Ok(Some(loaded))
}

struct DecodedSignal {
    local_path: String,
    unit: Option<String>,
    time: Arc<[f64]>,
    values: Arc<[f64]>,
    merged: Vec<Vec<EnvelopeBin>>,
}

fn digest_bytes(digest: &str) -> Option<[u8; 32]> {
    if digest.len() != 64 {
        return None;
    }
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digest[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

fn parse<'a>(bytes: &'a [u8], expected: &str) -> Option<(CacheDirectory, &'a [u8])> {
    if bytes.len() < HEADER_LEN || bytes[..8] != MAGIC {
        return None;
    }
    let read_u32 = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    let read_u64 = |at: usize| Some(u64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?));
    if read_u32(8)? != CACHE_VERSION {
        return None;
    }
    if bytes.get(12..44)? != digest_bytes(expected)? {
        return None;
    }
    let directory_len = usize::try_from(read_u64(44)?).ok()?;
    let directory_end = HEADER_LEN.checked_add(directory_len)?;
    let directory: CacheDirectory =
        serde_json::from_slice(bytes.get(HEADER_LEN..directory_end)?).ok()?;
    let payload_base = directory_end.checked_next_multiple_of(8)?;
    Some((directory, bytes.get(payload_base..)?))
}

fn decode_signal(entry: &CacheSignal, payload: &[u8]) -> Option<DecodedSignal> {
    if entry.sections.len() < 2 {
        return None;
    }
    let time = decode_column(section_bytes(payload, entry.sections[0])?)?;
    let values = decode_column(section_bytes(payload, entry.sections[1])?)?;
    let point_count = usize::try_from(entry.point_count).ok()?;
    if time.len() != point_count || values.len() != point_count {
        return None;
    }
    let mut merged = Vec::new();
    let mut expected_len = point_count.div_ceil(2);
    for section in &entry.sections[2..] {
        let level = decode_bins(section_bytes(payload, *section)?)?;
        if level.len() != expected_len {
            return None;
        }
        merged.push(level);
        expected_len = expected_len.div_ceil(2);
    }
    if point_count > 0 && merged.last().is_none_or(|level| level.len() != 1) {
        return None;
    }
    Some(DecodedSignal {
        local_path: entry.local_path.clone(),
        unit: entry.unit.clone(),
        time: time.into(),
        values: values.into(),
        merged,
    })
}

fn section_bytes(payload: &[u8], section: CacheSection) -> Option<&[u8]> {
    let start = usize::try_from(section.offset).ok()?;
    let len = usize::try_from(section.len).ok()?;
    let bytes = payload.get(start..start.checked_add(len)?)?;
    (crc32fast::hash(bytes) == section.crc32).then_some(bytes)
}

fn append_section(payload: &mut Vec<u8>, bytes: &[u8]) -> CacheSection {
    pad_to_8(payload);
    let section = CacheSection {
        offset: payload.len() as u64,
        len: bytes.len() as u64,
        crc32: crc32fast::hash(bytes),
    };
    payload.extend_from_slice(bytes);
    section
}

fn encode_column(values: &[f64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 8);
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

fn decode_column(bytes: &[u8]) -> Option<Vec<f64>> {
    if bytes.len() % 8 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(8)
            .map(|chunk| f64::from_le_bytes(chunk.try_into().expect("8-byte chunk")))
            .collect(),
    )
}

fn encode_bins(bins: &[EnvelopeBin]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bins.len() * BIN_RECORD_LEN);
    for bin in bins {
        out.extend_from_slice(&bin.t0.to_le_bytes());
        out.extend_from_slice(&bin.t1.to_le_bytes());
        for value in [bin.first, bin.last, bin.min, bin.max] {
            out.extend_from_slice(&value.unwrap_or(f64::NAN).to_le_bytes());
        }
        out.extend_from_slice(&bin.sum.to_le_bytes());
        out.extend_from_slice(&bin.sum_sq.to_le_bytes());
        out.extend_from_slice(&bin.sample_count.to_le_bytes());
        out.extend_from_slice(&bin.finite_count.to_le_bytes());
        out.push(u8::from(bin.has_gap));
        out.extend_from_slice(&[0_u8; 7]);
    }
    out
}

fn decode_bins(bytes: &[u8]) -> Option<Vec<EnvelopeBin>> {
    if bytes.len() % BIN_RECORD_LEN != 0 {
        return None;
    }
    let field = |chunk: &[u8], at: usize| {
        f64::from_le_bytes(chunk[at..at + 8].try_into().expect("8-byte field"))
    };
    let optional = |chunk: &[u8], at: usize| {
        let value = field(chunk, at);
        (!value.is_nan()).then_some(value)
    };
    Some(
        bytes
            .chunks_exact(BIN_RECORD_LEN)
            .map(|chunk| EnvelopeBin {
                t0: field(chunk, 0),
                t1: field(chunk, 8),
                first: optional(chunk, 16),
                last: optional(chunk, 24),
                min: optional(chunk, 32),
                max: optional(chunk, 40),
                sum: field(chunk, 48),
                sum_sq: field(chunk, 56),
                sample_count: u64::from_le_bytes(chunk[64..72].try_into().expect("8-byte field")),
                finite_count: u64::from_le_bytes(chunk[72..80].try_into().expect("8-byte field")),
                has_gap: chunk[80] != 0,
            })
            .collect(),
    )
}

fn pad_to_8(bytes: &mut Vec<u8>) {
    while bytes.len() % 8 != 0 {
        bytes.push(0);
    }
}

#[allow(clippy::cast_precision_loss)]
fn fraction(done: usize, total: usize) -> f64 {
    done as f64 / total as f64
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, io::Write as _};

    use super::*;
    use crate::{
        ingest::{CancelToken, DecodeContext, ingest_for_test},
        naming,
    };

    fn key() -> SourceKey {
        SourceKey(uuid::Uuid::new_v4())
    }

    fn try_load_test(
        source: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<Option<LoadedCache>, CacheError> {
        try_load(
            source,
            store,
            key(),
            &naming::default_prefix(source),
            progress,
        )
    }

    fn ingest_or_load_test(
        source: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(IngestStage, f64),
    ) -> Result<IngestOutcome, CacheError> {
        let sink = RefCell::new(progress);
        let cancel = CancelToken::default();
        let mut decode = |fraction| (sink.borrow_mut())(IngestStage::Decode, fraction);
        let mut context = DecodeContext {
            progress: &mut decode,
            cancel: &cancel,
        };
        let mut stage = |stage, fraction| (sink.borrow_mut())(stage, fraction);
        ingest_or_load(
            source,
            store,
            key(),
            &naming::default_prefix(source),
            &mut context,
            &mut stage,
        )
    }

    fn csv_source(dir: &tempfile::TempDir) -> PathBuf {
        let path = dir.path().join("flight.csv");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "time,alt,speed").unwrap();
        for row in 0..500 {
            let speed = if row == 42 {
                "bad".to_owned()
            } else {
                format!("{}", 100 - row)
            };
            writeln!(file, "{row},{},{speed}", row * 2).unwrap();
        }
        path
    }

    fn build(source: &Path) -> (SignalStore, IngestSummary, Vec<(SignalId, Pyramid)>) {
        let mut store = SignalStore::new();
        let summary = ingest_for_test(source, &mut store, &mut |_| {}).unwrap();
        let pyramids: Vec<(SignalId, Pyramid)> = summary
            .signals
            .iter()
            .map(|id| (*id, Pyramid::from_signal(store.signal(*id).unwrap())))
            .collect();
        (store, summary, pyramids)
    }

    fn write_sidecar(
        source: &Path,
        store: &SignalStore,
        summary: &IngestSummary,
        pyramids: &[(SignalId, Pyramid)],
    ) {
        let entries: Vec<(&Signal, &Pyramid)> = pyramids
            .iter()
            .map(|(id, pyramid)| (store.signal(*id).unwrap(), pyramid))
            .collect();
        let provider = ingest::provider_for(ingest::sniff_format(source).unwrap());
        let provenance = provenance_digest(&provider, &fingerprint(source).unwrap(), &[]);
        write(
            source,
            &provenance,
            summary.row_count as u64,
            &entries,
            &mut |_| {},
        )
        .unwrap();
    }

    #[test]
    fn sidecar_round_trips_store_and_pyramid_queries() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);
        assert!(sidecar_path(&source).exists());

        let mut fresh = SignalStore::new();
        let mut fractions = Vec::new();
        let loaded = try_load_test(&source, &mut fresh, &mut |f| fractions.push(f))
            .unwrap()
            .expect("cache hit");
        assert_eq!(loaded.summary.row_count, summary.row_count);
        assert_eq!(loaded.pyramids.len(), pyramids.len());
        assert!(!fractions.is_empty());
        for ((_, original), (id, cached)) in pyramids.iter().zip(&loaded.pyramids) {
            let expected = original.query(0.0, 499.0, 100);
            let actual = cached.query(0.0, 499.0, 100);
            assert_eq!(expected.level, actual.level);
            assert_eq!(expected.bins, actual.bins);
            assert_eq!(fresh.signal(*id).unwrap().len(), 500);
        }
        let speed = fresh.signal_by_path("flight/speed").unwrap();
        assert!(speed.values()[42].is_nan());
    }

    #[test]
    fn ingest_or_load_builds_then_hits_the_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let mut store = SignalStore::new();
        let mut stages = Vec::new();
        let outcome =
            ingest_or_load_test(&source, &mut store, &mut |stage, _| stages.push(stage)).unwrap();
        assert!(outcome.sidecar_error.is_none());
        assert!(sidecar_path(&source).exists());
        assert!(stages.contains(&IngestStage::Decode));
        assert!(stages.contains(&IngestStage::Pyramid));

        let mut fresh = SignalStore::new();
        stages.clear();
        let cached =
            ingest_or_load_test(&source, &mut fresh, &mut |stage, _| stages.push(stage)).unwrap();
        assert_eq!(
            cached.loaded.summary.row_count,
            outcome.loaded.summary.row_count
        );
        assert_eq!(cached.loaded.pyramids.len(), outcome.loaded.pyramids.len());
        assert!(stages.iter().all(|stage| *stage == IngestStage::Cache));
    }

    #[test]
    fn a_changed_cache_abi_invalidates_the_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let mut store = SignalStore::new();
        let outcome = ingest_or_load_test(&source, &mut store, &mut |_, _| {}).unwrap();
        assert_eq!(outcome.provider_id, "csv");
        assert_eq!(outcome.provenance.len(), 64);

        let path = sidecar_path(&source);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[12..44].fill(0);
        std::fs::write(&path, bytes).unwrap();

        let mut fresh = SignalStore::new();
        let reloaded = ingest_or_load_test(&source, &mut fresh, &mut |_, _| {}).unwrap();
        assert_eq!(reloaded.provenance, outcome.provenance);
        assert_ne!(&std::fs::read(path).unwrap()[12..44], &[0; 32]);
    }

    #[test]
    fn missing_sidecar_is_a_miss() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let mut store = SignalStore::new();
        assert!(
            try_load_test(&source, &mut store, &mut |_| {})
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn changed_source_is_a_miss() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);

        let mut file = fs::OpenOptions::new().append(true).open(&source).unwrap();
        writeln!(file, "999,1,1").unwrap();
        drop(file);

        let mut fresh = SignalStore::new();
        assert!(
            try_load_test(&source, &mut fresh, &mut |_| {})
                .unwrap()
                .is_none()
        );
        assert_eq!(fresh.signals().count(), 0);
    }

    #[test]
    fn corrupt_payload_and_truncation_are_misses() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);
        let path = sidecar_path(&source);
        let original = fs::read(&path).unwrap();

        let mut corrupt = original.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 0xFF;
        fs::write(&path, &corrupt).unwrap();
        let mut fresh = SignalStore::new();
        assert!(
            try_load_test(&source, &mut fresh, &mut |_| {})
                .unwrap()
                .is_none()
        );

        fs::write(&path, &original[..original.len() / 2]).unwrap();
        assert!(
            try_load_test(&source, &mut fresh, &mut |_| {})
                .unwrap()
                .is_none()
        );

        let mut versioned = original;
        versioned[8..12].copy_from_slice(&(CACHE_VERSION + 1).to_le_bytes());
        fs::write(&path, &versioned).unwrap();
        assert!(
            try_load_test(&source, &mut fresh, &mut |_| {})
                .unwrap()
                .is_none()
        );
    }
}

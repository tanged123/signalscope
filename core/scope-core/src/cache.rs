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
//! The JSON directory lists shared time columns and per-signal value and
//! pyramid sections. Offsets are relative to the payload base. Every section
//! is aligned and independently checksummed.
//!
//! Any structural mismatch is a cache miss (`Ok(None)`), never an error:
//! the caller rebuilds and rewrites.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use scope_protocol::IngestStage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    bins::BinLevel,
    columns::TimebaseId,
    ingest::{
        self, DecodeContext, IngestError, IngestSummary,
        provenance::{fingerprint, provenance_digest},
    },
    paging::{PageCache, PageError, PageHandle},
    preferences::Preferences,
    pyramid::Pyramid,
    store::{Signal, SignalId, SignalStore, SourceKey, StoreError},
};

pub const CACHE_VERSION: u32 = 4;
const MAGIC: [u8; 8] = *b"\x89SSPYR\r\n";
const HEADER_LEN: usize = 52;

/// The sidecar file beside `source`: `<file name>.sspyr`.
#[must_use]
pub fn sidecar_path(source: &Path) -> PathBuf {
    let mut name = source.file_name().unwrap_or_default().to_os_string();
    name.push(".sspyr");
    source.with_file_name(name)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CacheRoot {
    directory: PathBuf,
    beside_entry: Option<PathBuf>,
}

impl CacheRoot {
    #[must_use]
    pub fn beside_source(source: &Path) -> Self {
        Self {
            directory: source.parent().unwrap_or_else(|| Path::new(".")).to_owned(),
            beside_entry: Some(sidecar_path(source)),
        }
    }

    #[must_use]
    pub fn app_owned(directory: &Path) -> Self {
        Self {
            directory: directory.to_owned(),
            beside_entry: None,
        }
    }

    #[must_use]
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    #[must_use]
    pub fn entry_path(&self, provenance: &str) -> PathBuf {
        self.beside_entry
            .clone()
            .unwrap_or_else(|| self.directory.join(format!("{provenance}.sspyr")))
    }

    #[must_use]
    pub fn is_app_owned(&self) -> bool {
        self.beside_entry.is_none()
    }
}

#[must_use]
pub fn resolve_root(source: &Path, preferences: &Preferences) -> CacheRoot {
    let directory = source.parent().unwrap_or_else(|| Path::new("."));
    if directory_is_writable(directory) {
        CacheRoot::beside_source(source)
    } else {
        let directory = preferences
            .cache_root
            .as_deref()
            .map_or_else(|| default_cache_directory().to_owned(), PathBuf::from);
        CacheRoot::app_owned(&directory)
    }
}

fn default_cache_directory() -> &'static Path {
    static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
    DIRECTORY
        .get_or_init(|| {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
                })
                .unwrap_or_else(std::env::temp_dir)
                .join("signalscope/cache")
        })
        .as_path()
}

fn directory_is_writable(directory: &Path) -> bool {
    static WRITABLE: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();
    let cache = WRITABLE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(writable) = cache.lock().expect("writability cache").get(directory) {
        return *writable;
    }
    let writable = probe_writable(directory);
    cache
        .lock()
        .expect("writability cache")
        .insert(directory.to_owned(), writable);
    writable
}

fn probe_writable(directory: &Path) -> bool {
    if fs::metadata(directory).is_ok_and(|metadata| metadata.permissions().readonly()) {
        return false;
    }
    let probe = directory.join(format!(".signalscope-write-{}.tmp", std::process::id()));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct CacheDirectory {
    row_count: u64,
    time_sections: Vec<CacheSection>,
    signals: Vec<CacheSignal>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CacheSignal {
    local_path: String,
    unit: Option<String>,
    point_count: u64,
    time_section: u32,
    value_section: CacheSection,
    levels: Vec<CacheSection>,
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
    #[error(transparent)]
    Page(#[from] PageError),
    #[error("invalid provenance digest: {0}")]
    InvalidProvenance(String),
}

const SPILL_MAGIC: [u8; 8] = *b"SSCOL001";
const SPILL_HEADER_LEN: usize = 32;

/// Writes a derived value column and returns its page-backed region.
///
/// # Errors
///
/// Returns an error when the cache root cannot be written.
pub fn spill_columns(
    root: &CacheRoot,
    timebase_id: TimebaseId,
    time: &[f64],
    values: &[f64],
) -> Result<PageHandle, CacheError> {
    let mut hash = Sha256::new();
    hash.update(timebase_id.0.to_le_bytes());
    for column in [time, values] {
        for value in column {
            hash.update(value.to_le_bytes());
        }
    }
    let directory = root.directory().join("derived");
    fs::create_dir_all(&directory)?;
    let target = directory.join(format!("{:x}.sscol", hash.finalize()));
    let value_offset = SPILL_HEADER_LEN + size_of_val(time);
    let value_bytes = size_of_val(values);
    if !target.exists() {
        let temporary = target.with_extension("sscol.tmp");
        let mut file = File::create(&temporary)?;
        file.write_all(&SPILL_MAGIC)?;
        file.write_all(&1_u32.to_le_bytes())?;
        file.write_all(&0_u32.to_le_bytes())?;
        file.write_all(&timebase_id.0.to_le_bytes())?;
        file.write_all(&(time.len() as u64).to_le_bytes())?;
        file.write_all(&encode_column(time))?;
        file.write_all(&encode_column(values))?;
        file.sync_all()?;
        fs::rename(temporary, &target)?;
    }
    let cache = PageCache::new(&directory, value_bytes.max(1));
    Ok(PageHandle::cached(
        cache,
        target,
        value_offset as u64,
        value_bytes,
    ))
}

pub(crate) fn write_page(
    root: &CacheRoot,
    name: &str,
    bytes: &[u8],
    cache: &PageCache,
) -> Result<PageHandle, CacheError> {
    fs::create_dir_all(root.directory())?;
    let target = root.directory().join(name);
    if fs::metadata(&target).map_or(true, |metadata| metadata.len() != bytes.len() as u64) {
        let temporary = target.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
        let mut file = File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(temporary, &target)?;
    }
    Ok(PageHandle::cached(cache.clone(), target, 0, bytes.len()))
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
    ingest_or_load_at(
        &CacheRoot::beside_source(source),
        source,
        store,
        key,
        prefix,
        context,
        progress,
    )
}

/// Uses an explicit cache root for ingest and cache lookup.
///
/// # Errors
///
/// Returns [`CacheError`] when ingest fails or an app-owned cache cannot be
/// written.
pub fn ingest_or_load_at(
    root: &CacheRoot,
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
        try_load_from_root(root, source, store, key, prefix, &provenance, &mut on_cache)?
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
    let write_result = write_at(
        root,
        &provenance,
        summary.row_count as u64,
        &entries,
        &mut on_write,
    );
    let sidecar_error = match write_result {
        Ok(_) => None,
        Err(error) if root.is_app_owned() => return Err(error),
        Err(error) => Some(error),
    };
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
    write_at(
        &CacheRoot::beside_source(source),
        provenance,
        row_count,
        signals,
        progress,
    )
}

/// Writes a sidecar into `root`.
///
/// # Errors
///
/// Returns [`CacheError`] when the root cannot be created or written.
pub fn write_at(
    root: &CacheRoot,
    provenance: &str,
    row_count: u64,
    signals: &[(&Signal, &Pyramid)],
    progress: &mut dyn FnMut(f64),
) -> Result<PathBuf, CacheError> {
    let entry_name = provenance.to_owned();
    let provenance =
        digest_bytes(provenance).ok_or_else(|| CacheError::InvalidProvenance(provenance.into()))?;
    let mut payload: Vec<u8> = Vec::new();
    let mut directory = CacheDirectory {
        row_count,
        time_sections: Vec::new(),
        signals: Vec::new(),
    };
    let mut times: Vec<Arc<[f64]>> = Vec::new();
    let total = signals.len().max(1);
    for (index, (signal, pyramid)) in signals.iter().enumerate() {
        let time = signal.time_shared();
        let time_section = times
            .iter()
            .position(|candidate| Arc::ptr_eq(candidate, &time))
            .unwrap_or_else(|| {
                directory
                    .time_sections
                    .push(append_section(&mut payload, &encode_column(&time)));
                times.push(Arc::clone(&time));
                times.len() - 1
            });
        let value_section = append_section(&mut payload, &encode_column(&signal.values()));
        let mut levels = Vec::new();
        for level in pyramid.merged_levels() {
            levels.push(append_section(&mut payload, &encode_bins(level)));
        }
        directory.signals.push(CacheSignal {
            local_path: signal.local_path.clone(),
            unit: signal.unit.clone(),
            point_count: signal.len() as u64,
            time_section: u32::try_from(time_section).unwrap_or(u32::MAX),
            value_section,
            levels,
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

    if root.is_app_owned() {
        fs::create_dir_all(root.directory())?;
    }
    let target = root.entry_path(&entry_name);
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
    try_load_from_root(
        &CacheRoot::beside_source(source),
        source,
        store,
        key,
        prefix,
        &provenance,
        progress,
    )
}

fn try_load_from_root(
    root: &CacheRoot,
    source: &Path,
    store: &mut SignalStore,
    key: SourceKey,
    prefix: &str,
    provenance: &str,
    progress: &mut dyn FnMut(f64),
) -> Result<Option<LoadedCache>, CacheError> {
    let path = root.entry_path(provenance);
    let Ok(bytes) = fs::read(&path) else {
        return Ok(None);
    };
    let Some((directory, payload)) = parse(&bytes, provenance) else {
        return Ok(None);
    };

    let mut decoded = Vec::new();
    let total = directory.signals.len().max(1);
    for (index, entry) in directory.signals.iter().enumerate() {
        let Some(signal) = decode_signal(&directory, entry, payload) else {
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
            let signal = store.signal(id).expect("inserted signal exists");
            pyramids.push((id, Pyramid::from_signal_parts(signal, entry.merged)));
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
    merged: Vec<BinLevel>,
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

fn decode_signal(
    directory: &CacheDirectory,
    entry: &CacheSignal,
    payload: &[u8],
) -> Option<DecodedSignal> {
    let time_section = *directory
        .time_sections
        .get(usize::try_from(entry.time_section).ok()?)?;
    let time = decode_column(section_bytes(payload, time_section)?)?;
    let values = decode_column(section_bytes(payload, entry.value_section)?)?;
    let point_count = usize::try_from(entry.point_count).ok()?;
    if time.len() != point_count || values.len() != point_count {
        return None;
    }
    let mut merged = Vec::new();
    let mut expected_len = point_count.div_ceil(1 << crate::pyramid::FINEST_STORED_LEVEL);
    for section in &entry.levels {
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

fn encode_bins(bins: &BinLevel) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + bins.len() * BinLevel::BYTES_PER_BIN);
    out.extend_from_slice(&(bins.len() as u64).to_le_bytes());
    for values in [
        &bins.t0,
        &bins.t1,
        &bins.first,
        &bins.last,
        &bins.min,
        &bins.max,
        &bins.sum,
        &bins.sum_sq,
    ] {
        for value in values {
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
    for values in [&bins.sample_count, &bins.finite_count] {
        for value in values {
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
    out.extend_from_slice(&bins.flags);
    pad_to_8(&mut out);
    out
}

fn decode_bins(bytes: &[u8]) -> Option<BinLevel> {
    let count = usize::try_from(u64::from_le_bytes(bytes.get(..8)?.try_into().ok()?)).ok()?;
    let used = 8_usize.checked_add(count.checked_mul(BinLevel::BYTES_PER_BIN)?)?;
    if bytes.len() != used.checked_next_multiple_of(8)? {
        return None;
    }
    let mut at = 8;
    let t0 = decode_f64_array(bytes, &mut at, count)?;
    let t1 = decode_f64_array(bytes, &mut at, count)?;
    let first = decode_f64_array(bytes, &mut at, count)?;
    let last = decode_f64_array(bytes, &mut at, count)?;
    let min = decode_f64_array(bytes, &mut at, count)?;
    let max = decode_f64_array(bytes, &mut at, count)?;
    let sum = decode_f64_array(bytes, &mut at, count)?;
    let sum_sq = decode_f64_array(bytes, &mut at, count)?;
    let sample_count = decode_u32_array(bytes, &mut at, count)?;
    let finite_count = decode_u32_array(bytes, &mut at, count)?;
    let flags = bytes.get(at..at.checked_add(count)?)?.to_vec();
    Some(BinLevel {
        t0,
        t1,
        first,
        last,
        min,
        max,
        sum,
        sum_sq,
        sample_count,
        finite_count,
        flags,
    })
}

fn decode_f64_array(bytes: &[u8], at: &mut usize, count: usize) -> Option<Vec<f64>> {
    let len = count.checked_mul(8)?;
    let end = at.checked_add(len)?;
    let values = bytes
        .get(*at..end)?
        .chunks_exact(8)
        .map(|chunk| f64::from_le_bytes(chunk.try_into().expect("8-byte chunk")))
        .collect();
    *at = end;
    Some(values)
}

fn decode_u32_array(bytes: &[u8], at: &mut usize, count: usize) -> Option<Vec<u32>> {
    let len = count.checked_mul(4)?;
    let end = at.checked_add(len)?;
    let values = bytes
        .get(*at..end)?
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes(chunk.try_into().expect("4-byte chunk")))
        .collect();
    *at = end;
    Some(values)
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

    fn directory(bytes: &[u8]) -> (CacheDirectory, &[u8]) {
        let len = usize::try_from(u64::from_le_bytes(bytes[44..52].try_into().unwrap())).unwrap();
        let end = HEADER_LEN + len;
        let directory = serde_json::from_slice(&bytes[HEADER_LEN..end]).unwrap();
        let payload = &bytes[end.next_multiple_of(8)..];
        (directory, payload)
    }

    #[test]
    fn one_shared_time_column_is_written_once_per_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);

        let bytes = fs::read(sidecar_path(&source)).unwrap();
        let (directory, payload) = directory(&bytes);
        let references = directory
            .signals
            .iter()
            .map(|signal| signal.time_section)
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(directory.time_sections.len(), 1);
        assert_eq!(references.len(), 1);
        assert_eq!(
            section_bytes(payload, directory.time_sections[0])
                .unwrap()
                .len(),
            500 * size_of::<f64>()
        );
    }

    #[test]
    fn spilled_columns_reopen_from_the_cache_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = CacheRoot::app_owned(directory.path());
        let handle = spill_columns(&root, TimebaseId(7), &[0.0, 1.0], &[2.0, 4.0]).unwrap();

        assert_eq!(&*handle.values().unwrap(), &[2.0, 4.0]);
        let reopened =
            crate::paging::PageHandle::region(handle.path(), handle.offset(), handle.byte_len());
        assert_eq!(&*reopened.values().unwrap(), &[2.0, 4.0]);
    }

    #[test]
    fn level_sections_are_aligned_and_independently_readable() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);

        let bytes = fs::read(sidecar_path(&source)).unwrap();
        let (directory, payload) = directory(&bytes);
        for signal in directory.signals {
            for section in signal.levels {
                assert_eq!(section.offset % 8, 0);
                assert_eq!(section.len % 8, 0);
                assert!(decode_bins(section_bytes(payload, section).unwrap()).is_some());
            }
        }
    }

    #[test]
    fn a_v3_sidecar_is_a_miss_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);
        let path = sidecar_path(&source);
        let mut bytes = fs::read(&path).unwrap();
        bytes[8..12].copy_from_slice(&3_u32.to_le_bytes());
        fs::write(path, bytes).unwrap();

        assert!(
            try_load_test(&source, &mut SignalStore::new(), &mut |_| {})
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn root_falls_back_when_the_source_directory_is_read_only() {
        let data = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let source = csv_source(&data);
        let mut permissions = fs::metadata(data.path()).unwrap().permissions();
        let original_permissions = permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(data.path(), permissions).unwrap();
        let preferences = Preferences {
            cache_root: Some(cache.path().display().to_string()),
            ..Preferences::default()
        };

        let root = resolve_root(&source, &preferences);

        fs::set_permissions(data.path(), original_permissions).unwrap();
        assert_eq!(root.directory(), cache.path());
        assert!(root.is_app_owned());
    }

    #[test]
    fn root_entries_use_the_provenance_digest() {
        let directory = tempfile::tempdir().unwrap();
        let root = CacheRoot::app_owned(directory.path());
        let digest = "a".repeat(64);

        assert!(
            root.entry_path(&digest)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(&digest[..16])
        );
    }

    #[test]
    fn root_write_failures_are_reported() {
        let directory = tempfile::NamedTempFile::new().unwrap();
        let root = CacheRoot::app_owned(directory.path());
        let error = write_at(&root, &"a".repeat(64), 0, &[], &mut |_| {}).unwrap_err();

        assert!(matches!(error, CacheError::Io(_)));
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

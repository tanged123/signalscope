//! Leased byte-range cache over sidecar files.

use std::{
    collections::HashMap,
    fs::File,
    ops::Range,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use thiserror::Error;

#[derive(Clone, Debug)]
pub struct PageHandle {
    path: PathBuf,
    offset: u64,
    len: Option<usize>,
    memory: Option<Arc<[f64]>>,
    cache: Option<PageCache>,
}

impl PageHandle {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            offset: 0,
            len: None,
            memory: None,
            cache: None,
        }
    }

    #[must_use]
    pub fn region(path: impl Into<PathBuf>, offset: u64, len: usize) -> Self {
        Self {
            path: path.into(),
            offset,
            len: Some(len),
            memory: None,
            cache: None,
        }
    }

    #[must_use]
    pub fn memory(values: Arc<[f64]>) -> Self {
        Self {
            path: PathBuf::new(),
            offset: 0,
            len: Some(values.len().saturating_mul(size_of::<f64>())),
            memory: Some(values),
            cache: None,
        }
    }

    #[must_use]
    pub fn cached(cache: PageCache, path: impl Into<PathBuf>, offset: u64, len: usize) -> Self {
        Self {
            path: path.into(),
            offset,
            len: Some(len),
            memory: None,
            cache: Some(cache),
        }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn offset(&self) -> u64 {
        self.offset
    }

    #[must_use]
    pub fn byte_len(&self) -> usize {
        self.len.unwrap_or_default()
    }

    #[must_use]
    pub fn value_len(&self) -> usize {
        self.memory
            .as_ref()
            .map_or_else(|| self.byte_len() / size_of::<f64>(), |values| values.len())
    }

    #[must_use]
    pub fn same_region(&self, other: &Self) -> bool {
        self.memory
            .as_ref()
            .zip(other.memory.as_ref())
            .is_some_and(|(left, right)| Arc::ptr_eq(left, right))
            || (self.memory.is_none()
                && other.memory.is_none()
                && self.path == other.path
                && self.offset == other.offset
                && self.len == other.len)
    }

    /// Loads and decodes the complete f64 region.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid regions or failed page reads.
    pub fn values(&self) -> Result<Arc<[f64]>, PageError> {
        self.values_range(0..self.value_len())
    }

    /// Loads and decodes an f64 range.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid ranges or failed page reads.
    pub fn values_range(&self, range: Range<usize>) -> Result<Arc<[f64]>, PageError> {
        if range.start > range.end || range.end > self.value_len() {
            return Err(PageError::InvalidRange);
        }
        if let Some(values) = &self.memory {
            return Ok(values[range].into());
        }
        let len = self.len.ok_or(PageError::InvalidRange)?;
        if len % size_of::<f64>() != 0 {
            return Err(PageError::InvalidColumn);
        }
        let start = range
            .start
            .checked_mul(size_of::<f64>())
            .ok_or(PageError::InvalidRange)?;
        let end = range
            .end
            .checked_mul(size_of::<f64>())
            .ok_or(PageError::InvalidRange)?;
        let lease = self.read(start..end)?;
        Ok(lease
            .bytes()
            .chunks_exact(size_of::<f64>())
            .map(|bytes| {
                let mut value = [0; size_of::<f64>()];
                value.copy_from_slice(bytes);
                f64::from_le_bytes(value)
            })
            .collect::<Vec<_>>()
            .into())
    }

    /// Loads one f64 value.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid index or failed page read.
    pub fn value(&self, index: usize) -> Result<f64, PageError> {
        self.values_range(index..index.saturating_add(1))?
            .first()
            .copied()
            .ok_or(PageError::InvalidRange)
    }

    /// Loads the complete byte region.
    ///
    /// # Errors
    ///
    /// Returns an error for memory handles or failed page reads.
    pub fn bytes(&self) -> Result<Arc<[u8]>, PageError> {
        if self.memory.is_some() {
            return Err(PageError::MemoryHandle);
        }
        let len = self.len.ok_or(PageError::InvalidRange)?;
        Ok(self.read(0..len)?.shared())
    }

    /// Loads a byte range.
    ///
    /// # Errors
    ///
    /// Returns an error for memory handles or failed page reads.
    pub fn bytes_range(&self, range: Range<usize>) -> Result<Arc<[u8]>, PageError> {
        if self.memory.is_some() {
            return Err(PageError::MemoryHandle);
        }
        Ok(self.read(range)?.shared())
    }

    fn read(&self, range: Range<usize>) -> Result<Lease, PageError> {
        let len = self.len.ok_or(PageError::InvalidRange)?;
        let cache = self.cache.clone().unwrap_or_else(|| {
            PageCache::new(self.path.parent().unwrap_or_else(|| Path::new(".")), len)
        });
        cache.read(self, range)
    }
}

#[derive(Clone)]
pub struct PageCache {
    inner: Arc<Mutex<State>>,
}

impl std::fmt::Debug for PageCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = lock(&self.inner);
        formatter
            .debug_struct("PageCache")
            .field("root", &state.root)
            .field("capacity", &state.capacity)
            .finish_non_exhaustive()
    }
}

struct State {
    root: PathBuf,
    capacity: usize,
    clock: u64,
    entries: HashMap<Key, Entry>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Key {
    path: PathBuf,
    offset: u64,
    len: usize,
}

struct Entry {
    bytes: Arc<[u8]>,
    leases: usize,
    used_at: u64,
}

pub struct Lease {
    cache: Arc<Mutex<State>>,
    key: Key,
    bytes: Arc<[u8]>,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Lease")
            .field("key", &self.key)
            .field("bytes", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

impl Lease {
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[must_use]
    pub fn shared(&self) -> Arc<[u8]> {
        Arc::clone(&self.bytes)
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(entry) = lock(&self.cache).entries.get_mut(&self.key) {
            entry.leases = entry.leases.saturating_sub(1);
        }
    }
}

impl PageCache {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>, capacity_bytes: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(State {
                root: root.into(),
                capacity: capacity_bytes,
                clock: 0,
                entries: HashMap::new(),
            })),
        }
    }

    /// # Errors
    ///
    /// Returns an error for invalid ranges, short reads, IO failures, or when
    /// outstanding leases hold the available capacity.
    pub fn read(&self, handle: &PageHandle, range: Range<usize>) -> Result<Lease, PageError> {
        if range.start > range.end || handle.len.is_some_and(|len| range.end > len) {
            return Err(PageError::InvalidRange);
        }
        if handle.memory.is_some() {
            return Err(PageError::MemoryHandle);
        }
        let offset = handle
            .offset
            .checked_add(u64::try_from(range.start).map_err(|_| PageError::InvalidRange)?)
            .ok_or(PageError::InvalidRange)?;
        let key = Key {
            path: handle.path.clone(),
            offset,
            len: range.len(),
        };
        {
            let mut state = lock(&self.inner);
            if !key.path.starts_with(&state.root) {
                return Err(PageError::OutsideRoot(key.path));
            }
            state.clock = state.clock.wrapping_add(1);
            let used_at = state.clock;
            if let Some(entry) = state.entries.get_mut(&key) {
                entry.leases += 1;
                entry.used_at = used_at;
                return Ok(Lease {
                    cache: Arc::clone(&self.inner),
                    key,
                    bytes: Arc::clone(&entry.bytes),
                });
            }
        }

        let requested = range.len();
        let mut bytes = vec![0; requested];
        let file = File::open(&handle.path)?;
        let read = read_at(&file, &mut bytes, offset)?;
        if read != requested {
            return Err(PageError::ShortRead {
                expected: requested,
                actual: read,
            });
        }
        let bytes: Arc<[u8]> = bytes.into();
        let mut state = lock(&self.inner);
        state.clock = state.clock.wrapping_add(1);
        let used_at = state.clock;
        if let Some(entry) = state.entries.get_mut(&key) {
            entry.leases += 1;
            entry.used_at = used_at;
            return Ok(Lease {
                cache: Arc::clone(&self.inner),
                key,
                bytes: Arc::clone(&entry.bytes),
            });
        }
        make_room(&mut state, requested)?;
        state.entries.insert(
            key.clone(),
            Entry {
                bytes: Arc::clone(&bytes),
                leases: 1,
                used_at,
            },
        );
        Ok(Lease {
            cache: Arc::clone(&self.inner),
            key,
            bytes,
        })
    }

    pub fn evict_unleased(&self) {
        lock(&self.inner)
            .entries
            .retain(|_, entry| entry.leases > 0);
    }

    #[must_use]
    pub fn leased_bytes(&self) -> usize {
        lock(&self.inner)
            .entries
            .values()
            .filter(|entry| entry.leases > 0)
            .map(|entry| entry.bytes.len())
            .sum()
    }

    #[must_use]
    pub fn resident_bytes(&self) -> usize {
        resident_bytes(&lock(&self.inner))
    }

    /// # Errors
    ///
    /// Returns [`PageError::CapacityHeld`] while any range from the entry is
    /// leased, or an IO error when deletion fails.
    pub fn delete(&self, handle: &PageHandle) -> Result<(), PageError> {
        let mut state = lock(&self.inner);
        if !handle.path.starts_with(&state.root) {
            return Err(PageError::OutsideRoot(handle.path.clone()));
        }
        let leased = state
            .entries
            .iter()
            .filter(|(key, _)| key.path == handle.path)
            .filter(|(_, entry)| entry.leases > 0)
            .map(|(_, entry)| entry.bytes.len())
            .sum();
        if leased > 0 {
            return Err(PageError::CapacityHeld {
                requested: 0,
                leased,
                capacity: state.capacity,
            });
        }
        state.entries.retain(|key, _| key.path != handle.path);
        drop(state);
        std::fs::remove_file(&handle.path)?;
        Ok(())
    }
}

fn make_room(state: &mut State, requested: usize) -> Result<(), PageError> {
    while resident_bytes(state).saturating_add(requested) > state.capacity {
        let candidate = state
            .entries
            .iter()
            .filter(|(_, entry)| entry.leases == 0)
            .min_by_key(|(_, entry)| entry.used_at)
            .map(|(key, _)| key.clone());
        let Some(candidate) = candidate else {
            return Err(PageError::CapacityHeld {
                requested,
                leased: state
                    .entries
                    .values()
                    .filter(|entry| entry.leases > 0)
                    .map(|entry| entry.bytes.len())
                    .sum(),
                capacity: state.capacity,
            });
        };
        state.entries.remove(&candidate);
    }
    Ok(())
}

fn resident_bytes(state: &State) -> usize {
    state.entries.values().map(|entry| entry.bytes.len()).sum()
}

fn lock(mutex: &Mutex<State>) -> MutexGuard<'_, State> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(unix)]
fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt;
    read_loop(buffer, |buffer, done| {
        file.read_at(buffer, offset + done as u64)
    })
}

#[cfg(windows)]
fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::windows::fs::FileExt;
    read_loop(buffer, |buffer, done| {
        file.seek_read(buffer, offset + done as u64)
    })
}

fn read_loop(
    buffer: &mut [u8],
    mut read: impl FnMut(&mut [u8], usize) -> std::io::Result<usize>,
) -> std::io::Result<usize> {
    let mut done = 0;
    while done < buffer.len() {
        match read(&mut buffer[done..], done)? {
            0 => break,
            count => done += count,
        }
    }
    Ok(done)
}

#[derive(Debug, Error)]
pub enum PageError {
    #[error("page range is invalid")]
    InvalidRange,
    #[error("memory page handles are not file-backed")]
    MemoryHandle,
    #[error("page is not a complete f64 column")]
    InvalidColumn,
    #[error("page path is outside the cache root: {0}")]
    OutsideRoot(PathBuf),
    #[error("short page read: expected {expected} bytes, read {actual}")]
    ShortRead { expected: usize, actual: usize },
    #[error(
        "page capacity is held by leases: requested {requested}, leased {leased}, capacity {capacity}"
    )]
    CapacityHeld {
        requested: usize,
        leased: usize,
        capacity: usize,
    },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    const PAGE_BYTES: usize = 64;

    fn page(directory: &tempfile::TempDir, name: &str, byte: u8) -> PageHandle {
        let path = directory.path().join(name);
        let mut file = File::create(&path).unwrap();
        file.write_all(&[byte; PAGE_BYTES]).unwrap();
        PageHandle::new(path)
    }

    #[test]
    fn eviction_never_touches_a_leased_range() {
        let directory = tempfile::tempdir().unwrap();
        let cache = PageCache::new(directory.path(), 2 * PAGE_BYTES);
        let held = cache
            .read(&page(&directory, "a", 1), 0..PAGE_BYTES)
            .unwrap();
        cache
            .read(&page(&directory, "b", 2), 0..PAGE_BYTES)
            .unwrap();
        cache
            .read(&page(&directory, "c", 3), 0..PAGE_BYTES)
            .unwrap();

        assert_eq!(held.bytes().len(), PAGE_BYTES);
        assert!(cache.leased_bytes() >= PAGE_BYTES);
        assert!(cache.resident_bytes() <= 2 * PAGE_BYTES);
    }

    #[test]
    fn full_leases_reject_a_new_read() {
        let directory = tempfile::tempdir().unwrap();
        let cache = PageCache::new(directory.path(), PAGE_BYTES);
        let _held = cache
            .read(&page(&directory, "a", 1), 0..PAGE_BYTES)
            .unwrap();
        let error = cache
            .read(&page(&directory, "b", 2), 0..PAGE_BYTES)
            .unwrap_err();

        assert!(matches!(error, PageError::CapacityHeld { .. }));
    }

    #[test]
    fn deletion_waits_for_leases() {
        let directory = tempfile::tempdir().unwrap();
        let handle = page(&directory, "a", 1);
        let cache = PageCache::new(directory.path(), PAGE_BYTES);
        let held = cache.read(&handle, 0..PAGE_BYTES).unwrap();
        assert!(matches!(
            cache.delete(&handle),
            Err(PageError::CapacityHeld { .. })
        ));
        drop(held);
        cache.delete(&handle).unwrap();
        assert!(!handle.path().exists());
    }

    #[test]
    fn truncated_files_return_short_reads() {
        let directory = tempfile::tempdir().unwrap();
        let handle = page(&directory, "a", 1);
        File::options()
            .write(true)
            .open(handle.path())
            .unwrap()
            .set_len((PAGE_BYTES / 2) as u64)
            .unwrap();
        let error = PageCache::new(directory.path(), PAGE_BYTES)
            .read(&handle, 0..PAGE_BYTES)
            .unwrap_err();

        assert!(matches!(error, PageError::ShortRead { .. }));
    }
}

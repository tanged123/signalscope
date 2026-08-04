//! Leased byte-range cache over sidecar files.

use std::{
    collections::{HashMap, hash_map::Entry as MapEntry},
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

    /// Finds a partition point without re-reading or copying one value at a
    /// time from the page cache.
    pub(crate) fn partition_point(
        &self,
        byte_offset: usize,
        value_count: usize,
        mut predicate: impl FnMut(f64) -> bool,
    ) -> Result<usize, PageError> {
        let byte_len = value_count
            .checked_mul(size_of::<f64>())
            .and_then(|len| byte_offset.checked_add(len))
            .ok_or(PageError::InvalidRange)?;
        if byte_len > self.byte_len() || byte_offset % size_of::<f64>() != 0 {
            return Err(PageError::InvalidRange);
        }
        if let Some(values) = &self.memory {
            let start = byte_offset / size_of::<f64>();
            let end = start
                .checked_add(value_count)
                .ok_or(PageError::InvalidRange)?;
            let values = values.get(start..end).ok_or(PageError::InvalidRange)?;
            let mut left = 0;
            let mut right = values.len();
            while left < right {
                let middle = left + (right - left) / 2;
                if predicate(values[middle]) {
                    left = middle + 1;
                } else {
                    right = middle;
                }
            }
            return Ok(left);
        }

        let cache = self.cache.clone().unwrap_or_else(|| {
            PageCache::new(
                self.path.parent().unwrap_or_else(|| Path::new(".")),
                self.byte_len(),
            )
        });
        let page_size = cache.page_size();
        let mut pages: HashMap<usize, (usize, Arc<[u8]>)> = HashMap::new();
        let value_at = |index: usize,
                        pages: &mut HashMap<usize, (usize, Arc<[u8]>)>|
         -> Result<f64, PageError> {
            let offset = byte_offset
                .checked_add(
                    index
                        .checked_mul(size_of::<f64>())
                        .ok_or(PageError::InvalidRange)?,
                )
                .ok_or(PageError::InvalidRange)?;
            let page = offset / page_size;
            if let MapEntry::Vacant(entry) = pages.entry(page) {
                entry.insert(cache.read_page(self, page)?);
            }
            let (page_start, bytes) = pages.get(&page).ok_or(PageError::InvalidRange)?;
            let local = offset
                .checked_sub(*page_start)
                .ok_or(PageError::InvalidRange)?;
            let value = bytes
                .get(local..local + size_of::<f64>())
                .ok_or(PageError::InvalidRange)?;
            Ok(f64::from_le_bytes(
                value.try_into().map_err(|_| PageError::InvalidRange)?,
            ))
        };
        let mut left = 0;
        let mut right = value_count;
        while left < right {
            let middle = left + (right - left) / 2;
            if predicate(value_at(middle, &mut pages)?) {
                left = middle + 1;
            } else {
                right = middle;
            }
        }
        Ok(left)
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
    page_bytes: usize,
    clock: u64,
    resident: usize,
    entries: HashMap<Key, Entry>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Key {
    path: PathBuf,
    region: u64,
    page: u64,
}

struct Entry {
    bytes: Arc<[u8]>,
    leases: usize,
    used_at: u64,
}

pub struct Lease {
    cache: Arc<Mutex<State>>,
    keys: Vec<Key>,
    bytes: Arc<[u8]>,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Lease")
            .field("keys", &self.keys)
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
        let mut state = lock(&self.cache);
        for key in &self.keys {
            if let Some(entry) = state.entries.get_mut(key) {
                entry.leases = entry.leases.saturating_sub(1);
            }
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
                page_bytes: 64 * 1024,
                clock: 0,
                resident: 0,
                entries: HashMap::new(),
            })),
        }
    }

    #[cfg(test)]
    fn with_page_bytes(root: impl Into<PathBuf>, capacity_bytes: usize, page_bytes: usize) -> Self {
        assert!(page_bytes > 0);
        Self {
            inner: Arc::new(Mutex::new(State {
                root: root.into(),
                capacity: capacity_bytes,
                page_bytes,
                clock: 0,
                resident: 0,
                entries: HashMap::new(),
            })),
        }
    }

    fn page_size(&self) -> usize {
        lock(&self.inner).page_bytes
    }

    fn read_page(&self, handle: &PageHandle, page: usize) -> Result<(usize, Arc<[u8]>), PageError> {
        let page_size = self.page_size();
        let start = page.checked_mul(page_size).ok_or(PageError::InvalidRange)?;
        let end = start.saturating_add(page_size).min(handle.byte_len());
        if start >= end {
            return Err(PageError::InvalidRange);
        }
        let lease = self.read(handle, start..end)?;
        Ok((start, lease.shared()))
    }

    /// # Errors
    ///
    /// Returns an error for invalid ranges, short reads, IO failures, or when
    /// outstanding leases hold the available capacity.
    #[allow(clippy::too_many_lines)]
    pub fn read(&self, handle: &PageHandle, range: Range<usize>) -> Result<Lease, PageError> {
        if range.start > range.end || handle.len.is_some_and(|len| range.end > len) {
            return Err(PageError::InvalidRange);
        }
        if handle.memory.is_some() {
            return Err(PageError::MemoryHandle);
        }
        let len = if let Some(len) = handle.len {
            len
        } else {
            let file_len = std::fs::metadata(&handle.path)?.len();
            let region_len = file_len
                .checked_sub(handle.offset)
                .and_then(|len| usize::try_from(len).ok())
                .unwrap_or_default();
            region_len.max(range.end)
        };
        let (page_size, first, last) = {
            let state = lock(&self.inner);
            if !handle.path.starts_with(&state.root) {
                return Err(PageError::OutsideRoot(handle.path.clone()));
            }
            if range.is_empty() {
                return Ok(Lease {
                    cache: Arc::clone(&self.inner),
                    keys: Vec::new(),
                    bytes: Arc::from([]),
                });
            }
            let first = range.start / state.page_bytes;
            let last = (range.end - 1) / state.page_bytes;
            (state.page_bytes, first, last)
        };

        let missing: Vec<(Key, usize, usize)> = {
            let state = lock(&self.inner);
            (first..=last)
                .filter_map(|page| {
                    let page_start = page.checked_mul(page_size)?;
                    let page_len = page_size.min(len.checked_sub(page_start)?);
                    let key = Key {
                        path: handle.path.clone(),
                        region: handle.offset,
                        page: u64::try_from(page).ok()?,
                    };
                    (!state.entries.contains_key(&key)).then_some((key, page_start, page_len))
                })
                .collect()
        };

        if !missing.is_empty() {
            let file = File::open(&handle.path)?;
            let mut loaded = Vec::with_capacity(missing.len());
            for (key, page_start, page_len) in missing {
                let mut bytes = vec![0; page_len];
                let offset = handle
                    .offset
                    .checked_add(u64::try_from(page_start).map_err(|_| PageError::InvalidRange)?)
                    .ok_or(PageError::InvalidRange)?;
                let read = read_at(&file, &mut bytes, offset)?;
                if read != page_len {
                    return Err(PageError::ShortRead {
                        expected: page_len,
                        actual: read,
                    });
                }
                loaded.push((key, Arc::<[u8]>::from(bytes)));
            }

            let mut state = lock(&self.inner);
            for (key, bytes) in loaded {
                if state.entries.contains_key(&key) {
                    continue;
                }
                make_room(&mut state, bytes.len())?;
                state.resident += bytes.len();
                let used_at = state.clock;
                state.entries.insert(
                    key,
                    Entry {
                        bytes,
                        leases: 0,
                        used_at,
                    },
                );
            }
        }

        let mut state = lock(&self.inner);
        let mut keys = Vec::with_capacity(last - first + 1);
        let mut pages = Vec::with_capacity(last - first + 1);
        for page in first..=last {
            let key = Key {
                path: handle.path.clone(),
                region: handle.offset,
                page: u64::try_from(page).map_err(|_| PageError::InvalidRange)?,
            };
            state.clock = state.clock.wrapping_add(1);
            let used_at = state.clock;
            let entry = state.entries.get_mut(&key).ok_or(PageError::InvalidRange)?;
            entry.leases += 1;
            entry.used_at = used_at;
            keys.push(key);
            pages.push(Arc::clone(&entry.bytes));
        }

        let mut bytes = Vec::with_capacity(range.len());
        for (page, page_data) in pages.iter().enumerate() {
            let page_start = (first + page).saturating_mul(page_size);
            let start = range.start.saturating_sub(page_start).min(page_data.len());
            let end = range.end.saturating_sub(page_start).min(page_data.len());
            if start < end {
                bytes.extend_from_slice(&page_data[start..end]);
            }
        }
        drop(state);

        let bytes = if pages.len() == 1
            && range.start == first.saturating_mul(page_size)
            && range.end == range.start.saturating_add(pages[0].len())
        {
            Arc::clone(&pages[0])
        } else {
            bytes.into()
        };
        Ok(Lease {
            cache: Arc::clone(&self.inner),
            keys,
            bytes,
        })
    }

    pub fn evict_unleased(&self) {
        let mut state = lock(&self.inner);
        let removed: usize = state
            .entries
            .values()
            .filter(|entry| entry.leases == 0)
            .map(|entry| entry.bytes.len())
            .sum();
        state.entries.retain(|_, entry| entry.leases > 0);
        state.resident = state.resident.saturating_sub(removed);
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
        lock(&self.inner).resident
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
        let removed: usize = state
            .entries
            .iter()
            .filter(|(key, _)| key.path == handle.path)
            .map(|(_, entry)| entry.bytes.len())
            .sum();
        state.entries.retain(|key, _| key.path != handle.path);
        state.resident = state.resident.saturating_sub(removed);
        drop(state);
        std::fs::remove_file(&handle.path)?;
        Ok(())
    }
}

fn make_room(state: &mut State, requested: usize) -> Result<(), PageError> {
    while state.resident.saturating_add(requested) > state.capacity {
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
        if let Some(entry) = state.entries.remove(&candidate) {
            state.resident = state.resident.saturating_sub(entry.bytes.len());
        }
    }
    Ok(())
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

    const PAGE_BYTES_TEST: usize = 64;

    fn page(directory: &tempfile::TempDir, name: &str, byte: u8) -> PageHandle {
        let path = directory.path().join(name);
        let mut file = File::create(&path).unwrap();
        file.write_all(&[byte; PAGE_BYTES_TEST]).unwrap();
        PageHandle::new(path)
    }

    #[test]
    fn repeated_probes_hit_one_page() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("column");
        let values: Vec<u8> = (0..PAGE_BYTES_TEST * 2)
            .map(|i| u8::try_from(i % 251).expect("modulo fits in u8"))
            .collect();
        std::fs::write(&path, &values).unwrap();
        let cache = PageCache::with_page_bytes(directory.path(), 1024 * 1024, PAGE_BYTES_TEST);
        let handle = PageHandle::cached(cache.clone(), &path, 0, values.len());
        drop(cache.read(&handle, 0..8).unwrap());
        let resident = cache.resident_bytes();
        drop(cache.read(&handle, 16..24).unwrap());
        assert_eq!(cache.resident_bytes(), resident);
        drop(
            cache
                .read(&handle, PAGE_BYTES_TEST..PAGE_BYTES_TEST + 8)
                .unwrap(),
        );
        assert_eq!(cache.resident_bytes(), resident * 2);
    }

    #[test]
    fn partition_point_reuses_loaded_pages() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("column");
        let values: Vec<f64> = (0..32).map(f64::from).collect();
        let bytes: Vec<u8> = values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        std::fs::write(&path, bytes).unwrap();
        let cache = PageCache::with_page_bytes(directory.path(), 1024 * 1024, PAGE_BYTES_TEST);
        let handle = PageHandle::cached(cache.clone(), &path, 0, values.len() * size_of::<f64>());
        assert_eq!(
            handle
                .partition_point(0, values.len(), |value| value < 19.5)
                .unwrap(),
            20
        );
        assert_eq!(cache.resident_bytes(), PAGE_BYTES_TEST * 2);
    }

    #[test]
    fn cross_page_reads_assemble_correct_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("column");
        let values: Vec<u8> = (0..PAGE_BYTES_TEST * 3)
            .map(|i| u8::try_from(i % 251).expect("modulo fits in u8"))
            .collect();
        std::fs::write(&path, &values).unwrap();
        let cache = PageCache::with_page_bytes(directory.path(), 1024 * 1024, PAGE_BYTES_TEST);
        let handle = PageHandle::cached(cache.clone(), &path, 0, values.len());
        let range = PAGE_BYTES_TEST - 5..PAGE_BYTES_TEST * 2 + 7;
        let lease = cache.read(&handle, range.clone()).unwrap();
        assert_eq!(lease.bytes(), &values[range]);
        assert_eq!(cache.resident_bytes(), PAGE_BYTES_TEST * 3);
    }

    #[test]
    fn eviction_never_touches_a_leased_range() {
        let directory = tempfile::tempdir().unwrap();
        let cache =
            PageCache::with_page_bytes(directory.path(), 2 * PAGE_BYTES_TEST, PAGE_BYTES_TEST);
        let held = cache
            .read(&page(&directory, "a", 1), 0..PAGE_BYTES_TEST)
            .unwrap();
        cache
            .read(&page(&directory, "b", 2), 0..PAGE_BYTES_TEST)
            .unwrap();
        cache
            .read(&page(&directory, "c", 3), 0..PAGE_BYTES_TEST)
            .unwrap();

        assert_eq!(held.bytes().len(), PAGE_BYTES_TEST);
        assert!(cache.leased_bytes() >= PAGE_BYTES_TEST);
        assert!(cache.resident_bytes() <= 2 * PAGE_BYTES_TEST);
    }

    #[test]
    fn full_leases_reject_a_new_read() {
        let directory = tempfile::tempdir().unwrap();
        let cache = PageCache::with_page_bytes(directory.path(), PAGE_BYTES_TEST, PAGE_BYTES_TEST);
        let _held = cache
            .read(&page(&directory, "a", 1), 0..PAGE_BYTES_TEST)
            .unwrap();
        let error = cache
            .read(&page(&directory, "b", 2), 0..PAGE_BYTES_TEST)
            .unwrap_err();

        assert!(matches!(error, PageError::CapacityHeld { .. }));
    }

    #[test]
    fn deletion_waits_for_leases() {
        let directory = tempfile::tempdir().unwrap();
        let handle = page(&directory, "a", 1);
        let cache = PageCache::with_page_bytes(directory.path(), PAGE_BYTES_TEST, PAGE_BYTES_TEST);
        let held = cache.read(&handle, 0..PAGE_BYTES_TEST).unwrap();
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
            .set_len((PAGE_BYTES_TEST / 2) as u64)
            .unwrap();
        let error = PageCache::with_page_bytes(directory.path(), PAGE_BYTES_TEST, PAGE_BYTES_TEST)
            .read(&handle, 0..PAGE_BYTES_TEST)
            .unwrap_err();

        assert!(matches!(error, PageError::ShortRead { .. }));
    }
}

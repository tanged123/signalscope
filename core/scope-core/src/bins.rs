use std::ops::Range;
use std::sync::Arc;

use scope_protocol::EnvelopeBin;

use crate::paging::PageHandle;

pub const HAS_FIRST: u8 = 1 << 0;
pub const HAS_LAST: u8 = 1 << 1;
pub const HAS_MIN: u8 = 1 << 2;
pub const HAS_MAX: u8 = 1 << 3;
pub const HAS_GAP: u8 = 1 << 4;
pub const MISSING_INDEX: u64 = u64::MAX;

#[derive(Clone, Debug)]
pub struct BinLevel {
    pub(crate) t0: Vec<f64>,
    pub(crate) t1: Vec<f64>,
    pub(crate) first: Vec<f64>,
    pub(crate) last: Vec<f64>,
    pub(crate) min: Vec<f64>,
    pub(crate) max: Vec<f64>,
    pub(crate) sum: Vec<f64>,
    pub(crate) sum_sq: Vec<f64>,
    pub(crate) first_index: Vec<u64>,
    pub(crate) last_index: Vec<u64>,
    pub(crate) min_index: Vec<u64>,
    pub(crate) max_index: Vec<u64>,
    pub(crate) sample_count: Vec<u32>,
    pub(crate) finite_count: Vec<u32>,
    pub(crate) flags: Vec<u8>,
    shared: Option<Arc<SharedBinLevel>>,
    range: Range<usize>,
}

#[derive(Clone, Debug, PartialEq)]
struct SharedBinLevel {
    t0: Arc<[f64]>,
    t1: Arc<[f64]>,
    first: Arc<[f64]>,
    last: Arc<[f64]>,
    min: Arc<[f64]>,
    max: Arc<[f64]>,
    sum: Arc<[f64]>,
    sum_sq: Arc<[f64]>,
    first_index: Arc<[u64]>,
    last_index: Arc<[u64]>,
    min_index: Arc<[u64]>,
    max_index: Arc<[u64]>,
    sample_count: Arc<[u32]>,
    finite_count: Arc<[u32]>,
    flags: Arc<[u8]>,
}

impl Default for BinLevel {
    fn default() -> Self {
        Self {
            t0: Vec::new(),
            t1: Vec::new(),
            first: Vec::new(),
            last: Vec::new(),
            min: Vec::new(),
            max: Vec::new(),
            sum: Vec::new(),
            sum_sq: Vec::new(),
            first_index: Vec::new(),
            last_index: Vec::new(),
            min_index: Vec::new(),
            max_index: Vec::new(),
            sample_count: Vec::new(),
            finite_count: Vec::new(),
            flags: Vec::new(),
            shared: None,
            range: 0..0,
        }
    }
}

impl PartialEq for BinLevel {
    fn eq(&self, other: &Self) -> bool {
        self.t0_column() == other.t0_column()
            && self.t1_column() == other.t1_column()
            && self.first_column() == other.first_column()
            && self.last_column() == other.last_column()
            && self.min_column() == other.min_column()
            && self.max_column() == other.max_column()
            && self.sum_column() == other.sum_column()
            && self.sum_sq_column() == other.sum_sq_column()
            && self.first_index_column() == other.first_index_column()
            && self.last_index_column() == other.last_index_column()
            && self.min_index_column() == other.min_index_column()
            && self.max_index_column() == other.max_index_column()
            && self.sample_count_column() == other.sample_count_column()
            && self.finite_count_column() == other.finite_count_column()
            && self.flags_column() == other.flags_column()
    }
}

impl BinLevel {
    pub const BYTES_PER_BIN: usize =
        8 * size_of::<f64>() + 4 * size_of::<u64>() + 2 * size_of::<u32>() + size_of::<u8>();

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            t0: Vec::with_capacity(capacity),
            t1: Vec::with_capacity(capacity),
            first: Vec::with_capacity(capacity),
            last: Vec::with_capacity(capacity),
            min: Vec::with_capacity(capacity),
            max: Vec::with_capacity(capacity),
            sum: Vec::with_capacity(capacity),
            sum_sq: Vec::with_capacity(capacity),
            first_index: Vec::with_capacity(capacity),
            last_index: Vec::with_capacity(capacity),
            min_index: Vec::with_capacity(capacity),
            max_index: Vec::with_capacity(capacity),
            sample_count: Vec::with_capacity(capacity),
            finite_count: Vec::with_capacity(capacity),
            flags: Vec::with_capacity(capacity),
            shared: None,
            range: 0..0,
        }
    }

    pub fn from_wire(bins: &[EnvelopeBin]) -> Self {
        let mut level = Self::with_capacity(bins.len());
        for bin in bins {
            level.push(bin);
        }
        level
    }

    pub fn push(&mut self, bin: &EnvelopeBin) {
        self.push_indexed(
            bin,
            MISSING_INDEX,
            MISSING_INDEX,
            MISSING_INDEX,
            MISSING_INDEX,
        );
    }

    pub(crate) fn push_indexed(
        &mut self,
        bin: &EnvelopeBin,
        first_index: u64,
        last_index: u64,
        min_index: u64,
        max_index: u64,
    ) {
        let mut flags = 0;
        self.t0.push(bin.t0);
        self.t1.push(bin.t1);
        push_optional(&mut self.first, &mut flags, HAS_FIRST, bin.first);
        push_optional(&mut self.last, &mut flags, HAS_LAST, bin.last);
        push_optional(&mut self.min, &mut flags, HAS_MIN, bin.min);
        push_optional(&mut self.max, &mut flags, HAS_MAX, bin.max);
        self.sum.push(bin.sum);
        self.sum_sq.push(bin.sum_sq);
        self.first_index
            .push(index_or_missing(first_index, bin.first));
        self.last_index.push(index_or_missing(last_index, bin.last));
        self.min_index.push(index_or_missing(min_index, bin.min));
        self.max_index.push(index_or_missing(max_index, bin.max));
        self.sample_count.push(saturating_u32(bin.sample_count));
        self.finite_count.push(saturating_u32(bin.finite_count));
        if bin.has_gap {
            flags |= HAS_GAP;
        }
        self.flags.push(flags);
    }

    pub fn len(&self) -> usize {
        self.shared
            .as_ref()
            .map_or(self.t0.len(), |_| self.range.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get(&self, index: usize) -> Option<BinRef<'_>> {
        (index < self.len()).then_some(BinRef { level: self, index })
    }

    /// # Panics
    ///
    /// Panics when `index` is outside this level.
    pub fn to_wire(&self, index: usize) -> EnvelopeBin {
        self.get(index).expect("bin index out of bounds").to_wire()
    }

    pub fn to_wire_vec(&self) -> Vec<EnvelopeBin> {
        (0..self.len()).map(|index| self.to_wire(index)).collect()
    }

    #[must_use]
    pub fn t0_column(&self) -> &[f64] {
        self.shared
            .as_ref()
            .map_or(&self.t0, |shared| &shared.t0[self.range.clone()])
    }

    #[must_use]
    pub fn t1_column(&self) -> &[f64] {
        self.shared
            .as_ref()
            .map_or(&self.t1, |shared| &shared.t1[self.range.clone()])
    }

    #[must_use]
    pub fn first_column(&self) -> &[f64] {
        self.shared
            .as_ref()
            .map_or(&self.first, |shared| &shared.first[self.range.clone()])
    }

    #[must_use]
    pub fn last_column(&self) -> &[f64] {
        self.shared
            .as_ref()
            .map_or(&self.last, |shared| &shared.last[self.range.clone()])
    }

    #[must_use]
    pub fn min_column(&self) -> &[f64] {
        self.shared
            .as_ref()
            .map_or(&self.min, |shared| &shared.min[self.range.clone()])
    }

    #[must_use]
    pub fn max_column(&self) -> &[f64] {
        self.shared
            .as_ref()
            .map_or(&self.max, |shared| &shared.max[self.range.clone()])
    }

    #[must_use]
    pub fn sum_column(&self) -> &[f64] {
        self.shared
            .as_ref()
            .map_or(&self.sum, |shared| &shared.sum[self.range.clone()])
    }

    #[must_use]
    pub fn sum_sq_column(&self) -> &[f64] {
        self.shared
            .as_ref()
            .map_or(&self.sum_sq, |shared| &shared.sum_sq[self.range.clone()])
    }

    #[must_use]
    pub fn first_index_column(&self) -> &[u64] {
        self.shared.as_ref().map_or(&self.first_index, |shared| {
            &shared.first_index[self.range.clone()]
        })
    }

    #[must_use]
    pub fn last_index_column(&self) -> &[u64] {
        self.shared.as_ref().map_or(&self.last_index, |shared| {
            &shared.last_index[self.range.clone()]
        })
    }

    #[must_use]
    pub fn min_index_column(&self) -> &[u64] {
        self.shared.as_ref().map_or(&self.min_index, |shared| {
            &shared.min_index[self.range.clone()]
        })
    }

    #[must_use]
    pub fn max_index_column(&self) -> &[u64] {
        self.shared.as_ref().map_or(&self.max_index, |shared| {
            &shared.max_index[self.range.clone()]
        })
    }

    #[must_use]
    pub fn sample_count_column(&self) -> &[u32] {
        self.shared.as_ref().map_or(&self.sample_count, |shared| {
            &shared.sample_count[self.range.clone()]
        })
    }

    #[must_use]
    pub fn finite_count_column(&self) -> &[u32] {
        self.shared.as_ref().map_or(&self.finite_count, |shared| {
            &shared.finite_count[self.range.clone()]
        })
    }

    #[must_use]
    pub fn flags_column(&self) -> &[u8] {
        self.shared
            .as_ref()
            .map_or(&self.flags, |shared| &shared.flags[self.range.clone()])
    }

    #[must_use]
    pub fn slice(&self, range: Range<usize>) -> Self {
        if let Some(shared) = &self.shared {
            let start = self.range.start + range.start;
            let end = self.range.start + range.end;
            let _ = &shared.t0[start..end];
            return Self {
                t0: Vec::new(),
                t1: Vec::new(),
                first: Vec::new(),
                last: Vec::new(),
                min: Vec::new(),
                max: Vec::new(),
                sum: Vec::new(),
                sum_sq: Vec::new(),
                first_index: Vec::new(),
                last_index: Vec::new(),
                min_index: Vec::new(),
                max_index: Vec::new(),
                sample_count: Vec::new(),
                finite_count: Vec::new(),
                flags: Vec::new(),
                shared: Some(Arc::clone(shared)),
                range: start..end,
            };
        }
        Self {
            t0: self.t0[range.clone()].to_vec(),
            t1: self.t1[range.clone()].to_vec(),
            first: self.first[range.clone()].to_vec(),
            last: self.last[range.clone()].to_vec(),
            min: self.min[range.clone()].to_vec(),
            max: self.max[range.clone()].to_vec(),
            sum: self.sum[range.clone()].to_vec(),
            sum_sq: self.sum_sq[range.clone()].to_vec(),
            first_index: self.first_index[range.clone()].to_vec(),
            last_index: self.last_index[range.clone()].to_vec(),
            min_index: self.min_index[range.clone()].to_vec(),
            max_index: self.max_index[range.clone()].to_vec(),
            sample_count: self.sample_count[range.clone()].to_vec(),
            finite_count: self.finite_count[range.clone()].to_vec(),
            flags: self.flags[range].to_vec(),
            shared: None,
            range: 0..0,
        }
    }

    pub(crate) fn into_shared(self) -> Self {
        if self.shared.is_some() {
            return self;
        }
        let len = self.t0.len();
        Self {
            t0: Vec::new(),
            t1: Vec::new(),
            first: Vec::new(),
            last: Vec::new(),
            min: Vec::new(),
            max: Vec::new(),
            sum: Vec::new(),
            sum_sq: Vec::new(),
            first_index: Vec::new(),
            last_index: Vec::new(),
            min_index: Vec::new(),
            max_index: Vec::new(),
            sample_count: Vec::new(),
            finite_count: Vec::new(),
            flags: Vec::new(),
            shared: Some(Arc::new(SharedBinLevel {
                t0: self.t0.into(),
                t1: self.t1.into(),
                first: self.first.into(),
                last: self.last.into(),
                min: self.min.into(),
                max: self.max.into(),
                sum: self.sum.into(),
                sum_sq: self.sum_sq.into(),
                first_index: self.first_index.into(),
                last_index: self.last_index.into(),
                min_index: self.min_index.into(),
                max_index: self.max_index.into(),
                sample_count: self.sample_count.into(),
                finite_count: self.finite_count.into(),
                flags: self.flags.into(),
            })),
            range: 0..len,
        }
    }

    pub(crate) fn decode_cache(bytes: &[u8]) -> Option<Self> {
        let count = usize::try_from(u64::from_le_bytes(bytes.get(..8)?.try_into().ok()?)).ok()?;
        let used = 8_usize.checked_add(count.checked_mul(Self::BYTES_PER_BIN)?)?;
        if bytes.len() != used.checked_next_multiple_of(8)? {
            return None;
        }
        let mut at = 8;
        Some(Self {
            t0: decode_f64s(bytes, &mut at, count)?,
            t1: decode_f64s(bytes, &mut at, count)?,
            first: decode_f64s(bytes, &mut at, count)?,
            last: decode_f64s(bytes, &mut at, count)?,
            min: decode_f64s(bytes, &mut at, count)?,
            max: decode_f64s(bytes, &mut at, count)?,
            sum: decode_f64s(bytes, &mut at, count)?,
            sum_sq: decode_f64s(bytes, &mut at, count)?,
            first_index: decode_u64s(bytes, &mut at, count)?,
            last_index: decode_u64s(bytes, &mut at, count)?,
            min_index: decode_u64s(bytes, &mut at, count)?,
            max_index: decode_u64s(bytes, &mut at, count)?,
            sample_count: decode_u32s(bytes, &mut at, count)?,
            finite_count: decode_u32s(bytes, &mut at, count)?,
            flags: bytes.get(at..at.checked_add(count)?)?.to_vec(),
            shared: None,
            range: 0..count,
        })
    }

    pub(crate) fn cache_count(handle: &PageHandle) -> Option<usize> {
        let bytes = handle.bytes_range(0..8).ok()?;
        usize::try_from(u64::from_le_bytes(bytes.as_ref().try_into().ok()?)).ok()
    }

    pub(crate) fn cache_len(count: usize) -> Option<usize> {
        8_usize
            .checked_add(count.checked_mul(Self::BYTES_PER_BIN)?)?
            .checked_next_multiple_of(8)
    }

    pub(crate) fn decode_cache_range(
        handle: &PageHandle,
        count: usize,
        range: std::ops::Range<usize>,
    ) -> Option<Self> {
        if range.start > range.end || range.end > count {
            return None;
        }
        let mut fields = Vec::with_capacity(8);
        for field in 0..8 {
            let base = 8_usize.checked_add(field * count * size_of::<f64>())?;
            fields.push(decode_f64_bytes(
                &handle
                    .bytes_range(
                        base.checked_add(range.start * size_of::<f64>())?
                            ..base.checked_add(range.end * size_of::<f64>())?,
                    )
                    .ok()?,
            )?);
        }
        let index_base = 8_usize.checked_add(8 * count * size_of::<f64>())?;
        let mut indexes = Vec::with_capacity(4);
        for field in 0..4 {
            let base = index_base.checked_add(field * count * size_of::<u64>())?;
            indexes.push(decode_u64_bytes(
                &handle
                    .bytes_range(
                        base.checked_add(range.start * size_of::<u64>())?
                            ..base.checked_add(range.end * size_of::<u64>())?,
                    )
                    .ok()?,
            )?);
        }
        let counts = index_base.checked_add(4 * count * size_of::<u64>())?;
        let sample_count = decode_u32_bytes(
            &handle
                .bytes_range(
                    counts.checked_add(range.start * size_of::<u32>())?
                        ..counts.checked_add(range.end * size_of::<u32>())?,
                )
                .ok()?,
        )?;
        let finite_base = counts.checked_add(count * size_of::<u32>())?;
        let finite_count = decode_u32_bytes(
            &handle
                .bytes_range(
                    finite_base.checked_add(range.start * size_of::<u32>())?
                        ..finite_base.checked_add(range.end * size_of::<u32>())?,
                )
                .ok()?,
        )?;
        let flags_base = finite_base.checked_add(count * size_of::<u32>())?;
        let flags = handle
            .bytes_range(flags_base.checked_add(range.start)?..flags_base.checked_add(range.end)?)
            .ok()?
            .to_vec();
        let mut fields = fields.into_iter();
        Some(Self {
            t0: fields.next()?,
            t1: fields.next()?,
            first: fields.next()?,
            last: fields.next()?,
            min: fields.next()?,
            max: fields.next()?,
            sum: fields.next()?,
            sum_sq: fields.next()?,
            first_index: indexes.first()?.clone(),
            last_index: indexes.get(1)?.clone(),
            min_index: indexes.get(2)?.clone(),
            max_index: indexes.get(3)?.clone(),
            sample_count,
            finite_count,
            flags,
            shared: None,
            range: 0..range.len(),
        })
    }

    pub(crate) fn t0s(&self) -> &[f64] {
        self.t0_column()
    }

    pub(crate) fn t1s(&self) -> &[f64] {
        self.t1_column()
    }
}

fn decode_f64_bytes(bytes: &[u8]) -> Option<Vec<f64>> {
    (bytes.len() % size_of::<f64>() == 0).then(|| {
        bytes
            .chunks_exact(size_of::<f64>())
            .map(|chunk| f64::from_le_bytes(chunk.try_into().expect("exact chunk")))
            .collect()
    })
}

fn decode_u32_bytes(bytes: &[u8]) -> Option<Vec<u32>> {
    (bytes.len() % size_of::<u32>() == 0).then(|| {
        bytes
            .chunks_exact(size_of::<u32>())
            .map(|chunk| u32::from_le_bytes(chunk.try_into().expect("exact chunk")))
            .collect()
    })
}

fn decode_u64_bytes(bytes: &[u8]) -> Option<Vec<u64>> {
    (bytes.len() % size_of::<u64>() == 0).then(|| {
        bytes
            .chunks_exact(size_of::<u64>())
            .map(|chunk| u64::from_le_bytes(chunk.try_into().expect("exact chunk")))
            .collect()
    })
}

fn decode_f64s(bytes: &[u8], at: &mut usize, count: usize) -> Option<Vec<f64>> {
    let end = at.checked_add(count.checked_mul(size_of::<f64>())?)?;
    let values = bytes
        .get(*at..end)?
        .chunks_exact(size_of::<f64>())
        .map(|chunk| {
            let mut value = [0; size_of::<f64>()];
            value.copy_from_slice(chunk);
            f64::from_le_bytes(value)
        })
        .collect();
    *at = end;
    Some(values)
}

fn decode_u32s(bytes: &[u8], at: &mut usize, count: usize) -> Option<Vec<u32>> {
    let end = at.checked_add(count.checked_mul(size_of::<u32>())?)?;
    let values = bytes
        .get(*at..end)?
        .chunks_exact(size_of::<u32>())
        .map(|chunk| {
            let mut value = [0; size_of::<u32>()];
            value.copy_from_slice(chunk);
            u32::from_le_bytes(value)
        })
        .collect();
    *at = end;
    Some(values)
}

fn decode_u64s(bytes: &[u8], at: &mut usize, count: usize) -> Option<Vec<u64>> {
    let end = at.checked_add(count.checked_mul(size_of::<u64>())?)?;
    let values = bytes
        .get(*at..end)?
        .chunks_exact(size_of::<u64>())
        .map(|chunk| u64::from_le_bytes(chunk.try_into().expect("exact chunk")))
        .collect();
    *at = end;
    Some(values)
}

#[derive(Clone, Copy)]
pub struct BinRef<'a> {
    level: &'a BinLevel,
    index: usize,
}

impl BinRef<'_> {
    pub fn first_index(self) -> Option<u64> {
        self.index_for(HAS_FIRST, self.level.first_index_column())
    }

    pub fn last_index(self) -> Option<u64> {
        self.index_for(HAS_LAST, self.level.last_index_column())
    }

    pub fn min_index(self) -> Option<u64> {
        self.index_for(HAS_MIN, self.level.min_index_column())
    }

    pub fn max_index(self) -> Option<u64> {
        self.index_for(HAS_MAX, self.level.max_index_column())
    }

    fn index_for(self, bit: u8, column: &[u64]) -> Option<u64> {
        (self.level.flags_column()[self.index] & bit != 0)
            .then_some(column[self.index])
            .filter(|index| *index != MISSING_INDEX)
    }

    pub fn to_wire(self) -> EnvelopeBin {
        let flags = self.level.flags_column()[self.index];
        EnvelopeBin {
            t0: self.level.t0_column()[self.index],
            t1: self.level.t1_column()[self.index],
            first: optional(self.level.first_column()[self.index], flags, HAS_FIRST),
            last: optional(self.level.last_column()[self.index], flags, HAS_LAST),
            min: optional(self.level.min_column()[self.index], flags, HAS_MIN),
            max: optional(self.level.max_column()[self.index], flags, HAS_MAX),
            sample_count: u64::from(self.level.sample_count_column()[self.index]),
            finite_count: u64::from(self.level.finite_count_column()[self.index]),
            sum: self.level.sum_column()[self.index],
            sum_sq: self.level.sum_sq_column()[self.index],
            has_gap: flags & HAS_GAP != 0,
        }
    }
}

fn push_optional(values: &mut Vec<f64>, flags: &mut u8, bit: u8, value: Option<f64>) {
    if let Some(value) = value {
        *flags |= bit;
        values.push(value);
    } else {
        values.push(f64::NAN);
    }
}

fn index_or_missing(index: u64, value: Option<f64>) -> u64 {
    value.map_or(MISSING_INDEX, |_| index)
}

fn optional(value: f64, flags: u8, bit: u8) -> Option<f64> {
    (flags & bit != 0).then_some(value)
}

fn saturating_u32(value: u64) -> u32 {
    value.try_into().unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bin() -> EnvelopeBin {
        EnvelopeBin {
            t0: 1.0,
            t1: 2.0,
            first: Some(3.0),
            last: None,
            min: Some(-1.0),
            max: Some(5.0),
            sample_count: u64::MAX,
            finite_count: 4,
            sum: 7.0,
            sum_sq: 29.0,
            has_gap: true,
        }
    }

    #[test]
    fn compact_storage_stays_within_budget() {
        assert!(std::hint::black_box(BinLevel::BYTES_PER_BIN) <= 112);
    }

    #[test]
    fn flags_preserve_optional_values_and_gaps() {
        let level = BinLevel::from_wire(&[bin()]);
        let wire = level.to_wire(0);

        assert_eq!(wire.first, Some(3.0));
        assert_eq!(wire.last, None);
        assert_eq!(wire.min, Some(-1.0));
        assert_eq!(wire.max, Some(5.0));
        assert!(wire.has_gap);
        assert_eq!(wire.sample_count, u64::from(u32::MAX));
        assert!(level.last[0].is_nan());
    }

    #[test]
    fn slice_matches_wire_roundtrip() {
        let level = BinLevel::from_wire(&[bin(), bin(), bin()]);
        let sliced = level.slice(1..3);
        assert_eq!(sliced.len(), 2);
        assert_eq!(sliced.to_wire(0), level.to_wire(1));
    }

    #[test]
    fn shared_slice_reuses_column_storage() {
        let level = BinLevel::from_wire(&[bin(), bin(), bin()]).into_shared();
        let sliced = level.slice(1..3);
        assert_eq!(sliced.t0_column().as_ptr(), level.t0_column()[1..].as_ptr());
        assert_eq!(sliced.to_wire(0), level.to_wire(1));
    }
}

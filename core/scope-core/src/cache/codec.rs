use serde::{Deserialize, Serialize};

use crate::bins::BinLevel;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub(super) struct CacheSection {
    pub(super) offset: u64,
    pub(super) len: u64,
    pub(super) crc32: u32,
}

pub(super) fn digest_bytes(digest: &str) -> Option<[u8; 32]> {
    if digest.len() != 64 || !digest.is_ascii() {
        return None;
    }
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digest[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

#[cfg(test)]
pub(super) fn section_bytes(payload: &[u8], section: CacheSection) -> Option<&[u8]> {
    let start = usize::try_from(section.offset).ok()?;
    let len = usize::try_from(section.len).ok()?;
    let bytes = payload.get(start..start.checked_add(len)?)?;
    (crc32fast::hash(bytes) == section.crc32).then_some(bytes)
}

pub(super) fn append_section(payload: &mut Vec<u8>, bytes: &[u8]) -> CacheSection {
    pad_to_8(payload);
    let section = CacheSection {
        offset: payload.len() as u64,
        len: bytes.len() as u64,
        crc32: crc32fast::hash(bytes),
    };
    payload.extend_from_slice(bytes);
    section
}

pub(super) fn encode_column(values: &[f64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 8);
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

pub(super) fn encode_bins(bins: &BinLevel) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + bins.len() * BinLevel::BYTES_PER_BIN);
    out.extend_from_slice(&(bins.len() as u64).to_le_bytes());
    for values in [
        bins.t0_column(),
        bins.t1_column(),
        bins.first_column(),
        bins.last_column(),
        bins.min_column(),
        bins.max_column(),
        bins.sum_column(),
        bins.sum_sq_column(),
    ] {
        for value in values {
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
    for values in [bins.sample_count_column(), bins.finite_count_column()] {
        for value in values {
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
    out.extend_from_slice(bins.flags_column());
    pad_to_8(&mut out);
    out
}

#[cfg(test)]
pub(super) fn decode_bins(bytes: &[u8]) -> Option<BinLevel> {
    BinLevel::decode_cache(bytes)
}

pub(super) fn pad_to_8(bytes: &mut Vec<u8>) {
    while bytes.len() % 8 != 0 {
        bytes.push(0);
    }
}

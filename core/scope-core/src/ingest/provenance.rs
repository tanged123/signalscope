//! Decode inputs used for cache invalidation.

use std::{fs::File, io::Read, path::Path, time::UNIX_EPOCH};

use sha2::{Digest, Sha256};

pub const CACHE_ABI_CSV: u32 = 1;
pub const CACHE_ABI_MCAP: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderInfo {
    pub id: &'static str,
    pub cache_abi: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fingerprint {
    pub source_len: u64,
    pub mtime_ns: u64,
    pub head_crc: u32,
}

const FINGERPRINT_HEAD_LEN: usize = 64 * 1024;

/// # Errors
///
/// Returns the underlying IO error.
pub fn fingerprint(source: &Path) -> std::io::Result<Fingerprint> {
    let metadata = std::fs::metadata(source)?;
    let mtime_ns = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX)
        });
    let mut head = Vec::with_capacity(FINGERPRINT_HEAD_LEN);
    File::open(source)?
        .take(FINGERPRINT_HEAD_LEN as u64)
        .read_to_end(&mut head)?;
    Ok(Fingerprint {
        source_len: metadata.len(),
        mtime_ns,
        head_crc: crc32fast::hash(&head),
    })
}

fn field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

#[must_use]
pub fn provenance_digest(
    provider: &ProviderInfo,
    fingerprint: &Fingerprint,
    options: &[(&str, &str)],
) -> String {
    let mut hasher = Sha256::new();
    field(&mut hasher, b"scope-provenance-1");
    field(&mut hasher, provider.id.as_bytes());
    field(&mut hasher, &provider.cache_abi.to_le_bytes());
    field(&mut hasher, &fingerprint.source_len.to_le_bytes());
    field(&mut hasher, &fingerprint.mtime_ns.to_le_bytes());
    field(&mut hasher, &fingerprint.head_crc.to_le_bytes());
    for (name, value) in options {
        field(&mut hasher, name.as_bytes());
        field(&mut hasher, value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> ProviderInfo {
        ProviderInfo {
            id: "csv",
            cache_abi: CACHE_ABI_CSV,
        }
    }

    #[test]
    fn the_digest_changes_with_every_input_that_changes_the_columns() {
        let base = Fingerprint {
            source_len: 10,
            mtime_ns: 20,
            head_crc: 30,
        };
        let digest = provenance_digest(&info(), &base, &[]);
        assert_eq!(digest.len(), 64);
        assert_eq!(digest, provenance_digest(&info(), &base, &[]));

        let other_abi = ProviderInfo {
            id: "csv",
            cache_abi: CACHE_ABI_CSV + 1,
        };
        assert_ne!(digest, provenance_digest(&other_abi, &base, &[]));
        assert_ne!(
            digest,
            provenance_digest(
                &ProviderInfo {
                    id: "mcap",
                    cache_abi: CACHE_ABI_CSV,
                },
                &base,
                &[]
            )
        );
        assert_ne!(
            digest,
            provenance_digest(
                &info(),
                &Fingerprint {
                    source_len: 11,
                    ..base
                },
                &[]
            )
        );
        assert_ne!(
            digest,
            provenance_digest(&info(), &base, &[("recipe", "abc")])
        );
    }

    #[test]
    fn option_encoding_cannot_be_confused_by_separators() {
        let base = Fingerprint {
            source_len: 1,
            mtime_ns: 1,
            head_crc: 1,
        };
        assert_ne!(
            provenance_digest(&info(), &base, &[("a", "b:c")]),
            provenance_digest(&info(), &base, &[("a:b", "c")])
        );
    }
}

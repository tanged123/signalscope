//! Stable source keys and display prefixes.

use std::{collections::BTreeSet, path::Path};

use uuid::Uuid;

/// Fixed namespace for pre-v11 session migration.
pub const LEGACY_NAMESPACE: Uuid = Uuid::from_u128(0x6a1f_2d47_9c53_4f21_8b0e_1d7c_3a95_04ef);

#[must_use]
pub fn normalize_segment(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .replace([' ', '.'], "_")
        .to_lowercase()
}

#[must_use]
pub fn default_prefix(path: &Path) -> String {
    let stem = path
        .file_stem()
        .or_else(|| path.file_name())
        .and_then(|value| value.to_str())
        .unwrap_or("source");
    let normalized = normalize_segment(stem.trim_start_matches('.'));
    if normalized.is_empty() {
        "source".to_owned()
    } else {
        normalized
    }
}

#[must_use]
pub fn allocate_prefix(taken: &BTreeSet<String>, path: &Path, key: Uuid) -> Option<String> {
    let base = default_prefix(path);
    if !taken.contains(&base) {
        return Some(base);
    }
    let digest = key.simple().to_string();
    [4_usize, 8, 16, 32].into_iter().find_map(|width| {
        let candidate = format!("{base}_{}", &digest[..width]);
        (!taken.contains(&candidate)).then_some(candidate)
    })
}

#[must_use]
pub fn legacy_source_key(path: &str) -> Uuid {
    Uuid::new_v5(&LEGACY_NAMESPACE, path.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_never_carry_parent_directory_text() {
        assert_eq!(
            default_prefix(Path::new("/runs/2026/Flight Test.csv")),
            "flight_test"
        );
        assert_eq!(default_prefix(Path::new("/runs/.hidden")), "hidden");
        assert_eq!(default_prefix(Path::new("/runs/")), "runs");
    }

    #[test]
    fn collisions_widen_a_key_digest_instead_of_counting() {
        let key = legacy_source_key("/a/run.csv");
        let mut taken = BTreeSet::new();
        let first = allocate_prefix(&taken, Path::new("/a/run.csv"), key).unwrap();
        assert_eq!(first, "run");
        taken.insert(first);
        let second = allocate_prefix(&taken, Path::new("/b/run.csv"), key).unwrap();
        assert_eq!(second, format!("run_{}", &key.simple().to_string()[..4]));
        taken.insert(second.clone());
        assert!(
            allocate_prefix(&taken, Path::new("/c/run.csv"), key)
                .unwrap()
                .starts_with("run_")
        );
    }

    #[test]
    fn legacy_keys_are_stable_across_machines() {
        assert_eq!(
            legacy_source_key("/data/run.csv"),
            legacy_source_key("/data/run.csv")
        );
        assert_ne!(
            legacy_source_key("/data/run.csv"),
            legacy_source_key("/data/run2.csv")
        );
        assert_eq!(
            legacy_source_key("/data/run.csv").to_string(),
            uuid::Uuid::new_v5(&LEGACY_NAMESPACE, b"/data/run.csv").to_string()
        );
    }
}

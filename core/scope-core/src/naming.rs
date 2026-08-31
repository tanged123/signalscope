//! Stable source keys and display prefixes.

use std::{collections::BTreeSet, path::Path};

use uuid::Uuid;

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
        let key = Uuid::from_bytes([7; 16]);
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
}

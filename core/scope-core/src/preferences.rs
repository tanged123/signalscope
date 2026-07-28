//! Versioned global preferences schema (ADR 0023): appearance settings that
//! persist across sessions, unlike the per-workspace session file.

mod generated;

pub use generated::*;

use std::path::Path;

use serde::Deserialize;
use thiserror::Error;

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: PREFERENCES_SCHEMA_VERSION,
            ui_font_family: FontFamily::Inter,
            plot_font_family: FontFamily::Jetbrains,
            ui_font_size: 13.0,
            plot_font_size: 9.0,
        }
    }
}

/// Deserializes and migrates a preferences document.
///
/// # Errors
///
/// Returns [`PreferencesError`] when the JSON is malformed or uses an
/// unsupported schema version.
pub fn from_json(json: &str) -> Result<Preferences, PreferencesError> {
    #[derive(Deserialize)]
    struct Head {
        schema_version: u32,
    }

    let value: serde_json::Value = serde_json::from_str(json)?;
    let head: Head = Head::deserialize(&value)?;
    migrate(head.schema_version, value)
}

/// Serializes `preferences` through a sibling temporary file renamed into
/// place, so an interrupted write never truncates the previous file.
///
/// # Errors
///
/// Returns [`PreferencesError::Io`] when the write or rename fails and
/// [`PreferencesError::Json`] when serialization fails.
pub fn save_to_path(preferences: &Preferences, path: &Path) -> Result<(), PreferencesError> {
    let json = serde_json::to_string_pretty(preferences)?;
    let temporary = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&temporary, json)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Reads and migrates the preferences stored at `path`.
///
/// # Errors
///
/// Returns [`PreferencesError::Io`] when the file cannot be read and the
/// variants of [`from_json`] otherwise.
pub fn load_from_path(path: &Path) -> Result<Preferences, PreferencesError> {
    from_json(&std::fs::read_to_string(path)?)
}

/// Migration ladder (ADR 0005 pattern): v1 is current; each future bump adds
/// one arm that rewrites vN into vN+1 shape and recurses.
fn migrate(version: u32, value: serde_json::Value) -> Result<Preferences, PreferencesError> {
    match version {
        PREFERENCES_SCHEMA_VERSION => Ok(serde_json::from_value(value)?),
        version => Err(PreferencesError::UnsupportedVersion(version)),
    }
}

#[derive(Debug, Error)]
pub enum PreferencesError {
    #[error("unsupported preferences schema version: {0}")]
    UnsupportedVersion(u32),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/preferences-conformance.json"
    );

    #[test]
    fn preferences_conformance_fixture_matches_rust() {
        let preferences = Preferences::default();
        let current = format!(
            "{}\n",
            serde_json::to_string_pretty(&preferences).expect("serializes")
        );
        if std::env::var("REGENERATE_FIXTURES").is_ok() {
            std::fs::write(FIXTURE_PATH, &current).expect("write fixture");
            return;
        }
        let stored = std::fs::read_to_string(FIXTURE_PATH).expect("read fixture");
        assert_eq!(
            from_json(&stored).expect("the fixture is loadable preferences"),
            preferences,
            "regenerate with REGENERATE_FIXTURES=1"
        );
    }

    #[test]
    fn saving_and_loading_round_trips_through_a_file() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("preferences.json");
        let preferences = Preferences {
            plot_font_family: FontFamily::Dejavu,
            plot_font_size: 11.5,
            ..Preferences::default()
        };
        save_to_path(&preferences, &path).expect("saves");
        assert_eq!(load_from_path(&path).expect("loads"), preferences);
        assert!(
            !directory.path().join("preferences.json.tmp").exists(),
            "the temporary file is renamed, not left behind"
        );
    }

    #[test]
    fn future_version_is_rejected() {
        let error = from_json(r#"{"schema_version":99}"#).unwrap_err();
        assert!(matches!(error, PreferencesError::UnsupportedVersion(99)));
    }

    #[test]
    fn truncated_preferences_fail_instead_of_partially_restoring() {
        let error = from_json("{\"schema_ver").unwrap_err();
        assert!(matches!(error, PreferencesError::Json(_)));
    }

    #[test]
    fn a_missing_preferences_file_reports_io() {
        let directory = tempfile::tempdir().expect("temp dir");
        assert!(matches!(
            load_from_path(&directory.path().join("absent.json")).expect_err("absent"),
            PreferencesError::Io(_)
        ));
    }
}

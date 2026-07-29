//! Versioned global preferences schema (ADR 0023): appearance settings that
//! persist across sessions, unlike the per-workspace session file.

mod generated;

pub use generated::*;

use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

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
    migrate(head.schema_version, &value)
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
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let (temporary, mut file) = create_temporary_sibling(path)?;
    if let Err(error) = file.write_all(json.as_bytes()) {
        drop(file);
        let _ = std::fs::remove_file(&temporary);
        return Err(error.into());
    }
    drop(file);
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

static NEXT_TEMPORARY_ID: AtomicU64 = AtomicU64::new(0);

fn create_temporary_sibling(path: &Path) -> Result<(PathBuf, File), std::io::Error> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "preferences path has no file name",
        )
    })?;
    loop {
        let id = NEXT_TEMPORARY_ID.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".{}.{}.{}.tmp",
            file_name.to_string_lossy(),
            std::process::id(),
            id
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
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
fn migrate(version: u32, value: &serde_json::Value) -> Result<Preferences, PreferencesError> {
    match version {
        PREFERENCES_SCHEMA_VERSION => Ok(repair_current(value)),
        version => Err(PreferencesError::UnsupportedVersion(version)),
    }
}

fn repair_current(value: &serde_json::Value) -> Preferences {
    let defaults = Preferences::default();
    let family = |name: &str, fallback| match value.get(name).and_then(serde_json::Value::as_str) {
        Some("inter") => FontFamily::Inter,
        Some("dejavu") => FontFamily::Dejavu,
        Some("arimo") => FontFamily::Arimo,
        Some("jetbrains") => FontFamily::Jetbrains,
        _ => fallback,
    };
    let size = |name: &str, fallback: f64, min: f64, max: f64, half_steps: bool| {
        let value = value
            .get(name)
            .and_then(serde_json::Value::as_f64)
            .filter(|candidate| candidate.is_finite())
            .unwrap_or(fallback)
            .clamp(min, max);
        if half_steps {
            (value * 2.0).round() / 2.0
        } else {
            value.round()
        }
    };
    Preferences {
        schema_version: PREFERENCES_SCHEMA_VERSION,
        ui_font_family: family("ui_font_family", defaults.ui_font_family),
        plot_font_family: family("plot_font_family", defaults.plot_font_family),
        ui_font_size: size("ui_font_size", defaults.ui_font_size, 10.0, 20.0, false),
        plot_font_size: size("plot_font_size", defaults.plot_font_size, 6.0, 16.0, true),
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
    fn overlapping_saves_do_not_collide() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("preferences.json");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let errors = std::sync::Mutex::new(Vec::new());

        std::thread::scope(|scope| {
            for index in 0..8 {
                let barrier = std::sync::Arc::clone(&barrier);
                let errors = &errors;
                let path = &path;
                scope.spawn(move || {
                    let preferences = Preferences {
                        plot_font_size: if index % 2 == 0 { 9.0 } else { 11.5 },
                        ..Preferences::default()
                    };
                    barrier.wait();
                    for _ in 0..250 {
                        if let Err(error) = save_to_path(&preferences, path) {
                            errors.lock().expect("locks errors").push(error);
                            break;
                        }
                    }
                });
            }
        });

        assert!(
            errors.into_inner().expect("unlocks errors").is_empty(),
            "overlapping saves must use distinct temporary files"
        );
        let saved = load_from_path(&path).expect("final preferences remain valid");
        assert!(matches!(saved.plot_font_size, 9.0 | 11.5));
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
    fn repairs_unknown_families_and_sizes_without_losing_valid_fields() {
        let preferences = from_json(
            r#"{
                "schema_version": 1,
                "ui_font_family": "unknown",
                "plot_font_family": "arimo",
                "ui_font_size": 99,
                "plot_font_size": 10.5
            }"#,
        )
        .expect("repairs hand-edited preferences");
        assert_eq!(preferences.ui_font_family, FontFamily::Inter);
        assert_eq!(preferences.plot_font_family, FontFamily::Arimo);
        assert!((preferences.ui_font_size - 20.0).abs() < f64::EPSILON);
        assert!((preferences.plot_font_size - 10.5).abs() < f64::EPSILON);
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

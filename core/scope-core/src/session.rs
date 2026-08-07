//! Versioned session schema and migration entry point.

mod generated;

pub use generated::*;

use std::path::Path;

use serde::Deserialize;
use thiserror::Error;

/// Id and title of the tab every session starts with; the v2 migration
/// wraps legacy single-workspace sessions in this same tab.
pub const DEFAULT_TAB_ID: &str = "workspace-1";
pub const DEFAULT_TAB_TITLE: &str = "Workspace 1";

impl Default for Session {
    fn default() -> Self {
        Self {
            app: "signalscope".into(),
            schema_version: SESSION_SCHEMA_VERSION,
            theme: Theme::Dark,
            linked_time: LinkedTime::default(),
            active_tab_id: DEFAULT_TAB_ID.into(),
            tabs: vec![WorkspaceTab {
                id: DEFAULT_TAB_ID.into(),
                title: DEFAULT_TAB_TITLE.into(),
                cursor_mode: CursorMode::None,
                focused_panel_id: None,
                maximized_panel_id: None,
                panels: Vec::new(),
                layout: Vec::new(),
            }],
            named_sets: Vec::new(),
            derived: Vec::new(),
            derived_bundles: Vec::new(),
            sources: Vec::new(),
        }
    }
}

impl Default for LinkedTime {
    fn default() -> Self {
        Self {
            t0: 0.0,
            t1: 1.0,
            linked: true,
            paused: false,
            cursor_t: None,
            mode: TimeMode::Fixed,
        }
    }
}

/// Deserializes and validates a `SignalScope` session.
///
/// # Errors
///
/// Returns [`SessionError`] when the JSON is malformed, belongs to another
/// application, or uses an unsupported schema version.
pub fn from_json(json: &str) -> Result<Session, SessionError> {
    #[derive(Deserialize)]
    struct Head {
        app: String,
        schema_version: u32,
    }

    let value: serde_json::Value = serde_json::from_str(json)?;
    let head: Head = Head::deserialize(&value)?;
    if head.app != "signalscope" {
        return Err(SessionError::WrongApplication(head.app));
    }
    migrate(head.schema_version, value)
}

/// Serializes `session` to `path` through a sibling temporary file that is
/// renamed into place, so an interrupted write never truncates the previous
/// session.
///
/// # Errors
///
/// Returns [`SessionError::Io`] when the write or rename fails and
/// [`SessionError::Json`] when serialization fails.
pub fn save_to_path(session: &Session, path: &Path) -> Result<(), SessionError> {
    let json = serde_json::to_string_pretty(session)?;
    let temporary = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&temporary, json)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Reads and migrates the session stored at `path`.
///
/// # Errors
///
/// Returns [`SessionError::Io`] when the file cannot be read and the variants
/// of [`from_json`] otherwise.
pub fn load_from_path(path: &Path) -> Result<Session, SessionError> {
    from_json(&std::fs::read_to_string(path)?)
}

/// Accepts only the current session schema. Breaking session changes are not migrated.
fn migrate(version: u32, value: serde_json::Value) -> Result<Session, SessionError> {
    if version != SESSION_SCHEMA_VERSION {
        return Err(SessionError::UnsupportedVersion(version));
    }
    Ok(serde_json::from_value(value)?)
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session belongs to another application: {0}")]
    WrongApplication(String),
    #[error("unsupported session schema version: {0}")]
    UnsupportedVersion(u32),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION_FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/session-conformance.json"
    );

    fn source(path: &str) -> SourceRecord {
        let key = crate::naming::legacy_source_key(path);
        SourceRecord {
            key: key.to_string(),
            path: path.into(),
            prefix: crate::naming::default_prefix(Path::new(path)),
            provider_id: None,
            decode_provenance: None,
            recipe_id: None,
            recipe_digest: None,
            reconcile_legacy: false,
        }
    }

    #[test]
    fn rejects_every_older_session_without_migration() {
        let mut value = serde_json::to_value(Session::default()).unwrap();
        value["schema_version"] = serde_json::json!(SESSION_SCHEMA_VERSION - 1);
        assert!(matches!(
            from_json(&value.to_string()),
            Err(SessionError::UnsupportedVersion(version))
                if version == SESSION_SCHEMA_VERSION - 1
        ));
    }

    #[test]
    fn rejects_unknown_session_versions() {
        let mut value = serde_json::to_value(Session::default()).unwrap();
        value["schema_version"] = serde_json::json!(99);
        assert!(matches!(
            from_json(&value.to_string()),
            Err(SessionError::UnsupportedVersion(99))
        ));
    }

    #[test]
    fn rejects_foreign_applications() {
        let mut value = serde_json::to_value(Session::default()).unwrap();
        value["app"] = serde_json::json!("other");
        assert!(matches!(
            from_json(&value.to_string()),
            Err(SessionError::WrongApplication(app)) if app == "other"
        ));
    }

    #[test]
    fn current_time_only_session_round_trips() {
        let session = Session::default();
        assert_eq!(
            from_json(&serde_json::to_string(&session).unwrap()).unwrap(),
            session
        );
    }

    #[test]
    fn saving_and_loading_round_trips_through_a_file() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("session.json");
        let session = Session {
            sources: vec![source("/data/run.csv")],
            ..Session::default()
        };

        save_to_path(&session, &path).expect("saves");
        let restored = load_from_path(&path).expect("loads");
        assert_eq!(restored, session);
        assert!(!directory.path().join("session.json.tmp").exists());
    }

    #[test]
    fn truncated_sessions_fail_instead_of_partially_restoring() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("session.json");
        std::fs::write(&path, "{\"app\":\"signalscope\",\"schema_ver").expect("writes");
        assert!(matches!(
            load_from_path(&path).expect_err("truncated"),
            SessionError::Json(_)
        ));
    }

    #[test]
    fn missing_session_files_report_io() {
        let directory = tempfile::tempdir().expect("temp dir");
        assert!(matches!(
            load_from_path(&directory.path().join("absent.json")).expect_err("absent"),
            SessionError::Io(_)
        ));
    }

    #[test]
    fn session_conformance_fixture_matches_rust() {
        let session = Session {
            derived: vec![DerivedSignal {
                path: "derived/speed".into(),
                expr: "hypot('imu/vx', 'imu/vy')".into(),
            }],
            sources: vec![source("/data/run.csv")],
            named_sets: vec![
                NamedSet {
                    id: "set-1".into(),
                    name: "imu/vx".into(),
                    kind: NamedSetKind::Pick,
                    selector: None,
                    refs: vec![SeriesRef {
                        source_key: source("/data/run.csv").key,
                        channel: "vx".into(),
                    }],
                },
                NamedSet {
                    id: "set-2".into(),
                    name: "imu/accel/x".into(),
                    kind: NamedSetKind::Query,
                    selector: Some("imu/accel/x".into()),
                    refs: Vec::new(),
                },
            ],
            ..Session::default()
        };
        let current = format!(
            "{}\n",
            serde_json::to_string_pretty(&session).expect("serializes")
        );
        if std::env::var("REGENERATE_FIXTURES").is_ok() {
            std::fs::write(SESSION_FIXTURE_PATH, &current).expect("write fixture");
            return;
        }
        let stored = std::fs::read_to_string(SESSION_FIXTURE_PATH).expect("read fixture");
        assert_eq!(
            from_json(&stored).expect("the fixture is a loadable session"),
            session,
            "regenerate with REGENERATE_FIXTURES=1"
        );
    }
}

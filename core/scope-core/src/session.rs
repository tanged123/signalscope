//! Versioned session schema and migration entry point.

mod generated;

pub use generated::*;

use std::path::Path;

use serde::Deserialize;
use thiserror::Error;

/// Id and title of the tab every new session starts with.
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
    if head.schema_version == SESSION_SCHEMA_VERSION {
        Ok(serde_json::from_value(value)?)
    } else {
        Err(SessionError::UnsupportedVersion(head.schema_version))
    }
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

/// Reads the session stored at `path`.
///
/// # Errors
///
/// Returns [`SessionError::Io`] when the file cannot be read and the variants
/// of [`from_json`] otherwise.
pub fn load_from_path(path: &Path) -> Result<Session, SessionError> {
    from_json(&std::fs::read_to_string(path)?)
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
        assert_eq!(restored.sources, session.sources);
        assert!(
            !directory.path().join("session.json.tmp").exists(),
            "the temporary file is renamed, not left behind"
        );
    }

    #[test]
    fn a_truncated_session_fails_instead_of_partially_restoring() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("session.json");
        std::fs::write(&path, "{\"app\":\"signalscope\",\"schema_ver").expect("writes");
        assert!(matches!(
            load_from_path(&path).expect_err("truncated"),
            SessionError::Json(_)
        ));
    }

    #[test]
    fn a_missing_session_file_reports_io() {
        let directory = tempfile::tempdir().expect("temp dir");
        assert!(matches!(
            load_from_path(&directory.path().join("absent.json")).expect_err("absent"),
            SessionError::Io(_)
        ));
    }

    #[test]
    fn current_session_round_trips() {
        let session = Session {
            tabs: vec![WorkspaceTab {
                id: "workspace-1".into(),
                title: "Flight review".into(),
                cursor_mode: CursorMode::None,
                focused_panel_id: Some("panel-a".into()),
                maximized_panel_id: None,
                panels: vec![PanelState {
                    id: "panel-a".into(),
                    title: "Body velocity".into(),
                    mode: PanelMode::Time,
                    axis_style: AxisStyle::Gutter,
                    bindings: vec![Binding {
                        kind: BindingKind::Pick,
                        selector: None,
                        refs: vec![SeriesRef {
                            source_key: "rocket".into(),
                            channel: "velocity_body/x".into(),
                        }],
                        set_id: None,
                    }],
                    color_by: StyleDimension::Source,
                    overrides: vec![SeriesOverride {
                        target_ref: Some(SeriesRef {
                            source_key: "rocket".into(),
                            channel: "velocity_body/x".into(),
                        }),
                        target_selector: None,
                        color_slot: Some(1),
                        dash: Some(DashStyle::Solid),
                        width: Some(1.5),
                        opacity: None,
                        visible: Some(true),
                    }],
                    focus: Vec::new(),
                    ghost_mode: GhostMode::All,
                    split_by: SplitDimension::None,
                    y_range: None,
                    x_range: None,
                    x_label: None,
                    y_label: None,
                    time_window: None,
                    annotations: Vec::new(),
                    show_stats: false,
                }],
                layout: vec![LayoutRow {
                    height: 1.0,
                    panels: vec![LayoutCell {
                        panel_id: "panel-a".into(),
                        width: 1.0,
                    }],
                }],
            }],
            ..Session::default()
        };

        let json = serde_json::to_string(&session).unwrap();
        assert_eq!(from_json(&json).unwrap(), session);
    }

    #[test]
    fn derived_definitions_survive_a_round_trip() {
        let session = Session {
            derived: vec![
                DerivedSignal {
                    path: "derived/speed".into(),
                    expr: "hypot('imu/vx', 'imu/vy')".into(),
                },
                DerivedSignal {
                    path: "derived/jerk".into(),
                    expr: "gradient('derived/speed')".into(),
                },
            ],
            sources: vec![source("/data/run.csv")],
            ..Session::default()
        };
        let restored =
            from_json(&serde_json::to_string(&session).expect("serializes")).expect("round trips");
        assert_eq!(restored.derived, session.derived);
        assert_eq!(restored.sources, session.sources);
    }

    #[test]
    fn future_version_is_rejected() {
        let error = from_json(r#"{"app":"signalscope","schema_version":99}"#).unwrap_err();
        assert!(matches!(error, SessionError::UnsupportedVersion(99)));
    }

    #[test]
    fn earlier_schema_versions_are_rejected() {
        for version in 1..SESSION_SCHEMA_VERSION {
            let value = serde_json::json!({
                "app": "signalscope",
                "schema_version": version,
            });
            assert!(matches!(
                from_json(&value.to_string()),
                Err(SessionError::UnsupportedVersion(_))
            ));
        }
    }
}

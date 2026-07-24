//! Versioned session schema and migration entry point.

mod generated;

pub use generated::*;

use serde::Deserialize;
use thiserror::Error;

impl Default for Session {
    fn default() -> Self {
        Self {
            app: "signalscope".into(),
            schema_version: SESSION_SCHEMA_VERSION,
            theme: Theme::Dark,
            linked_time: LinkedTime::default(),
            focused_panel_id: None,
            panels: Vec::new(),
            layout: Vec::new(),
            favorites: Vec::new(),
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

/// Migration ladder (ADR 0005): each arm upgrades `value` one schema
/// version and falls through to the next; the current version deserializes
/// directly. To add v(N+1): bump `schema_version` in
/// `protocol/schema/scope-session.json`, regenerate, then add an arm here
/// that rewrites a vN `value` into vN+1 shape and recurses.
fn migrate(version: u32, mut value: serde_json::Value) -> Result<Session, SessionError> {
    match version {
        1 => {
            let panel_ids: Vec<String> = value
                .get("panels")
                .and_then(serde_json::Value::as_array)
                .map(|panels| {
                    panels
                        .iter()
                        .filter_map(|panel| {
                            panel
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned)
                        })
                        .collect()
                })
                .unwrap_or_default();
            #[allow(clippy::cast_precision_loss)]
            let width = 1.0 / panel_ids.len().max(1) as f64;
            let layout = if panel_ids.is_empty() {
                serde_json::json!([])
            } else {
                let cells: Vec<serde_json::Value> = panel_ids
                    .iter()
                    .map(|id| serde_json::json!({ "panel_id": id, "width": width }))
                    .collect();
                serde_json::json!([{ "height": 1.0, "panels": cells }])
            };
            value["layout"] = layout;
            value["favorites"] = serde_json::json!([]);
            value["schema_version"] = serde_json::json!(2);
            migrate(2, value)
        }
        SESSION_SCHEMA_VERSION => Ok(serde_json::from_value(value)?),
        version => Err(SessionError::UnsupportedVersion(version)),
    }
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session belongs to another application: {0}")]
    WrongApplication(String),
    #[error("unsupported session schema version: {0}")]
    UnsupportedVersion(u32),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_session_round_trips() {
        let session = Session {
            focused_panel_id: Some("panel-a".into()),
            panels: vec![PanelState {
                id: "panel-a".into(),
                title: "Body velocity".into(),
                mode: PanelMode::Time,
                axis_style: AxisStyle::Gutter,
                x_signal: None,
                color_signal: None,
                series: vec![SeriesState {
                    path: "rocket/velocity_body/x".into(),
                    color_slot: 1,
                    dash: DashStyle::Solid,
                    width: 1.5,
                    visible: true,
                }],
                y_range: None,
                annotations: Vec::new(),
                show_stats: false,
            }],
            ..Session::default()
        };

        let json = serde_json::to_string(&session).unwrap();
        assert_eq!(from_json(&json).unwrap(), session);
    }

    #[test]
    fn future_version_is_rejected() {
        let error = from_json(r#"{"app":"signalscope","schema_version":99}"#).unwrap_err();
        assert!(matches!(error, SessionError::UnsupportedVersion(99)));
    }

    #[test]
    fn v1_sessions_migrate_to_v2() {
        let json = r#"{
            "app": "signalscope",
            "schema_version": 1,
            "theme": "dark",
            "linked_time": {"t0":0.0,"t1":1.0,"linked":true,"paused":false,"cursorT":null,"mode":"fixed"},
            "focused_panel_id": "panel-a",
            "panels": [{"id":"panel-a","title":"A","mode":"time","axis_style":"gutter","x_signal":null,"color_signal":null,"series":[],"y_range":null,"annotations":[],"show_stats":false}]
        }"#;
        let session = from_json(json).unwrap();
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        assert_eq!(session.layout.len(), 1);
        assert_eq!(session.layout[0].panels[0].panel_id, "panel-a");
        assert!((session.layout[0].panels[0].width - 1.0).abs() < f64::EPSILON);
        assert!(session.favorites.is_empty());
    }

    #[test]
    fn migrate_is_the_single_dispatch_point() {
        let json = serde_json::to_string(&Session::default()).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let session = migrate(SESSION_SCHEMA_VERSION, value).unwrap();
        assert_eq!(session, Session::default());
    }
}

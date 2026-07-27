//! Versioned session schema and migration entry point.

mod generated;

pub use generated::*;

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
            favorites: Vec::new(),
            derived: Vec::new(),
            source_paths: Vec::new(),
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
/// that rewrites a vN `value` into vN+1 shape and recurses. Additive optional
/// fields need no rung; only new required fields do.
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
        2 => {
            let object = value.as_object_mut().ok_or_else(|| {
                serde_json::Error::io(std::io::Error::other("session is not an object"))
            })?;
            let focused_panel_id = object
                .remove("focused_panel_id")
                .unwrap_or(serde_json::Value::Null);
            let panels = object
                .remove("panels")
                .unwrap_or_else(|| serde_json::json!([]));
            let layout = object
                .remove("layout")
                .unwrap_or_else(|| serde_json::json!([]));
            object.insert("active_tab_id".into(), serde_json::json!(DEFAULT_TAB_ID));
            object.insert(
                "tabs".into(),
                serde_json::json!([{
                    "id": DEFAULT_TAB_ID,
                    "title": DEFAULT_TAB_TITLE,
                    "focused_panel_id": focused_panel_id,
                    "panels": panels,
                    "layout": layout
                }]),
            );
            object.insert("schema_version".into(), serde_json::json!(3));
            migrate(3, value)
        }
        3 | 4 | 7 => {
            // Purely additive optional panel fields; #[serde(default)] restores
            // absent fields, so no rewrite is needed.
            let next = version + 1;
            value["schema_version"] = serde_json::json!(next);
            migrate(next, value)
        }
        5 => {
            migrate_v5_annotations(&mut value);
            value["schema_version"] = serde_json::json!(6);
            migrate(6, value)
        }
        6 => {
            default_tab_cursor_modes(&mut value);
            value["schema_version"] = serde_json::json!(7);
            migrate(7, value)
        }
        8 => {
            for_each_panel(&mut value, |panel| {
                let by_time = panel
                    .get("color_signal")
                    .and_then(serde_json::Value::as_str)
                    == Some("time");
                if by_time {
                    panel.insert("color_signal".into(), serde_json::Value::Null);
                }
                panel.insert("color_by_time".into(), serde_json::json!(by_time));
            });
            value["schema_version"] = serde_json::json!(9);
            migrate(9, value)
        }
        9 => {
            value["derived"] = serde_json::json!([]);
            value["source_paths"] = serde_json::json!([]);
            value["schema_version"] = serde_json::json!(10);
            migrate(10, value)
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

/// Runs `visit` over every panel object across every tab.
///
/// Most migrations only widen panels, so the traversal lives here once rather
/// than being re-inlined by each new arm.
fn for_each_panel(
    value: &mut serde_json::Value,
    mut visit: impl FnMut(&mut serde_json::Map<String, serde_json::Value>),
) {
    let Some(tabs) = value
        .get_mut("tabs")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for tab in tabs {
        let panels = tab
            .get_mut("panels")
            .and_then(serde_json::Value::as_array_mut);
        for panel in panels.into_iter().flatten() {
            if let Some(object) = panel.as_object_mut() {
                visit(object);
            }
        }
    }
}

/// Defaults the v7 workspace cursor state without disturbing authored fields.
fn default_tab_cursor_modes(value: &mut serde_json::Value) {
    let Some(tabs) = value
        .get_mut("tabs")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for tab in tabs {
        if let Some(object) = tab.as_object_mut() {
            object
                .entry("cursor_mode")
                .or_insert_with(|| serde_json::json!("none"));
        }
    }
}

/// Rewrites the v5 time/value annotation pair into the domain-tagged anchor.
fn migrate_v5_annotations(value: &mut serde_json::Value) {
    for_each_panel(value, |panel| {
        let Some(annotations) = panel
            .get_mut("annotations")
            .and_then(serde_json::Value::as_array_mut)
        else {
            return;
        };
        for annotation in annotations {
            let Some(object) = annotation.as_object_mut() else {
                continue;
            };
            let anchor = object
                .remove("time")
                .unwrap_or_else(|| serde_json::json!(0.0));
            let pinned_value = object
                .remove("value")
                .unwrap_or_else(|| serde_json::json!(0.0));
            object.insert("domain".into(), serde_json::json!("time"));
            object.insert("anchor".into(), anchor);
            object.insert("pinned_value".into(), pinned_value);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
                    x_signal: None,
                    color_signal: None,
                    color_by_time: false,
                    series: vec![SeriesState {
                        path: "rocket/velocity_body/x".into(),
                        color_slot: 1,
                        dash: DashStyle::Solid,
                        width: 1.5,
                        visible: true,
                    }],
                    y_range: None,
                    x_range: None,
                    x_label: None,
                    y_label: None,
                    c_label: None,
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
    fn v9_sessions_gain_empty_derived_and_source_lists() {
        let json = serde_json::json!({
            "app": "signalscope",
            "schema_version": 9,
            "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 60.0, "linked": true,
                            "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1",
            "favorites": [],
            "tabs": [{
                "id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
                "focused_panel_id": null, "maximized_panel_id": null,
                "layout": [], "panels": []
            }]
        })
        .to_string();
        let session = from_json(&json).expect("v9 session migrates");
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        assert!(session.derived.is_empty());
        assert!(session.source_paths.is_empty());
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
            source_paths: vec!["/data/run.csv".into()],
            ..Session::default()
        };
        let restored =
            from_json(&serde_json::to_string(&session).expect("serializes")).expect("round trips");
        assert_eq!(restored.derived, session.derived);
        assert_eq!(restored.source_paths, session.source_paths);
    }

    #[test]
    fn future_version_is_rejected() {
        let error = from_json(r#"{"app":"signalscope","schema_version":99}"#).unwrap_err();
        assert!(matches!(error, SessionError::UnsupportedVersion(99)));
    }

    #[test]
    fn v1_sessions_migrate_to_current() {
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
        assert_eq!(session.tabs.len(), 1);
        assert_eq!(session.tabs[0].layout.len(), 1);
        assert_eq!(session.tabs[0].layout[0].panels[0].panel_id, "panel-a");
        assert!((session.tabs[0].layout[0].panels[0].width - 1.0).abs() < f64::EPSILON);
        assert!(session.favorites.is_empty());
    }

    #[test]
    fn v2_sessions_migrate_panels_into_the_first_workspace_tab() {
        let json = r#"{
            "app": "signalscope",
            "schema_version": 2,
            "theme": "dark",
            "linked_time": {"t0":0.0,"t1":1.0,"linked":true,"paused":false,"cursorT":null,"mode":"fixed"},
            "focused_panel_id": "panel-a",
            "panels": [{"id":"panel-a","title":"A","mode":"time","axis_style":"gutter","x_signal":null,"color_signal":null,"series":[],"y_range":null,"annotations":[],"show_stats":false}],
            "layout": [{"height":1.0,"panels":[{"panel_id":"panel-a","width":1.0}]}],
            "favorites": ["rocket/velocity"]
        }"#;
        let session = from_json(json).unwrap();
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        assert_eq!(session.active_tab_id, "workspace-1");
        assert_eq!(session.tabs[0].focused_panel_id.as_deref(), Some("panel-a"));
        assert_eq!(session.tabs[0].panels[0].id, "panel-a");
        assert_eq!(session.tabs[0].layout[0].panels[0].panel_id, "panel-a");
        assert_eq!(session.favorites, ["rocket/velocity"]);
    }

    #[test]
    fn v3_sessions_gain_axis_labels_and_local_windows() {
        let json = r#"{
            "app": "signalscope",
            "schema_version": 3,
            "theme": "dark",
            "linked_time": {"t0":0.0,"t1":1.0,"linked":true,"paused":false,"cursorT":null,"mode":"fixed"},
            "active_tab_id": "workspace-1",
            "tabs": [{"id":"workspace-1","title":"Workspace 1","focused_panel_id":null,
                "panels":[{"id":"panel-a","title":"A","mode":"time","axis_style":"gutter","x_signal":null,"color_signal":null,"series":[],"y_range":null,"annotations":[],"show_stats":false}],
                "layout":[{"height":1.0,"panels":[{"panel_id":"panel-a","width":1.0}]}]}],
            "favorites": []
        }"#;
        let session = from_json(json).unwrap();
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        let panel = &session.tabs[0].panels[0];
        assert_eq!(panel.x_label, None);
        assert_eq!(panel.y_label, None);
        assert_eq!(panel.time_window, None);
    }

    #[test]
    fn v4_sessions_gain_panel_x_ranges() {
        let json = serde_json::json!({
            "app": "signalscope",
            "schema_version": 4,
            "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 60.0, "linked": true,
                            "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1",
            "favorites": [],
            "tabs": [{
                "id": "workspace-1",
                "title": "Workspace 1",
                "focused_panel_id": "panel-1",
                "layout": [{"height": 1.0, "panels": [{"panel_id": "panel-1", "width": 1.0}]}],
                "panels": [{
                    "id": "panel-1", "title": "Panel 1", "mode": "time",
                    "axis_style": "gutter", "x_signal": null, "color_signal": null,
                    "series": [], "y_range": null, "x_label": null, "y_label": null,
                    "time_window": null, "annotations": [], "show_stats": false
                }]
            }]
        })
        .to_string();
        let session = from_json(&json).expect("v4 session migrates");
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        assert_eq!(session.tabs[0].panels[0].x_range, None);
    }

    #[test]
    fn v5_annotations_gain_explicit_time_domains() {
        let json = serde_json::json!({
            "app": "signalscope",
            "schema_version": 5,
            "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 60.0, "linked": true,
                            "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1",
            "favorites": [],
            "tabs": [{
                "id": "workspace-1",
                "title": "Workspace 1",
                "focused_panel_id": "panel-1",
                "layout": [{"height": 1.0, "panels": [{"panel_id": "panel-1", "width": 1.0}]}],
                "panels": [{
                    "id": "panel-1", "title": "Panel 1", "mode": "time",
                    "axis_style": "gutter", "x_signal": null, "color_signal": null,
                    "series": [], "y_range": null, "x_range": null,
                    "x_label": null, "y_label": null, "time_window": null,
                    "annotations": [{
                        "id": "ann-1", "series_path": "demo/altitude",
                        "time": 12.5, "value": 42.0, "label": "peak"
                    }],
                    "show_stats": false
                }]
            }]
        })
        .to_string();
        let session = from_json(&json).expect("v5 session migrates");
        let annotation = &session.tabs[0].panels[0].annotations[0];
        assert_eq!(annotation.domain, AnnotationDomain::Time);
        assert!((annotation.anchor - 12.5).abs() < f64::EPSILON);
        assert!((annotation.pinned_value - 42.0).abs() < f64::EPSILON);
        assert_eq!(annotation.label, "peak");
    }

    #[test]
    fn v6_workspaces_gain_a_default_cursor_mode() {
        let json = serde_json::json!({
            "app": "signalscope",
            "schema_version": 6,
            "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 60.0, "linked": true,
                            "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1",
            "favorites": [],
            "tabs": [{
                "id": "workspace-1",
                "title": "Workspace 1",
                "focused_panel_id": null,
                "layout": [],
                "panels": []
            }]
        })
        .to_string();
        let session = from_json(&json).expect("v6 session migrates");
        assert_eq!(session.tabs[0].cursor_mode, CursorMode::None);
    }

    #[test]
    fn v7_panels_gain_a_default_color_axis_label() {
        let json = serde_json::json!({
            "app": "signalscope",
            "schema_version": 7,
            "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 60.0, "linked": true,
                            "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1",
            "favorites": [],
            "tabs": [{
                "id": "workspace-1",
                "title": "Workspace 1",
                "cursor_mode": "none",
                "focused_panel_id": "panel-1",
                "layout": [{"height": 1.0, "panels": [{"panel_id": "panel-1", "width": 1.0}]}],
                "panels": [{
                    "id": "panel-1", "title": "Panel 1", "mode": "xy",
                    "axis_style": "gutter", "x_signal": "demo/x", "color_signal": "time",
                    "series": [], "y_range": null, "x_range": null,
                    "x_label": null, "y_label": null, "time_window": null,
                    "annotations": [], "show_stats": false
                }]
            }]
        })
        .to_string();
        let session = from_json(&json).expect("v7 session migrates");
        assert_eq!(session.tabs[0].panels[0].c_label, None);
    }

    #[test]
    fn v8_time_colour_sentinel_becomes_a_flag() {
        let json = serde_json::json!({
            "app": "signalscope",
            "schema_version": 8,
            "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 60.0, "linked": true,
                            "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1",
            "favorites": [],
            "tabs": [{
                "id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
                "focused_panel_id": null,
                "layout": [{"height": 1.0, "panels": [{"panel_id": "panel-1", "width": 1.0}]}],
                "panels": [{
                    "id": "panel-1", "title": "Panel 1", "mode": "xy",
                    "axis_style": "gutter", "x_signal": "demo/x", "color_signal": "time",
                    "series": [], "y_range": null, "x_range": null,
                    "x_label": null, "y_label": null, "c_label": null,
                    "time_window": null, "annotations": [], "show_stats": false
                }]
            }]
        })
        .to_string();
        let session = from_json(&json).expect("v8 session migrates");
        let panel = &session.tabs[0].panels[0];
        assert!(panel.color_by_time);
        assert_eq!(panel.color_signal, None);
        assert_eq!(session.tabs[0].maximized_panel_id, None);
    }

    #[test]
    fn migrate_is_the_single_dispatch_point() {
        let json = serde_json::to_string(&Session::default()).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let session = migrate(SESSION_SCHEMA_VERSION, value).unwrap();
        assert_eq!(session, Session::default());
    }
}

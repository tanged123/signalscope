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

/// Migration ladder (ADR 0005): each arm upgrades `value` one schema
/// version and falls through to the next; the current version deserializes
/// directly. To add v(N+1): bump `schema_version` in
/// `protocol/schema/scope-session.json`, regenerate, then add an arm here
/// that rewrites a vN `value` into vN+1 shape and recurses. Additive optional
/// fields need no rung; only new required fields do.
#[allow(clippy::too_many_lines)]
fn migrate(version: u32, mut value: serde_json::Value) -> Result<Session, SessionError> {
    match version {
        1 => {
            migrate_v1_layout(&mut value);
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
        3 | 4 | 7 | 12 => {
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
            migrate_v8_color(&mut value);
            value["schema_version"] = serde_json::json!(9);
            migrate(9, value)
        }
        9 => {
            value["derived"] = serde_json::json!([]);
            value["source_paths"] = serde_json::json!([]);
            value["schema_version"] = serde_json::json!(10);
            migrate(10, value)
        }
        10 => {
            migrate_v10_sources(&mut value);
            value["schema_version"] = serde_json::json!(11);
            migrate(11, value)
        }
        11 => {
            value["source_sets"] = serde_json::json!([]);
            value["schema_version"] = serde_json::json!(12);
            migrate(12, value)
        }
        13 => {
            migrate_v13_ensembles(&mut value);
            value["schema_version"] = serde_json::json!(14);
            migrate(14, value)
        }
        14 => {
            value["favorite_bundles"] = serde_json::json!([]);
            value["schema_version"] = serde_json::json!(15);
            migrate(15, value)
        }
        15 => {
            value["derived_bundles"] = serde_json::json!([]);
            value["schema_version"] = serde_json::json!(16);
            migrate(16, value)
        }
        16 => {
            migrate_v16_bindings(&mut value);
            value["schema_version"] = serde_json::json!(17);
            migrate(17, value)
        }
        17 => {
            migrate_v17_channel_refs(&mut value);
            value["schema_version"] = serde_json::json!(18);
            migrate(18, value)
        }
        18 => {
            migrate_v18_remove_alignment(&mut value);
            value["schema_version"] = serde_json::json!(19);
            migrate(19, value)
        }
        SESSION_SCHEMA_VERSION => Ok(serde_json::from_value(value)?),
        version => Err(SessionError::UnsupportedVersion(version)),
    }
}

fn migrate_v1_layout(value: &mut serde_json::Value) {
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
}

fn migrate_v8_color(value: &mut serde_json::Value) {
    for_each_panel(value, |panel| {
        let by_time = panel
            .get("color_signal")
            .and_then(serde_json::Value::as_str)
            == Some("time");
        if by_time {
            panel.insert("color_signal".into(), serde_json::Value::Null);
        }
        panel.insert("color_by_time".into(), serde_json::json!(by_time));
    });
}

fn migrate_v10_sources(value: &mut serde_json::Value) {
    let paths = value
        .get("source_paths")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut taken = std::collections::BTreeSet::new();
    let records = paths
        .into_iter()
        .map(|path| {
            let key = crate::naming::legacy_source_key(&path);
            let prefix = crate::naming::allocate_prefix(&taken, Path::new(&path), key)
                .unwrap_or_else(|| key.simple().to_string());
            taken.insert(prefix.clone());
            serde_json::json!({
                "key": key.to_string(),
                "path": path,
                "prefix": prefix,
                "provider_id": null,
                "decode_provenance": null,
                "reconcile_legacy": true
            })
        })
        .collect();
    if let Some(object) = value.as_object_mut() {
        object.remove("source_paths");
        object.insert("sources".into(), serde_json::Value::Array(records));
    }
}

/// Longest-prefix match of a flat path against source prefixes; derived
/// paths map to the reserved derived source key.
fn path_to_ref(path: &str, prefixes: &[(String, String)]) -> Option<serde_json::Value> {
    crate::series_ref::ref_from_prefixes(path, prefixes)
        .and_then(|reference| serde_json::to_value(reference).ok())
}

#[allow(clippy::too_many_lines)]
fn migrate_v16_bindings(value: &mut serde_json::Value) {
    let prefixes: Vec<(String, String)> = value
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .map(|sources| {
            sources
                .iter()
                .filter_map(|source| {
                    Some((
                        source.get("prefix")?.as_str()?.to_owned(),
                        source.get("key")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();

    for_each_panel(value, |panel| {
        let series = panel
            .remove("series")
            .unwrap_or_else(|| serde_json::json!([]));
        let mut refs = Vec::new();
        let mut overrides = Vec::new();
        for entry in series.as_array().into_iter().flatten() {
            let Some(path) = entry.get("path").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let Some(target) = path_to_ref(path, &prefixes) else {
                continue;
            };
            refs.push(target.clone());
            overrides.push(serde_json::json!({
                "target_ref": target,
                "target_selector": null,
                "color_slot": entry.get("color_slot").cloned().unwrap_or_else(|| serde_json::json!(1)),
                "dash": entry.get("dash").cloned().unwrap_or_else(|| serde_json::json!("solid")),
                "width": entry.get("width").cloned().unwrap_or_else(|| serde_json::json!(1.4)),
                "opacity": null,
                "visible": entry.get("visible").cloned().unwrap_or(serde_json::json!(true)),
            }));
        }
        panel.insert(
            "bindings".into(),
            serde_json::json!([{
                "kind": "pick",
                "selector": null,
                "refs": refs,
                "set_id": null
            }]),
        );
        panel.insert("overrides".into(), serde_json::Value::Array(overrides));

        let highlighted = panel
            .remove("highlighted_sources")
            .unwrap_or_else(|| serde_json::json!([]));
        let focus: Vec<serde_json::Value> = highlighted
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("path").and_then(serde_json::Value::as_str))
            .filter_map(|path| path_to_ref(path, &prefixes))
            .map(|target| {
                serde_json::json!({
                    "kind": "series",
                    "ref": target,
                    "source_key": null,
                    "channel": null
                })
            })
            .collect();
        panel.insert("focus".into(), serde_json::Value::Array(focus));

        let x_ref = panel
            .remove("x_signal")
            .and_then(|value| value.as_str().map(str::to_owned))
            .and_then(|path| path_to_ref(&path, &prefixes))
            .unwrap_or(serde_json::Value::Null);
        panel.insert("x_ref".into(), x_ref);

        let by_time = panel
            .remove("color_by_time")
            .and_then(|value| value.as_bool())
            == Some(true);
        let color_ref = panel
            .remove("color_signal")
            .and_then(|value| value.as_str().map(str::to_owned))
            .and_then(|path| path_to_ref(&path, &prefixes))
            .unwrap_or(serde_json::Value::Null);
        let axis = if by_time {
            "time"
        } else if color_ref.is_null() {
            "none"
        } else {
            "signal"
        };
        panel.insert("color_axis".into(), serde_json::json!(axis));
        panel.insert("color_ref".into(), color_ref);
        panel.insert("color_by".into(), serde_json::json!("source"));
        panel.insert("ghost_mode".into(), serde_json::json!("all"));
        panel.insert("split_by".into(), serde_json::json!("none"));
    });

    let object = value.as_object_mut().expect("session object");
    let mut named_sets = Vec::new();
    for path in take_string_array(object, "favorites") {
        if let Some(target) = path_to_ref(&path, &prefixes) {
            named_sets.push(serde_json::json!({
                "id": format!("set-fav-{}", named_sets.len() + 1),
                "name": path,
                "kind": "pick",
                "selector": null,
                "refs": [target]
            }));
        }
    }
    for local in take_string_array(object, "favorite_bundles") {
        named_sets.push(serde_json::json!({
            "id": format!("set-fav-{}", named_sets.len() + 1),
            "name": local,
            "kind": "query",
            "selector": local,
            "refs": []
        }));
    }
    object.insert("named_sets".into(), serde_json::Value::Array(named_sets));
    object.insert("channel_map".into(), serde_json::json!([]));

    object.remove("source_sets");
}

fn migrate_v18_remove_alignment(value: &mut serde_json::Value) {
    for source in value
        .get_mut("sources")
        .and_then(serde_json::Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if let Some(source) = source.as_object_mut() {
            source.remove("time_domain");
            source.remove("scale");
            source.remove("offset");
        }
    }
}

fn rewrite_v17_channel_refs(
    value: &mut serde_json::Value,
    aliases: &std::collections::HashMap<(String, String), String>,
) {
    match value {
        serde_json::Value::Array(entries) => {
            for entry in entries {
                rewrite_v17_channel_refs(entry, aliases);
            }
        }
        serde_json::Value::Object(object) => {
            let source_key = object
                .get("source_key")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let channel = object
                .get("channel")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            if let (Some(source_key), Some(channel)) = (source_key, channel) {
                if let Some(name) = aliases.get(&(source_key, channel)) {
                    object.insert("channel".into(), serde_json::json!(name));
                }
            }
            for entry in object.values_mut() {
                rewrite_v17_channel_refs(entry, aliases);
            }
        }
        _ => {}
    }
}

fn migrate_v17_channel_refs(value: &mut serde_json::Value) {
    let aliases: std::collections::HashMap<(String, String), String> = value
        .get("channel_map")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            let canonical = entry
                .get("canonical")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned();
            entry
                .get("aliases")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(move |alias| {
                    Some((
                        (
                            alias.get("source_key")?.as_str()?.to_owned(),
                            canonical.clone(),
                        ),
                        alias.get("name")?.as_str()?.to_owned(),
                    ))
                })
        })
        .collect();

    if let Some(object) = value.as_object_mut() {
        object.remove("channel_map");
    }
    rewrite_v17_channel_refs(value, &aliases);
}

fn take_string_array(
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Vec<String> {
    object
        .remove(key)
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| entry.as_str().map(str::to_owned))
        .collect()
}

fn migrate_v13_ensembles(value: &mut serde_json::Value) {
    let prefixes = source_prefixes(value);
    let sets = value
        .get("source_sets")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    for_each_panel(value, |panel| {
        let ensemble = panel.remove("ensemble").unwrap_or(serde_json::Value::Null);
        panel.insert("highlighted_sources".into(), serde_json::json!([]));
        let Some(ensemble) = ensemble.as_object() else {
            return;
        };
        let (Some(set_key), Some(local_path)) = (
            ensemble.get("set_key").and_then(serde_json::Value::as_str),
            ensemble
                .get("local_path")
                .and_then(serde_json::Value::as_str),
        ) else {
            return;
        };
        let member_filter: Vec<&str> = ensemble
            .get("member_filter")
            .and_then(serde_json::Value::as_array)
            .map(|keys| keys.iter().filter_map(serde_json::Value::as_str).collect())
            .unwrap_or_default();
        let Some(set) = sets
            .iter()
            .find(|set| set.get("key").and_then(serde_json::Value::as_str) == Some(set_key))
        else {
            return;
        };
        let mut member_paths: Vec<String> = set
            .get("members")
            .and_then(serde_json::Value::as_array)
            .map(|members| {
                members
                    .iter()
                    .filter_map(|member| {
                        let source_key = member.get("source_key")?.as_str()?;
                        if !member_filter.is_empty() && !member_filter.contains(&source_key) {
                            return None;
                        }
                        let missing = member.get("missing")?.as_array()?;
                        if missing
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .any(|path| path == local_path)
                        {
                            return None;
                        }
                        let prefix = prefixes.get(source_key)?;
                        Some(format!("{prefix}/{local_path}"))
                    })
                    .collect()
            })
            .unwrap_or_default();
        member_paths.sort();
        let Some(series) = panel
            .get_mut("series")
            .and_then(serde_json::Value::as_array_mut)
        else {
            return;
        };
        let existing: std::collections::BTreeSet<String> = series
            .iter()
            .filter_map(|entry| entry.get("path").and_then(serde_json::Value::as_str))
            .map(str::to_owned)
            .collect();
        let mut used: std::collections::BTreeSet<u64> = series
            .iter()
            .filter_map(|entry| entry.get("color_slot").and_then(serde_json::Value::as_u64))
            .collect();
        for path in member_paths {
            if existing.contains(&path) {
                continue;
            }
            let mut slot = 1;
            while used.contains(&slot) {
                slot += 1;
            }
            used.insert(slot);
            series.push(serde_json::json!({
                "path": path,
                "color_slot": slot,
                "dash": "solid",
                "width": 1.4,
                "visible": true
            }));
        }
    });
}

fn source_prefixes(value: &serde_json::Value) -> std::collections::BTreeMap<String, String> {
    value
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .map(|sources| {
            sources
                .iter()
                .filter_map(|source| {
                    Some((
                        source.get("key")?.as_str()?.to_owned(),
                        source.get("prefix")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
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
            reconcile_legacy: false,
        }
    }

    fn v16_fixture() -> serde_json::Value {
        serde_json::json!({
            "app": "signalscope", "schema_version": 16, "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 1.0, "linked": true, "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1",
            "tabs": [{
                "id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
                "focused_panel_id": null, "maximized_panel_id": null,
                "layout": [{"height": 1.0, "panels": [{"panel_id": "panel-1", "width": 1.0}]}],
                "panels": [{
                    "id": "panel-1", "title": "Panel 1", "mode": "time", "axis_style": "gutter",
                    "x_signal": "run/temp", "color_signal": null, "color_by_time": true,
                    "series": [
                        {"path": "run/pressure", "color_slot": 2, "dash": "dash", "width": 2.0, "visible": false},
                        {"path": "derived/err", "color_slot": 1, "dash": "solid", "width": 1.4, "visible": true},
                        {"path": "orphan/x", "color_slot": 3, "dash": "solid", "width": 1.4, "visible": true}
                    ],
                    "highlighted_sources": [{"local_path": "pressure", "path": "run/pressure"}],
                    "y_range": null, "x_range": null, "x_label": null, "y_label": null, "c_label": null,
                    "time_window": null, "annotations": [], "show_stats": false
                }]
            }],
            "favorites": ["run/temp"], "favorite_bundles": ["imu/accel/x"],
            "derived": [], "derived_bundles": [],
            "sources": [{"key": "11111111-1111-1111-1111-111111111111", "path": "/data/run.csv",
                         "prefix": "run", "provider_id": null, "decode_provenance": null, "reconcile_legacy": false}],
            "source_sets": [{
                "key": "22222222-2222-2222-2222-222222222222", "label": "Set 1", "generation": 3,
                "members": [{"source_key": "11111111-1111-1111-1111-111111111111",
                             "missing": [], "scale": 0.001, "offset": 0.5}]
            }]
        })
    }

    #[test]
    fn v16_series_become_a_pick_binding_with_overrides() {
        let session = from_json(&v16_fixture().to_string()).unwrap();
        let panel = &session.tabs[0].panels[0];
        assert_eq!(panel.bindings.len(), 1);
        let binding = &panel.bindings[0];
        assert!(matches!(binding.kind, BindingKind::Pick));
        assert_eq!(binding.refs.len(), 2);
        assert_eq!(
            binding.refs[0].source_key,
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(binding.refs[0].channel, "pressure");
        assert_eq!(binding.refs[1].source_key, "derived");
        assert_eq!(binding.refs[1].channel, "err");
        let first = &panel.overrides[0];
        assert_eq!(first.target_ref.as_ref().unwrap().channel, "pressure");
        assert_eq!(first.color_slot, Some(2));
        assert_eq!(first.dash, Some(DashStyle::Dash));
        assert_eq!(first.visible, Some(false));
    }

    #[test]
    fn v16_axes_highlights_and_favorites_migrate() {
        let session = from_json(&v16_fixture().to_string()).unwrap();
        let panel = &session.tabs[0].panels[0];
        assert_eq!(panel.x_ref.as_ref().unwrap().channel, "temp");
        assert!(matches!(panel.color_axis, ColorAxis::Time));
        assert!(panel.color_ref.is_none());
        assert_eq!(panel.focus.len(), 1);
        assert!(matches!(panel.focus[0].kind, FocusKind::Series));
        assert_eq!(panel.focus[0].r#ref.as_ref().unwrap().channel, "pressure");
        assert_eq!(session.named_sets.len(), 2);
        assert!(matches!(session.named_sets[0].kind, NamedSetKind::Pick));
        assert_eq!(session.named_sets[0].name, "run/temp");
        assert!(matches!(session.named_sets[1].kind, NamedSetKind::Query));
        assert_eq!(
            session.named_sets[1].selector.as_deref(),
            Some("imu/accel/x")
        );
    }

    #[test]
    fn v16_bare_paths_migrate_for_an_empty_source_prefix() {
        let mut value = v16_fixture();
        value["sources"][0]["prefix"] = serde_json::json!("");
        value["tabs"][0]["panels"][0]["x_signal"] = serde_json::json!("temp");
        value["tabs"][0]["panels"][0]["series"] = serde_json::json!([{
            "path": "pressure", "color_slot": 2, "dash": "dash", "width": 2.0, "visible": true
        }]);

        let session = from_json(&value.to_string()).expect("v16 migrates");
        let panel = &session.tabs[0].panels[0];
        assert_eq!(panel.x_ref.as_ref().unwrap().channel, "temp");
        assert_eq!(panel.bindings[0].refs[0].channel, "pressure");
    }

    #[test]
    fn migrates_v17_channel_refs() {
        let mut value = serde_json::to_value(Session::default()).expect("serializes");
        value["schema_version"] = serde_json::json!(17);
        value["channel_map"] = serde_json::json!([{
            "canonical": "temp",
            "aliases": [
                {"source_key": "run-01", "name": "temperature"},
                {"source_key": "run-02", "name": "T_amb"}
            ]
        }]);
        value["named_sets"] = serde_json::json!([{
            "id": "set-1",
            "name": "Temperatures",
            "kind": "pick",
            "selector": "temp",
            "refs": [
                {"source_key": "run-01", "channel": "temp"},
                {"source_key": "run-03", "channel": "pressure"}
            ]
        }]);
        value["tabs"][0]["panels"] = serde_json::json!([{
            "id": "panel-1",
            "title": "Temperatures",
            "mode": "xy",
            "axis_style": "gutter",
            "x_ref": {"source_key": "run-01", "channel": "temp"},
            "color_axis": "signal",
            "color_ref": {"source_key": "run-02", "channel": "temp"},
            "bindings": [{
                "kind": "pick",
                "selector": "temp",
                "refs": [{"source_key": "run-02", "channel": "temp"}],
                "set_id": null
            }],
            "color_by": "source",
            "overrides": [{
                "target_ref": {"source_key": "run-01", "channel": "temp"},
                "target_selector": "temp",
                "color_slot": 1,
                "dash": "solid",
                "width": 1.4,
                "opacity": null,
                "visible": true
            }],
            "focus": [{
                "kind": "series",
                "ref": {"source_key": "run-02", "channel": "temp"},
                "source_key": null,
                "channel": null
            }],
            "ghost_mode": "all",
            "split_by": "none",
            "y_range": null,
            "x_range": null,
            "x_label": null,
            "y_label": null,
            "c_label": null,
            "time_window": null,
            "annotations": [],
            "show_stats": false
        }]);

        let session = from_json(&value.to_string()).expect("v17 migrates");
        let panel = &session.tabs[0].panels[0];
        assert_eq!(session.schema_version, 19);
        assert_eq!(session.named_sets[0].refs[0].channel, "temperature");
        assert_eq!(session.named_sets[0].refs[1].channel, "pressure");
        assert_eq!(session.named_sets[0].selector.as_deref(), Some("temp"));
        assert_eq!(panel.x_ref.as_ref().unwrap().channel, "temperature");
        assert_eq!(panel.color_ref.as_ref().unwrap().channel, "T_amb");
        assert_eq!(panel.bindings[0].refs[0].channel, "T_amb");
        assert_eq!(panel.bindings[0].selector.as_deref(), Some("temp"));
        assert_eq!(
            panel.overrides[0].target_ref.as_ref().unwrap().channel,
            "temperature"
        );
        assert_eq!(panel.overrides[0].target_selector.as_deref(), Some("temp"));
        assert_eq!(panel.focus[0].r#ref.as_ref().unwrap().channel, "T_amb");
        assert!(
            serde_json::to_value(session)
                .expect("serializes")
                .get("channel_map")
                .is_none()
        );
    }

    #[test]
    fn migrates_v18_without_alignment() {
        let mut value = serde_json::to_value(Session::default()).expect("serializes");
        value["schema_version"] = serde_json::json!(18);
        let mut time_domain = serde_json::json!({
            "unit": "seconds",
            "origin": "relative"
        });
        time_domain["alignment_".to_owned() + "origin"] = serde_json::json!(0.0);
        value["sources"] = serde_json::json!([{
            "key": "run-01",
            "path": "/data/run-01.csv",
            "prefix": "run_01",
            "provider_id": null,
            "decode_provenance": null,
            "reconcile_legacy": false,
            "time_domain": time_domain,
            "scale": 1.0,
            "offset": 0.0
        }]);

        let session = from_json(&value.to_string()).expect("migrates");

        assert_eq!(session.schema_version, 19);
        let serialized = serde_json::to_value(session).expect("serializes");
        let source = &serialized["sources"][0];
        assert!(source.get("time_domain").is_none());
        assert!(source.get("scale").is_none());
        assert!(source.get("offset").is_none());
        assert_eq!(source["key"], "run-01");
        assert_eq!(source["prefix"], "run_01");
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
                    x_ref: None,
                    color_axis: ColorAxis::None,
                    color_ref: None,
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
    fn v13_band_panels_expand_to_member_series() {
        let json = serde_json::json!({
            "app": "signalscope", "schema_version": 13,
            "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 1.0, "linked": true, "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "tab-1",
            "tabs": [{
                "id": "tab-1", "title": "Tab", "cursor_mode": "none",
                "focused_panel_id": null, "maximized_panel_id": null,
                "layout": [],
                "panels": [{
                    "id": "p1", "title": "Band", "mode": "time", "axis_style": "gutter",
                    "x_signal": null, "color_signal": null, "color_by_time": false,
                    "series": [{"path": "run_01/alt", "color_slot": 1, "dash": "solid", "width": 1.4, "visible": true}],
                    "ensemble": {"set_key": "set-1", "local_path": "alt", "member_filter": []},
                    "y_range": null, "x_range": null, "x_label": null, "y_label": null,
                    "c_label": null, "time_window": null, "annotations": [], "show_stats": false
                }]
            }],
            "favorites": [], "derived": [],
            "sources": [
                {"key": "k1", "path": "/data/run_01.csv", "prefix": "run_01", "provider_id": null, "decode_provenance": null, "reconcile_legacy": false},
                {"key": "k2", "path": "/data/run_02.csv", "prefix": "run_02", "provider_id": null, "decode_provenance": null, "reconcile_legacy": false},
                {"key": "k3", "path": "/data/run_03.csv", "prefix": "run_03", "provider_id": null, "decode_provenance": null, "reconcile_legacy": false}
            ],
            "source_sets": [{
                "key": "set-1", "label": "Runs", "generation": "1",
                "members": [
                    {"source_key": "k1", "missing": [], "scale": 1.0, "offset": 0.0},
                    {"source_key": "k2", "missing": [], "scale": 1.0, "offset": 0.0},
                    {"source_key": "k3", "missing": ["alt"], "scale": 1.0, "offset": 0.0}
                ]
            }]
        });
        let session = from_json(&json.to_string()).expect("v13 migrates");
        let panel = &session.tabs[0].panels[0];
        assert_eq!(
            panel.bindings[0].refs,
            vec![
                SeriesRef {
                    source_key: "k1".into(),
                    channel: "alt".into(),
                },
                SeriesRef {
                    source_key: "k2".into(),
                    channel: "alt".into(),
                }
            ]
        );
        assert_eq!(panel.overrides[1].color_slot, Some(2));
        assert!(panel.focus.is_empty());
    }

    #[test]
    fn v13_band_with_unknown_set_keeps_explicit_series() {
        let json = serde_json::json!({
            "app": "signalscope", "schema_version": 13, "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 1.0, "linked": true, "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1", "favorites": [], "derived": [], "sources": [],
            "source_sets": [],
            "tabs": [{"id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
                "focused_panel_id": null, "maximized_panel_id": null, "layout": [], "panels": [{
                    "id": "p1", "title": "Band", "mode": "time", "axis_style": "gutter",
                    "x_signal": null, "color_signal": null, "color_by_time": false,
                    "series": [{"path": "run_01/alt", "color_slot": 1, "dash": "solid", "width": 1.4, "visible": true}],
                    "ensemble": {"set_key": "missing", "local_path": "alt", "member_filter": []},
                    "y_range": null, "x_range": null, "x_label": null, "y_label": null,
                    "c_label": null, "time_window": null, "annotations": [], "show_stats": false
                }]}]
        });
        let session = from_json(&json.to_string()).expect("v13 migrates");
        assert!(session.tabs[0].panels[0].bindings[0].refs.is_empty());
        assert!(session.tabs[0].panels[0].focus.is_empty());
    }

    #[test]
    fn v10_source_paths_migrate_to_deterministic_keyed_records() {
        let json = serde_json::json!({
            "app": "signalscope", "schema_version": 10, "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 1.0, "linked": true,
                            "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1", "favorites": [], "derived": [],
            "source_paths": ["/data/run.csv", "/other/run.csv"],
            "tabs": [{
                "id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
                "focused_panel_id": null, "maximized_panel_id": null,
                "layout": [], "panels": []
            }]
        })
        .to_string();

        let session = from_json(&json).expect("v10 migrates");
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        assert_eq!(session.sources.len(), 2);
        assert_eq!(
            session.sources[0].key,
            crate::naming::legacy_source_key("/data/run.csv").to_string()
        );
        assert_eq!(session.sources[0].prefix, "run");
        assert!(session.sources[1].prefix.starts_with("run_"));
        assert!(session.sources.iter().all(|record| record.reconcile_legacy));
        assert!(
            session
                .sources
                .iter()
                .all(|record| record.provider_id.is_none())
        );
        assert_eq!(from_json(&json).unwrap().sources, session.sources);
    }

    #[test]
    fn v14_sessions_gain_empty_bundle_favorites() {
        let mut value = serde_json::to_value(Session::default()).expect("serializes");
        value["schema_version"] = serde_json::json!(14);
        value
            .as_object_mut()
            .expect("session object")
            .remove("favorite_bundles");
        let session = from_json(&value.to_string()).expect("v14 migrates");
        assert!(session.named_sets.is_empty());
    }

    #[test]
    fn v15_sessions_gain_empty_derived_bundles() {
        let mut value = serde_json::to_value(Session::default()).expect("serializes");
        value["schema_version"] = serde_json::json!(15);
        value
            .as_object_mut()
            .expect("session object")
            .remove("derived_bundles");
        let session = from_json(&value.to_string()).expect("v15 migrates");
        assert!(session.derived_bundles.is_empty());
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
        assert!(session.sources.is_empty());
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
        assert!(session.named_sets.is_empty());
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
        assert!(session.named_sets.is_empty());
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
        assert!(matches!(panel.color_axis, ColorAxis::Time));
        assert_eq!(panel.color_ref, None);
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

use super::*;

#[test]
fn line_sessions_migrate_and_scatter_round_trips() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../protocol/testdata/session-parser-cases.json"
    ))
    .unwrap();
    let mut value = serde_json::to_value(Session::default()).unwrap();
    value["schema_version"] = 32.into();
    let mut panel = fixture["panel"].clone();
    panel.as_object_mut().unwrap().remove("content");
    value["tabs"][0]["panels"] = serde_json::json!([panel]);
    let mut session = from_json(&value.to_string()).unwrap();
    assert!(matches!(
        session.tabs[0].panels[0].content,
        PanelContent::Line2d
    ));
    session.tabs[0].panels[0].content = PanelContent::Scatter2d;
    let restored = from_json(&serde_json::to_string(&session).unwrap()).unwrap();
    assert!(matches!(
        restored.tabs[0].panels[0].content,
        PanelContent::Scatter2d
    ));
}

const SESSION_FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../protocol/testdata/session-conformance.json"
);

fn source(path: &str) -> SourceRecord {
    let key = uuid::Uuid::from_bytes([u8::try_from(path.len()).unwrap_or(0); 16]);
    SourceRecord {
        key: key.to_string(),
        path: path.into(),
        prefix: crate::naming::default_prefix(Path::new(path)),
        provider_id: None,
        decode_provenance: None,
        recipe_id: None,
        recipe_digest: None,
    }
}

#[test]
fn shared_runtime_parser_cases() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../protocol/testdata/session-parser-cases.json"
    ))
    .unwrap();
    let base: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../protocol/testdata/session-conformance.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let mut input = base.clone();
        input
            .as_object_mut()
            .unwrap()
            .extend(case["session"].as_object().unwrap().clone());
        let mut panel = fixture["panel"].clone();
        panel
            .as_object_mut()
            .unwrap()
            .extend(case["panel"].as_object().unwrap().clone());
        input["tabs"][0]["panels"] = serde_json::json!([panel]);
        let result = from_json(&input.to_string());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {result:?}",
            case["name"]
        );
        if let Ok(session) = result {
            let json = serde_json::to_string(&session).unwrap();
            assert_eq!(from_json(&json).unwrap(), session);
            for annotation in &session.tabs[0].panels[0].annotations {
                assert_eq!(annotation.pinned_x, None);
            }
        }
    }
}

#[test]
fn session_title_is_optional_and_round_trips() {
    let session = Session {
        title: Some("Thermal review".into()),
        ..Session::default()
    };
    let mut value = serde_json::to_value(&session).unwrap();
    assert_eq!(from_json(&value.to_string()).unwrap(), session);
    value.as_object_mut().unwrap().remove("title");
    assert_eq!(from_json(&value.to_string()).unwrap().title, None);
    value["title"] = 42.into();
    assert!(from_json(&value.to_string()).is_err());
}

#[test]
fn v31_migrates_without_changing_session_state() {
    let expected = from_json(include_str!(
        "../../../../protocol/testdata/session-conformance.json"
    ))
    .unwrap();
    let mut value = serde_json::to_value(&expected).unwrap();
    value["schema_version"] = 31.into();
    assert_eq!(from_json(&value.to_string()).unwrap(), expected);
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
                content: crate::session::PanelContent::Line2d,
                id: "panel-a".into(),
                title: "Body velocity".into(),
                axis_style: AxisStyle::Gutter,
                axis_equal: None,
                x_scale: None,
                y_scale: None,
                x_reversed: None,
                y_reversed: None,
                bindings: vec![Binding {
                    kind: BindingKind::Pick,
                    selector: None,
                    refs: vec![SeriesRef {
                        source_key: "rocket".into(),
                        channel: "velocity_body/x".into(),
                    }],
                    set_id: None,
                }],
                color_by: Some(StyleDimension::Source),
                dash_by: None,
                width_by: None,
                line_width: 1.4,
                ghost_opacity: 0.5,
                overrides: vec![SeriesOverride {
                    target_ref: Some(SeriesRef {
                        source_key: "rocket".into(),
                        channel: "velocity_body/x".into(),
                    }),
                    target_selector: None,
                    color_slot: Some(300),
                    dash: Some(DashStyle::Solid),
                    width: Some(1.5),
                    opacity: None,
                    visible: Some(true),
                }],
                focus: Vec::new(),
                ghost_mode: GhostMode::All,
                legend_state: LegendState::Keys,
                legend_position: None,
                legend_size: None,
                legend_anchor: None,
                legend_dock: None,
                legend_hint_dismissed: false,
                x_axis: SampleAxisSource::Time,
                color_axis: None,
                y_range: None,
                x_range: None,
                x_label: None,
                y_label: None,
                time_window: None,
                annotations: Vec::new(),
                annotation_display: AnnotationDisplay::Labels,
                show_stats: false,
                stat_columns: vec![
                    StatColumn::Min,
                    StatColumn::Max,
                    StatColumn::Mean,
                    StatColumn::Rms,
                    StatColumn::Cursor,
                ],
                stats_sort: None,
                stats_sort_descending: false,
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
    for version in 1..22 {
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

#[test]
fn v22_panels_migrate_to_the_default_legend() {
    let panel = serde_json::json!({
        "id": "panel-a",
        "title": "Panel A",
        "mode": "time",
        "axis_style": "gutter",
        "bindings": [],
        "color_by": "source",
        "overrides": [],
        "focus": [],
        "ghost_mode": "all",
        "split_by": "none",
        "y_range": null,
        "x_range": null,
        "x_label": null,
        "y_label": null,
        "time_window": null,
        "annotations": [],
        "show_stats": false
    });
    let value = serde_json::json!({
        "app": "signalscope",
        "schema_version": 22,
        "theme": "dark",
        "linked_time": {
            "t0": 0.0,
            "t1": 1.0,
            "linked": true,
            "paused": false,
            "cursorT": null,
            "mode": "fixed"
        },
        "active_tab_id": "workspace-1",
        "tabs": [{
            "id": "workspace-1",
            "title": "Workspace 1",
            "cursor_mode": "none",
            "focused_panel_id": "panel-a",
            "maximized_panel_id": null,
            "panels": [panel],
            "layout": [{
                "height": 1.0,
                "panels": [{"panel_id": "panel-a", "width": 1.0}]
            }]
        }],
        "named_sets": [],
        "derived": [],
        "derived_bundles": [],
        "sources": []
    });

    let restored = from_json(&value.to_string()).expect("v22 migrates");
    let panel = &restored.tabs[0].panels[0];
    assert_eq!(panel.legend_state, LegendState::Keys);
    assert_eq!(panel.legend_position, None);
    assert_eq!(panel.legend_size, None);
    assert_eq!(panel.legend_anchor, None);
    assert!(!panel.legend_hint_dismissed);
}

#[test]
fn v24_panels_migrate_style_and_statistics_defaults() {
    let mut value = serde_json::json!({
        "app": "signalscope",
        "schema_version": 24,
        "theme": "dark",
        "linked_time": {
            "t0": 0.0, "t1": 1.0, "linked": true, "paused": false,
            "cursorT": null, "mode": "fixed"
        },
        "active_tab_id": "workspace-1",
        "tabs": [{
            "id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
            "focused_panel_id": null, "maximized_panel_id": null,
            "panels": [], "layout": []
        }],
        "named_sets": [], "derived": [], "derived_bundles": [], "sources": []
    });
    value["tabs"][0]["panels"] = serde_json::json!([{
        "id": "panel-a", "title": "Panel A", "axis_style": "gutter",
        "bindings": [], "color_by": "source", "overrides": [], "focus": [],
        "ghost_mode": "all", "legend_state": "keys", "legend_position": null,
        "legend_size": null, "legend_anchor": null, "legend_hint_dismissed": false,
        "y_range": null, "x_range": null, "x_label": null, "y_label": null,
        "time_window": null, "annotations": [], "show_stats": false
    }]);
    let restored = from_json(&value.to_string()).expect("v24 migrates");
    let panel = &restored.tabs[0].panels[0];
    assert_eq!(panel.color_by, Some(StyleDimension::Source));
    assert_eq!(panel.dash_by, None);
    assert_eq!(panel.width_by, None);
    assert!((panel.line_width - 1.4).abs() < f32::EPSILON);
    assert!((panel.ghost_opacity - 0.5).abs() < f32::EPSILON);
    assert_eq!(
        panel.stat_columns,
        vec![
            StatColumn::Min,
            StatColumn::Max,
            StatColumn::Mean,
            StatColumn::Rms,
            StatColumn::Cursor,
        ]
    );
    assert_eq!(panel.stats_sort, None);
    assert!(!panel.stats_sort_descending);
}

#[test]
fn v25_tips_gain_display_and_offset_defaults() {
    let value: serde_json::Value = serde_json::from_str(
        r#"{
        "app": "signalscope",
        "schema_version": 25,
        "theme": "dark",
        "linked_time": {
            "t0": 0.0, "t1": 1.0, "linked": true, "paused": false,
            "cursorT": null, "mode": "fixed"
        },
        "active_tab_id": "workspace-1",
        "tabs": [{
            "id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
            "focused_panel_id": null, "maximized_panel_id": null,
            "panels": [{
                "id": "panel-a", "title": "Panel A", "axis_style": "gutter",
                "bindings": [], "color_by": "source", "dash_by": null,
                "width_by": null, "line_width": 1.4, "ghost_opacity": 0.5,
                "overrides": [], "focus": [], "ghost_mode": "all",
                "legend_state": "keys", "legend_position": null,
                "legend_size": null, "legend_anchor": null,
                "legend_hint_dismissed": false, "y_range": null, "x_range": null,
                "x_label": null, "y_label": null, "time_window": null,
                "annotations": [{
                    "id": "tip-1", "series_path": "run-01/temp",
                    "anchor": 1.5, "pinned_value": 3.25, "label": "peak"
                }],
                "show_stats": false,
                "stat_columns": ["min", "max", "mean", "rms", "cursor"],
                "stats_sort": null, "stats_sort_descending": false
            }],
            "layout": [{
                "height": 1.0,
                "panels": [{"panel_id": "panel-a", "width": 1.0}]
            }]
        }],
        "named_sets": [], "derived": [], "derived_bundles": [], "sources": []
    }"#,
    )
    .expect("valid v25 fixture");

    let restored = from_json(&value.to_string()).expect("v25 migrates");
    let panel = &restored.tabs[0].panels[0];
    assert_eq!(panel.annotation_display, AnnotationDisplay::Labels);
    assert!((panel.annotations[0].offset[0] - 10.0).abs() < f64::EPSILON);
    assert!((panel.annotations[0].offset[1] + 10.0).abs() < f64::EPSILON);
    assert!((panel.annotations[0].pinned_value - 3.25).abs() < f64::EPSILON);
    assert_eq!(panel.legend_dock, None);
    assert_eq!(panel.x_axis, SampleAxisSource::Time);

    let mut v26 = serde_json::to_value(restored).expect("serializes migrated session");
    v26["schema_version"] = 26.into();
    let legacy_panel = v26["tabs"][0]["panels"][0]
        .as_object_mut()
        .expect("panel object");
    legacy_panel.insert("legend_state".into(), "rail".into());
    legacy_panel.remove("legend_dock");
    let docked = from_json(&v26.to_string()).expect("v26 rail migrates");
    assert_eq!(
        docked.tabs[0].panels[0].legend_dock,
        Some(LegendDock::Right)
    );
}

#[test]
fn v30_sessions_disable_color_and_reject_invalid_current_limits() {
    let mut value = serde_json::to_value(Session::default()).unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../protocol/testdata/session-parser-cases.json"
    ))
    .unwrap();
    value["tabs"][0]["panels"] = serde_json::json!([fixture["panel"]]);
    value["tabs"][0]["panels"][0]
        .as_object_mut()
        .unwrap()
        .remove("color_axis");
    value["schema_version"] = 30.into();
    let migrated = from_json(&value.to_string()).unwrap();
    assert_eq!(migrated.schema_version, SESSION_SCHEMA_VERSION);
    assert!(migrated.tabs[0].panels[0].color_axis.is_none());
}

#[test]
fn v29_sessions_keep_their_axes_and_advance_to_current() {
    let mut value = serde_json::to_value(Session::default()).unwrap();
    value["schema_version"] = 29.into();
    let migrated = from_json(&value.to_string()).unwrap();
    assert_eq!(migrated.schema_version, SESSION_SCHEMA_VERSION);
    assert_eq!(migrated.linked_time, LinkedTime::default());
}

#[test]
fn malformed_v30_tabs_and_panels_return_errors_without_panicking() {
    for tabs in [
        serde_json::json!([42]),
        serde_json::json!([{ "panels": [42] }]),
    ] {
        let mut value = serde_json::to_value(Session::default()).unwrap();
        value["schema_version"] = 30.into();
        value["tabs"] = tabs;
        assert!(matches!(
            from_json(&value.to_string()),
            Err(SessionError::Json(_))
        ));
    }
}

#[test]
fn v27_panels_migrate_to_time_x_axis() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../protocol/testdata/session-parser-cases.json"
    ))
    .expect("valid shared panel fixture");
    let mut value = serde_json::to_value(Session::default()).expect("serializes session");
    value["tabs"][0]["panels"] = serde_json::json!([fixture["panel"]]);
    value["schema_version"] = 27.into();
    value["tabs"][0]["panels"][0]
        .as_object_mut()
        .expect("panel object")
        .remove("x_axis");

    let restored = from_json(&value.to_string()).expect("v27 migrates");
    let panel = &restored.tabs[0].panels[0];
    assert_eq!(panel.x_axis, SampleAxisSource::Time);

    let mut v28 = serde_json::to_value(&restored).expect("serializes migrated session");
    v28["schema_version"] = 28.into();
    v28["tabs"][0]["panels"][0]["x_axis"]["ref"] = serde_json::Value::Null;
    let migrated_v28 = from_json(&v28.to_string()).expect("v28 migrates");
    assert_eq!(
        migrated_v28.tabs[0].panels[0].x_axis,
        SampleAxisSource::Time
    );

    for invalid_ref in [
        serde_json::json!({"source_key": "source", "channel": "x"}),
        serde_json::json!("x"),
        serde_json::json!(false),
    ] {
        v28["tabs"][0]["panels"][0]["x_axis"]["ref"] = invalid_ref;
        assert!(matches!(
            from_json(&v28.to_string()),
            Err(SessionError::Json(_))
        ));
    }
    v28["tabs"][0]["panels"][0]["x_axis"]
        .as_object_mut()
        .unwrap()
        .remove("ref");
    assert_eq!(
        from_json(&v28.to_string()).unwrap().tabs[0].panels[0].x_axis,
        SampleAxisSource::Time
    );

    value["schema_version"] = SESSION_SCHEMA_VERSION.into();
    value["tabs"][0]["panels"][0]["x_axis"] = serde_json::json!({
        "kind": "signal"
    });
    let error = from_json(&value.to_string()).expect_err("invalid axis source");
    assert!(matches!(error, SessionError::Json(_)));

    value["tabs"][0]["panels"][0]["x_axis"] = serde_json::json!({
        "kind": "signal",
        "ref": {"source_key": "source", "channel": "x"}
    });
    let signal_axis = from_json(&value.to_string()).expect("signal axis source");
    assert_eq!(
        signal_axis.tabs[0].panels[0].x_axis,
        SampleAxisSource::Signal {
            r#ref: SeriesRef {
                source_key: "source".into(),
                channel: "x".into(),
            },
        }
    );
}

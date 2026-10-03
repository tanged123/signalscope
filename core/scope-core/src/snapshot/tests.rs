use std::collections::BTreeMap;

use super::payload::decode::Decoded;
use super::*;
use crate::pyramid::Pyramid;
use crate::session::{
    AxisStyle, Binding, BindingKind, NamedSet, NamedSetKind, PanelState, SampleAxisSource,
    SeriesOverride, SeriesRef, Session,
};
use crate::store::{SignalId, SignalStore, SourceKey};
use scope_protocol::{ExportFidelity, ExportRange, TimeWindow};

fn store_with(signals: &[(&str, usize)]) -> (SignalStore, BTreeMap<SignalId, Pyramid>) {
    let mut store = SignalStore::new();
    let source = store
        .register_source("test.csv", SourceKey(uuid::Uuid::from_bytes([1; 16])), "")
        .unwrap();
    let mut pyramids = BTreeMap::new();
    for (path, count) in signals {
        let count = u32::try_from(*count).expect("test signal is small");
        let time: Vec<f64> = (0..count).map(f64::from).collect();
        let values: Vec<f64> = time.iter().map(|time| time * 0.5).collect();
        let id = store
            .insert_signal(source, (*path).to_owned(), None, time, values)
            .expect("insert");
        let signal = store.signal(id).expect("signal");
        pyramids.insert(id, Pyramid::from_signal(signal));
    }
    (store, pyramids)
}

fn panel(id: &str, paths: &[&str]) -> PanelState {
    PanelState {
        content: crate::session::PanelContent::Line2d,
        content_selection_pending: None,
        id: id.to_owned(),
        title: "Panel".to_owned(),
        axis_style: AxisStyle::Gutter,
        axis_equal: None,
        x_scale: None,
        y_scale: None,
        x_reversed: None,
        y_reversed: None,
        bindings: vec![Binding {
            kind: BindingKind::Pick,
            selector: None,
            refs: paths
                .iter()
                .map(|path| SeriesRef {
                    source_key: uuid::Uuid::from_bytes([1; 16]).to_string(),
                    channel: (*path).to_owned(),
                })
                .collect(),
            set_id: None,
        }],
        color_by: Some(crate::session::StyleDimension::Source),
        dash_by: None,
        width_by: None,
        line_width: 1.4,
        ghost_opacity: 0.5,
        overrides: Vec::new(),
        focus: Vec::new(),
        ghost_mode: crate::session::GhostMode::All,
        legend_state: crate::session::LegendState::Keys,
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
        annotation_display: crate::session::AnnotationDisplay::Labels,
        show_stats: false,
        stat_columns: vec![
            crate::session::StatColumn::Min,
            crate::session::StatColumn::Max,
            crate::session::StatColumn::Mean,
            crate::session::StatColumn::Rms,
            crate::session::StatColumn::Cursor,
        ],
        stats_sort: None,
        stats_sort_descending: false,
    }
}

fn session_with(panels: Vec<PanelState>) -> Session {
    let mut session = Session::default();
    session.sources.push(crate::session::SourceRecord {
        key: uuid::Uuid::from_bytes([1; 16]).to_string(),
        path: "/data/test.csv".into(),
        prefix: String::new(),
        provider_id: None,
        decode_provenance: None,
        recipe_id: None,
        recipe_digest: None,
    });
    session.tabs[0].panels = panels;
    session
}

#[test]
fn all_scope_bakes_every_signal_full_range_from_level_zero() {
    let (store, pyramids) = store_with(&[("a", 10), ("b", 10_000)]);
    let plan = plan(
        &Session::default(),
        &store,
        &pyramids,
        ExportRange::All,
        ExportFidelity::Full,
    )
    .expect("plan");
    assert_eq!(plan.signals.len(), 2);
    assert!(plan.signals.iter().all(|signal| signal.finest_level() == 0));
    assert!(plan.signals.iter().all(|signal| signal.window.is_none()));
}

#[test]
fn visible_signal_x_export_bakes_shared_paired_levels() {
    let (store, pyramids) = store_with(&[("x", 64), ("y", 64)]);
    let mut panel = panel("panel-1", &["y"]);
    panel.x_axis = SampleAxisSource::Signal {
        r#ref: SeriesRef {
            source_key: uuid::Uuid::from_bytes([1; 16]).to_string(),
            channel: "x".to_owned(),
        },
    };
    let session = session_with(vec![panel]);
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Full,
    )
    .expect("plan");
    assert_eq!(
        export
            .signals
            .iter()
            .map(|signal| signal.signal.id)
            .collect::<Vec<_>>(),
        vec![SignalId(1), SignalId(2)]
    );
    assert_eq!(export.lines.len(), 1);
    assert_eq!(export.lines[0].x_signal.id, SignalId(1));
    assert_eq!(export.lines[0].y_signals[0].id, SignalId(2));
    let manifest = bake(&export, &session).expect("bake");
    let decoded = Decoded::new(&manifest);
    let line = &manifest.line2d.as_ref().expect("line payload")[0];
    assert_eq!(line.x_signal_id, 1);
    assert_eq!(line.y_signal_ids, vec![2]);
    let level = &line.levels[0];
    assert_eq!(level.level, 0);
    assert_eq!(
        decoded.f64s(level.anchor).len(),
        decoded.f64s(level.ys[0]).len()
    );
    assert_eq!(decoded.optional_f64s(level.x)[2], Some(1.0));
    assert_eq!(decoded.optional_f64s(level.ys[0])[2], Some(1.0));
}

#[test]
fn signal_x_snapshot_deduplicates_reordered_y_bindings() {
    let (store, pyramids) = store_with(&[("x", 64), ("a", 64), ("b", 64)]);
    let x_axis = SampleAxisSource::Signal {
        r#ref: SeriesRef {
            source_key: uuid::Uuid::from_bytes([1; 16]).to_string(),
            channel: "x".to_owned(),
        },
    };
    let mut first = panel("panel-1", &["x", "a", "b"]);
    first.x_axis = x_axis.clone();
    let mut second = panel("panel-2", &["b", "a", "x"]);
    second.x_axis = x_axis;

    let export = plan(
        &session_with(vec![first, second]),
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Full,
    )
    .expect("plan");

    assert_eq!(export.lines.len(), 1);
    assert_eq!(
        export.lines[0]
            .y_signals
            .iter()
            .map(|signal| signal.id)
            .collect::<Vec<_>>(),
        vec![SignalId(1), SignalId(2), SignalId(3)]
    );
}

#[test]
fn signal_x_snapshot_skips_unresolved_and_captures_a_signal_against_itself() {
    let (store, pyramids) = store_with(&[("y", 64)]);
    let mut unresolved = panel("unresolved", &["y"]);
    unresolved.x_axis = SampleAxisSource::Signal {
        r#ref: SeriesRef {
            source_key: uuid::Uuid::from_bytes([1; 16]).to_string(),
            channel: "missing".to_owned(),
        },
    };
    let mut only_x = panel("only-x", &["y"]);
    only_x.x_axis = SampleAxisSource::Signal {
        r#ref: SeriesRef {
            source_key: uuid::Uuid::from_bytes([1; 16]).to_string(),
            channel: "y".to_owned(),
        },
    };

    let export = plan(
        &session_with(vec![unresolved, only_x]),
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Full,
    )
    .expect("unresolved line panels are skipped");

    assert_eq!(export.lines.len(), 1);
    assert_eq!(export.lines[0].x_signal.id, export.lines[0].y_signals[0].id);
}

#[test]
fn all_full_round_trips_every_pyramid_level_exactly() {
    let (mut store, mut pyramids) = store_with(&[("a", 32)]);
    let source = store
        .register_source(
            "gaps.csv",
            SourceKey(uuid::Uuid::from_bytes([2; 16])),
            "gaps",
        )
        .unwrap();
    let values = vec![
        1.0,
        f64::NAN,
        -0.0,
        f64::INFINITY,
        3.5,
        f64::NAN,
        2.0,
        1e-300,
        7.0,
    ];
    let time: Vec<f64> = (0..u32::try_from(values.len()).expect("small fixture"))
        .map(|index| f64::from(index) * 0.25)
        .collect();
    let gapped = store
        .insert_signal(source, "gapped".to_owned(), None, time, values)
        .expect("insert");
    pyramids.insert(
        gapped,
        Pyramid::from_signal(store.signal(gapped).expect("signal")),
    );
    let session = Session::default();
    let plan = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::All,
        ExportFidelity::Full,
    )
    .expect("plan");
    let manifest = bake(&plan, &session).expect("bake");
    let decoded = Decoded::new(&manifest);
    assert_eq!(manifest.signals.len(), 2);
    for baked in &manifest.signals {
        let signal = store
            .signal(SignalId(baked.summary.signal_id))
            .expect("signal");
        let pyramid = pyramids.get(&signal.id).expect("pyramid");
        assert_eq!(
            baked.summary,
            signal_summary(
                signal,
                source_key(&store, signal).expect("source"),
                pyramid.last_finite_value(),
            )
        );
        assert_eq!(baked.levels.len(), pyramid.level_count());
        assert_eq!(
            baked.levels[0].encoding,
            scope_protocol::BakedLevelEncoding::Samples
        );
        for (index, level) in baked.levels.iter().enumerate() {
            let expected = pyramid.level(index).expect("level");
            let actual = decoded.bins(level);
            assert_eq!(actual, expected, "{} level {index}", signal.path);
            for (left, right) in actual.iter().zip(&expected) {
                assert_eq!(left.sum.to_bits(), right.sum.to_bits());
                assert_eq!(left.sum_sq.to_bits(), right.sum_sq.to_bits());
            }
        }
    }
}

#[test]
fn histogram_snapshot_bakes_exact_shared_edges_and_panel_window() {
    let (store, pyramids) = store_with(&[("a", 10)]);
    let mut panel = panel("histogram-1", &["a"]);
    panel.content = crate::session::PanelContent::Histogram { bin_count: 2 };
    let mut session = session_with(vec![panel]);
    session.linked_time.t0 = 2.0;
    session.linked_time.t1 = 6.0;

    let plan = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Full,
    )
    .expect("histogram plan");
    assert!(
        plan.lines.is_empty(),
        "histograms are not line combinations"
    );
    assert_eq!(plan.histograms.len(), 1);
    assert_eq!(plan.histograms[0].window, TimeWindow { t0: 2.0, t1: 6.0 });

    let manifest = bake(&plan, &session).expect("histogram bake");
    let histogram = &manifest.histograms.expect("histogram payload")[0];
    assert_eq!(histogram.panel_id, "histogram-1");
    assert_eq!(histogram.response.window, TimeWindow { t0: 2.0, t1: 6.0 });
    assert_eq!(histogram.response.edges, vec![1.0, 2.0, 3.0]);
    assert_eq!(histogram.response.series[0].counts, vec![2, 3]);
    assert_eq!(histogram.response.series[0].finite_count, 5);
    assert_eq!(histogram.response.series[0].excluded_count, 0);
}

#[test]
fn histogram_snapshot_excludes_hidden_resolved_series() {
    let (store, pyramids) = store_with(&[("a", 10), ("b", 10)]);
    let mut panel = panel("histogram-1", &["a", "b"]);
    panel.content = crate::session::PanelContent::Histogram { bin_count: 4 };
    panel.overrides = vec![SeriesOverride {
        target_ref: Some(SeriesRef {
            source_key: uuid::Uuid::from_bytes([1; 16]).to_string(),
            channel: "b".to_owned(),
        }),
        target_selector: None,
        color_slot: None,
        dash: None,
        width: None,
        opacity: None,
        visible: Some(false),
    }];
    let session = session_with(vec![panel]);
    let plan = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Full,
    )
    .expect("histogram plan");
    let manifest = bake(&plan, &session).expect("histogram bake");
    let histogram = &manifest.histograms.expect("histogram payload")[0];
    assert_eq!(histogram.response.series.len(), 1);
    assert_eq!(histogram.response.series[0].signal_path, "a");
}

#[test]
fn planning_rejects_a_signal_without_a_pyramid() {
    let (store, mut pyramids) = store_with(&[("a", 10)]);
    pyramids.clear();
    assert!(matches!(
        plan(
            &Session::default(),
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full
        ),
        Err(SnapshotError::MissingPyramid(SignalId(1)))
    ));
}

#[test]
fn visible_scope_excludes_signals_on_no_panel() {
    let (store, pyramids) = store_with(&[("a", 10), ("b", 10)]);
    let session = session_with(vec![panel("panel-1", &["a"])]);
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Standard,
    )
    .expect("plan");
    assert_eq!(export.signals.len(), 1);
    assert_eq!(export.signals[0].signal.path, "a");
}

#[test]
fn visible_scope_resolves_query_and_saved_set_bindings() {
    let (store, pyramids) = store_with(&[("alpha", 10), ("beta", 10), ("ignored", 10)]);
    let mut panel = panel("panel-1", &[]);
    panel.bindings = vec![
        Binding {
            kind: BindingKind::Query,
            selector: Some("alpha".into()),
            refs: Vec::new(),
            set_id: None,
        },
        Binding {
            kind: BindingKind::Set,
            selector: None,
            refs: Vec::new(),
            set_id: Some("saved".into()),
        },
    ];
    let mut session = session_with(vec![panel]);
    session.named_sets.push(NamedSet {
        id: "saved".into(),
        name: "Saved".into(),
        kind: NamedSetKind::Pick,
        selector: None,
        refs: vec![SeriesRef {
            source_key: uuid::Uuid::from_bytes([1; 16]).to_string(),
            channel: "beta".into(),
        }],
    });

    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Standard,
    )
    .expect("plan");
    let paths = export
        .signals
        .iter()
        .map(|entry| entry.signal.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(paths, ["alpha", "beta"]);
}

#[test]
fn visible_scope_query_matcher_handles_globs_kinds_and_empty_results() {
    let (store, pyramids) = store_with(&[("alpha", 10), ("beta", 10), ("derived/score", 10)]);
    let cases: &[(&str, &[&str])] = &[
        ("alpha*", &["alpha"]),
        ("alpha|beta", &["alpha", "beta"]),
        ("alpha[", &[]),
        ("* kind:derived", &["derived/score"]),
        ("missing*", &[]),
    ];

    for (selector, expected) in cases {
        let mut query_panel = panel("panel-query", &[]);
        query_panel.bindings = vec![Binding {
            kind: BindingKind::Query,
            selector: Some((*selector).into()),
            refs: Vec::new(),
            set_id: None,
        }];
        let session = session_with(vec![query_panel]);

        let export = plan(
            &session,
            &store,
            &pyramids,
            ExportRange::Visible,
            ExportFidelity::Standard,
        )
        .expect("plan");
        let paths = export
            .signals
            .iter()
            .map(|entry| entry.signal.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, *expected, "selector: {selector}");
    }
}

#[test]
fn visible_scope_decimates_dense_time_signals() {
    let (store, pyramids) = store_with(&[("a", 100_000)]);
    let mut session = session_with(vec![panel("panel-1", &["a"])]);
    session.linked_time.t1 = 99_999.0;
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Standard,
    )
    .expect("plan");
    let entry = &export.signals[0];
    assert!(entry.finest_level() > 0);
    let level = entry
        .pyramid
        .level(entry.finest_level())
        .expect("planned level");
    let limit = ceiling(ExportFidelity::Standard).expect("standard ceiling");
    assert!(level.len() <= limit);
    if entry.finest_level() > 1 {
        assert!(
            entry
                .pyramid
                .level(entry.finest_level() - 1)
                .expect("previous level")
                .len()
                > limit
        );
    }
}

#[test]
fn honesty_rule_bakes_raw_when_sparse_at_every_fidelity() {
    let (store, pyramids) = store_with(&[("a", 500)]);
    let session = session_with(vec![panel("panel-1", &["a"])]);
    for fidelity in [
        ExportFidelity::Preview,
        ExportFidelity::Standard,
        ExportFidelity::High,
        ExportFidelity::Full,
    ] {
        let export =
            plan(&session, &store, &pyramids, ExportRange::Visible, fidelity).expect("plan");
        assert_eq!(export.signals[0].finest_level(), 0);
        assert_eq!(export.series_full_rate, 1);
    }
}

#[test]
fn fidelity_ceiling_is_monotone() {
    let (store, pyramids) = store_with(&[("a", 100_000)]);
    let session = session_with(vec![panel("panel-1", &["a"])]);
    let bins: Vec<usize> = [
        ExportFidelity::Preview,
        ExportFidelity::Standard,
        ExportFidelity::High,
        ExportFidelity::Full,
    ]
    .into_iter()
    .map(|fidelity| {
        plan(&session, &store, &pyramids, ExportRange::All, fidelity)
            .expect("plan")
            .signals
            .iter()
            .flat_map(|signal| &signal.levels)
            .map(|level| level.bin_count)
            .sum()
    })
    .collect();
    assert!(bins.windows(2).all(|pair| pair[0] <= pair[1]));
}

#[test]
fn window_is_the_union_of_panel_windows() {
    let (store, pyramids) = store_with(&[("a", 100), ("b", 100)]);
    let mut session = Session::default();
    session.linked_time.t0 = 0.0;
    session.linked_time.t1 = 10.0;
    let linked = panel("panel-linked", &["a"]);
    let mut unlinked = panel("panel-unlinked", &["b"]);
    unlinked.time_window = Some([20.0, 30.0]);
    session.linked_time.linked = false;
    session.tabs[0].panels = vec![linked, unlinked];
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Standard,
    )
    .expect("plan");
    assert!(
        export
            .signals
            .iter()
            .all(|signal| signal.window == Some((0.0, 30.0)))
    );
}

#[test]
fn bake_clears_sources_and_orders_signals_by_id() {
    let (store, pyramids) = store_with(&[("b", 100), ("a", 100)]);
    let session = Session {
        sources: vec![crate::session::SourceRecord {
            key: uuid::Uuid::nil().to_string(),
            path: "/home/user/secret.csv".into(),
            prefix: "secret".into(),
            provider_id: None,
            decode_provenance: None,
            recipe_id: None,
            recipe_digest: None,
        }],
        ..Session::default()
    };
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::All,
        ExportFidelity::Full,
    )
    .expect("plan");
    let manifest = bake(&export, &session).expect("bake");
    assert!(!manifest.session_json.contains("secret.csv"));
    let ids: Vec<u64> = manifest
        .signals
        .iter()
        .map(|signal| signal.summary.signal_id)
        .collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(ids, sorted);
}

#[test]
fn baked_levels_are_positional_from_the_finest_planned_level() {
    let (store, pyramids) = store_with(&[("a", 100_000)]);
    let mut session = session_with(vec![panel("panel-1", &["a"])]);
    session.linked_time.t1 = 99_999.0;
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Standard,
    )
    .expect("plan");
    let entry = &export.signals[0];
    assert!(entry.finest_level() > 0);
    let pyramid = entry.pyramid;
    let finest_level = entry.finest_level();
    let manifest = bake(&export, &session).expect("bake");
    assert_eq!(
        manifest.signals[0].levels.len(),
        pyramid.level_count() - finest_level
    );
    assert_eq!(
        Decoded::new(&manifest).bins(&manifest.signals[0].levels[0]),
        pyramid.level(finest_level).expect("planned level")
    );
}

#[test]
fn clipping_retains_one_neighbor_bin_each_side() {
    let (store, pyramids) = store_with(&[("a", 1_000)]);
    let mut session = session_with(vec![panel("panel-1", &["a"])]);
    session.linked_time.t0 = 100.0;
    session.linked_time.t1 = 200.0;
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Standard,
    )
    .expect("plan");
    let manifest = bake(&export, &session).expect("bake");
    let level = Decoded::new(&manifest).bins(&manifest.signals[0].levels[0]);
    assert_eq!(level.first().map(|bin| bin.t0), Some(99.0));
    assert_eq!(level.last().map(|bin| bin.t1), Some(201.0));
}

#[test]
fn bake_serializes_deterministically() {
    let (store, pyramids) = store_with(&[("b", 100), ("a", 100)]);
    let session = Session::default();
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::All,
        ExportFidelity::Full,
    )
    .expect("plan");
    let first = bake(&export, &session).expect("bake");
    let second = bake(&export, &session).expect("bake");
    assert_eq!(
        serde_json::to_string(&first).expect("serialize"),
        serde_json::to_string(&second).expect("serialize")
    );
}

#[test]
fn inject_replaces_the_slot_atomically() {
    let template = "<html><script id=\"signalscope-baked-data\" type=\"application/json\">\n      null\n    </script></html>";
    let manifest = empty_manifest();
    let html = inject(template, manifest).expect("inject");
    assert!(!html.contains(">null<") && !html.contains("null\n"));
    assert!(html.contains("\"session_json\""));
    assert!(html.starts_with("<html><script id=\"signalscope-baked-data\""));
    assert!(html.ends_with("</script></html>"));
}

#[test]
fn inject_escapes_case_insensitive_script_terminators() {
    let mut session = Session::default();
    session.tabs[0].title = "</ScRiPt><script>alert(1)</SCRIPT>".to_owned();
    let (store, pyramids) = store_with(&[]);
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::All,
        ExportFidelity::Full,
    )
    .expect("plan");
    let mut manifest = bake(&export, &session).expect("bake");
    manifest.preferences_json = Some(r#"{"plot_font_family":"</SCRIPT>"}"#.to_owned());
    let html = inject(
        "<script id=\"signalscope-baked-data\">null</script>",
        manifest,
    )
    .expect("inject");
    assert_eq!(html.to_ascii_lowercase().matches("</script").count(), 1);
    assert!(html.contains("\\u003c/ScRiPt"));
}

#[test]
fn inject_without_slot_errors() {
    assert!(matches!(
        inject("<html></html>", empty_manifest()),
        Err(SnapshotError::MissingSlot)
    ));
}

#[test]
fn estimate_counts_planned_bins_without_serializing() {
    let (store, pyramids) = store_with(&[("a", 1_000)]);
    let export = plan(
        &Session::default(),
        &store,
        &pyramids,
        ExportRange::All,
        ExportFidelity::Full,
    )
    .expect("plan");
    let expected: u64 = export.signals[0]
        .levels
        .iter()
        .map(|level| {
            level.bin_count as u64
                * if level.index == 0 {
                    BYTES_PER_SAMPLE
                } else {
                    BYTES_PER_BIN
                }
        })
        .sum();
    assert_eq!(estimated_bytes(&export), expected);
    let manifest = bake(&export, &Session::default()).expect("bake");
    assert!((manifest.payload.len() as u64) < expected);
}

#[test]
fn estimate_shrinks_with_visible_scope() {
    let (store, pyramids) = store_with(&[("a", 100_000)]);
    let mut session = session_with(vec![panel("panel-1", &["a"])]);
    session.linked_time.t0 = 40_000.0;
    session.linked_time.t1 = 40_100.0;
    let visible = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::Visible,
        ExportFidelity::Standard,
    )
    .expect("visible plan");
    let all = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::All,
        ExportFidelity::Full,
    )
    .expect("all plan");
    assert!(estimated_bytes(&visible) < estimated_bytes(&all));
}

#[test]
fn estimate_bounds_the_serialized_manifest() {
    let mut store = SignalStore::new();
    let source = store
        .register_source("test.csv", SourceKey(uuid::Uuid::from_bytes([2; 16])), "")
        .unwrap();
    let time: Vec<f64> = (0..10_000).map(|value| f64::from(value) / 7.0).collect();
    let values: Vec<f64> = time.iter().map(|time| time.sin() * 13.0).collect();
    let id = store
        .insert_signal(source, "a".to_owned(), None, time, values)
        .expect("insert");
    let mut pyramids = BTreeMap::new();
    pyramids.insert(id, Pyramid::from_signal(store.signal(id).expect("signal")));
    let session = Session::default();
    let export = plan(
        &session,
        &store,
        &pyramids,
        ExportRange::All,
        ExportFidelity::Full,
    )
    .expect("plan");
    let estimated = estimated_bytes(&export);
    let actual = serde_json::to_vec(&bake(&export, &session).expect("bake"))
        .expect("serialize")
        .len() as u64;
    assert!(actual <= estimated);
}

#[test]
fn export_selection_filters_all_range_before_level_planning() {
    let mut store = SignalStore::new();
    let mut pyramids = BTreeMap::new();
    for key in [1_u8, 2] {
        let source = store
            .register_source(
                format!("run-{key}.csv"),
                SourceKey(uuid::Uuid::from_bytes([key; 16])),
                format!("run-{key}"),
            )
            .unwrap();
        let signal = store
            .insert_signal(source, "a", None, vec![0.0, 1.0], vec![0.0, 1.0])
            .unwrap();
        pyramids.insert(signal, Pyramid::from_signal(store.signal(signal).unwrap()));
    }
    let selected = store.sources().next().unwrap().key.0.to_string();
    let selection = ExportSelection {
        source_keys: vec![selected],
    };
    let plan = plan_selected(
        &Session::default(),
        &store,
        &pyramids,
        &selection,
        ExportRange::All,
        ExportFidelity::Full,
    )
    .unwrap();
    assert_eq!(plan.series_total, 1);
}

fn empty_manifest() -> scope_protocol::SnapshotManifest {
    scope_protocol::SnapshotManifest {
        preferences_json: None,
        session_json: "{}".to_owned(),
        payload: String::new(),
        signals: Vec::new(),
        line2d: None,
        histograms: None,
    }
}

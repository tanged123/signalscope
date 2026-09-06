use super::SnapshotError;
use crate::series_ref::path_from_ref;
use crate::session::{BindingKind, NamedSetKind, PanelState, SampleAxisSource, SeriesRef, Session};
use crate::store::{Signal, SignalId, SignalStore};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn panel_signal_ids(
    session: &Session,
    store: &SignalStore,
    panel: &PanelState,
) -> BTreeSet<SignalId> {
    let mut ids = panel_y_signal_ids(session, store, panel)
        .into_iter()
        .collect::<BTreeSet<_>>();
    let mut refs = x_refs(&panel.x_axis);
    if let Some(axis) = &panel.color_axis {
        refs.extend(x_refs(&axis.source));
    }
    for r#ref in refs {
        if let Some(signal) = signal_from_ref(session, store, r#ref) {
            ids.insert(signal.id);
        }
    }
    ids
}

fn panel_y_signal_ids(session: &Session, store: &SignalStore, panel: &PanelState) -> Vec<SignalId> {
    let mut ids = Vec::new();
    for binding in &panel.bindings {
        match binding.kind {
            BindingKind::Pick => append_refs(&mut ids, session, store, &binding.refs),
            BindingKind::Query => {
                if let Some(selector) = &binding.selector {
                    if let Some(signals) = matching_signals(store, selector) {
                        ids.extend(signals.map(|signal| signal.id));
                    }
                }
            }
            BindingKind::Set => {
                let Some(set) = session
                    .named_sets
                    .iter()
                    .find(|set| Some(set.id.as_str()) == binding.set_id.as_deref())
                else {
                    continue;
                };
                match set.kind {
                    NamedSetKind::Pick => append_refs(&mut ids, session, store, &set.refs),
                    NamedSetKind::Query => {
                        if let Some(selector) = &set.selector {
                            if let Some(signals) = matching_signals(store, selector) {
                                ids.extend(signals.map(|signal| signal.id));
                            }
                        }
                    }
                }
            }
        }
    }
    let mut seen = BTreeSet::new();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

fn append_refs(
    ids: &mut Vec<SignalId>,
    session: &Session,
    store: &SignalStore,
    refs: &[SeriesRef],
) {
    ids.extend(
        refs.iter()
            .filter_map(|reference| signal_from_ref(session, store, reference))
            .map(|signal| signal.id),
    );
}

fn signal_from_ref<'a>(
    session: &Session,
    store: &'a SignalStore,
    reference: &SeriesRef,
) -> Option<&'a Signal> {
    path_from_ref(&session.sources, reference)
        .and_then(|path| store.signal_by_path(&path))
        .or_else(|| {
            let source = store.sources().find(|source| {
                source.key.0.to_string() == reference.source_key
                    || source.prefix == reference.source_key
            })?;
            store
                .signals_of(source.id)
                .find(|signal| signal.local_path == reference.channel)
        })
}

fn matching_signals<'a>(
    store: &'a SignalStore,
    selector: &'a str,
) -> Option<impl Iterator<Item = &'a Signal>> {
    crate::selector::matching_signals(store, selector)
}

pub(super) fn line_combinations(
    session: &Session,
    store: &SignalStore,
) -> Result<Vec<(SignalId, Vec<SignalId>)>, SnapshotError> {
    let mut combinations = BTreeSet::new();
    for tab in &session.tabs {
        for panel in &tab.panels {
            if matches!(panel.x_axis, SampleAxisSource::Time) && panel.color_axis.is_none() {
                continue;
            }
            let mut groups = BTreeMap::<SignalId, Vec<SignalId>>::new();
            let mut color_units = BTreeSet::new();
            for y_id in panel_y_signal_ids(session, store, panel) {
                let y = store
                    .signal(y_id)
                    .ok_or(SnapshotError::MissingSignal(y_id))?;
                let source_key = super::source_key(store, y)?.0.to_string();
                let x_id = if matches!(panel.x_axis, SampleAxisSource::Time) {
                    y_id
                } else {
                    let Some(x) =
                        axis_signal(session, store, &panel.x_axis, &source_key, "X", false)?
                    else {
                        continue;
                    };
                    x.id
                };
                let ids = groups.entry(x_id).or_default();
                ids.push(y_id);
                if let Some(axis) = &panel.color_axis {
                    if !matches!(axis.source, SampleAxisSource::Time) {
                        let c = axis_signal(session, store, &axis.source, &source_key, "C", true)?
                            .ok_or_else(|| {
                                SnapshotError::MissingLineXReference("C signal unavailable".into())
                            })?;
                        color_units.insert(c.unit.clone());
                        if c.id != x_id {
                            ids.push(c.id);
                        }
                    }
                }
            }
            if color_units.len() > 1 {
                return Err(SnapshotError::MissingLineXReference(
                    "C signals must use the same unit".into(),
                ));
            }
            for (x_id, mut ys) in groups {
                ys.sort_unstable();
                ys.dedup();
                combinations.insert((x_id, ys));
            }
        }
    }
    Ok(combinations.into_iter().collect())
}

fn axis_signal<'a>(
    session: &Session,
    store: &'a SignalStore,
    axis: &SampleAxisSource,
    source_key: &str,
    role: &str,
    required: bool,
) -> Result<Option<&'a Signal>, SnapshotError> {
    let mut candidates = Vec::new();
    for reference in x_refs(axis) {
        let signal = signal_from_ref(session, store, reference);
        if !matches!(axis, SampleAxisSource::Bundle { .. })
            || signal.is_some_and(|signal| {
                super::source_key(store, signal).is_ok_and(|key| key.0.to_string() == source_key)
            })
        {
            candidates.push(signal);
        }
    }
    if candidates.len() != 1 {
        return Err(SnapshotError::MissingLineXReference(format!(
            "{role}: expected one member for source {source_key}"
        )));
    }
    let signal = candidates[0];
    if signal.is_none() && (required || matches!(axis, SampleAxisSource::Bundle { .. })) {
        return Err(SnapshotError::MissingLineXReference(format!(
            "{role}: signal unavailable for source {source_key}"
        )));
    }
    Ok(signal)
}

fn x_refs(axis: &SampleAxisSource) -> Vec<&SeriesRef> {
    match axis {
        SampleAxisSource::Time => vec![],
        SampleAxisSource::Signal { r#ref } => vec![r#ref],
        SampleAxisSource::Bundle { refs } => refs.iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SourceKey;
    use crate::{pyramid::Pyramid, session, snapshot};
    use scope_protocol::{ExportFidelity, ExportRange};

    fn colored_fixture() -> (
        session::Session,
        SignalStore,
        BTreeMap<SignalId, Pyramid>,
        Vec<SeriesRef>,
    ) {
        let mut session = session::from_json(include_str!(
            "../../../../protocol/testdata/session-conformance.json"
        ))
        .unwrap();
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../protocol/testdata/session-parser-cases.json"
        ))
        .unwrap();
        session.tabs.truncate(1);
        session.tabs[0].panels = vec![serde_json::from_value(fixture["panel"].clone()).unwrap()];
        let mut store = SignalStore::new();
        let mut pyramids = BTreeMap::new();
        let mut ys = Vec::new();
        let mut cs = Vec::new();
        for run in 1_u8..=2 {
            let key = SourceKey(uuid::Uuid::from_bytes([run; 16]));
            let source = store
                .register_source(format!("run{run}.csv"), key, format!("run{run}"))
                .unwrap();
            for (channel, values) in [("y", vec![1.0, 2.0, 3.0]), ("c", vec![10.0, 99.0, 20.0])] {
                let id = store
                    .insert_signal(
                        source,
                        channel,
                        Some("K".into()),
                        vec![0.0, 1.0, 2.0],
                        values,
                    )
                    .unwrap();
                pyramids.insert(id, Pyramid::from_signal(store.signal(id).unwrap()));
                let reference = SeriesRef {
                    source_key: key.0.to_string(),
                    channel: channel.into(),
                };
                if channel == "y" {
                    ys.push(reference);
                } else {
                    cs.push(reference);
                }
            }
        }
        let panel = &mut session.tabs[0].panels[0];
        panel.bindings = vec![crate::session::Binding {
            kind: BindingKind::Pick,
            refs: ys,
            selector: None,
            set_id: None,
        }];
        panel.color_axis = Some(crate::session::ColorAxis {
            source: SampleAxisSource::Bundle { refs: cs.clone() },
            range: None,
            label: None,
        });
        (session, store, pyramids, cs)
    }

    #[test]
    fn bundles_match_canonical_sources_for_prefix_refs_and_derived_display_prefix() {
        let (mut session, _, _, _) = colored_fixture();
        let mut store = SignalStore::new();
        let key = SourceKey(uuid::Uuid::from_bytes([7; 16]));
        let source = store.register_source("run.csv", key, "derived").unwrap();
        let x = store
            .insert_signal(source, "x", None, vec![0.0, 1.0], vec![1.0, 2.0])
            .unwrap();
        let y = store
            .insert_signal(source, "y", None, vec![0.0, 1.0], vec![3.0, 4.0])
            .unwrap();
        for source_key in [key.0.to_string(), "derived".into()] {
            let reference = SeriesRef {
                source_key,
                channel: "x".into(),
            };
            let panel = &mut session.tabs[0].panels[0];
            panel.bindings[0].refs = vec![SeriesRef {
                source_key: key.0.to_string(),
                channel: "y".into(),
            }];
            panel.x_axis = SampleAxisSource::Bundle {
                refs: vec![reference.clone()],
            };
            panel.color_axis.as_mut().unwrap().source = SampleAxisSource::Bundle {
                refs: vec![reference],
            };
            assert_eq!(
                line_combinations(&session, &store).unwrap(),
                vec![(x, vec![y])]
            );
        }
    }

    #[test]
    fn colored_time_bundles_capture_auxiliary_columns_and_validate_timebases() {
        let (mut session, mut store, mut pyramids, mut cs) = colored_fixture();
        let plan = snapshot::plan(
            &session,
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .unwrap();
        let manifest = snapshot::bake(&plan, &session).unwrap();
        let lines = manifest.line2d.unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|line| line.y_signal_ids.len() == 2));
        assert_eq!(
            lines[0].levels[0].ys[1],
            vec![Some(10.0), Some(99.0), Some(20.0)]
        );
        let source = store
            .register_source(
                "other.csv",
                SourceKey(uuid::Uuid::from_bytes([3; 16])),
                "other",
            )
            .unwrap();
        let id = store
            .insert_signal(
                source,
                "bad",
                Some("K".into()),
                vec![0.0, 1.5, 2.0],
                vec![1.0, 2.0, 3.0],
            )
            .unwrap();
        pyramids.insert(id, Pyramid::from_signal(store.signal(id).unwrap()));
        session.tabs[0].panels[0]
            .color_axis
            .as_mut()
            .unwrap()
            .source = SampleAxisSource::Signal {
            r#ref: SeriesRef {
                source_key: uuid::Uuid::from_bytes([3; 16]).to_string(),
                channel: "bad".into(),
            },
        };
        assert!(
            snapshot::plan(
                &session,
                &store,
                &pyramids,
                ExportRange::All,
                ExportFidelity::Full
            )
            .is_err()
        );
        cs.push(cs[0].clone());
        session.tabs[0].panels[0]
            .color_axis
            .as_mut()
            .unwrap()
            .source = SampleAxisSource::Bundle { refs: cs };
        assert!(
            snapshot::plan(
                &session,
                &store,
                &pyramids,
                ExportRange::All,
                ExportFidelity::Full
            )
            .is_err()
        );
    }

    #[test]
    fn bundle_snapshot_captures_each_sources_coordinates_and_rejects_ambiguity() {
        let mut session = session::from_json(include_str!(
            "../../../../protocol/testdata/session-conformance.json"
        ))
        .unwrap();
        let mut store = SignalStore::new();
        let mut pyramids = BTreeMap::new();
        let mut x_refs = Vec::new();
        let mut y_refs = Vec::new();
        for run in 1_u8..=2 {
            let key = SourceKey(uuid::Uuid::from_bytes([run; 16]));
            let source = store
                .register_source(format!("run{run}.csv"), key, format!("run{run}"))
                .unwrap();
            for (channel, values) in [
                ("x", vec![f64::from(run), 8.0, 3.0]),
                ("y", vec![4.0, 5.0, 6.0]),
            ] {
                let id = store
                    .insert_signal(source, channel, None, vec![0.0, 1.0, 2.0], values)
                    .unwrap();
                pyramids.insert(id, Pyramid::from_signal(store.signal(id).unwrap()));
                let reference = SeriesRef {
                    source_key: key.0.to_string(),
                    channel: channel.into(),
                };
                if channel == "x" {
                    x_refs.push(reference);
                } else {
                    y_refs.push(reference);
                }
            }
        }
        session.tabs.truncate(1);
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../protocol/testdata/session-parser-cases.json"
        ))
        .unwrap();
        session.tabs[0].panels = vec![serde_json::from_value(fixture["panel"].clone()).unwrap()];
        let panel = &mut session.tabs[0].panels[0];
        panel.bindings = vec![crate::session::Binding {
            kind: BindingKind::Pick,
            refs: y_refs,
            selector: None,
            set_id: None,
        }];
        panel.x_axis = SampleAxisSource::Bundle {
            refs: x_refs.clone(),
        };
        let plan = snapshot::plan(
            &session,
            &store,
            &pyramids,
            ExportRange::All,
            ExportFidelity::Full,
        )
        .unwrap();
        let manifest = snapshot::bake(&plan, &session).unwrap();
        let lines = manifest.line2d.unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].y_signal_ids.len(), 1);
        assert_eq!(lines[0].levels[0].x[0], Some(1.0));
        assert_eq!(lines[1].levels[0].x[0], Some(2.0));
        x_refs.push(x_refs[0].clone());
        session.tabs[0].panels[0].x_axis = SampleAxisSource::Bundle { refs: x_refs };
        assert!(
            snapshot::plan(
                &session,
                &store,
                &pyramids,
                ExportRange::All,
                ExportFidelity::Full
            )
            .is_err()
        );
    }
}

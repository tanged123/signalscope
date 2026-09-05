use super::SnapshotError;
use crate::series_ref::path_from_ref;
use crate::session::{BindingKind, NamedSetKind, PanelState, SeriesRef, Session, XAxisSource};
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
    for r#ref in x_refs(&panel.x_axis) {
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
            if matches!(panel.x_axis, XAxisSource::Time) {
                continue;
            }
            let refs = x_refs(&panel.x_axis);
            let mut groups = BTreeMap::<SignalId, Vec<SignalId>>::new();
            for y_id in panel_y_signal_ids(session, store, panel) {
                let y = store
                    .signal(y_id)
                    .ok_or(SnapshotError::MissingSignal(y_id))?;
                let source_key = if y.path.starts_with("derived/") {
                    "derived".to_owned()
                } else {
                    super::source_key(store, y)?.0.to_string()
                };
                let candidates = refs
                    .iter()
                    .filter(|x| {
                        !matches!(panel.x_axis, XAxisSource::Bundle { .. })
                            || x.source_key == source_key
                    })
                    .collect::<Vec<_>>();
                if candidates.len() != 1 {
                    if matches!(panel.x_axis, XAxisSource::Signal { .. }) && candidates.is_empty() {
                        continue;
                    }
                    return Err(SnapshotError::MissingLineXReference(format!(
                        "{}: expected one X member for source",
                        y.path
                    )));
                }
                let Some(x) = signal_from_ref(session, store, candidates[0]) else {
                    if matches!(panel.x_axis, XAxisSource::Signal { .. }) {
                        continue;
                    }
                    return Err(SnapshotError::MissingLineXReference(format!(
                        "{}/{}",
                        candidates[0].source_key, candidates[0].channel
                    )));
                };
                groups.entry(x.id).or_default().push(y_id);
            }
            for (x_id, mut ys) in groups {
                ys.sort_unstable();
                combinations.insert((x_id, ys));
            }
        }
    }
    Ok(combinations.into_iter().collect())
}

fn x_refs(axis: &XAxisSource) -> Vec<&SeriesRef> {
    match axis {
        XAxisSource::Time => vec![],
        XAxisSource::Signal { r#ref } => vec![r#ref],
        XAxisSource::Bundle { refs } => refs.iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SourceKey;
    use crate::{pyramid::Pyramid, session, snapshot};
    use scope_protocol::{ExportFidelity, ExportRange};

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
        panel.x_axis = XAxisSource::Bundle {
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
        session.tabs[0].panels[0].x_axis = XAxisSource::Bundle { refs: x_refs };
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

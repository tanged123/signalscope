//! Legacy session reference reconciliation after source restore.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use thiserror::Error;

use crate::{
    expr::{self, ExprError},
    naming,
    session::{FocusKind, NamedSetKind, SeriesRef, Session},
    sources::SourceRecord,
    store::SourceKey,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LegacyNaming {
    Csv,
    Mcap,
}

impl LegacyNaming {
    #[must_use]
    pub fn for_provider(provider_id: &str) -> Option<Self> {
        match provider_id {
            "csv" => Some(Self::Csv),
            "mcap" => Some(Self::Mcap),
            _ => None,
        }
    }

    fn path(self, record: &SourceRecord, local_path: &str) -> String {
        match self {
            Self::Csv => format!(
                "{}/{local_path}",
                naming::default_prefix(Path::new(&record.path))
            ),
            Self::Mcap => local_path.to_owned(),
        }
    }
}

#[must_use]
pub fn legacy_aliases(
    provider_id: &str,
    record: &SourceRecord,
    local_paths: &[String],
) -> BTreeMap<String, String> {
    let Some(naming) = LegacyNaming::for_provider(provider_id) else {
        return BTreeMap::new();
    };
    local_paths
        .iter()
        .map(|local| {
            (
                naming.path(record, local),
                format!("{}/{local}", record.prefix),
            )
        })
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AliasConflict {
    pub legacy_path: String,
    pub claimants: Vec<SourceKey>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BuiltAliases {
    pub aliases: BTreeMap<String, String>,
    pub conflicts: Vec<AliasConflict>,
}

#[derive(Debug, Default)]
pub struct AliasBuilder {
    claims: BTreeMap<String, BTreeMap<SourceKey, String>>,
}

impl AliasBuilder {
    pub fn add(&mut self, key: SourceKey, legacy_path: String, path: String) {
        self.claims
            .entry(legacy_path)
            .or_default()
            .insert(key, path);
    }

    #[must_use]
    pub fn build(self) -> BuiltAliases {
        let mut built = BuiltAliases::default();
        for (legacy_path, claims) in self.claims {
            if claims.len() == 1 {
                if let Some(path) = claims.into_values().next() {
                    built.aliases.insert(legacy_path, path);
                }
            } else {
                built.conflicts.push(AliasConflict {
                    legacy_path,
                    claimants: claims.into_keys().collect(),
                });
            }
        }
        built
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReconcileOutcome {
    pub rewritten: u64,
    pub conflicts: Vec<AliasConflict>,
    pub unresolved: Vec<String>,
}

#[derive(Debug, Error)]
pub enum ReconcileError {
    #[error(transparent)]
    Expression(#[from] ExprError),
}

/// Rewrites all durable signal references atomically.
///
/// # Errors
///
/// Returns an expression error without modifying `session`.
pub fn reconcile(
    session: &mut Session,
    aliases: &BTreeMap<String, String>,
    missing: &BTreeSet<SourceKey>,
) -> Result<ReconcileOutcome, ReconcileError> {
    let mut next = session.clone();
    let mut rewritten = 0;
    for set in &mut next.named_sets {
        if matches!(set.kind, NamedSetKind::Pick) {
            for reference in &mut set.refs {
                rewrite_ref(&next.sources, reference, aliases, &mut rewritten);
            }
        }
    }
    for tab in &mut next.tabs {
        for panel in &mut tab.panels {
            for binding in &mut panel.bindings {
                for reference in &mut binding.refs {
                    rewrite_ref(&next.sources, reference, aliases, &mut rewritten);
                }
            }
            for override_ in &mut panel.overrides {
                if let Some(reference) = &mut override_.target_ref {
                    rewrite_ref(&next.sources, reference, aliases, &mut rewritten);
                }
            }
            for focus in &mut panel.focus {
                if let Some(reference) = &mut focus.r#ref {
                    rewrite_ref(&next.sources, reference, aliases, &mut rewritten);
                }
                if matches!(focus.kind, FocusKind::Source) {
                    if let Some(source_key) = &mut focus.source_key {
                        rewrite(source_key, aliases, &mut rewritten);
                    }
                }
            }
            if let Some(reference) = &mut panel.x_ref {
                rewrite_ref(&next.sources, reference, aliases, &mut rewritten);
            }
            if let Some(reference) = &mut panel.color_ref {
                rewrite_ref(&next.sources, reference, aliases, &mut rewritten);
            }
            for annotation in &mut panel.annotations {
                rewrite(&mut annotation.series_path, aliases, &mut rewritten);
            }
        }
    }
    for derived in &mut next.derived {
        derived.expr = expr::rename_references(&derived.expr, aliases)?;
    }
    for derived in &mut next.derived_bundles {
        derived.expr = expr::rename_references(&derived.expr, aliases)?;
    }
    for record in &mut next.sources {
        let Ok(uuid) = uuid::Uuid::parse_str(&record.key) else {
            continue;
        };
        let key = SourceKey(uuid);
        if !missing.contains(&key)
            && aliases
                .values()
                .any(|path| path.starts_with(&format!("{}/", record.prefix)))
        {
            record.reconcile_legacy = false;
        }
    }
    let unresolved = next
        .sources
        .iter()
        .filter(|record| record.reconcile_legacy)
        .map(|record| record.key.clone())
        .collect();
    *session = next;
    Ok(ReconcileOutcome {
        rewritten,
        conflicts: Vec::new(),
        unresolved,
    })
}

fn rewrite(path: &mut String, aliases: &BTreeMap<String, String>, count: &mut u64) {
    if let Some(replacement) = aliases.get(path) {
        path.clone_from(replacement);
        *count += 1;
    }
}

fn rewrite_ref(
    sources: &[crate::session::SourceRecord],
    reference: &mut SeriesRef,
    aliases: &BTreeMap<String, String>,
    count: &mut u64,
) {
    let Some(path) = path_from_ref(sources, reference) else {
        return;
    };
    let Some(replacement) = aliases.get(&path) else {
        return;
    };
    let Some(rewritten) = ref_from_path(sources, replacement) else {
        return;
    };
    *reference = rewritten;
    *count += 1;
}

fn path_from_ref(
    sources: &[crate::session::SourceRecord],
    reference: &SeriesRef,
) -> Option<String> {
    if reference.source_key == "derived" {
        return Some(format!("derived/{}", reference.channel));
    }
    sources
        .iter()
        .find(|source| source.key == reference.source_key)
        .map(|source| format!("{}/{}", source.prefix, reference.channel))
}

fn ref_from_path(sources: &[crate::session::SourceRecord], path: &str) -> Option<SeriesRef> {
    if let Some(channel) = path.strip_prefix("derived/") {
        return Some(SeriesRef {
            source_key: "derived".into(),
            channel: channel.into(),
        });
    }
    sources
        .iter()
        .filter(|source| {
            path.len() > source.prefix.len() + 1
                && path.starts_with(&source.prefix)
                && path.as_bytes()[source.prefix.len()] == b'/'
        })
        .max_by_key(|source| source.prefix.len())
        .map(|source| SeriesRef {
            source_key: source.key.clone(),
            channel: path[source.prefix.len() + 1..].into(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        Annotation, AnnotationDomain, AxisStyle, Binding, BindingKind, ColorAxis, DerivedSignal,
        FocusEntry, FocusKind, GhostMode, NamedSet, NamedSetKind, OriginKindState, PanelMode,
        PanelState, SeriesOverride, SeriesRef, Session, SplitDimension, StyleDimension,
        TimeDomainState, TimeUnitState,
    };

    fn session_with(path: &str, expression: &str) -> Session {
        let mut session = Session {
            derived: vec![DerivedSignal {
                path: "derived/speed".into(),
                expr: expression.into(),
            }],
            named_sets: vec![NamedSet {
                id: "set-1".into(),
                name: path.into(),
                kind: NamedSetKind::Pick,
                selector: None,
                refs: vec![SeriesRef {
                    source_key: key(1).0.to_string(),
                    channel: path.into(),
                }],
            }],
            sources: vec![
                crate::session::SourceRecord {
                    key: key(1).0.to_string(),
                    path: "/data/run_a.csv".into(),
                    prefix: "run_a".into(),
                    provider_id: Some("mcap".into()),
                    decode_provenance: None,
                    reconcile_legacy: true,
                    time_domain: TimeDomainState {
                        unit: TimeUnitState::Seconds,
                        origin: OriginKindState::Relative,
                        alignment_origin: 0.0,
                    },
                    scale: 1.0,
                    offset: 0.0,
                },
                crate::session::SourceRecord {
                    key: key(2).0.to_string(),
                    path: "/data/run_b.csv".into(),
                    prefix: "run_b".into(),
                    provider_id: Some("mcap".into()),
                    decode_provenance: None,
                    reconcile_legacy: false,
                    time_domain: TimeDomainState {
                        unit: TimeUnitState::Seconds,
                        origin: OriginKindState::Relative,
                        alignment_origin: 0.0,
                    },
                    scale: 1.0,
                    offset: 0.0,
                },
            ],
            ..Session::default()
        };
        let reference = SeriesRef {
            source_key: key(1).0.to_string(),
            channel: path.into(),
        };
        session.tabs[0].panels.push(PanelState {
            id: "panel-a".into(),
            title: "A".into(),
            mode: PanelMode::Time,
            axis_style: AxisStyle::Gutter,
            x_ref: Some(reference.clone()),
            color_axis: ColorAxis::Signal,
            color_ref: Some(reference.clone()),
            bindings: vec![Binding {
                kind: BindingKind::Pick,
                selector: None,
                refs: vec![reference.clone()],
                set_id: None,
            }],
            color_by: StyleDimension::Source,
            overrides: vec![SeriesOverride {
                target_ref: Some(reference.clone()),
                target_selector: None,
                color_slot: Some(1),
                dash: None,
                width: None,
                opacity: None,
                visible: Some(true),
            }],
            focus: vec![FocusEntry {
                kind: FocusKind::Series,
                r#ref: Some(reference),
                source_key: None,
                channel: None,
            }],
            ghost_mode: GhostMode::All,
            split_by: SplitDimension::None,
            y_range: None,
            x_range: None,
            x_label: None,
            y_label: None,
            c_label: None,
            time_window: None,
            annotations: vec![Annotation {
                id: "ann".into(),
                series_path: path.into(),
                domain: AnnotationDomain::Time,
                anchor: 0.0,
                pinned_value: 0.0,
                label: "x".into(),
            }],
            show_stats: false,
        });
        session
    }

    #[test]
    fn mcap_bare_paths_are_rewritten_everywhere() {
        let mut session = session_with("vehicle/imu/ax", "'vehicle/imu/ax' * 2");
        let aliases = BTreeMap::from([
            ("run_a/vehicle/imu/ax".into(), "run_b/vehicle/imu/ax".into()),
            ("vehicle/imu/ax".into(), "run_a/vehicle/imu/ax".into()),
        ]);

        let outcome = reconcile(&mut session, &aliases, &BTreeSet::new()).unwrap();
        assert_eq!(outcome.rewritten, 7);
        let panel = &session.tabs[0].panels[0];
        assert_eq!(panel.bindings[0].refs[0].source_key, key(2).0.to_string());
        assert_eq!(
            panel.x_ref.as_ref().unwrap().source_key,
            key(2).0.to_string()
        );
        assert_eq!(
            panel.color_ref.as_ref().unwrap().source_key,
            key(2).0.to_string()
        );
        assert_eq!(
            panel.overrides[0].target_ref.as_ref().unwrap().source_key,
            key(2).0.to_string()
        );
        assert_eq!(
            panel.focus[0].r#ref.as_ref().unwrap().source_key,
            key(2).0.to_string()
        );
        assert_eq!(panel.annotations[0].series_path, "run_a/vehicle/imu/ax");
        assert_eq!(
            session.named_sets[0].refs[0].source_key,
            key(2).0.to_string()
        );
        assert_eq!(session.derived[0].expr, "'run_a/vehicle/imu/ax' * 2");
    }

    #[test]
    fn conflicting_claims_are_reported_and_dropped() {
        let mut builder = AliasBuilder::default();
        builder.add(key(1), "imu/ax".into(), "run_a/imu/ax".into());
        builder.add(key(2), "imu/ax".into(), "run_b/imu/ax".into());
        let built = builder.build();

        assert!(built.aliases.is_empty());
        assert_eq!(built.conflicts[0].legacy_path, "imu/ax");
        assert_eq!(built.conflicts[0].claimants, vec![key(1), key(2)]);
    }

    #[test]
    fn invalid_derived_expression_aborts_the_rewrite() {
        let mut session = session_with("imu/ax", "'imu/ax' +");
        let before = session.clone();
        let aliases = BTreeMap::from([("imu/ax".into(), "run/imu/ax".into())]);
        assert!(reconcile(&mut session, &aliases, &BTreeSet::new()).is_err());
        assert_eq!(session, before);
    }

    #[test]
    fn rewrites_full_paths_inside_derived_bundle_definitions() {
        let mut session = Session {
            derived_bundles: vec![crate::session::DerivedBundleState {
                name: "score".into(),
                expr: "'vehicle/imu/ax' + 'temp'".into(),
            }],
            ..Session::default()
        };
        let aliases = BTreeMap::from([("vehicle/imu/ax".into(), "run/vehicle/imu/ax".into())]);
        reconcile(&mut session, &aliases, &BTreeSet::new()).unwrap();
        assert_eq!(
            session.derived_bundles[0].expr,
            "'run/vehicle/imu/ax' + 'temp'"
        );
    }

    #[test]
    fn provider_rules_build_legacy_aliases() {
        let record = crate::sources::SourceRecord {
            key: key(1),
            path: "/data/Flight Test.csv".into(),
            prefix: "run_a".into(),
            provider_id: None,
            decode_provenance: None,
            reconcile_legacy: true,
            time_domain: crate::alignment::TimeDomain::default(),
            transform: crate::alignment::AffineTransform {
                scale: 1.0,
                offset: 0.0,
            },
        };
        let paths = vec!["imu/ax".into()];
        assert_eq!(
            legacy_aliases("csv", &record, &paths)["flight_test/imu/ax"],
            "run_a/imu/ax"
        );
        assert_eq!(
            legacy_aliases("mcap", &record, &paths)["imu/ax"],
            "run_a/imu/ax"
        );
        assert!(legacy_aliases("unknown", &record, &paths).is_empty());
    }

    #[test]
    fn legacy_marker_clears_only_after_its_source_has_aliases() {
        let mut session = session_with("imu/ax", "'imu/ax'");
        session.sources[0].prefix = "run".into();
        session.sources[0].path = "/data/run.csv".into();
        let aliases = BTreeMap::from([("imu/ax".into(), "run/imu/ax".into())]);
        reconcile(&mut session, &aliases, &BTreeSet::new()).unwrap();
        assert!(!session.sources[0].reconcile_legacy);

        session.sources[0].reconcile_legacy = true;
        let outcome = reconcile(&mut session, &BTreeMap::new(), &BTreeSet::from([key(1)])).unwrap();
        assert_eq!(outcome.unresolved, vec![key(1).0.to_string()]);
        assert!(session.sources[0].reconcile_legacy);
    }

    fn key(byte: u8) -> SourceKey {
        SourceKey(uuid::Uuid::from_bytes([byte; 16]))
    }
}

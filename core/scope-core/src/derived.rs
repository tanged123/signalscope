//! Derived definitions, dependency checks, and materialization over core storage.

use crate::{
    cache::{self, CacheRoot},
    columns::Column,
    derived_bundle::SkippedMember,
    expr,
    ingest::admission::{MemoryBudget, ResidentCharge},
    pyramid::Pyramid,
    store::{Signal, SignalId, SignalStore, SourceId, SourceKey},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

const DERIVED_PREFIX: &str = "derived/";
type BundleInputs = (
    BTreeSet<String>,
    BTreeMap<SourceKey, (String, BTreeSet<String>)>,
);

#[derive(Default)]
pub struct DerivedSignals {
    source_id: Option<SourceId>,
    references: BTreeMap<String, Vec<String>>,
    bundles: BTreeMap<String, String>,
    charges: BTreeMap<String, ResidentCharge>,
}

pub struct DerivedContext<'a> {
    pub state: &'a mut DerivedSignals,
    pub store: &'a mut SignalStore,
    pub pyramids: &'a mut BTreeMap<SignalId, Pyramid>,
    pub budget: &'a MemoryBudget,
    pub cache_root: &'a Path,
}

pub struct MaterializedBundle {
    pub local_path: String,
    pub created: Vec<SignalId>,
    pub skipped: Vec<SkippedMember>,
}

struct PreparedDerived {
    time: std::sync::Arc<[f64]>,
    values: Column,
    charge: Option<ResidentCharge>,
}

impl DerivedContext<'_> {
    fn dependents(&self, path: &str) -> Vec<&str> {
        self.state
            .references
            .iter()
            .filter(|(derived, references)| {
                derived.as_str() != path && references.iter().any(|reference| reference == path)
            })
            .map(|(derived, _)| derived.as_str())
            .collect()
    }

    fn ensure_owned_derived(&self, path: &str) -> Result<(), String> {
        let Some(signal) = self.store.signal_by_path(path) else {
            return Ok(());
        };
        if Some(signal.source_id) != self.state.source_id {
            return Err(format!("signal path belongs to an ingested source: {path}"));
        }
        Ok(())
    }

    fn ensure_without_dependents(&self, path: &str, action: &str) -> Result<(), String> {
        let dependents = self.dependents(path);
        if dependents.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "cannot {action} {path}; dependent derived signals: {}",
                dependents.join(", ")
            ))
        }
    }

    fn bundle_inputs(&self) -> BundleInputs {
        let full_paths = self
            .store
            .signals()
            .map(|signal| signal.path.clone())
            .collect();
        let mut locals = BTreeMap::new();
        for source in self
            .store
            .sources()
            .filter(|source| Some(source.id) != self.state.source_id)
        {
            locals.insert(
                source.key,
                (
                    source.prefix.clone(),
                    self.store
                        .signals_of(source.id)
                        .map(|signal| signal.local_path.clone())
                        .collect(),
                ),
            );
        }
        (full_paths, locals)
    }

    fn materialize_derived(
        &mut self,
        path: String,
        source_id: SourceId,
        evaluated: expr::Evaluated,
        references: Vec<String>,
    ) -> Result<SignalId, String> {
        let prepared = self.prepare_values(evaluated, &references)?;
        self.publish_derived(path, source_id, prepared, references)
    }

    fn prepare_values(
        &self,
        evaluated: expr::Evaluated,
        references: &[String],
    ) -> Result<PreparedDerived, String> {
        let bytes = evaluated.values.len().saturating_mul(size_of::<f64>());
        let charge = self
            .budget
            .acquire_working(bytes)
            .and_then(crate::ingest::admission::Ticket::transfer_to_resident)
            .ok();
        let values = if charge.is_some() {
            Column::from(evaluated.values)
        } else {
            let timebase_id = references
                .first()
                .and_then(|reference| self.store.signal_by_path(reference))
                .map(Signal::timebase_id)
                .ok_or_else(|| "derived expression has no timebase".to_owned())?;
            let handle = cache::spill_columns(
                &CacheRoot::app_owned(self.cache_root),
                timebase_id,
                &evaluated.time,
                &evaluated.values,
            )
            .map_err(|error| error.to_string())?;
            Column::paged(handle)
        };
        Ok(PreparedDerived {
            time: evaluated.time,
            values,
            charge,
        })
    }

    fn publish_derived(
        &mut self,
        path: String,
        source_id: SourceId,
        prepared: PreparedDerived,
        references: Vec<String>,
    ) -> Result<SignalId, String> {
        let signal_id = self
            .store
            .insert_signal(source_id, path, None, prepared.time, prepared.values)
            .map_err(|error| error.to_string())?;
        let signal = self
            .store
            .signal(signal_id)
            .ok_or_else(|| "derived signal vanished after insertion".to_owned())?;
        let path = signal.path.clone();
        let pyramid = Pyramid::from_signal(signal);
        self.pyramids.insert(signal_id, pyramid);
        self.state.references.insert(path.clone(), references);
        if let Some(charge) = prepared.charge {
            self.state.charges.insert(path, charge);
        }
        Ok(signal_id)
    }

    /// Evaluates and publishes a derived signal, rejecting dependent replacement.
    ///
    /// # Errors
    /// Returns an error for invalid expressions, dependencies, storage, or spill IO.
    pub fn create_derived_signal(
        &mut self,
        path: &str,
        expression: &str,
    ) -> Result<SignalId, String> {
        let local_path = path.strip_prefix(DERIVED_PREFIX).unwrap_or(path).to_owned();
        let path = format!("{DERIVED_PREFIX}{local_path}");
        self.ensure_owned_derived(&path)?;
        if self.store.signal_by_path(&path).is_some() {
            self.ensure_without_dependents(&path, "replace")?;
        }
        let parsed = expr::parse(expression).map_err(|error| error.to_string())?;
        let references = expr::references(&parsed);
        let evaluated = expr::evaluate(&parsed, self.store).map_err(|error| error.to_string())?;
        let prepared = self.prepare_values(evaluated, &references)?;
        let source_id = if let Some(id) = self.state.source_id {
            id
        } else {
            let id = self
                .store
                .register_source(
                    DERIVED_PREFIX,
                    SourceKey(uuid::Uuid::new_v4()),
                    DERIVED_PREFIX.trim_end_matches('/'),
                )
                .map_err(|error| error.to_string())?;
            self.state.source_id = Some(id);
            id
        };
        if let Some(previous) = self.store.remove_signal(&path) {
            self.pyramids.remove(&previous);
        }
        self.state.charges.remove(&path);
        self.publish_derived(local_path, source_id, prepared, references)
    }

    /// Expands a definition across eligible sources and reports skipped members.
    ///
    /// # Errors
    /// Returns an error for invalid or duplicate names and invalid bundle expressions.
    pub fn create_derived_bundle(
        &mut self,
        name: &str,
        expression: &str,
    ) -> Result<MaterializedBundle, String> {
        let name = name.strip_prefix(DERIVED_PREFIX).unwrap_or(name).to_owned();
        if name.is_empty() {
            return Err("derived bundle name is empty".into());
        }
        if name.contains('/') {
            return Err("derived bundle names are a single segment".into());
        }
        if self.state.bundles.contains_key(&name) {
            return Err(format!("derived bundle already exists: {name}"));
        }
        let (full_paths, locals) = self.bundle_inputs();
        let expansion = crate::derived_bundle::expand(expression, &full_paths, &locals)
            .map_err(|error| error.to_string())?;
        let mut skipped = expansion.skipped;
        let local_path = format!("{DERIVED_PREFIX}{name}");
        let mut created = Vec::new();
        for member in expansion.members {
            let Some(source_id) = self
                .store
                .sources()
                .find(|source| source.key == member.source_key)
                .map(|source| source.id)
            else {
                continue;
            };
            let parsed = match expr::parse(&member.expr) {
                Ok(parsed) => parsed,
                Err(error) => {
                    skipped.push(SkippedMember {
                        prefix: member.prefix,
                        missing: vec![error.to_string()],
                    });
                    continue;
                }
            };
            let references = expr::references(&parsed);
            let evaluated = match expr::evaluate(&parsed, self.store) {
                Ok(evaluated) => evaluated,
                Err(error) => {
                    skipped.push(SkippedMember {
                        prefix: member.prefix,
                        missing: vec![error.to_string()],
                    });
                    continue;
                }
            };
            match self.materialize_derived(local_path.clone(), source_id, evaluated, references) {
                Ok(summary) => created.push(summary),
                Err(error) => skipped.push(SkippedMember {
                    prefix: member.prefix,
                    missing: vec![error],
                }),
            }
        }
        skipped.sort_by(|left, right| left.prefix.cmp(&right.prefix));
        self.state.bundles.insert(name, expression.to_owned());
        Ok(MaterializedBundle {
            local_path,
            created,
            skipped,
        })
    }

    pub fn reexpand_derived_bundles(&mut self) {
        let definitions: Vec<(String, String)> = self
            .state
            .bundles
            .iter()
            .map(|(name, expr)| (name.clone(), expr.clone()))
            .collect();
        for (name, expression) in definitions {
            let (full_paths, locals) = self.bundle_inputs();
            let Ok(expansion) = crate::derived_bundle::expand(&expression, &full_paths, &locals)
            else {
                continue;
            };
            for member in expansion.members {
                let Some(source_id) = self
                    .store
                    .sources()
                    .find(|source| source.key == member.source_key)
                    .map(|source| source.id)
                else {
                    continue;
                };
                let display_path = format!("{}/{}{}", member.prefix, DERIVED_PREFIX, name);
                if self.store.signal_by_path(&display_path).is_some() {
                    continue;
                }
                let Ok(parsed) = expr::parse(&member.expr) else {
                    continue;
                };
                let references = expr::references(&parsed);
                let Ok(evaluated) = expr::evaluate(&parsed, self.store) else {
                    continue;
                };
                let _ = self.materialize_derived(
                    format!("{DERIVED_PREFIX}{name}"),
                    source_id,
                    evaluated,
                    references,
                );
            }
        }
    }

    /// Removes a bundle only when none of its members has dependents.
    ///
    /// # Errors
    /// Returns an error before any removal when another definition needs a member.
    pub fn remove_derived_bundle(&mut self, name: &str) -> Result<(), String> {
        let name = name.strip_prefix(DERIVED_PREFIX).unwrap_or(name);
        let local_path = format!("{DERIVED_PREFIX}{name}");
        let paths: Vec<String> = self
            .store
            .signals()
            .filter(|signal| signal.local_path == local_path)
            .map(|signal| signal.path.clone())
            .collect();
        for path in &paths {
            self.ensure_without_dependents(path, "remove")?;
        }
        for path in paths {
            if let Some(id) = self.store.remove_signal(&path) {
                self.pyramids.remove(&id);
            }
            self.state.charges.remove(&path);
            self.state.references.remove(&path);
        }
        self.state.bundles.remove(name);
        Ok(())
    }

    /// Removes an owned derived signal and releases its resources.
    ///
    /// # Errors
    /// Returns an error for ingested signals or signals with dependents.
    pub fn remove_derived_signal(&mut self, path: &str) -> Result<(), String> {
        if !path.starts_with(DERIVED_PREFIX) {
            return Err(format!(
                "only derived signals can be removed individually: {path}"
            ));
        }
        self.ensure_owned_derived(path)?;
        if self.store.signal_by_path(path).is_none() {
            return Ok(());
        }
        self.ensure_without_dependents(path, "remove")?;
        if let Some(id) = self.store.remove_signal(path) {
            self.pyramids.remove(&id);
        }
        self.state.charges.remove(path);
        self.state.references.remove(path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::admission::BudgetConfig;

    fn add_source(store: &mut SignalStore, prefix: &str, channel: &str) {
        let source = store
            .register_source(
                format!("{prefix}.csv"),
                SourceKey(uuid::Uuid::new_v4()),
                prefix,
            )
            .unwrap();
        store
            .insert_signal(
                source,
                channel,
                None,
                vec![0.0, 1.0, 2.0],
                vec![1.0, 2.0, 3.0],
            )
            .unwrap();
    }

    #[test]
    fn failed_spill_publishes_nothing_and_preserves_a_previous_definition() {
        let dir = tempfile::tempdir().unwrap();
        let invalid_root = tempfile::NamedTempFile::new().unwrap();
        let mut store = SignalStore::new();
        add_source(&mut store, "run", "value");
        let mut context = DerivedContext {
            state: &mut DerivedSignals::default(),
            store: &mut store,
            pyramids: &mut BTreeMap::new(),
            cache_root: invalid_root.path(),
            budget: &MemoryBudget::new(BudgetConfig {
                working_bytes: 1,
                resident_bytes: 1,
            }),
        };
        assert!(
            context
                .create_derived_signal("a", "'run/value' * 2")
                .is_err()
        );
        assert_eq!(context.store.sources().count(), 1);
        assert_eq!(context.store.signals().count(), 1);
        assert!(context.state.references.is_empty());
        context.cache_root = dir.path();
        let id = context
            .create_derived_signal("a", "'run/value' * 2")
            .unwrap();
        context.cache_root = invalid_root.path();
        assert!(
            context
                .create_derived_signal("a", "'run/value' * 3")
                .is_err()
        );
        assert_eq!(context.store.signal_by_path("derived/a").unwrap().id, id);
        assert_eq!(
            &*context.store.signal(id).unwrap().values(),
            &[2.0, 4.0, 6.0]
        );
        assert!(context.pyramids.contains_key(&id));
    }

    #[test]
    fn dependencies_block_removal_and_replacement_without_changing_data() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SignalStore::new();
        add_source(&mut store, "run", "value");
        let mut context = DerivedContext {
            state: &mut DerivedSignals::default(),
            store: &mut store,
            pyramids: &mut BTreeMap::new(),
            cache_root: dir.path(),
            budget: &MemoryBudget::new(BudgetConfig {
                working_bytes: 1024,
                resident_bytes: 1024,
            }),
        };
        let original = context
            .create_derived_signal("a", "'run/value' * 2")
            .unwrap();
        context
            .create_derived_signal("b", "'derived/a' + 1")
            .unwrap();
        assert!(
            context
                .remove_derived_signal("derived/a")
                .unwrap_err()
                .contains("dependent")
        );
        assert!(
            context
                .create_derived_signal("a", "'run/value' * 3")
                .unwrap_err()
                .contains("dependent")
        );
        assert_eq!(
            context.store.signal_by_path("derived/a").unwrap().id,
            original
        );
        assert_eq!(
            &*context.store.signal(original).unwrap().values(),
            &[2.0, 4.0, 6.0]
        );
        assert!(context.remove_derived_signal("run/value").is_err());
        context.remove_derived_signal("derived/b").unwrap();
        context.remove_derived_signal("derived/a").unwrap();
        assert_eq!(context.budget.resident_used(), 0);
        assert!(context.pyramids.is_empty());
    }

    #[test]
    fn bundles_expand_new_sources_and_validate_every_member_before_removal() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SignalStore::new();
        add_source(&mut store, "first", "value");
        add_source(&mut store, "missing", "other");
        let mut context = DerivedContext {
            state: &mut DerivedSignals::default(),
            store: &mut store,
            pyramids: &mut BTreeMap::new(),
            cache_root: dir.path(),
            budget: &MemoryBudget::new(BudgetConfig {
                working_bytes: 1024,
                resident_bytes: 1024,
            }),
        };
        let bundle = context
            .create_derived_bundle("scaled", "'value' * 2")
            .unwrap();
        assert_eq!(bundle.created.len(), 1);
        assert_eq!(bundle.skipped[0].prefix, "missing");
        assert!(
            context
                .create_derived_bundle("scaled", "'value' * 3")
                .is_err()
        );
        add_source(context.store, "second", "value");
        context.reexpand_derived_bundles();
        let second = context
            .store
            .signal_by_path("second/derived/scaled")
            .unwrap()
            .id;
        context.reexpand_derived_bundles();
        assert_eq!(
            context
                .store
                .signal_by_path("second/derived/scaled")
                .unwrap()
                .id,
            second
        );
        context
            .create_derived_signal("consumer", "'second/derived/scaled' + 1")
            .unwrap();
        assert!(context.remove_derived_bundle("scaled").is_err());
        assert!(
            context
                .store
                .signal_by_path("first/derived/scaled")
                .is_some()
        );
        context.remove_derived_signal("derived/consumer").unwrap();
        context.remove_derived_bundle("scaled").unwrap();
        assert!(
            context
                .store
                .signal_by_path("first/derived/scaled")
                .is_none()
        );
        assert!(
            context
                .store
                .signal_by_path("second/derived/scaled")
                .is_none()
        );
    }

    #[test]
    fn removing_a_spilled_signal_keeps_active_readers_alive() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SignalStore::new();
        add_source(&mut store, "run", "value");
        let mut context = DerivedContext {
            state: &mut DerivedSignals::default(),
            store: &mut store,
            pyramids: &mut BTreeMap::new(),
            cache_root: dir.path(),
            budget: &MemoryBudget::new(BudgetConfig {
                working_bytes: 1,
                resident_bytes: 1,
            }),
        };
        let id = context
            .create_derived_signal("a", "'run/value' * 2")
            .unwrap();
        let reader = context.store.signal(id).unwrap().clone();
        let Column::Paged(handle) = reader.values_column() else {
            panic!("expected spill")
        };
        let path = handle.path().to_owned();
        context.remove_derived_signal("derived/a").unwrap();
        assert!(path.exists());
        assert_eq!(&*reader.values_column().range(1..3).unwrap(), &[4.0, 6.0]);
        drop(reader);
        assert!(!path.exists());
    }
}

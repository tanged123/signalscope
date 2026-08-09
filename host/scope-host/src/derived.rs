use std::collections::{BTreeMap, BTreeSet};

use scope_core::{
    cache::{self, CacheRoot},
    columns::Column,
    expr,
    gaps::GapRuns,
    ingest::admission::Ticket,
    pyramid::Pyramid,
    store::{Signal, SourceId, SourceKey},
};
use scope_protocol::{
    CreateDerivedBundleRequest, DerivedBundleResponse, DerivedRequest, RemoveDerivedBundleRequest,
    RemoveSignalRequest, SignalSummary, SkippedMemberSummary,
};

use crate::{HostError, ScopeHost, catalog::signal_summary, state::DataState};

const DERIVED_PREFIX: &str = "derived/";

fn invalid(message: impl Into<String>) -> HostError {
    HostError::Invalid {
        code: "invalid_request",
        message: message.into(),
    }
}

type BundleInputs = (
    BTreeSet<String>,
    BTreeMap<SourceKey, (String, BTreeSet<String>)>,
);

impl ScopeHost {
    pub fn create_derived(&self, request: DerivedRequest) -> Result<SignalSummary, HostError> {
        self.inner()
            .state
            .lock()
            .map_err(|error| invalid(error.to_string()))?
            .create_derived_signal(request)
    }

    pub fn remove_signal(&self, request: RemoveSignalRequest) -> Result<(), HostError> {
        self.inner()
            .state
            .lock()
            .map_err(|error| invalid(error.to_string()))?
            .remove_derived_signal(&request.path)
    }

    pub fn create_derived_bundle(
        &self,
        request: CreateDerivedBundleRequest,
    ) -> Result<DerivedBundleResponse, HostError> {
        self.inner()
            .state
            .lock()
            .map_err(|error| invalid(error.to_string()))?
            .create_derived_bundle(request)
    }

    pub fn remove_derived_bundle(
        &self,
        request: RemoveDerivedBundleRequest,
    ) -> Result<(), HostError> {
        self.inner()
            .state
            .lock()
            .map_err(|error| invalid(error.to_string()))?
            .remove_derived_bundle(&request)
    }
}

impl DataState {
    fn dependents(&self, path: &str) -> Vec<&str> {
        self.derived_references
            .iter()
            .filter(|(derived, references)| {
                derived.as_str() != path && references.iter().any(|reference| reference == path)
            })
            .map(|(derived, _)| derived.as_str())
            .collect()
    }

    fn ensure_owned_derived(&self, path: &str) -> Result<(), HostError> {
        if let Some(signal) = self.store.signal_by_path(path) {
            if Some(signal.source_id) != self.derived_source {
                return Err(invalid(format!(
                    "signal path belongs to an ingested source: {path}"
                )));
            }
        }
        Ok(())
    }

    fn ensure_without_dependents(&self, path: &str, action: &str) -> Result<(), HostError> {
        let dependents = self.dependents(path);
        if dependents.is_empty() {
            Ok(())
        } else {
            Err(invalid(format!(
                "cannot {action} {path}; dependent derived signals: {}",
                dependents.join(", ")
            )))
        }
    }

    fn remove_spill(&mut self, path: &str) {
        let Some(handle) = self.derived_spills.remove(path) else {
            return;
        };
        if !self
            .derived_spills
            .values()
            .any(|other| other.path() == handle.path())
        {
            let _ = std::fs::remove_file(handle.path());
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
            .filter(|source| Some(source.id) != self.derived_source)
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
    ) -> Result<SignalSummary, HostError> {
        let gap_runs = GapRuns::from_values(&evaluated.values);
        let bytes = evaluated
            .values
            .len()
            .saturating_mul(std::mem::size_of::<f64>());
        let charge = self
            .budget
            .acquire_working(bytes)
            .and_then(Ticket::transfer_to_resident)
            .ok();
        let (values, spill) = if charge.is_some() {
            (Column::from(evaluated.values), None)
        } else {
            let timebase_id = references
                .first()
                .and_then(|reference| self.store.signal_by_path(reference))
                .map(Signal::timebase_id)
                .ok_or_else(|| invalid("derived expression has no timebase"))?;
            let handle = cache::spill_columns(
                &CacheRoot::app_owned(&self.cache_root),
                timebase_id,
                &evaluated.time,
                &evaluated.values,
            )
            .map_err(|error| invalid(error.to_string()))?;
            (Column::paged(handle.clone()), Some(handle))
        };
        let signal_id = self
            .store
            .insert_signal_with_gaps(source_id, path, None, evaluated.time, values, gap_runs)
            .map_err(|error| invalid(error.to_string()))?;
        let signal = self
            .store
            .signal(signal_id)
            .ok_or_else(|| invalid("derived signal vanished after insertion"))?;
        let source_key = self
            .store
            .sources()
            .find(|source| source.id == source_id)
            .expect("derived source")
            .key;
        let pyramid =
            Pyramid::try_from_signal(signal).map_err(|error| invalid(error.to_string()))?;
        let summary = signal_summary(signal, source_key, pyramid.last_finite_value());
        self.pyramids.insert(signal_id, pyramid);
        self.derived_references
            .insert(summary.path.clone(), references);
        if let Some(handle) = spill {
            self.derived_spills.insert(summary.path.clone(), handle);
        }
        if let Some(charge) = charge {
            self.derived_charges.insert(summary.path.clone(), charge);
        }
        Ok(summary)
    }

    fn create_derived_signal(
        &mut self,
        request: DerivedRequest,
    ) -> Result<SignalSummary, HostError> {
        let path = if request.path.starts_with(DERIVED_PREFIX) {
            request.path
        } else {
            format!("{DERIVED_PREFIX}{}", request.path)
        };
        self.ensure_owned_derived(&path)?;
        if self.store.signal_by_path(&path).is_some() {
            self.ensure_without_dependents(&path, "replace")?;
        }
        let parsed = expr::parse(&request.expr).map_err(|error| invalid(error.to_string()))?;
        let references = expr::references(&parsed);
        let evaluated =
            expr::evaluate(&parsed, &self.store).map_err(|error| invalid(error.to_string()))?;
        let source_id = if let Some(id) = self.derived_source {
            id
        } else {
            let id = self
                .store
                .register_source(
                    DERIVED_PREFIX,
                    SourceKey(uuid::Uuid::new_v4()),
                    DERIVED_PREFIX.trim_end_matches('/'),
                )
                .map_err(|error| invalid(error.to_string()))?;
            self.derived_source = Some(id);
            id
        };
        if let Some(previous) = self.store.remove_signal(&path) {
            self.pyramids.remove(&previous);
        }
        self.remove_spill(&path);
        self.derived_charges.remove(&path);
        self.materialize_derived(
            path.trim_start_matches(DERIVED_PREFIX).to_owned(),
            source_id,
            evaluated,
            references,
        )
    }

    fn create_derived_bundle(
        &mut self,
        request: CreateDerivedBundleRequest,
    ) -> Result<DerivedBundleResponse, HostError> {
        let name = request
            .name
            .strip_prefix(DERIVED_PREFIX)
            .unwrap_or(&request.name)
            .to_owned();
        if name.is_empty() {
            return Err(invalid("derived bundle name is empty"));
        }
        if name.contains('/') {
            return Err(invalid("derived bundle names are a single segment"));
        }
        if self.derived_bundles.contains_key(&name) {
            return Err(invalid(format!("derived bundle already exists: {name}")));
        }
        let (full_paths, locals) = self.bundle_inputs();
        let expansion = scope_core::derived_bundle::expand(&request.expr, &full_paths, &locals)
            .map_err(|error| invalid(error.to_string()))?;
        let mut skipped: Vec<SkippedMemberSummary> = expansion
            .skipped
            .into_iter()
            .map(|member| SkippedMemberSummary {
                prefix: member.prefix,
                missing: member.missing,
            })
            .collect();
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
                    skipped.push(SkippedMemberSummary {
                        prefix: member.prefix,
                        missing: vec![error.to_string()],
                    });
                    continue;
                }
            };
            let references = expr::references(&parsed);
            let evaluated = match expr::evaluate(&parsed, &self.store) {
                Ok(evaluated) => evaluated,
                Err(error) => {
                    skipped.push(SkippedMemberSummary {
                        prefix: member.prefix,
                        missing: vec![error.to_string()],
                    });
                    continue;
                }
            };
            match self.materialize_derived(local_path.clone(), source_id, evaluated, references) {
                Ok(summary) => created.push(summary),
                Err(error) => skipped.push(SkippedMemberSummary {
                    prefix: member.prefix,
                    missing: vec![error.to_string()],
                }),
            }
        }
        skipped.sort_by(|left, right| left.prefix.cmp(&right.prefix));
        self.derived_bundles.insert(name, request.expr);
        Ok(DerivedBundleResponse {
            local_path,
            created,
            skipped,
        })
    }

    pub(crate) fn reexpand_derived_bundles(&mut self) {
        let definitions: Vec<(String, String)> = self
            .derived_bundles
            .iter()
            .map(|(name, expression)| (name.clone(), expression.clone()))
            .collect();
        for (name, expression) in definitions {
            let (full_paths, locals) = self.bundle_inputs();
            let Ok(expansion) =
                scope_core::derived_bundle::expand(&expression, &full_paths, &locals)
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
                let Ok(evaluated) = expr::evaluate(&parsed, &self.store) else {
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

    fn remove_derived_bundle(
        &mut self,
        request: &RemoveDerivedBundleRequest,
    ) -> Result<(), HostError> {
        let name = request
            .name
            .strip_prefix(DERIVED_PREFIX)
            .unwrap_or(&request.name);
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
            self.remove_spill(&path);
            self.derived_charges.remove(&path);
            self.derived_references.remove(&path);
        }
        self.derived_bundles.remove(name);
        Ok(())
    }

    fn remove_derived_signal(&mut self, path: &str) -> Result<(), HostError> {
        if !path.starts_with(DERIVED_PREFIX) {
            return Err(invalid(format!(
                "only derived signals can be removed individually: {path}"
            )));
        }
        self.ensure_owned_derived(path)?;
        if self.store.signal_by_path(path).is_none() {
            return Ok(());
        }
        self.ensure_without_dependents(path, "remove")?;
        if let Some(id) = self.store.remove_signal(path) {
            self.pyramids.remove(&id);
        }
        self.remove_spill(path);
        self.derived_charges.remove(path);
        self.derived_references.remove(path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{HostConfig, HostPaths, ScopeHost};
    use scope_protocol::DerivedRequest;

    fn host(root: &std::path::Path) -> ScopeHost {
        ScopeHost::open(HostConfig {
            paths: HostPaths {
                config_dir: root.join("config"),
                cache_dir: root.join("cache"),
                resource_dir: root.join("resources"),
            },
            available_memory_bytes: 8 * 1024 * 1024 * 1024,
        })
        .unwrap()
    }

    #[test]
    fn derived_signal_requires_a_valid_expression() {
        let root = tempfile::tempdir().unwrap();
        let error = host(root.path())
            .create_derived(DerivedRequest {
                path: "answer".into(),
                expr: "not valid".into(),
            })
            .unwrap_err();
        assert_eq!(error.code(), "invalid_request");
    }
}

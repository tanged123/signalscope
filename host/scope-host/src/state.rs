use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use scope_core::{
    columns::PageHandle,
    ingest::{
        admission::{BudgetConfig, MemoryBudget, ResidentCharge},
        batch::{BatchJobs, BatchOptions},
        registry::ProviderRegistry,
    },
    pyramid::Pyramid,
    sources::SourceRegistry,
    store::{SignalId, SignalStore, SourceId},
};

use crate::{config::HostConfig, error::HostError};

pub(crate) struct DataState {
    pub(crate) store: SignalStore,
    pub(crate) pyramids: BTreeMap<SignalId, Pyramid>,
    pub(crate) registry: SourceRegistry,
    pub(crate) derived_source: Option<SourceId>,
    pub(crate) derived_references: BTreeMap<String, Vec<String>>,
    pub(crate) derived_bundles: BTreeMap<String, String>,
    pub(crate) derived_spills: BTreeMap<String, PageHandle>,
    pub(crate) derived_charges: BTreeMap<String, ResidentCharge>,
    pub(crate) cache_root: PathBuf,
    pub(crate) budget: MemoryBudget,
}

impl DataState {
    pub(crate) fn with_config(cache_root: PathBuf, budget: MemoryBudget) -> Self {
        Self {
            store: SignalStore::default(),
            pyramids: BTreeMap::new(),
            registry: SourceRegistry::default(),
            derived_source: None,
            derived_references: BTreeMap::new(),
            derived_bundles: BTreeMap::new(),
            derived_spills: BTreeMap::new(),
            derived_charges: BTreeMap::new(),
            cache_root,
            budget,
        }
    }

    pub(crate) fn reset(&mut self) {
        for handle in self.derived_spills.values() {
            let _ = std::fs::remove_file(handle.path());
        }
        let cache_root = self.cache_root.clone();
        let budget = self.budget.clone();
        *self = Self::with_config(cache_root, budget);
    }
}

#[derive(Default)]
pub(crate) struct RestoreGate(AtomicUsize);

impl RestoreGate {
    pub(crate) fn begin(&self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }

    pub(crate) fn settle(&self) {
        let _ = self
            .0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                Some(count.saturating_sub(1))
            });
    }

    pub(crate) fn save_allowed(&self, autosave: bool) -> Result<(), HostError> {
        (!autosave || self.0.load(Ordering::Acquire) == 0)
            .then_some(())
            .ok_or_else(|| HostError::Conflict {
                code: "restore_in_progress",
                message: "restore in progress".into(),
            })
    }
}

pub(crate) struct RestoreSettlement<'a>(pub(crate) &'a RestoreGate);

impl Drop for RestoreSettlement<'_> {
    fn drop(&mut self) {
        self.0.settle();
    }
}

pub(crate) struct HostInner {
    pub(crate) state: Arc<Mutex<DataState>>,
    pub(crate) jobs: BatchJobs,
    pub(crate) gate: RestoreGate,
    pub(crate) config: HostConfig,
    pub(crate) budget: BudgetConfig,
}

impl HostInner {
    pub(crate) fn open(config: HostConfig, budget: BudgetConfig) -> Result<Self, HostError> {
        std::fs::create_dir_all(&config.paths.config_dir).map_err(|error| HostError::Internal {
            code: "config_directory",
            message: error.to_string(),
        })?;
        std::fs::create_dir_all(&config.paths.cache_dir).map_err(|error| HostError::Internal {
            code: "cache_directory",
            message: error.to_string(),
        })?;
        let cache_root = config.paths.cache_root();
        let budget_value = MemoryBudget::new(budget);
        let recipe_directory = config.paths.recipe_directory();
        let jobs = BatchJobs::new(BatchOptions {
            worker_count: std::thread::available_parallelism().map_or(1, usize::from),
            budget: Arc::new(budget_value.clone()),
            terminal_ttl: Duration::from_secs(300),
            cache_directory: Some(cache_root.clone()),
            recipe_directory: Some(recipe_directory),
            provider_registry: Arc::new(ProviderRegistry::builtin()),
        });
        Ok(Self {
            state: Arc::new(Mutex::new(DataState::with_config(cache_root, budget_value))),
            jobs,
            gate: RestoreGate::default(),
            config,
            budget,
        })
    }
}

#[cfg(test)]
mod tests {}

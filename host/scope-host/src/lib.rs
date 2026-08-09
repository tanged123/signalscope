#![allow(
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::needless_pass_by_value
)]

mod catalog;
mod config;
mod derived;
mod error;
mod export;
mod ingest;
mod preferences;
mod query;
mod session;
mod state;

pub use config::{HostConfig, HostPaths};
pub use error::HostError;

use std::{path::PathBuf, sync::Arc};

use scope_core::{ingest::admission::BudgetConfig, preferences as core_preferences};

use crate::state::HostInner;

#[derive(Clone)]
pub struct ScopeHost {
    inner: Arc<HostInner>,
}

impl ScopeHost {
    pub fn open(config: HostConfig) -> Result<Self, HostError> {
        let stored = config.paths.preferences_file();
        let preferences = if stored.exists() {
            core_preferences::load_from_path(&stored).map_err(|error| HostError::Invalid {
                code: "invalid_preferences",
                message: error.to_string(),
            })?
        } else {
            core_preferences::Preferences::default()
        };
        let defaults = BudgetConfig::from_available(
            usize::try_from(config.available_memory_bytes).unwrap_or(usize::MAX),
        );
        let budget = BudgetConfig {
            working_bytes: preferences
                .ingest_working_bytes
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(defaults.working_bytes),
            resident_bytes: preferences
                .ingest_resident_bytes
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(defaults.resident_bytes),
        };
        let inner = HostInner::open(config, budget)?;
        if let Some(cache_root) = preferences.cache_root {
            inner.state.lock().expect("host state lock").cache_root = PathBuf::from(cache_root);
        }
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    #[must_use]
    pub fn cache_root(&self) -> PathBuf {
        self.inner
            .state
            .lock()
            .expect("host state lock")
            .cache_root
            .clone()
    }

    #[must_use]
    pub fn budget_config(&self) -> (usize, usize) {
        (
            self.inner.budget.working_bytes,
            self.inner.budget.resident_bytes,
        )
    }

    pub fn snapshot_template(&self) -> Result<PathBuf, HostError> {
        let path = self.inner.config.paths.snapshot_template();
        path.is_file()
            .then_some(path)
            .ok_or_else(|| HostError::Internal {
                code: "missing_snapshot_template",
                message: "snapshot template is missing; run ./scripts/build.sh web".into(),
            })
    }

    pub(crate) fn inner(&self) -> &HostInner {
        &self.inner
    }
}

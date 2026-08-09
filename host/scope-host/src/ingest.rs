use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use scope_core::{
    ingest::{
        self, DecodedSource, IngestError, IngestSummary,
        batch::{CommitSink, JobId},
        container::ContainerReader,
    },
    pyramid::Pyramid,
    restore, session,
    sources::SourceRecord,
    store::SourceKey,
};
use scope_protocol::{
    AliasConflictSummary, BatchDetail, BatchDetailRequest, BatchFailure, BatchFileStatus, BatchJob,
    BatchState, BatchStatus, ContainerOutline, DatasetOutline, DatasetOutlineKind, FileState,
    IngestBatchRequest, IntrospectRequest, RecipeDestination, RestoreReconcileRequest,
    RestoreReconcileResponse, RestoreSourcesRequest, SaveRecipeRequest, SaveRecipeResponse,
};

use crate::{
    HostError, ScopeHost,
    catalog::expand_sources,
    state::{DataState, RestoreSettlement},
};

fn invalid(message: impl Into<String>) -> HostError {
    HostError::Invalid {
        code: "invalid_request",
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> HostError {
    HostError::Internal {
        code: "host_operation",
        message: message.into(),
    }
}

struct HostCommitSink {
    state: Arc<Mutex<DataState>>,
}

impl CommitSink for HostCommitSink {
    fn commit(
        &self,
        record: &SourceRecord,
        decoded: DecodedSource,
        pyramids: Vec<(String, Pyramid)>,
    ) -> Result<IngestSummary, IngestError> {
        let expected: BTreeSet<_> = decoded
            .signals
            .iter()
            .map(|signal| signal.local_path.as_str())
            .collect();
        let mut pyramids: BTreeMap<_, _> = pyramids.into_iter().collect();
        if expected.len() != pyramids.len()
            || !expected.iter().all(|path| pyramids.contains_key(*path))
        {
            return Err(std::io::Error::other("pyramids do not match decoded signals").into());
        }
        let mut data = self.state.lock().expect("host data state lock");
        let mut registry = data.registry.clone();
        registry.restore(record.clone())?;
        let summary = ingest::commit(
            &mut data.store,
            record.key,
            &record.prefix,
            &record.path,
            decoded,
        )?;
        for id in &summary.signals {
            let local_path = data
                .store
                .signal(*id)
                .expect("committed signal")
                .local_path
                .clone();
            data.pyramids.insert(
                *id,
                pyramids.remove(&local_path).expect("validated pyramid"),
            );
        }
        data.registry = registry;
        Ok(summary)
    }
}

impl ScopeHost {
    pub fn start_batch(&self, request: IngestBatchRequest) -> Result<BatchJob, HostError> {
        let paths = expand_sources(request.paths)?;
        let sink = Arc::new(HostCommitSink {
            state: Arc::clone(&self.inner().state),
        });
        Ok(BatchJob {
            job_id: self.inner().jobs.submit(paths, sink).0,
        })
    }

    pub fn batch_status(&self, request: BatchJob) -> Result<BatchStatus, HostError> {
        let status = self
            .inner()
            .jobs
            .status(JobId(request.job_id))
            .ok_or_else(|| invalid(format!("unknown batch job: {}", request.job_id)))?;
        Ok(batch_status_response(status))
    }

    pub fn batch_detail(&self, request: BatchDetailRequest) -> Result<BatchDetail, HostError> {
        let detail = self
            .inner()
            .jobs
            .detail(
                JobId(request.job_id),
                request.offset as usize,
                request.limit as usize,
            )
            .ok_or_else(|| invalid(format!("unknown batch job: {}", request.job_id)))?;
        Ok(BatchDetail {
            total: detail.total,
            entries: detail
                .entries
                .into_iter()
                .map(|entry| BatchFileStatus {
                    path: entry.path.display().to_string(),
                    state: file_state(entry.state),
                    error: entry.error,
                })
                .collect(),
        })
    }

    pub fn cancel_batch(&self, request: BatchJob) -> Result<(), HostError> {
        self.inner().jobs.cancel(JobId(request.job_id));
        Ok(())
    }

    pub fn release_batch(&self, request: BatchJob) -> Result<(), HostError> {
        self.inner().jobs.release(JobId(request.job_id));
        Ok(())
    }

    pub fn introspect_container(
        &self,
        request: IntrospectRequest,
    ) -> Result<ContainerOutline, HostError> {
        let path = Path::new(&request.path);
        let mut file = std::fs::File::open(path).map_err(|error| invalid(error.to_string()))?;
        let mut probe = Vec::with_capacity(scope_core::ingest::registry::PROBE_BYTES);
        Read::by_ref(&mut file)
            .take(scope_core::ingest::registry::PROBE_BYTES as u64)
            .read_to_end(&mut probe)
            .map_err(|error| invalid(error.to_string()))?;
        let (container, reader): (String, Box<dyn ContainerReader>) =
            if scope_core::ingest::container::hdf5::is_hdf5_magic(&probe) {
                (
                    "hdf5".into(),
                    Box::new(
                        scope_core::ingest::container::hdf5::Hdf5Container::open(path)
                            .map_err(|error| invalid(error.to_string()))?,
                    ),
                )
            } else if scope_core::ingest::container::parquet::is_parquet_magic(&probe) {
                (
                    "parquet".into(),
                    Box::new(
                        scope_core::ingest::container::parquet::ParquetContainer::open(path)
                            .map_err(|error| invalid(error.to_string()))?,
                    ),
                )
            } else {
                return Err(invalid("unsupported container magic"));
            };
        let datasets = reader
            .datasets()
            .to_vec()
            .into_iter()
            .map(|entry| {
                let preview = match entry.kind {
                    scope_core::ingest::container::DatasetKind::Numeric => reader
                        .read_preview_f64(&entry.path, 8)
                        .unwrap_or_default()
                        .into_iter()
                        .take(8)
                        .collect(),
                    _ => Vec::new(),
                };
                DatasetOutline {
                    path: entry.path,
                    kind: match entry.kind {
                        scope_core::ingest::container::DatasetKind::Numeric => {
                            DatasetOutlineKind::Numeric
                        }
                        scope_core::ingest::container::DatasetKind::Text => {
                            DatasetOutlineKind::Text
                        }
                        scope_core::ingest::container::DatasetKind::Compound => {
                            DatasetOutlineKind::Compound
                        }
                        scope_core::ingest::container::DatasetKind::Unsupported => {
                            DatasetOutlineKind::Unsupported
                        }
                    },
                    len: entry.len as u64,
                    shape: entry
                        .shape
                        .into_iter()
                        .map(|value| u32::try_from(value).unwrap_or(u32::MAX))
                        .collect(),
                    sample_preview: preview,
                }
            })
            .collect();
        Ok(ContainerOutline {
            container,
            datasets,
        })
    }

    pub fn save_recipe(&self, request: SaveRecipeRequest) -> Result<SaveRecipeResponse, HostError> {
        let recipe = scope_core::ingest::recipe::parse_recipe(&request.recipe_toml)
            .map_err(|error| invalid(error.to_string()))?;
        let destination = match request.destination {
            RecipeDestination::Sidecar => sidecar_destination(Path::new(&request.path))?,
            RecipeDestination::UserDirectory => {
                let preferences = self.load_preferences_value().unwrap_or_default();
                let directory = preferences.recipe_directory.map_or_else(
                    || self.inner().config.paths.recipe_directory(),
                    PathBuf::from,
                );
                std::fs::create_dir_all(&directory).map_err(|error| internal(error.to_string()))?;
                directory.join(format!("{}.toml", recipe.id))
            }
        };
        write_recipe_file(&destination, &request.recipe_toml).map_err(internal)?;
        if let Ok(canonical) = std::fs::canonicalize(&request.path) {
            if let Ok(mut data) = self.inner().state.lock() {
                data.registry.forget_recipe(&canonical);
            }
        }
        Ok(SaveRecipeResponse {
            recipe_id: recipe.id.clone(),
            digest: scope_core::ingest::recipe::content_digest(&recipe),
            saved_to: destination.display().to_string(),
        })
    }

    fn load_preferences_value(&self) -> Result<scope_core::preferences::Preferences, HostError> {
        let path = self.inner().config.paths.preferences_file();
        if path.exists() {
            scope_core::preferences::load_from_path(&path)
                .map_err(|error| invalid(error.to_string()))
        } else {
            Ok(scope_core::preferences::Preferences::default())
        }
    }

    pub fn restore_sources(&self, request: RestoreSourcesRequest) -> Result<BatchJob, HostError> {
        let restored = session::from_json(&request.session_json)
            .map_err(|error| invalid(error.to_string()))?;
        let records = restored
            .sources
            .iter()
            .map(core_source_record)
            .collect::<Result<Vec<_>, _>>()?;
        self.inner()
            .jobs
            .replace_sources(records.clone())
            .map_err(|error| invalid(error.to_string()))?;
        self.inner()
            .state
            .lock()
            .map_err(|error| internal(error.to_string()))?
            .reset();
        self.inner().gate.begin();
        let sink = Arc::new(HostCommitSink {
            state: Arc::clone(&self.inner().state),
        });
        Ok(BatchJob {
            job_id: self
                .inner()
                .jobs
                .submit(
                    records.iter().map(|record| record.path.clone()).collect(),
                    sink,
                )
                .0,
        })
    }

    pub fn restore_reconcile(
        &self,
        request: RestoreReconcileRequest,
    ) -> Result<RestoreReconcileResponse, HostError> {
        let _settlement = RestoreSettlement(&self.inner().gate);
        self.inner()
            .jobs
            .join(JobId(request.job_id))
            .ok_or_else(|| invalid(format!("unknown batch job: {}", request.job_id)))?;
        let mut restored = session::from_json(&request.session_json)
            .map_err(|error| invalid(error.to_string()))?;
        let mut builder = restore::AliasBuilder::default();
        let mut missing = BTreeSet::new();
        {
            let data = self
                .inner()
                .state
                .lock()
                .map_err(|error| internal(error.to_string()))?;
            for record in &mut restored.sources {
                let Ok(uuid) = uuid::Uuid::parse_str(&record.key) else {
                    continue;
                };
                let key = SourceKey(uuid);
                let Some(current) = data.registry.record(key) else {
                    missing.insert(key);
                    continue;
                };
                record.path = current.path.display().to_string();
                record.prefix.clone_from(&current.prefix);
                record.provider_id.clone_from(&current.provider_id);
                record
                    .decode_provenance
                    .clone_from(&current.decode_provenance);
                record.recipe_id.clone_from(&current.recipe_id);
                record.recipe_digest.clone_from(&current.recipe_digest);
                let Some(source) = data.store.sources().find(|source| source.key == key) else {
                    missing.insert(key);
                    continue;
                };
                let Some(provider) = current.provider_id.as_deref() else {
                    missing.insert(key);
                    continue;
                };
                if !record.reconcile_legacy {
                    continue;
                }
                let local_paths = data
                    .store
                    .signals_of(source.id)
                    .map(|signal| signal.local_path.clone())
                    .collect::<Vec<_>>();
                for (legacy, path) in restore::legacy_aliases(provider, current, &local_paths) {
                    builder.add(key, legacy, path);
                }
            }
        }
        let built = builder.build();
        missing.extend(
            built
                .conflicts
                .iter()
                .flat_map(|conflict| conflict.claimants.iter().copied()),
        );
        let mut outcome = restore::reconcile(&mut restored, &built.aliases, &missing)
            .map_err(|error| invalid(error.to_string()))?;
        outcome.conflicts = built.conflicts;
        Ok(RestoreReconcileResponse {
            session_json: serde_json::to_string(&restored)
                .map_err(|error| internal(error.to_string()))?,
            rewritten: outcome.rewritten,
            conflicts: outcome
                .conflicts
                .into_iter()
                .map(|conflict| AliasConflictSummary {
                    legacy_path: conflict.legacy_path,
                    claimants: conflict
                        .claimants
                        .into_iter()
                        .map(|key| key.0.to_string())
                        .collect(),
                })
                .collect(),
            unresolved: outcome.unresolved,
        })
    }
}

fn core_source_record(record: &session::SourceRecord) -> Result<SourceRecord, HostError> {
    Ok(SourceRecord {
        key: SourceKey(
            uuid::Uuid::parse_str(&record.key).map_err(|error| invalid(error.to_string()))?,
        ),
        path: PathBuf::from(&record.path),
        prefix: record.prefix.clone(),
        provider_id: record.provider_id.clone(),
        decode_provenance: record.decode_provenance.clone(),
        recipe_id: record.recipe_id.clone(),
        recipe_digest: record.recipe_digest.clone(),
        reconcile_legacy: record.reconcile_legacy,
    })
}

fn batch_status_response(status: scope_core::ingest::batch::BatchStatus) -> BatchStatus {
    BatchStatus {
        state: batch_state(status.state),
        fraction: status.fraction,
        total: status.total,
        done: status.done,
        failed: status.failed,
        current_paths: status
            .current_paths
            .into_iter()
            .map(|path| path.display().to_string())
            .collect(),
        recent_failures: status
            .recent_failures
            .into_iter()
            .map(|failure| BatchFailure {
                path: failure.path.display().to_string(),
                error: failure.error,
                recipe_required: failure.recipe_required,
            })
            .collect(),
    }
}

fn batch_state(state: scope_core::ingest::batch::BatchState) -> BatchState {
    match state {
        scope_core::ingest::batch::BatchState::Running => BatchState::Running,
        scope_core::ingest::batch::BatchState::Done => BatchState::Done,
        scope_core::ingest::batch::BatchState::Partial => BatchState::Partial,
        scope_core::ingest::batch::BatchState::Failed => BatchState::Failed,
        scope_core::ingest::batch::BatchState::Cancelled => BatchState::Cancelled,
    }
}

fn file_state(state: scope_core::ingest::batch::FileState) -> FileState {
    match state {
        scope_core::ingest::batch::FileState::Pending => FileState::Pending,
        scope_core::ingest::batch::FileState::Running => FileState::Running,
        scope_core::ingest::batch::FileState::Done => FileState::Done,
        scope_core::ingest::batch::FileState::Failed => FileState::Failed,
        scope_core::ingest::batch::FileState::Cancelled => FileState::Cancelled,
    }
}

fn write_recipe_file(destination: &Path, contents: &str) -> Result<(), String> {
    static NEXT_RECIPE_ID: AtomicU64 = AtomicU64::new(0);
    write_recipe_file_with_suffix(
        destination,
        contents,
        NEXT_RECIPE_ID.fetch_add(1, Ordering::Relaxed),
    )
}

fn write_recipe_file_with_suffix(
    destination: &Path,
    contents: &str,
    suffix: u64,
) -> Result<(), String> {
    use std::io::Write as _;
    let temporary = destination.with_extension(format!("toml.{suffix}.tmp"));
    let (temporary, mut file) = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
    {
        Ok(file) => (temporary, file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let next = destination.with_extension(format!("toml.{}.tmp", suffix.saturating_add(1)));
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&next)
                .map_err(|error| error.to_string())?;
            (next, file)
        }
        Err(error) => return Err(error.to_string()),
    };
    let result = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string());
    drop(file);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&temporary, destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

fn sidecar_destination(source: &Path) -> Result<PathBuf, HostError> {
    if !source.is_file() {
        return Err(invalid("recipe source is not an existing file"));
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| invalid("source path has no file name"))?;
    Ok(source.with_file_name(format!("{}.scope.toml", file_name.to_string_lossy())))
}

#[cfg(test)]
mod tests {
    use crate::{HostConfig, HostPaths, ScopeHost};
    use scope_protocol::{BatchJob, BatchState, IngestBatchRequest};

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
    fn failed_batch_is_atomic_and_has_no_catalog_entries() {
        let root = tempfile::tempdir().unwrap();
        let host = host(root.path());
        let job = host
            .start_batch(IngestBatchRequest {
                paths: vec![root.path().join("missing.csv").display().to_string()],
            })
            .unwrap();
        let status = host.batch_status(job).unwrap();
        assert_eq!(status.state, BatchState::Failed);
        assert!(host.list_sources().unwrap().is_empty());
        assert!(host.list_signals().unwrap().is_empty());
    }

    #[test]
    fn batch_release_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let host = host(root.path());
        let job = BatchJob { job_id: 77 };
        host.release_batch(job.clone()).unwrap();
        host.release_batch(job).unwrap();
    }
}

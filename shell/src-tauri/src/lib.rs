use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use base64::Engine;
use scope_core::{
    compute, expr,
    ingest::{
        self, DecodedSource, IngestError, IngestSummary, SUPPORTED_FORMATS,
        admission::{BudgetConfig, MemoryBudget},
        batch::{BatchJobs, BatchOptions, CommitSink},
    },
    preferences,
    pyramid::Pyramid,
    restore, session, snapshot,
    sources::{SourceRecord, SourceRegistry},
    store::{Signal, SignalId, SignalStore, Source, SourceId, SourceKey},
};
use scope_protocol::{
    AliasConflictSummary, BatchDetail, BatchDetailRequest, BatchFailure, BatchFileStatus, BatchJob,
    BatchState, BatchStatus, DerivedRequest, Envelope, ExportEstimate, ExportEstimateEntry,
    ExportEstimateRequest, ExportFidelity, ExportFileKind, ExportRange, ExportWriteRequest,
    FileState, FormatDescriptor, IngestBatchRequest, LoadSessionRequest, LoadedSession,
    PickSessionRequest, RemoveSignalRequest, RestoreReconcileRequest, RestoreReconcileResponse,
    RestoreSourcesRequest, SampleRequest, SampleResponse, SampleSeries, SaveExportFileRequest,
    SaveExportFileToDirectoryRequest, SaveSessionRequest, SessionDialogMode, SignalSummary,
    SignalTile, SourceSummary, TileRequest, TileResponse,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct DataState {
    store: SignalStore,
    pyramids: BTreeMap<SignalId, Pyramid>,
    registry: SourceRegistry,
    derived_source: Option<SourceId>,
    derived_references: BTreeMap<String, Vec<String>>,
}

#[derive(Default)]
struct RestoreGate(AtomicUsize);

impl RestoreGate {
    fn begin(&self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }

    fn settle(&self) {
        let _ = self
            .0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                Some(count.saturating_sub(1))
            });
    }

    fn save_allowed(&self, autosave: bool) -> Result<(), String> {
        (!autosave || self.0.load(Ordering::Acquire) == 0)
            .then_some(())
            .ok_or_else(|| "restore in progress".into())
    }
}

struct RestoreSettlement<'a>(&'a RestoreGate);

impl Drop for RestoreSettlement<'_> {
    fn drop(&mut self) {
        self.0.settle();
    }
}

fn signal_summary(signal: &Signal, source_key: SourceKey) -> SignalSummary {
    let (t_min, t_max) = signal.time_bounds();
    SignalSummary {
        signal_id: signal.id.0,
        source_id: signal.source_id.0,
        source_key: source_key.0.to_string(),
        local_path: signal.local_path.clone(),
        path: signal.path.clone(),
        unit: signal.unit.clone(),
        point_count: signal.len() as u64,
        t_min,
        t_max,
    }
}

fn source_summary(source: &Source) -> SourceSummary {
    SourceSummary {
        source_id: source.id.0,
        source_key: source.key.0.to_string(),
        prefix: source.prefix.clone(),
        path: source.path.display().to_string(),
        point_count: source.point_count as u64,
    }
}

struct ShellCommitSink {
    state: Arc<Mutex<DataState>>,
}

impl CommitSink for ShellCommitSink {
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

        let mut data = self.state.lock().expect("data state lock");
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

#[tauri::command]
async fn pick_sources(app: AppHandle) -> Result<Envelope<Vec<String>>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let extensions: Vec<&str> = SUPPORTED_FORMATS
            .iter()
            .flat_map(|(_, extensions)| extensions.iter().copied())
            .collect();
        let combined = format!(
            "Supported telemetry ({})",
            extensions
                .iter()
                .map(|extension| extension.to_uppercase())
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut dialog = app.dialog().file().add_filter(combined, &extensions);
        for (label, extensions) in SUPPORTED_FORMATS {
            dialog = dialog.add_filter(*label, extensions);
        }
        dialog.blocking_pick_files()
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .map(|path| path.display().to_string())
            .collect(),
    ))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn ingest_batch(
    request: Envelope<IngestBatchRequest>,
    app: AppHandle,
    jobs: State<'_, BatchJobs>,
) -> Result<Envelope<BatchJob>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let paths = expand_sources(request.paths)?;
    let sink = Arc::new(ShellCommitSink {
        state: Arc::clone(app.state::<Arc<Mutex<DataState>>>().inner()),
    });
    Ok(Envelope::new(BatchJob {
        job_id: jobs.submit(paths, sink).0,
    }))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn batch_status(
    request: Envelope<BatchJob>,
    jobs: State<'_, BatchJobs>,
) -> Result<Envelope<BatchStatus>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let status = jobs
        .status(scope_core::ingest::batch::JobId(request.job_id))
        .ok_or_else(|| format!("unknown batch job: {}", request.job_id))?;
    Ok(Envelope::new(batch_status_response(status)))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn batch_detail(
    request: Envelope<BatchDetailRequest>,
    jobs: State<'_, BatchJobs>,
) -> Result<Envelope<BatchDetail>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let detail = jobs
        .detail(
            scope_core::ingest::batch::JobId(request.job_id),
            request.offset as usize,
            request.limit as usize,
        )
        .ok_or_else(|| format!("unknown batch job: {}", request.job_id))?;
    Ok(Envelope::new(BatchDetail {
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
    }))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn cancel_batch(
    request: Envelope<BatchJob>,
    jobs: State<'_, BatchJobs>,
) -> Result<Envelope<()>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    jobs.cancel(scope_core::ingest::batch::JobId(request.job_id));
    Ok(Envelope::new(()))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn release_batch(
    request: Envelope<BatchJob>,
    jobs: State<'_, BatchJobs>,
) -> Result<Envelope<()>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    jobs.release(scope_core::ingest::batch::JobId(request.job_id));
    Ok(Envelope::new(()))
}

#[tauri::command]
fn list_formats() -> Envelope<Vec<FormatDescriptor>> {
    Envelope::new(
        SUPPORTED_FORMATS
            .iter()
            .map(|(label, extensions)| FormatDescriptor {
                id: extensions.first().copied().unwrap_or_default().into(),
                label: (*label).into(),
                extensions: extensions
                    .iter()
                    .map(|extension| (*extension).into())
                    .collect(),
            })
            .collect(),
    )
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn restore_sources(
    request: Envelope<RestoreSourcesRequest>,
    app: AppHandle,
    jobs: State<'_, BatchJobs>,
    gate: State<'_, RestoreGate>,
) -> Result<Envelope<BatchJob>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let restored = session::from_json(&request.session_json).map_err(|error| error.to_string())?;
    let records = restored
        .sources
        .iter()
        .map(core_source_record)
        .collect::<Result<Vec<_>, _>>()?;
    jobs.replace_sources(records.clone())
        .map_err(|error| error.to_string())?;
    let state = Arc::clone(app.state::<Arc<Mutex<DataState>>>().inner());
    state.lock().map_err(|error| error.to_string())?.reset();
    gate.begin();
    let job = jobs.submit(
        records.iter().map(|record| record.path.clone()).collect(),
        Arc::new(ShellCommitSink { state }),
    );
    Ok(Envelope::new(BatchJob { job_id: job.0 }))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn restore_reconcile(
    request: Envelope<RestoreReconcileRequest>,
    jobs: State<'_, BatchJobs>,
    state: State<'_, Arc<Mutex<DataState>>>,
    gate: State<'_, RestoreGate>,
) -> Result<Envelope<RestoreReconcileResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let _settlement = RestoreSettlement(&gate);
    jobs.join(scope_core::ingest::batch::JobId(request.job_id))
        .ok_or_else(|| format!("unknown batch job: {}", request.job_id))?;
    let mut restored =
        session::from_json(&request.session_json).map_err(|error| error.to_string())?;
    let mut builder = restore::AliasBuilder::default();
    let mut missing = BTreeSet::new();
    {
        let data = state.lock().map_err(|error| error.to_string())?;
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
        .map_err(|error| error.to_string())?;
    outcome.conflicts = built.conflicts;
    Ok(Envelope::new(RestoreReconcileResponse {
        session_json: serde_json::to_string(&restored).map_err(|error| error.to_string())?,
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
    }))
}

fn core_source_record(record: &session::SourceRecord) -> Result<SourceRecord, String> {
    Ok(SourceRecord {
        key: SourceKey(uuid::Uuid::parse_str(&record.key).map_err(|error| error.to_string())?),
        path: PathBuf::from(&record.path),
        prefix: record.prefix.clone(),
        provider_id: record.provider_id.clone(),
        decode_provenance: record.decode_provenance.clone(),
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
        recent_failures: status
            .recent_failures
            .into_iter()
            .map(|failure| BatchFailure {
                path: failure.path.display().to_string(),
                error: failure.error,
            })
            .collect(),
    }
}

fn batch_state(state: scope_core::ingest::batch::BatchState) -> BatchState {
    use scope_core::ingest::batch::BatchState as Core;
    match state {
        Core::Running => BatchState::Running,
        Core::Done => BatchState::Done,
        Core::Partial => BatchState::Partial,
        Core::Failed => BatchState::Failed,
        Core::Cancelled => BatchState::Cancelled,
    }
}

fn file_state(state: scope_core::ingest::batch::FileState) -> FileState {
    use scope_core::ingest::batch::FileState as Core;
    match state {
        Core::Pending => FileState::Pending,
        Core::Running => FileState::Running,
        Core::Done => FileState::Done,
        Core::Failed => FileState::Failed,
        Core::Cancelled => FileState::Cancelled,
    }
}

fn expand_sources(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    let mut expanded = Vec::new();
    for path in paths {
        expand_source(Path::new(&path), &mut expanded)?;
    }
    expanded.sort();
    Ok(expanded)
}

fn expand_source(path: &Path, expanded: &mut Vec<PathBuf>) -> Result<(), String> {
    if !path.is_dir() {
        expanded.push(path.to_owned());
        return Ok(());
    }
    let mut entries = std::fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(std::fs::DirEntry::path);
    for entry in entries {
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            expand_source(&path, expanded)?;
        } else if supported_path(&path) {
            expanded.push(path);
        }
    }
    Ok(())
}

fn supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            SUPPORTED_FORMATS.iter().any(|(_, extensions)| {
                extensions
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(extension))
            })
        })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_sources(
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<Vec<SourceSummary>>, String> {
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        data.store.sources().map(source_summary).collect(),
    ))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_signals(
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<Vec<SignalSummary>>, String> {
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        data.store
            .signals()
            .map(|signal| {
                let key = data
                    .store
                    .sources()
                    .find(|source| source.id == signal.source_id)
                    .expect("signal source")
                    .key;
                signal_summary(signal, key)
            })
            .collect(),
    ))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn query_tiles(
    request: Envelope<TileRequest>,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<TileResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let data = state.lock().map_err(|error| error.to_string())?;
    let mut series = Vec::new();
    for raw_id in request.signal_ids {
        let signal_id = SignalId(raw_id);
        let signal = data
            .store
            .signal(signal_id)
            .ok_or_else(|| format!("unknown signal id: {raw_id}"))?;
        let pyramid = data
            .pyramids
            .get(&signal_id)
            .ok_or_else(|| format!("pyramid is unavailable for signal id: {raw_id}"))?;
        let query = pyramid.query(request.window.t0, request.window.t1, request.pixel_width);
        series.push(SignalTile {
            signal_id: raw_id,
            signal_path: signal.path.clone(),
            unit: signal.unit.clone(),
            level: query.level,
            bins: query.bins,
        });
    }

    Ok(Envelope::new(TileResponse {
        request_id: request.request_id,
        series,
    }))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn query_samples(
    request: Envelope<SampleRequest>,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<SampleResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let data = state.lock().map_err(|error| error.to_string())?;
    let mut series = Vec::new();
    for raw_id in request.signal_ids {
        let signal = data
            .store
            .signal(SignalId(raw_id))
            .ok_or_else(|| format!("unknown signal id: {raw_id}"))?;
        let slice = compute::sample_window(
            signal.time(),
            signal.values(),
            request.window.t0,
            request.window.t1,
            request.max_points,
        );
        series.push(SampleSeries {
            signal_id: raw_id,
            signal_path: signal.path.clone(),
            unit: signal.unit.clone(),
            time: slice.time,
            values: slice.values,
            stride: slice.stride,
        });
    }

    Ok(Envelope::new(SampleResponse {
        request_id: request.request_id,
        series,
    }))
}

const DERIVED_PREFIX: &str = "derived/";

impl DataState {
    fn reset(&mut self) {
        *self = Self::default();
    }

    fn dependents(&self, path: &str) -> Vec<&str> {
        self.derived_references
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
        if Some(signal.source_id) != self.derived_source {
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

    fn create_derived_signal(&mut self, request: DerivedRequest) -> Result<SignalSummary, String> {
        let path = if request.path.starts_with(DERIVED_PREFIX) {
            request.path
        } else {
            format!("{DERIVED_PREFIX}{}", request.path)
        };
        self.ensure_owned_derived(&path)?;
        if self.store.signal_by_path(&path).is_some() {
            self.ensure_without_dependents(&path, "replace")?;
        }

        let parsed = expr::parse(&request.expr).map_err(|error| error.to_string())?;
        let references = expr::references(&parsed);
        let evaluated = expr::evaluate(&parsed, &self.store).map_err(|error| error.to_string())?;

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
                .map_err(|error| error.to_string())?;
            self.derived_source = Some(id);
            id
        };
        if let Some(previous) = self.store.remove_signal(&path) {
            self.pyramids.remove(&previous);
        }
        let signal_id = self
            .store
            .insert_signal(
                source_id,
                path.trim_start_matches(DERIVED_PREFIX),
                None,
                evaluated.time,
                evaluated.values,
            )
            .map_err(|error| error.to_string())?;
        let signal = self
            .store
            .signal(signal_id)
            .ok_or_else(|| "derived signal vanished after insertion".to_owned())?;
        let pyramid = Pyramid::from_signal(signal);
        let source_key = self
            .store
            .sources()
            .find(|source| source.id == source_id)
            .expect("derived source")
            .key;
        let summary = signal_summary(signal, source_key);
        self.pyramids.insert(signal_id, pyramid);
        self.derived_references.insert(path, references);
        Ok(summary)
    }

    fn remove_derived_signal(&mut self, path: &str) -> Result<(), String> {
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
        self.derived_references.remove(path);
        Ok(())
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn create_derived(
    request: Envelope<DerivedRequest>,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<SignalSummary>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let mut data = state.lock().map_err(|error| error.to_string())?;
    data.create_derived_signal(request).map(Envelope::new)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn remove_signal(
    request: Envelope<RemoveSignalRequest>,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<()>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let mut data = state.lock().map_err(|error| error.to_string())?;
    data.remove_derived_signal(&request.path)?;
    Ok(Envelope::new(()))
}

const AUTOSAVE_FILE: &str = "session.autosave.json";
const DEFAULT_SESSION_FILE: &str = "workspace.signalscope";

/// Resolves an explicit path, or the autosave slot when none is given.
fn session_path(app: &AppHandle, path: Option<String>) -> Result<PathBuf, String> {
    match path {
        Some(path) => Ok(PathBuf::from(path)),
        None => Ok(app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join(AUTOSAVE_FILE)),
    }
}

fn normalized_session_save_path(mut path: PathBuf) -> PathBuf {
    if path.extension().is_none_or(std::ffi::OsStr::is_empty) {
        path.set_extension("signalscope");
    }
    path
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn save_session(
    request: Envelope<SaveSessionRequest>,
    app: AppHandle,
    gate: State<'_, RestoreGate>,
) -> Result<Envelope<String>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    gate.save_allowed(request.path.is_none())?;
    let session = session::from_json(&request.session_json).map_err(|error| error.to_string())?;
    let path = match request.path {
        Some(path) => normalized_session_save_path(PathBuf::from(path)),
        None => session_path(&app, None)?,
    };
    session::save_to_path(&session, &path).map_err(|error| error.to_string())?;
    Ok(Envelope::new(path.display().to_string()))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn load_session(
    request: Envelope<LoadSessionRequest>,
    app: AppHandle,
) -> Result<Envelope<LoadedSession>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let explicit = request.path.is_some();
    let path = session_path(&app, request.path)?;
    if !explicit && !path.exists() {
        let session = session::Session::default();
        return Ok(Envelope::new(LoadedSession {
            session_json: serde_json::to_string(&session).map_err(|error| error.to_string())?,
            path: None,
        }));
    }
    let session = session::load_from_path(&path).map_err(|error| error.to_string())?;
    Ok(Envelope::new(LoadedSession {
        session_json: serde_json::to_string(&session).map_err(|error| error.to_string())?,
        path: explicit.then(|| path.display().to_string()),
    }))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn reset_session(
    app: AppHandle,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<LoadedSession>, String> {
    let session = session::Session::default();
    let path = session_path(&app, None)?;
    session::save_to_path(&session, &path).map_err(|error| error.to_string())?;
    state.lock().map_err(|error| error.to_string())?.reset();
    Ok(Envelope::new(LoadedSession {
        session_json: serde_json::to_string(&session).map_err(|error| error.to_string())?,
        path: None,
    }))
}

#[tauri::command]
async fn pick_session_path(
    request: Envelope<PickSessionRequest>,
    app: AppHandle,
) -> Result<Envelope<Option<String>>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let picked = tauri::async_runtime::spawn_blocking(move || match request.mode {
        SessionDialogMode::Open => app.dialog().file().blocking_pick_file(),
        SessionDialogMode::Save => app
            .dialog()
            .file()
            .add_filter("SignalScope workspace", &["signalscope", "json"])
            .set_file_name(DEFAULT_SESSION_FILE)
            .blocking_save_file(),
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        picked
            .and_then(|file| file.into_path().ok())
            .map(|path| path.display().to_string()),
    ))
}

fn normalized_export_save_path(mut path: PathBuf, extension: &str) -> PathBuf {
    if path.extension() != Some(std::ffi::OsStr::new(extension)) {
        path.set_extension(extension);
    }
    path
}

fn export_file_path(directory: &Path, file_name: &str, extension: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(file_name).components();
    let Some(std::path::Component::Normal(_)) = components.next() else {
        return Err("export file name must be a single path component".to_owned());
    };
    if components.next().is_some() {
        return Err("export file name must be a single path component".to_owned());
    }
    Ok(normalized_export_save_path(
        directory.join(file_name),
        extension,
    ))
}

fn write_export_file(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);
    let file_name = path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("export"))
        .to_string_lossy();
    let staged = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(error) = std::fs::write(&staged, contents) {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&staged, path) {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    Ok(())
}

fn template_path(app: &AppHandle) -> Result<PathBuf, String> {
    use tauri::path::BaseDirectory;

    if let Ok(path) = app
        .path()
        .resolve("snapshot-template.html", BaseDirectory::Resource)
    {
        if path.exists() {
            return Ok(path);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../frontend/dist/snapshot-template.html");
    if development.exists() {
        return Ok(development);
    }
    Err("snapshot template is missing; run ./scripts/build.sh web".to_owned())
}

fn estimate_for(
    data: &DataState,
    session: &session::Session,
    session_json: &str,
    template_bytes: u64,
) -> Result<ExportEstimate, snapshot::SnapshotError> {
    let base = template_bytes + session_json.len() as u64;
    let mut entries = Vec::with_capacity(8);
    for range in [ExportRange::Visible, ExportRange::All] {
        for fidelity in [
            ExportFidelity::Preview,
            ExportFidelity::Standard,
            ExportFidelity::High,
            ExportFidelity::Full,
        ] {
            let plan = snapshot::plan(session, &data.store, &data.pyramids, range, fidelity)?;
            entries.push(ExportEstimateEntry {
                range,
                fidelity,
                bytes: base + snapshot::estimated_bytes(&plan),
                series_total: plan.series_total,
                series_decimated: plan.series_decimated,
                series_full_rate: plan.series_full_rate,
                coarsest_ratio: plan.coarsest_ratio,
            });
        }
    }
    Ok(ExportEstimate { entries })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn export_estimate(
    request: Envelope<ExportEstimateRequest>,
    app: AppHandle,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<ExportEstimate>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let session = session::from_json(&request.session_json).map_err(|error| error.to_string())?;
    let template_bytes = std::fs::metadata(template_path(&app)?)
        .map_err(|error| error.to_string())?
        .len();
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        estimate_for(&data, &session, &request.session_json, template_bytes)
            .map_err(|error| error.to_string())?,
    ))
}

#[tauri::command]
async fn export_write(
    request: Envelope<ExportWriteRequest>,
    app: AppHandle,
) -> Result<Envelope<Option<String>>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("HTML snapshot", &["html"])
            .set_file_name("snapshot.html")
            .blocking_save_file()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(Envelope::new(None));
    };
    let path = normalized_export_save_path(path, "html");
    let template =
        std::fs::read_to_string(template_path(&app)?).map_err(|error| error.to_string())?;
    let session = session::from_json(&request.session_json).map_err(|error| error.to_string())?;
    let manifest = {
        let state = app.state::<Arc<Mutex<DataState>>>();
        let data = state.lock().map_err(|error| error.to_string())?;
        let export = snapshot::plan(
            &session,
            &data.store,
            &data.pyramids,
            request.range,
            request.fidelity,
        )
        .map_err(|error| error.to_string())?;
        snapshot::bake(&export, &session).map_err(|error| error.to_string())?
    };
    let html = snapshot::inject(&template, manifest).map_err(|error| error.to_string())?;
    write_export_file(&path, &html).map_err(|error| error.to_string())?;
    Ok(Envelope::new(Some(path.display().to_string())))
}

#[tauri::command]
async fn save_export_file(
    request: Envelope<SaveExportFileRequest>,
    app: AppHandle,
) -> Result<Envelope<Option<String>>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let (label, extension) = match request.kind {
        ExportFileKind::Png => ("PNG image", "png"),
        ExportFileKind::Csv => ("CSV", "csv"),
    };
    let file_name = request.file_name.clone();
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter(label, &[extension])
            .set_file_name(&file_name)
            .blocking_save_file()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(Envelope::new(None));
    };
    let path = normalized_export_save_path(path, extension);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data_base64)
        .map_err(|error| error.to_string())?;
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(Envelope::new(Some(path.display().to_string())))
}

#[tauri::command]
async fn pick_export_directory(app: AppHandle) -> Result<Envelope<Option<String>>, String> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        picked
            .and_then(|folder| folder.into_path().ok())
            .map(|path| path.display().to_string()),
    ))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn save_export_file_to_directory(
    request: Envelope<SaveExportFileToDirectoryRequest>,
) -> Result<Envelope<String>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let extension = match request.kind {
        ExportFileKind::Png => "png",
        ExportFileKind::Csv => "csv",
    };
    let directory = PathBuf::from(&request.directory);
    if !directory.is_dir() {
        return Err("export directory does not exist".to_owned());
    }
    let path = export_file_path(&directory, &request.file_name, extension)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data_base64)
        .map_err(|error| error.to_string())?;
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(Envelope::new(path.display().to_string()))
}

const PREFERENCES_FILE: &str = "preferences.json";

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(PREFERENCES_FILE))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn load_preferences(app: AppHandle) -> Result<Envelope<Option<String>>, String> {
    let path = preferences_path(&app)?;
    if !path.exists() {
        return Ok(Envelope::new(None));
    }
    let preferences = preferences::load_from_path(&path).map_err(|error| error.to_string())?;
    Ok(Envelope::new(Some(
        serde_json::to_string(&preferences).map_err(|error| error.to_string())?,
    )))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn save_preferences(request: Envelope<String>, app: AppHandle) -> Result<Envelope<()>, String> {
    let json = request.open().map_err(|error| error.to_string())?;
    let preferences = preferences::from_json(&json).map_err(|error| error.to_string())?;
    preferences::save_to_path(&preferences, &preferences_path(&app)?)
        .map_err(|error| error.to_string())?;
    Ok(Envelope::new(()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the native `SignalScope` application.
///
/// # Panics
///
/// Panics when Tauri cannot initialize or run the application.
pub fn run() {
    let workers = std::thread::available_parallelism().map_or(1, usize::from);
    let jobs = BatchJobs::new(BatchOptions {
        worker_count: workers,
        budget: Arc::new(MemoryBudget::new(BudgetConfig::from_available(
            8 * 1024 * 1024 * 1024,
        ))),
        terminal_ttl: Duration::from_secs(300),
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(DataState::default())))
        .manage(jobs)
        .manage(RestoreGate::default())
        .invoke_handler(tauri::generate_handler![
            pick_sources,
            ingest_batch,
            batch_status,
            batch_detail,
            cancel_batch,
            release_batch,
            list_formats,
            restore_sources,
            restore_reconcile,
            list_sources,
            list_signals,
            query_tiles,
            query_samples,
            create_derived,
            remove_signal,
            save_session,
            load_session,
            reset_session,
            pick_session_path,
            export_estimate,
            export_write,
            save_export_file,
            pick_export_directory,
            save_export_file_to_directory,
            load_preferences,
            save_preferences
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SignalScope");
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use scope_core::{
        ingest::{DecodedSignal, DecodedSource, batch::CommitSink},
        sources::SourceRecord,
    };

    use super::*;

    fn data_with_signal(path: &str) -> (DataState, SourceId) {
        let mut data = DataState::default();
        let (prefix, local_path) = path.split_once('/').unwrap_or(("", path));
        let source = data
            .store
            .register_source(
                "input.csv",
                SourceKey(uuid::Uuid::from_bytes([1; 16])),
                prefix,
            )
            .unwrap();
        data.store
            .insert_signal(
                source,
                local_path,
                None,
                Arc::from(vec![0.0, 1.0]),
                vec![1.0, 2.0],
            )
            .expect("insert source signal");
        (data, source)
    }

    #[test]
    fn commit_sink_registers_signals_and_pyramids_together() {
        let state = Arc::new(Mutex::new(DataState::default()));
        let sink = ShellCommitSink {
            state: Arc::clone(&state),
        };
        let record = SourceRecord {
            key: SourceKey(uuid::Uuid::from_bytes([3; 16])),
            path: PathBuf::from("/a/run.csv"),
            prefix: "run".into(),
            provider_id: Some("csv".into()),
            decode_provenance: Some("abc".into()),
            reconcile_legacy: false,
        };
        let time: Arc<[f64]> = Arc::from(vec![0.0, 1.0, 2.0, 3.0]);
        let pyramid = Pyramid::from_samples(&time, &[1.0, 2.0, 3.0, 4.0]);
        let decoded = DecodedSource {
            row_count: 4,
            signals: vec![DecodedSignal {
                local_path: "imu/ax".into(),
                unit: None,
                time,
                values: Arc::from(vec![1.0, 2.0, 3.0, 4.0]),
            }],
        };

        let summary = sink
            .commit(&record, decoded, vec![("imu/ax".into(), pyramid)])
            .expect("commit");
        let data = state.lock().unwrap();
        assert_eq!(
            data.store
                .signal_by_path("run/imu/ax")
                .expect("signal")
                .len(),
            4
        );
        assert!(data.pyramids.contains_key(&summary.signals[0]));
        let restored = data.registry.record(record.key).expect("source record");
        assert_eq!(restored.provider_id.as_deref(), Some("csv"));
        assert_eq!(restored.decode_provenance.as_deref(), Some("abc"));
    }

    #[test]
    fn source_directories_expand_recursively_in_path_order() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(dir.path().join("b.csv"), "").unwrap();
        std::fs::write(dir.path().join("ignored.json"), "").unwrap();
        std::fs::write(nested.join("a.mcap"), "").unwrap();

        assert_eq!(
            expand_sources(vec![dir.path().display().to_string()]).unwrap(),
            vec![dir.path().join("b.csv"), nested.join("a.mcap")]
        );
    }

    #[test]
    fn restore_gate_refuses_autosave_until_restore_settles() {
        let gate = RestoreGate::default();
        gate.begin();
        assert!(gate.save_allowed(true).is_err());
        gate.settle();
        assert!(gate.save_allowed(true).is_ok());
    }

    #[test]
    fn restore_gate_never_blocks_named_saves() {
        let gate = RestoreGate::default();
        gate.begin();
        assert!(gate.save_allowed(false).is_ok());
    }

    #[test]
    fn rejects_replacing_or_removing_a_derived_signal_with_dependents() {
        let (mut data, _) = data_with_signal("input/x");
        data.create_derived_signal(DerivedRequest {
            path: "derived/a".into(),
            expr: "'input/x'".into(),
        })
        .expect("create a");
        data.create_derived_signal(DerivedRequest {
            path: "derived/b".into(),
            expr: "'derived/a' * 2".into(),
        })
        .expect("create b");

        let replace = data
            .create_derived_signal(DerivedRequest {
                path: "derived/a".into(),
                expr: "'input/x' + 1".into(),
            })
            .expect_err("dependent prevents replacement");
        assert!(replace.contains("derived/b"));
        let remove = data
            .remove_derived_signal("derived/a")
            .expect_err("dependent prevents removal");
        assert!(remove.contains("derived/b"));
        assert_eq!(
            data.store
                .signal_by_path("derived/a")
                .expect("a remains")
                .values(),
            &[1.0, 2.0]
        );
    }

    #[test]
    fn derived_prefix_does_not_grant_ownership_of_ingested_signals() {
        let (mut data, source) = data_with_signal("derived/value");

        let replace = data
            .create_derived_signal(DerivedRequest {
                path: "derived/value".into(),
                expr: "'derived/value' * 2".into(),
            })
            .expect_err("ingested signal cannot be replaced");
        assert!(replace.contains("ingested"));
        let remove = data
            .remove_derived_signal("derived/value")
            .expect_err("ingested signal cannot be removed");
        assert!(remove.contains("ingested"));
        assert_eq!(
            data.store
                .signal_by_path("derived/value")
                .expect("ingested signal remains")
                .source_id,
            source
        );
    }

    #[test]
    fn extensionless_workspace_saves_gain_the_default_extension() {
        assert_eq!(
            normalized_session_save_path(PathBuf::from("/tmp/goodstuff")),
            PathBuf::from("/tmp/goodstuff.signalscope")
        );
        assert_eq!(
            normalized_session_save_path(PathBuf::from("/tmp/goodstuff.json")),
            PathBuf::from("/tmp/goodstuff.json")
        );
        assert_eq!(
            normalized_session_save_path(PathBuf::from("/tmp/goodstuff.signalscope.json")),
            PathBuf::from("/tmp/goodstuff.signalscope.json")
        );
    }

    #[test]
    fn export_paths_gain_the_requested_extension() {
        assert_eq!(
            normalized_export_save_path(PathBuf::from("/tmp/snap"), "html"),
            PathBuf::from("/tmp/snap.html")
        );
        assert_eq!(
            normalized_export_save_path(PathBuf::from("/tmp/snap.html"), "html"),
            PathBuf::from("/tmp/snap.html")
        );
        assert_eq!(
            normalized_export_save_path(PathBuf::from("/tmp/plot.csv"), "png"),
            PathBuf::from("/tmp/plot.png")
        );
    }

    #[test]
    fn directory_export_names_are_single_path_components() {
        let directory = Path::new("/tmp/exports");
        assert_eq!(
            export_file_path(directory, "plot.png", "png").expect("valid file name"),
            directory.join("plot.png")
        );
        assert!(export_file_path(directory, "../plot.png", "png").is_err());
        assert!(export_file_path(directory, "nested/plot.png", "png").is_err());
        assert!(export_file_path(directory, "", "png").is_err());
    }

    #[test]
    fn estimate_covers_every_range_and_fidelity_once() {
        let (mut data, _) = data_with_signal("input/x");
        let signal = data.store.signal_by_path("input/x").expect("signal");
        data.pyramids
            .insert(signal.id, Pyramid::from_signal(signal));
        let session = session::Session::default();
        let estimate = estimate_for(&data, &session, "{}", 1_000).expect("estimate");
        assert_eq!(estimate.entries.len(), 8);
        for range in [ExportRange::Visible, ExportRange::All] {
            let entries: Vec<_> = estimate
                .entries
                .iter()
                .filter(|entry| entry.range == range)
                .collect();
            assert_eq!(entries.len(), 4);
            assert!(
                entries
                    .windows(2)
                    .all(|pair| pair[0].bytes <= pair[1].bytes)
            );
        }
    }

    #[test]
    fn failed_export_rename_removes_the_staging_file() {
        let root = std::env::temp_dir().join(format!(
            "signalscope-export-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("temporary directory");
        let destination = root.join("destination.html");
        std::fs::create_dir(&destination).expect("destination directory");

        assert!(write_export_file(&destination, "snapshot").is_err());
        assert_eq!(
            std::fs::read_dir(&root)
                .expect("read temporary directory")
                .count(),
            1
        );

        std::fs::remove_dir_all(root).expect("remove temporary directory");
    }

    #[test]
    fn resetting_data_clears_sources_signals_and_derived_state() {
        let (mut data, _) = data_with_signal("input/x");
        data.create_derived_signal(DerivedRequest {
            path: "derived/a".into(),
            expr: "'input/x'".into(),
        })
        .expect("create derived signal");

        data.reset();

        assert_eq!(data.store.sources().count(), 0);
        assert_eq!(data.store.signals().count(), 0);
        assert!(data.pyramids.is_empty());
        assert!(data.derived_source.is_none());
        assert!(data.derived_references.is_empty());
    }
}

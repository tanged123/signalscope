use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use base64::Engine;
use scope_core::{
    cache::{self, CacheRoot},
    columns::Column,
    compute, expr,
    ingest::{
        self, DecodedSource, IngestError, IngestSummary,
        admission::{BudgetConfig, MemoryBudget, ResidentCharge},
        batch::{BatchJobs, BatchOptions, CommitSink},
        container::ContainerReader,
        registry::ProviderRegistry,
    },
    paging::PageHandle,
    preferences,
    pyramid::Pyramid,
    restore, session, snapshot,
    sources::{SourceRecord, SourceRegistry},
    store::{Signal, SignalId, SignalStore, Source, SourceId, SourceKey},
};
use scope_protocol::{
    AliasConflictSummary, BatchDetail, BatchDetailRequest, BatchFailure, BatchFileStatus, BatchJob,
    BatchState, BatchStatus, ContainerOutline, CreateDerivedBundleRequest, DatasetOutline,
    DatasetOutlineKind, DerivedBundleResponse, DerivedRequest, DragDropForward, DragDropKind,
    Envelope, ExportEstimate, ExportEstimateEntry, ExportEstimateRequest, ExportFidelity,
    ExportFileKind, ExportRange, ExportSelection, ExportWriteRequest, FileState, FormatCount,
    FormatDescriptor, IngestBatchRequest, IntrospectRequest, LoadSessionRequest, LoadedSession,
    PickSessionRequest, RecipeDestination, RemoveDerivedBundleRequest, RemoveSignalRequest,
    RestoreReconcileRequest, RestoreReconcileResponse, RestoreSourcesRequest, SampleRequest,
    SampleResponse, SampleSeries, SaveExportFileRequest, SaveExportFileToDirectoryRequest,
    SaveRecipeRequest, SaveRecipeResponse, SaveSessionRequest, ScanSourcesRequest,
    ScanSourcesResponse, SessionDialogMode, SignalSummary, SignalTile, SkippedMemberSummary,
    SourceSummary, TileRequest, TileResponse,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

struct DataState {
    store: SignalStore,
    pyramids: BTreeMap<SignalId, Pyramid>,
    registry: SourceRegistry,
    derived_source: Option<SourceId>,
    derived_references: BTreeMap<String, Vec<String>>,
    derived_bundles: BTreeMap<String, String>,
    derived_spills: BTreeMap<String, PageHandle>,
    derived_charges: BTreeMap<String, ResidentCharge>,
    cache_root: PathBuf,
    budget: MemoryBudget,
}

impl Default for DataState {
    fn default() -> Self {
        Self {
            store: SignalStore::default(),
            pyramids: BTreeMap::new(),
            registry: SourceRegistry::default(),
            derived_source: None,
            derived_references: BTreeMap::new(),
            derived_bundles: BTreeMap::new(),
            derived_spills: BTreeMap::new(),
            derived_charges: BTreeMap::new(),
            cache_root: std::env::temp_dir().join("signalscope/cache"),
            budget: MemoryBudget::new(BudgetConfig::from_available(8 * 1024 * 1024 * 1024)),
        }
    }
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

fn signal_summary(
    signal: &Signal,
    source_key: SourceKey,
    last_value: Option<f64>,
) -> SignalSummary {
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
        last_value,
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
        let descriptors = format_descriptors(&ProviderRegistry::builtin());
        let extensions: Vec<&str> = descriptors
            .iter()
            .flat_map(|descriptor| descriptor.extensions.iter().map(String::as_str))
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
        for descriptor in &descriptors {
            let extensions = descriptor
                .extensions
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            dialog = dialog.add_filter(&descriptor.label, &extensions);
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
async fn pick_source_folder(app: AppHandle) -> Result<Envelope<Option<String>>, String> {
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
    Envelope::new(format_descriptors(&ProviderRegistry::builtin()))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
async fn introspect_container(
    request: Envelope<IntrospectRequest>,
) -> Result<Envelope<ContainerOutline>, String> {
    tauri::async_runtime::spawn_blocking(move || introspect_container_blocking(request))
        .await
        .map_err(|error| error.to_string())?
}

fn introspect_container_blocking(
    request: Envelope<IntrospectRequest>,
) -> Result<Envelope<ContainerOutline>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let path = Path::new(&request.path);
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut probe = Vec::with_capacity(scope_core::ingest::registry::PROBE_BYTES);
    std::io::Read::by_ref(&mut file)
        .take(scope_core::ingest::registry::PROBE_BYTES as u64)
        .read_to_end(&mut probe)
        .map_err(|error| error.to_string())?;
    let (container, reader): (String, Box<dyn ContainerReader>) =
        if scope_core::ingest::container::hdf5::is_hdf5_magic(&probe) {
            let reader = scope_core::ingest::container::hdf5::Hdf5Container::open(path)
                .map_err(|error| error.to_string())?;
            ("hdf5".into(), Box::new(reader))
        } else if scope_core::ingest::container::parquet::is_parquet_magic(&probe) {
            let reader = scope_core::ingest::container::parquet::ParquetContainer::open(path)
                .map_err(|error| error.to_string())?;
            ("parquet".into(), Box::new(reader))
        } else {
            return Err("unsupported container magic".into());
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
                    scope_core::ingest::container::DatasetKind::Text => DatasetOutlineKind::Text,
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
    Ok(Envelope::new(ContainerOutline {
        container,
        datasets,
    }))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
async fn save_recipe(
    request: Envelope<SaveRecipeRequest>,
    app: AppHandle,
) -> Result<Envelope<SaveRecipeResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || save_recipe_blocking(request, &app))
        .await
        .map_err(|error| error.to_string())?
}

fn save_recipe_blocking(
    request: Envelope<SaveRecipeRequest>,
    app: &AppHandle,
) -> Result<Envelope<SaveRecipeResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let recipe = scope_core::ingest::recipe::parse_recipe(&request.recipe_toml)
        .map_err(|error| error.to_string())?;
    let destination = match request.destination {
        RecipeDestination::Sidecar => sidecar_destination(Path::new(&request.path))?,
        RecipeDestination::UserDirectory => {
            let preferences = preferences_path(app)
                .ok()
                .filter(|path| path.exists())
                .and_then(|path| preferences::load_from_path(&path).ok())
                .unwrap_or_default();
            let directory = recipe_directory(app, &preferences)
                .ok_or_else(|| "no recipe directory is available".to_owned())?;
            std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            directory.join(format!("{}.toml", recipe.id))
        }
    };
    write_recipe_file(&destination, &request.recipe_toml)?;
    // Saving a recipe is how the user reconfirms a source whose recorded
    // recipe went missing or changed, so drop the stale identity: otherwise
    // the re-ingest below compares this new recipe against the old digest and
    // fails exactly as it just did.
    if let Ok(canonical) = std::fs::canonicalize(&request.path) {
        let state = app.state::<Arc<Mutex<DataState>>>();
        if let Ok(mut data) = state.lock() {
            data.registry.forget_recipe(&canonical);
        }
    }
    let digest = scope_core::ingest::recipe::content_digest(&recipe);
    Ok(Envelope::new(SaveRecipeResponse {
        recipe_id: recipe.id,
        digest,
        saved_to: destination.display().to_string(),
    }))
}

/// Writes a recipe through a uniquely named temporary in the destination
/// directory. `OpenOptions::create_new` never follows a pre-planted symlink.
fn write_recipe_file(destination: &Path, contents: &str) -> Result<(), String> {
    static NEXT_RECIPE_ID: AtomicU64 = AtomicU64::new(0);
    let suffix = NEXT_RECIPE_ID.fetch_add(1, Ordering::Relaxed);
    write_recipe_file_with_suffix(destination, contents, suffix)
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
            let next_suffix = suffix.saturating_add(1);
            let next_temporary = destination.with_extension(format!("toml.{next_suffix}.tmp"));
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&next_temporary)
                .map_err(|error| error.to_string())?;
            (next_temporary, file)
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

/// Returns the sidecar path beside an existing regular source file.
fn sidecar_destination(source: &Path) -> Result<PathBuf, String> {
    if !source.is_file() {
        return Err("recipe source is not an existing file".to_owned());
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "source path has no file name".to_owned())?;
    Ok(source.with_file_name(format!("{}.scope.toml", file_name.to_string_lossy())))
}

fn format_descriptors(registry: &ProviderRegistry) -> Vec<FormatDescriptor> {
    registry
        .descriptors()
        .into_iter()
        .map(|descriptor| FormatDescriptor {
            id: descriptor.id,
            label: descriptor.label,
            extensions: descriptor.extensions,
        })
        .collect()
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
    let registry = ProviderRegistry::builtin();
    expand_sources_with_registry(paths, &registry)
}

fn expand_sources_with_registry(
    paths: Vec<String>,
    registry: &ProviderRegistry,
) -> Result<Vec<PathBuf>, String> {
    let descriptors = registry.descriptors();
    let mut expanded = Vec::new();
    for path in paths {
        expand_source(Path::new(&path), true, &mut expanded, &descriptors)?;
    }
    expanded.sort();
    Ok(expanded)
}

fn expand_source(
    path: &Path,
    recursive: bool,
    expanded: &mut Vec<PathBuf>,
    descriptors: &[scope_core::ingest::registry::ProviderDescriptor],
) -> Result<(), String> {
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
            if recursive {
                expand_source(&path, true, expanded, descriptors)?;
            }
        } else if supported_path(descriptors, &path) {
            expanded.push(path);
        }
    }
    Ok(())
}

/// Envelope payload for a forwarded window drag-drop event. Paths use
/// `display()` like every other path the shell hands the frontend.
fn drag_forward(kind: DragDropKind, paths: &[PathBuf]) -> Envelope<DragDropForward> {
    Envelope::new(DragDropForward {
        kind,
        paths: paths
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn scan_sources(
    request: Envelope<ScanSourcesRequest>,
) -> Result<Envelope<ScanSourcesResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let registry = ProviderRegistry::builtin();
    let descriptors = registry.descriptors();
    let mut paths = Vec::new();
    expand_source(
        Path::new(&request.path),
        request.recursive,
        &mut paths,
        &descriptors,
    )?;
    paths.retain(|path| supported_path(&descriptors, path));
    paths.sort();

    let mut total_bytes = 0_u64;
    let mut counts = BTreeMap::<String, u32>::new();
    let files = paths
        .into_iter()
        .filter_map(|path| {
            let metadata = std::fs::metadata(&path).ok()?;
            total_bytes = total_bytes.saturating_add(metadata.len());
            let label = format_label(&descriptors, &path)?;
            *counts.entry(label).or_default() += 1;
            Some(path.display().to_string())
        })
        .collect();
    Ok(Envelope::new(ScanSourcesResponse {
        files,
        total_bytes,
        format_counts: counts
            .into_iter()
            .map(|(label, count)| FormatCount { label, count })
            .collect(),
    }))
}

fn supported_path(
    descriptors: &[scope_core::ingest::registry::ProviderDescriptor],
    path: &Path,
) -> bool {
    format_label(descriptors, path).is_some()
}

fn format_label(
    descriptors: &[scope_core::ingest::registry::ProviderDescriptor],
    path: &Path,
) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .and_then(|extension| {
            descriptors.iter().find_map(|descriptor| {
                descriptor
                    .extensions
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(extension))
                    .then(|| descriptor.label.clone())
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
    let mut data = state.lock().map_err(|error| error.to_string())?;
    data.reexpand_derived_bundles();
    Ok(Envelope::new(signal_summaries(&data)))
}

fn signal_summaries(data: &DataState) -> Vec<SignalSummary> {
    data.store
        .signals()
        .map(|signal| {
            let key = data
                .store
                .sources()
                .find(|source| source.id == signal.source_id)
                .expect("signal source")
                .key;
            signal_summary(
                signal,
                key,
                data.pyramids
                    .get(&signal.id)
                    .and_then(Pyramid::last_finite_value),
            )
        })
        .collect()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn query_tiles(
    request: Envelope<TileRequest>,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<TileResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let data = state.lock().map_err(|error| error.to_string())?;
    let per_series = request.max_total_bins.map(|budget| {
        (budget / u32::try_from(request.signal_ids.len().max(1)).unwrap_or(u32::MAX)).max(64)
    });
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
        let query = pyramid.query_with_target(
            request.window.t0,
            request.window.t1,
            request.pixel_width,
            per_series,
        );
        series.push(SignalTile {
            signal_id: raw_id,
            signal_path: signal.path.clone(),
            unit: signal.unit.clone(),
            level: query.level,
            bins: query.bins.to_wire_vec(),
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
        let (time, values) = windowed_slice(signal, request.window.t0, request.window.t1)?;
        let slice = compute::sample_window(
            &time,
            &values,
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

fn windowed_slice(
    signal: &Signal,
    t0: f64,
    t1: f64,
) -> Result<
    (
        scope_core::columns::ColumnGuard,
        scope_core::columns::ColumnGuard,
    ),
    String,
> {
    let time_column = signal.time_column();
    let start = time_column
        .partition_point(|time| time < t0)
        .map_err(|error| error.to_string())?
        .saturating_sub(1);
    let end = time_column
        .partition_point(|time| time <= t1)
        .map_err(|error| error.to_string())?
        .saturating_add(1)
        .min(time_column.len());
    let time = time_column
        .range(start..end)
        .map_err(|error| error.to_string())?;
    let values = signal
        .values_column()
        .range(start..end)
        .map_err(|error| error.to_string())?;
    Ok((time, values))
}

const DERIVED_PREFIX: &str = "derived/";
type BundleInputs = (
    BTreeSet<String>,
    BTreeMap<SourceKey, (String, BTreeSet<String>)>,
);

impl DataState {
    fn reset(&mut self) {
        for handle in self.derived_spills.values() {
            let _ = std::fs::remove_file(handle.path());
        }
        let cache_root = self.cache_root.clone();
        let budget = self.budget.clone();
        *self = Self {
            cache_root,
            budget,
            ..Self::default()
        };
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
    ) -> Result<SignalSummary, String> {
        let bytes = evaluated.values.len().saturating_mul(size_of::<f64>());
        let charge = self
            .budget
            .acquire_working(bytes)
            .and_then(scope_core::ingest::admission::Ticket::transfer_to_resident)
            .ok();
        let (values, spill) = if charge.is_some() {
            (Column::from(evaluated.values), None)
        } else {
            let timebase_id = references
                .first()
                .and_then(|reference| self.store.signal_by_path(reference))
                .map(Signal::timebase_id)
                .ok_or_else(|| "derived expression has no timebase".to_owned())?;
            let handle = cache::spill_columns(
                &CacheRoot::app_owned(&self.cache_root),
                timebase_id,
                &evaluated.time,
                &evaluated.values,
            )
            .map_err(|error| error.to_string())?;
            (Column::paged(handle.clone()), Some(handle))
        };
        let signal_id = self
            .store
            .insert_signal(source_id, path, None, evaluated.time, values)
            .map_err(|error| error.to_string())?;
        let signal = self
            .store
            .signal(signal_id)
            .ok_or_else(|| "derived signal vanished after insertion".to_owned())?;
        let source_key = self
            .store
            .sources()
            .find(|source| source.id == source_id)
            .expect("derived source")
            .key;
        let pyramid = Pyramid::from_signal(signal);
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
    ) -> Result<DerivedBundleResponse, String> {
        let name = request
            .name
            .strip_prefix(DERIVED_PREFIX)
            .unwrap_or(&request.name)
            .to_owned();
        if name.is_empty() {
            return Err("derived bundle name is empty".into());
        }
        if name.contains('/') {
            return Err("derived bundle names are a single segment".into());
        }
        if self.derived_bundles.contains_key(&name) {
            return Err(format!("derived bundle already exists: {name}"));
        }
        let (full_paths, locals) = self.bundle_inputs();
        let expansion = scope_core::derived_bundle::expand(&request.expr, &full_paths, &locals)
            .map_err(|error| error.to_string())?;
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
                    missing: vec![error],
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

    fn reexpand_derived_bundles(&mut self) {
        let definitions: Vec<(String, String)> = self
            .derived_bundles
            .iter()
            .map(|(name, expr)| (name.clone(), expr.clone()))
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
    ) -> Result<(), String> {
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
        self.remove_spill(path);
        self.derived_charges.remove(path);
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
fn create_derived_bundle(
    request: Envelope<CreateDerivedBundleRequest>,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<DerivedBundleResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let mut data = state.lock().map_err(|error| error.to_string())?;
    data.create_derived_bundle(request).map(Envelope::new)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn remove_derived_bundle(
    request: Envelope<RemoveDerivedBundleRequest>,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<Envelope<()>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let mut data = state.lock().map_err(|error| error.to_string())?;
    data.remove_derived_bundle(&request)?;
    Ok(Envelope::new(()))
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
    selection: &ExportSelection,
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
            let plan = snapshot::plan_selected(
                session,
                &data.store,
                &data.pyramids,
                selection,
                range,
                fidelity,
            )?;
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
        estimate_for(
            &data,
            &session,
            &request.session_json,
            template_bytes,
            &request.selection,
        )
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
        let export = snapshot::plan_selected(
            &session,
            &data.store,
            &data.pyramids,
            &request.selection,
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
async fn pick_recipe_directory(app: AppHandle) -> Result<Envelope<Option<String>>, String> {
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

/// The recipe directory currently in use. The renderer must never build this
/// path itself: the default is the per-OS app data directory, which only the
/// host can resolve.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn effective_recipe_directory(app: AppHandle) -> Result<Envelope<String>, String> {
    let preferences = preferences_path(&app)
        .ok()
        .filter(|path| path.exists())
        .and_then(|path| preferences::load_from_path(&path).ok())
        .unwrap_or_default();
    let directory = recipe_directory(&app, &preferences)
        .ok_or_else(|| "no recipe directory is available".to_owned())?;
    Ok(Envelope::new(directory.display().to_string()))
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

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("cache"))
}

/// The directory user recipes are saved to and resolved from. Saving and
/// resolving must agree: a recipe written somewhere resolution never reads is
/// a silent no-op, so both go through here rather than defaulting separately.
fn recipe_directory(app: &AppHandle, preferences: &preferences::Preferences) -> Option<PathBuf> {
    preferences
        .recipe_directory
        .as_ref()
        .map(PathBuf::from)
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|data| data.join("recipes"))
        })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn load_preferences(app: AppHandle) -> Result<Envelope<Option<String>>, String> {
    let path = preferences_path(&app)?;
    if !path.exists() {
        return Ok(Envelope::new(None));
    }
    let mut preferences = preferences::load_from_path(&path).map_err(|error| error.to_string())?;
    if preferences.cache_root.is_none() {
        preferences.cache_root = Some(cache_path(&app)?.display().to_string());
    }
    Ok(Envelope::new(Some(
        serde_json::to_string(&preferences).map_err(|error| error.to_string())?,
    )))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn save_preferences(request: Envelope<String>, app: AppHandle) -> Result<Envelope<()>, String> {
    let json = request.open().map_err(|error| error.to_string())?;
    let mut preferences = preferences::from_json(&json).map_err(|error| error.to_string())?;
    if preferences.cache_root.is_none() {
        preferences.cache_root = Some(cache_path(&app)?.display().to_string());
    }
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            use tauri::{DragDropEvent, Emitter, WindowEvent};
            let WindowEvent::DragDrop(event) = event else {
                return;
            };
            let payload = match event {
                DragDropEvent::Enter { paths, .. } => drag_forward(DragDropKind::Enter, paths),
                DragDropEvent::Drop { paths, .. } => drag_forward(DragDropKind::Drop, paths),
                DragDropEvent::Leave => drag_forward(DragDropKind::Leave, &[]),
                // Over fires at pointer-move frequency; never forwarded.
                _ => return,
            };
            let _ = window.emit("scope://drag-drop", payload);
        })
        .manage(Arc::new(Mutex::new(DataState::default())))
        .manage(RestoreGate::default())
        .setup(move |app| {
            let path = preferences_path(app.handle()).map_err(std::io::Error::other)?;
            let preferences = if path.exists() {
                preferences::load_from_path(&path).map_err(std::io::Error::other)?
            } else {
                preferences::Preferences::default()
            };
            let root = preferences
                .cache_root
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or(cache_path(app.handle()).map_err(std::io::Error::other)?);
            let defaults = BudgetConfig::from_available(8 * 1024 * 1024 * 1024);
            let config = BudgetConfig {
                working_bytes: preferences
                    .ingest_working_bytes
                    .and_then(|value| usize::try_from(value).ok())
                    .unwrap_or(defaults.working_bytes),
                resident_bytes: preferences
                    .ingest_resident_bytes
                    .and_then(|value| usize::try_from(value).ok())
                    .unwrap_or(defaults.resident_bytes),
            };
            let budget = MemoryBudget::new(config);
            {
                let state = app.state::<Arc<Mutex<DataState>>>();
                let mut data = state
                    .lock()
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
                data.cache_root.clone_from(&root);
                data.budget = budget.clone();
            }
            app.manage(BatchJobs::new(BatchOptions {
                worker_count: workers,
                budget: Arc::new(budget),
                terminal_ttl: Duration::from_secs(300),
                cache_directory: Some(root),
                recipe_directory: recipe_directory(app.handle(), &preferences),
                provider_registry: Arc::new(ProviderRegistry::builtin()),
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_sources,
            pick_source_folder,
            scan_sources,
            ingest_batch,
            batch_status,
            batch_detail,
            cancel_batch,
            release_batch,
            list_formats,
            introspect_container,
            save_recipe,
            restore_sources,
            restore_reconcile,
            list_sources,
            list_signals,
            query_tiles,
            query_samples,
            create_derived,
            create_derived_bundle,
            remove_derived_bundle,
            remove_signal,
            save_session,
            load_session,
            reset_session,
            pick_session_path,
            export_estimate,
            export_write,
            save_export_file,
            pick_export_directory,
            pick_recipe_directory,
            effective_recipe_directory,
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
        ingest::{
            DecodedSignal, DecodedSource,
            batch::CommitSink,
            registry::{Confidence, FormatProvider, ProviderRegistry},
        },
        sources::SourceRecord,
    };

    use super::*;

    const SAMPLE_RECIPE_TOML: &str = r#"id = "flight"
container = "hdf5"

[[selection]]
datasets = "signal"
name = "keep"

[selection.time]
kind = "index"
dt = 1.0
t0 = 0.0
"#;

    #[cfg(unix)]
    #[test]
    fn a_planted_temporary_symlink_cannot_redirect_a_recipe_write() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("data.h5");
        std::fs::write(&source, b"\x89HDF\r\n\x1a\n").unwrap();
        let victim = directory.path().join("victim.txt");
        std::fs::write(&victim, b"precious").unwrap();
        let destination = directory.path().join("data.h5.scope.toml");
        std::os::unix::fs::symlink(&victim, destination.with_extension("toml.0.tmp")).unwrap();

        let written = write_recipe_file_with_suffix(&destination, SAMPLE_RECIPE_TOML, 0);

        assert!(
            written.is_ok(),
            "a planted symlink must not block the write"
        );
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "precious",
            "the victim file must be untouched"
        );
    }

    #[test]
    fn a_sidecar_destination_requires_an_existing_regular_source_file() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("nope.h5");
        assert!(sidecar_destination(&missing).is_err());
    }

    #[test]
    fn drag_forwarding_serializes_kind_and_display_paths() {
        let payload = drag_forward(
            DragDropKind::Drop,
            &[std::path::PathBuf::from("/data/run 01.csv")],
        );
        let opened = payload.open().unwrap();
        assert!(matches!(opened.kind, DragDropKind::Drop));
        assert_eq!(opened.paths, ["/data/run 01.csv"]);

        let leave = drag_forward(DragDropKind::Leave, &[]).open().unwrap();
        assert!(leave.paths.is_empty());
    }

    #[test]
    fn sample_slice_reads_only_the_window() {
        let times: Arc<[f64]> = (0..=1000).map(f64::from).collect();
        let values: Arc<[f64]> = (0..=1000).map(f64::from).collect();
        let signal = Signal::new(
            SignalId(1),
            SourceId(1),
            "signal",
            "signal",
            None,
            times,
            values,
        )
        .unwrap();
        let (time, values) = windowed_slice(&signal, 10.0, 20.0).unwrap();
        assert!(time.first().is_some_and(|time| *time >= 9.0));
        assert!(time.last().is_some_and(|time| *time <= 21.0));
        assert_eq!(time.len(), values.len());
    }

    #[test]
    fn the_picker_filters_come_from_the_registry_not_a_static_table() {
        let mut registry = ProviderRegistry::builtin();
        registry.register(FormatProvider::new(
            "hdf5",
            "HDF5 containers",
            &["h5", "hdf5"],
            5,
            1,
            |_| Confidence::No,
            || Box::new(scope_core::ingest::CsvDecoder),
        ));
        let descriptors = format_descriptors(&registry);

        assert!(descriptors.iter().any(|entry| entry.id == "hdf5"));
        let extensions: Vec<_> = descriptors
            .iter()
            .flat_map(|entry| entry.extensions.clone())
            .collect();
        assert!(extensions.contains(&"h5".to_owned()));
        assert!(extensions.contains(&"csv".to_owned()));
    }

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

    fn data_with_bundle_sources() -> DataState {
        let mut data = DataState::default();
        let source_specs = [
            (1_u8, "run_01", true),
            (2_u8, "run_02", true),
            (3_u8, "run_03", false),
        ];
        for (byte, prefix, has_alt) in source_specs {
            let key = SourceKey(uuid::Uuid::from_bytes([byte; 16]));
            let source = data
                .store
                .register_source(format!("{prefix}.csv"), key, prefix)
                .unwrap();
            data.store
                .insert_signal(
                    source,
                    "temp",
                    None,
                    Arc::from(vec![0.0, 1.0]),
                    vec![1.0, 2.0],
                )
                .unwrap();
            if has_alt {
                data.store
                    .insert_signal(
                        source,
                        "alt",
                        None,
                        Arc::from(vec![0.0, 1.0]),
                        vec![3.0, 4.0],
                    )
                    .unwrap();
            }
        }
        data
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
            recipe_id: None,
            recipe_digest: None,
            reconcile_legacy: false,
        };
        let time: Arc<[f64]> = Arc::from(vec![0.0, 1.0, 2.0, 3.0]);
        let pyramid = Pyramid::from_samples(&time, &[1.0, 2.0, 3.0, 4.0]);
        let decoded = DecodedSource {
            row_count: 4,
            signals: vec![DecodedSignal {
                local_path: "imu/ax".into(),
                unit: None,
                time: time.into(),
                values: vec![1.0, 2.0, 3.0, 4.0].into(),
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
    fn scan_sources_respects_recursion_and_reports_bytes_and_formats() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(dir.path().join("b.csv"), "12345").unwrap();
        std::fs::write(dir.path().join("ignored.json"), "ignore").unwrap();
        std::fs::write(nested.join("a.mcap"), "1234567").unwrap();

        let flat = scan_sources(Envelope::new(ScanSourcesRequest {
            path: dir.path().display().to_string(),
            recursive: false,
        }))
        .unwrap()
        .open()
        .unwrap();
        assert_eq!(
            flat.files,
            vec![dir.path().join("b.csv").display().to_string()]
        );
        assert_eq!(flat.total_bytes, 5);
        assert_eq!(
            flat.format_counts,
            vec![FormatCount {
                label: "Delimited text (CSV, TSV, TXT, DAT)".into(),
                count: 1,
            }]
        );

        let recursive = scan_sources(Envelope::new(ScanSourcesRequest {
            path: dir.path().display().to_string(),
            recursive: true,
        }))
        .unwrap()
        .open()
        .unwrap();
        assert_eq!(recursive.total_bytes, 12);
        assert_eq!(
            recursive.format_counts,
            vec![
                FormatCount {
                    label: "Delimited text (CSV, TSV, TXT, DAT)".into(),
                    count: 1,
                },
                FormatCount {
                    label: "MCAP recordings (MCAP)".into(),
                    count: 1,
                },
            ]
        );
    }

    #[test]
    fn scan_sources_reports_empty_directories() {
        let dir = tempfile::tempdir().unwrap();
        let scan = scan_sources(Envelope::new(ScanSourcesRequest {
            path: dir.path().display().to_string(),
            recursive: true,
        }))
        .unwrap()
        .open()
        .unwrap();

        assert!(scan.files.is_empty());
        assert_eq!(scan.total_bytes, 0);
        assert!(scan.format_counts.is_empty());
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
    fn creates_partial_derived_bundles_and_removes_all_members() {
        let mut data = data_with_bundle_sources();
        let response = data
            .create_derived_bundle(CreateDerivedBundleRequest {
                name: "score".into(),
                expr: "'temp' + 'alt'".into(),
            })
            .expect("create bundle");
        assert_eq!(response.local_path, "derived/score");
        assert_eq!(response.created.len(), 2);
        assert_eq!(response.skipped.len(), 1);
        assert_eq!(response.skipped[0].prefix, "run_03");
        assert_eq!(response.skipped[0].missing, ["alt"]);
        assert!(data.store.signal_by_path("run_01/derived/score").is_some());
        assert!(data.store.signal_by_path("run_02/derived/score").is_some());
        assert!(data.store.signal_by_path("run_03/derived/score").is_none());
        assert!(
            data.create_derived_bundle(CreateDerivedBundleRequest {
                name: "score".into(),
                expr: "'temp'".into(),
            })
            .is_err()
        );

        data.remove_derived_bundle(&RemoveDerivedBundleRequest {
            name: "score".into(),
        })
        .expect("remove bundle");
        assert!(data.store.signal_by_path("run_01/derived/score").is_none());
        assert!(data.store.signal_by_path("run_02/derived/score").is_none());
        assert!(!data.derived_bundles.contains_key("score"));
    }

    #[test]
    fn rejects_derived_bundle_names_with_nested_paths() {
        let mut data = data_with_bundle_sources();
        let error = data
            .create_derived_bundle(CreateDerivedBundleRequest {
                name: "derived/score/extra".into(),
                expr: "'temp'".into(),
            })
            .expect_err("nested name must be rejected");
        assert_eq!(error, "derived bundle names are a single segment");
    }

    #[test]
    fn bundle_inputs_exclude_the_derived_source() {
        let mut data = data_with_bundle_sources();
        data.create_derived_signal(DerivedRequest {
            path: "derived/base".into(),
            expr: "'run_01/temp' * 2".into(),
        })
        .expect("creates derived signal");
        let derived_source = data.derived_source.expect("derived source");
        let derived_key = data
            .store
            .sources()
            .find(|source| source.id == derived_source)
            .expect("registered derived source")
            .key;

        let (_, locals) = data.bundle_inputs();

        assert!(!locals.contains_key(&derived_key));
        assert_eq!(locals.len(), 3);
    }

    #[test]
    fn signal_summaries_report_last_values_only_for_available_pyramids() {
        let mut data = data_with_bundle_sources();
        let signal = data
            .store
            .signal_by_path("run_01/temp")
            .expect("signal with pyramid");
        data.pyramids
            .insert(signal.id, Pyramid::from_signal(signal));

        let summaries = signal_summaries(&data);
        assert_eq!(
            summaries
                .iter()
                .find(|summary| summary.path == "run_01/temp")
                .and_then(|summary| summary.last_value),
            Some(2.0)
        );
        assert_eq!(
            summaries
                .iter()
                .find(|summary| summary.path == "run_02/temp")
                .and_then(|summary| summary.last_value),
            None
        );
    }

    #[test]
    fn a_derived_signal_spills_when_it_exceeds_the_resident_budget() {
        let (mut data, _) = data_with_signal("input/x");
        data.cache_root = tempfile::tempdir().unwrap().keep();
        data.budget = MemoryBudget::new(BudgetConfig {
            working_bytes: 1024,
            resident_bytes: 1,
        });

        let summary = data
            .create_derived_signal(DerivedRequest {
                path: "derived/a".into(),
                expr: "'input/x' * 2".into(),
            })
            .unwrap();
        let signal = data.store.signal(SignalId(summary.signal_id)).unwrap();

        assert_eq!(summary.last_value, Some(4.0));
        assert!(signal.is_paged());
        assert_eq!(&*signal.values(), &[2.0, 4.0]);
    }

    #[test]
    fn removing_a_derived_signal_deletes_its_spill_file() {
        let (mut data, _) = data_with_signal("input/x");
        data.cache_root = tempfile::tempdir().unwrap().keep();
        data.budget = MemoryBudget::new(BudgetConfig {
            working_bytes: 1024,
            resident_bytes: 1,
        });
        data.create_derived_signal(DerivedRequest {
            path: "derived/a".into(),
            expr: "'input/x' * 2".into(),
        })
        .unwrap();
        let path = data.derived_spills["derived/a"].path().to_owned();

        data.remove_derived_signal("derived/a").unwrap();

        assert!(!path.exists());
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
        let selection = ExportSelection {
            source_keys: data
                .store
                .sources()
                .map(|source| source.key.0.to_string())
                .collect(),
        };
        let estimate = estimate_for(&data, &session, "{}", 1_000, &selection).expect("estimate");
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

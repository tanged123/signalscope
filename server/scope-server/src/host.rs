use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write as _},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

use scope_core::{
    ingest::{
        self, DecodedSource, IngestError, IngestSummary,
        admission::{BudgetConfig, MemoryBudget},
        batch::CommitSink,
        container::ContainerReader,
        registry::ProviderRegistry,
    },
    pyramid::Pyramid,
    session,
    sources::{SourceRecord, SourceRegistry},
    store::{Signal, SignalId, SignalStore, Source, SourceKey},
};
use scope_protocol::{
    BatchFailure, BatchState, BatchStatus, ContainerOutline, DatasetOutline, DatasetOutlineKind,
    Envelope, FormatCount, FormatDescriptor, ScanSourcesResponse, SignalSummary, SourceSummary,
};

pub struct DataState {
    pub(crate) store: SignalStore,
    pub(crate) pyramids: BTreeMap<SignalId, Pyramid>,
    pub(crate) registry: SourceRegistry,
    derived: scope_core::derived::DerivedSignals,
    pub(crate) cache_root: PathBuf,
    pub(crate) budget: MemoryBudget,
}

impl Default for DataState {
    fn default() -> Self {
        Self {
            store: SignalStore::default(),
            pyramids: BTreeMap::new(),
            registry: SourceRegistry::default(),
            derived: scope_core::derived::DerivedSignals::default(),
            cache_root: std::env::temp_dir().join("signalscope/cache"),
            budget: MemoryBudget::new(BudgetConfig::from_available(8 * 1024 * 1024 * 1024)),
        }
    }
}

#[derive(Default)]
pub struct RestoreGate(AtomicUsize);

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

    pub(crate) fn clear(&self) {
        self.0.store(0, Ordering::Release);
    }

    pub(crate) fn save_allowed(&self, autosave: bool) -> Result<(), String> {
        (!autosave || self.0.load(Ordering::Acquire) == 0)
            .then_some(())
            .ok_or_else(|| "restore in progress".into())
    }
}

pub(crate) struct RestoreSettlement<'a>(pub(crate) &'a RestoreGate);

impl Drop for RestoreSettlement<'_> {
    fn drop(&mut self) {
        self.0.settle();
    }
}

pub(crate) fn signal_summary(
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

pub(crate) fn source_summary(source: &Source) -> SourceSummary {
    SourceSummary {
        source_id: source.id.0,
        source_key: source.key.0.to_string(),
        prefix: source.prefix.clone(),
        path: source.path.display().to_string(),
        point_count: source.point_count as u64,
    }
}

pub(crate) struct ServerCommitSink {
    pub(crate) state: Arc<Mutex<DataState>>,
}

impl CommitSink for ServerCommitSink {
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

pub(crate) fn format_descriptors(registry: &ProviderRegistry) -> Vec<FormatDescriptor> {
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

pub(crate) fn core_source_record(record: &session::SourceRecord) -> Result<SourceRecord, String> {
    Ok(SourceRecord {
        key: SourceKey(uuid::Uuid::parse_str(&record.key).map_err(|error| error.to_string())?),
        path: PathBuf::from(&record.path),
        prefix: record.prefix.clone(),
        provider_id: record.provider_id.clone(),
        decode_provenance: record.decode_provenance.clone(),
        recipe_id: record.recipe_id.clone(),
        recipe_digest: record.recipe_digest.clone(),
    })
}

pub(crate) fn batch_status_response(status: scope_core::ingest::batch::BatchStatus) -> BatchStatus {
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

pub(crate) fn file_state(state: scope_core::ingest::batch::FileState) -> scope_protocol::FileState {
    use scope_core::ingest::batch::FileState as Core;
    match state {
        Core::Pending => scope_protocol::FileState::Pending,
        Core::Running => scope_protocol::FileState::Running,
        Core::Done => scope_protocol::FileState::Done,
        Core::Failed => scope_protocol::FileState::Failed,
        Core::Cancelled => scope_protocol::FileState::Cancelled,
    }
}

pub(crate) fn expand_sources(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    let registry = ProviderRegistry::builtin();
    expand_sources_with_registry(paths, &registry)
}

pub(crate) fn expand_sources_with_registry(
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

pub(crate) fn supported_path(
    descriptors: &[scope_core::ingest::registry::ProviderDescriptor],
    path: &Path,
) -> bool {
    format_label(descriptors, path).is_some()
}

pub(crate) fn format_label(
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

pub(crate) fn scan_sources(
    request: &scope_protocol::ScanSourcesRequest,
) -> Result<Envelope<ScanSourcesResponse>, String> {
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

pub(crate) fn introspect_container(
    request: &scope_protocol::IntrospectRequest,
) -> Result<Envelope<ContainerOutline>, String> {
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

pub(crate) fn write_recipe_file(destination: &Path, contents: &str) -> Result<(), String> {
    static NEXT_RECIPE_ID: AtomicU64 = AtomicU64::new(0);
    for _ in 0..1000 {
        let suffix = NEXT_RECIPE_ID.fetch_add(1, Ordering::Relaxed);
        let temporary = destination.with_extension(format!("toml.{suffix}.tmp"));
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
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
        return Ok(());
    }
    Err("could not create a temporary recipe file after 1000 attempts".into())
}

pub(crate) fn sidecar_destination(source: &Path) -> Result<PathBuf, String> {
    if !source.is_file() {
        return Err("recipe source is not an existing file".to_owned());
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "source path has no file name".to_owned())?;
    Ok(source.with_file_name(format!("{}.scope.toml", file_name.to_string_lossy())))
}

pub(crate) fn windowed_slice(
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

impl DataState {
    pub(crate) fn reset(&mut self) {
        let cache_root = self.cache_root.clone();
        let budget = self.budget.clone();
        *self = Self {
            cache_root,
            budget,
            ..Self::default()
        };
    }

    pub(crate) fn derived(&mut self) -> scope_core::derived::DerivedContext<'_> {
        scope_core::derived::DerivedContext {
            state: &mut self.derived,
            store: &mut self.store,
            pyramids: &mut self.pyramids,
            budget: &self.budget,
            cache_root: &self.cache_root,
        }
    }
}

pub(crate) fn signal_summaries(data: &DataState) -> Vec<SignalSummary> {
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

#[cfg(test)]
mod tests {
    #[test]
    fn recipe_write_walks_past_stale_temp_files() {
        let dir = std::env::temp_dir().join(format!("scope-recipe-retry-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let destination = dir.join("data.csv.scope.toml");
        for suffix in 0..32u64 {
            std::fs::write(
                dir.join(format!("data.csv.scope.toml.{suffix}.tmp")),
                "stale",
            )
            .unwrap();
        }
        super::write_recipe_file(&destination, "recipe = true").unwrap();
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            "recipe = true"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_gate_clear_unblocks_autosave_after_abandoned_restore() {
        let gate = super::RestoreGate::default();
        gate.begin();
        assert!(gate.save_allowed(true).is_err());
        gate.clear();
        assert!(gate.save_allowed(true).is_ok());
        gate.begin();
        assert!(gate.save_allowed(true).is_err());
    }

    #[tokio::test]
    async fn context_setup_creates_dirs_and_empty_store() {
        let dir = std::env::temp_dir().join(format!("scope-host-{}", std::process::id()));
        let ctx = crate::AppContext::new(dir.clone(), None, None);
        let state = ctx.state.lock().unwrap();
        assert!(state.store.signals().next().is_none());
        assert!(dir.join("cache").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}

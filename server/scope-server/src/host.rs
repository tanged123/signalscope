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
    cache::{self, CacheRoot},
    columns::Column,
    expr,
    ingest::{
        self, DecodedSource, IngestError, IngestSummary,
        admission::{BudgetConfig, MemoryBudget, ResidentCharge},
        batch::CommitSink,
        container::ContainerReader,
        registry::ProviderRegistry,
    },
    paging::PageHandle,
    pyramid::Pyramid,
    session,
    sources::{SourceRecord, SourceRegistry},
    store::{Signal, SignalId, SignalStore, Source, SourceId, SourceKey},
};
use scope_protocol::{
    BatchFailure, BatchState, BatchStatus, ContainerOutline, DatasetOutline, DatasetOutlineKind,
    DerivedBundleResponse, DerivedRequest, Envelope, FormatCount, FormatDescriptor,
    ScanSourcesResponse, SignalSummary, SkippedMemberSummary, SourceSummary,
};

pub struct DataState {
    pub(crate) store: SignalStore,
    pub(crate) pyramids: BTreeMap<SignalId, Pyramid>,
    pub(crate) registry: SourceRegistry,
    pub(crate) derived_source: Option<SourceId>,
    derived_references: BTreeMap<String, Vec<String>>,
    derived_bundles: BTreeMap<String, String>,
    derived_spills: BTreeMap<String, PageHandle>,
    derived_charges: BTreeMap<String, ResidentCharge>,
    pub(crate) cache_root: PathBuf,
    pub(crate) budget: MemoryBudget,
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
        reconcile_legacy: record.reconcile_legacy,
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

const DERIVED_PREFIX: &str = "derived/";
type BundleInputs = (
    BTreeSet<String>,
    BTreeMap<SourceKey, (String, BTreeSet<String>)>,
);

impl DataState {
    pub(crate) fn reset(&mut self) {
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

    pub(crate) fn create_derived_signal(
        &mut self,
        request: DerivedRequest,
    ) -> Result<SignalSummary, String> {
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

    pub(crate) fn create_derived_bundle(
        &mut self,
        request: scope_protocol::CreateDerivedBundleRequest,
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

    pub(crate) fn reexpand_derived_bundles(&mut self) {
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

    pub(crate) fn remove_derived_bundle(
        &mut self,
        request: &scope_protocol::RemoveDerivedBundleRequest,
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

    pub(crate) fn remove_derived_signal(&mut self, path: &str) -> Result<(), String> {
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

#![allow(clippy::missing_errors_doc)]

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
};
use base64::Engine;
use scope_core::{
    compute, ingest::batch::JobId, preferences, restore, session, snapshot, store::SignalId,
};
use scope_protocol::{
    AliasConflictSummary, BatchDetail, BatchDetailRequest, BatchJob, CreateDerivedBundleRequest,
    DerivedRequest, Envelope, ExportEstimate, ExportEstimateRequest, ExportFileKind, ExportRange,
    ExportWriteRequest, IngestBatchRequest, IntrospectRequest, LoadSessionRequest, LoadedSession,
    PickSessionRequest, RecipeDestination, RemoveDerivedBundleRequest, RemoveSignalRequest,
    RestoreReconcileRequest, RestoreReconcileResponse, RestoreSourcesRequest, SampleRequest,
    SampleResponse, SampleSeries, SaveExportFileRequest, SaveExportFileToDirectoryRequest,
    SaveRecipeRequest, SaveRecipeResponse, SaveSessionRequest, ScanSourcesRequest, TileRequest,
};

use crate::{AppContext, host};

pub(crate) type ApiError = (StatusCode, String);

pub(crate) fn err(message: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, message.into())
}

pub(crate) async fn with_state<T: Send + 'static>(
    ctx: &AppContext,
    f: impl FnOnce(&mut host::DataState) -> Result<T, String> + Send + 'static,
) -> Result<T, ApiError> {
    let state = Arc::clone(&ctx.state);
    tokio::task::spawn_blocking(move || {
        let mut guard = state.lock().map_err(|_| "state poisoned".to_string())?;
        f(&mut guard)
    })
    .await
    .map_err(|error| err(error.to_string()))?
    .map_err(err)
}

pub async fn list_formats() -> Result<impl IntoResponse, ApiError> {
    let registry = scope_core::ingest::registry::ProviderRegistry::builtin();
    Ok(Json(Envelope::new(host::format_descriptors(&registry))))
}

pub async fn pick_sources(State(ctx): State<AppContext>) -> Result<impl IntoResponse, ApiError> {
    let descriptors = scope_core::ingest::registry::ProviderRegistry::builtin();
    let dialogs = Arc::clone(&ctx.dialogs);
    let paths = tokio::task::spawn_blocking(move || {
        let owned = host::format_descriptors(&descriptors);
        let supported = owned
            .iter()
            .flat_map(|descriptor| descriptor.extensions.iter().map(String::as_str))
            .collect::<Vec<_>>();
        let filters = owned
            .iter()
            .map(|descriptor| {
                (
                    descriptor.label.as_str(),
                    descriptor
                        .extensions
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>();
        let mut filter_refs = Vec::with_capacity(filters.len() + 1);
        filter_refs.push(("Supported telemetry", supported.as_slice()));
        filter_refs.extend(
            filters
                .iter()
                .map(|(name, extensions)| (*name, extensions.as_slice())),
        );
        dialogs.pick_files("Open telemetry sources", &filter_refs)
    })
    .await
    .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        paths
            .unwrap_or_default()
            .into_iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>(),
    )))
}

pub async fn pick_source_folder(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || dialogs.pick_folder("Open source folder"))
        .await
        .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        path.map(|path| path.display().to_string()),
    )))
}

pub async fn pick_session_path(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<PickSessionRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || match request.mode {
        scope_protocol::SessionDialogMode::Open => {
            dialogs.pick_files("Open SignalScope workspace", &[])
        }
        scope_protocol::SessionDialogMode::Save => dialogs
            .save_file(
                "Save SignalScope workspace",
                "workspace.signalscope",
                &[("SignalScope workspace", &["signalscope", "json"])],
            )
            .map(|path| vec![path]),
    })
    .await
    .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        path.and_then(|paths| paths.into_iter().next())
            .map(|path| path.display().to_string()),
    )))
}

pub async fn pick_export_directory(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || dialogs.pick_folder("Choose export directory"))
        .await
        .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        path.map(|path| path.display().to_string()),
    )))
}

pub async fn pick_recipe_directory(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || dialogs.pick_folder("Choose recipe directory"))
        .await
        .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        path.map(|path| path.display().to_string()),
    )))
}

pub async fn export_write(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<ExportWriteRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || {
        dialogs.save_file(
            "Export HTML snapshot",
            "snapshot.html",
            &[("HTML snapshot", &["html"])],
        )
    })
    .await
    .map_err(|error| err(error.to_string()))?;
    let Some(path) = path else {
        return Ok(Json(Envelope::new(None::<String>)));
    };
    let path = normalized_export_save_path(path, "html");
    let template = std::fs::read_to_string(template_path(&ctx).map_err(err)?)
        .map_err(|error| err(error.to_string()))?;
    let session =
        session::from_json(&request.session_json).map_err(|error| err(error.to_string()))?;
    let manifest = {
        let data = ctx.state.lock().map_err(|error| err(error.to_string()))?;
        let export = snapshot::plan_selected(
            &session,
            &data.store,
            &data.pyramids,
            &request.selection,
            request.range,
            request.fidelity,
        )
        .map_err(|error| err(error.to_string()))?;
        snapshot::bake(&export, &session).map_err(|error| err(error.to_string()))?
    };
    let html = snapshot::inject(&template, manifest).map_err(|error| err(error.to_string()))?;
    write_export_file(&path, &html).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(Some(path.display().to_string()))))
}

pub async fn save_export_file(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<SaveExportFileRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let (label, extension) = match request.kind {
        ExportFileKind::Png => ("PNG image", "png"),
        ExportFileKind::Csv => ("CSV", "csv"),
    };
    let dialogs = Arc::clone(&ctx.dialogs);
    let file_name = request.file_name.clone();
    let path = tokio::task::spawn_blocking(move || {
        dialogs.save_file(label, &file_name, &[(label, &[extension])])
    })
    .await
    .map_err(|error| err(error.to_string()))?;
    let Some(path) = path else {
        return Ok(Json(Envelope::new(None::<String>)));
    };
    let path = normalized_export_save_path(path, extension);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data_base64)
        .map_err(|error| err(error.to_string()))?;
    std::fs::write(&path, bytes).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(Some(path.display().to_string()))))
}

fn normalized_export_save_path(mut path: PathBuf, extension: &str) -> PathBuf {
    if path.extension() != Some(std::ffi::OsStr::new(extension)) {
        path.set_extension(extension);
    }
    path
}

fn write_export_file(path: &Path, contents: &str) -> Result<(), std::io::Error> {
    std::fs::write(path, contents)
}

pub async fn scan_sources(
    Json(request): Json<Envelope<ScanSourcesRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = tokio::task::spawn_blocking(move || host::scan_sources(&request))
        .await
        .map_err(|error| err(error.to_string()))?
        .map_err(err)?;
    Ok(Json(response))
}

pub async fn ingest_batch(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<IngestBatchRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let paths = host::expand_sources(request.paths).map_err(err)?;
    let sink = Arc::new(host::ServerCommitSink {
        state: Arc::clone(&ctx.state),
    });
    let job = ctx.jobs.submit(paths, sink);
    Ok(Json(Envelope::new(BatchJob { job_id: job.0 })))
}

pub async fn batch_status(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<BatchJob>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let status = ctx
        .jobs
        .status(JobId(request.job_id))
        .ok_or_else(|| err(format!("unknown batch job: {}", request.job_id)))?;
    Ok(Json(Envelope::new(host::batch_status_response(status))))
}

pub async fn batch_detail(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<BatchDetailRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let detail = ctx
        .jobs
        .detail(
            JobId(request.job_id),
            request.offset as usize,
            request.limit as usize,
        )
        .ok_or_else(|| err(format!("unknown batch job: {}", request.job_id)))?;
    Ok(Json(Envelope::new(BatchDetail {
        total: detail.total,
        entries: detail
            .entries
            .into_iter()
            .map(|entry| scope_protocol::BatchFileStatus {
                path: entry.path.display().to_string(),
                state: host::file_state(entry.state),
                error: entry.error,
            })
            .collect(),
    })))
}

pub async fn cancel_batch(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<BatchJob>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    ctx.jobs.cancel(JobId(request.job_id));
    Ok(Json(Envelope::new(())))
}

pub async fn release_batch(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<BatchJob>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    ctx.jobs.release(JobId(request.job_id));
    Ok(Json(Envelope::new(())))
}

pub async fn introspect_container(
    Json(request): Json<Envelope<IntrospectRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = tokio::task::spawn_blocking(move || host::introspect_container(&request))
        .await
        .map_err(|error| err(error.to_string()))?
        .map_err(err)?;
    Ok(Json(response))
}

pub async fn save_recipe(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<SaveRecipeRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = tokio::task::spawn_blocking(move || save_recipe_blocking(&ctx, &request))
        .await
        .map_err(|error| err(error.to_string()))?
        .map_err(err)?;
    Ok(Json(response))
}

fn save_recipe_blocking(
    ctx: &AppContext,
    request: &SaveRecipeRequest,
) -> Result<Envelope<SaveRecipeResponse>, String> {
    let recipe = scope_core::ingest::recipe::parse_recipe(&request.recipe_toml)
        .map_err(|error| error.to_string())?;
    let destination = match request.destination {
        RecipeDestination::Sidecar => host::sidecar_destination(Path::new(&request.path))?,
        RecipeDestination::UserDirectory => {
            let preferences = load_preferences_value(ctx).unwrap_or_default();
            let directory = recipe_directory(ctx, &preferences)
                .ok_or_else(|| "no recipe directory is available".to_owned())?;
            std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            directory.join(format!("{}.toml", recipe.id))
        }
    };
    host::write_recipe_file(&destination, &request.recipe_toml)?;
    if let Ok(canonical) = std::fs::canonicalize(&request.path)
        && let Ok(mut data) = ctx.state.lock()
    {
        data.registry.forget_recipe(&canonical);
    }
    let digest = scope_core::ingest::recipe::content_digest(&recipe);
    Ok(Envelope::new(SaveRecipeResponse {
        recipe_id: recipe.id,
        digest,
        saved_to: destination.display().to_string(),
    }))
}

pub async fn restore_sources(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<RestoreSourcesRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let restored =
        session::from_json(&request.session_json).map_err(|error| err(error.to_string()))?;
    let records = restored
        .sources
        .iter()
        .map(host::core_source_record)
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    ctx.jobs
        .replace_sources(records.clone())
        .map_err(|error| err(error.to_string()))?;
    ctx.state
        .lock()
        .map_err(|error| err(error.to_string()))?
        .reset();
    ctx.gate.begin();
    let job = ctx.jobs.submit(
        records.iter().map(|record| record.path.clone()).collect(),
        Arc::new(host::ServerCommitSink {
            state: Arc::clone(&ctx.state),
        }),
    );
    Ok(Json(Envelope::new(BatchJob { job_id: job.0 })))
}

pub async fn restore_reconcile(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<RestoreReconcileRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let gate = Arc::clone(&ctx.gate);
    let jobs = Arc::clone(&ctx.jobs);
    let state = Arc::clone(&ctx.state);
    let response = tokio::task::spawn_blocking(move || {
        let _settlement = host::RestoreSettlement(&gate);
        jobs.join(JobId(request.job_id))
            .ok_or_else(|| format!("unknown batch job: {}", request.job_id))?;
        let mut restored =
            session::from_json(&request.session_json).map_err(|error| error.to_string())?;
        let mut builder = restore::AliasBuilder::default();
        let mut missing = std::collections::BTreeSet::new();
        {
            let data = state.lock().map_err(|error| error.to_string())?;
            for record in &mut restored.sources {
                let Ok(uuid) = uuid::Uuid::parse_str(&record.key) else {
                    continue;
                };
                let key = scope_core::store::SourceKey(uuid);
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
        Ok::<_, String>(Envelope::new(RestoreReconcileResponse {
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
    })
    .await
    .map_err(|error| err(error.to_string()))?
    .map_err(err)?;
    Ok(Json(response))
}

pub async fn list_sources(State(ctx): State<AppContext>) -> Result<impl IntoResponse, ApiError> {
    let sources = with_state(&ctx, |data| {
        Ok(data
            .store
            .sources()
            .map(host::source_summary)
            .collect::<Vec<_>>())
    })
    .await?;
    Ok(Json(Envelope::new(sources)))
}

pub async fn list_signals(State(ctx): State<AppContext>) -> Result<impl IntoResponse, ApiError> {
    let signals = with_state(&ctx, |data| {
        data.reexpand_derived_bundles();
        Ok(host::signal_summaries(data))
    })
    .await?;
    Ok(Json(Envelope::new(signals)))
}

pub async fn query_samples(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<SampleRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = with_state(&ctx, move |data| {
        let mut series = Vec::new();
        for raw_id in request.signal_ids {
            let signal = data
                .store
                .signal(SignalId(raw_id))
                .ok_or_else(|| format!("unknown signal id: {raw_id}"))?;
            let (time, values) =
                host::windowed_slice(signal, request.window.t0, request.window.t1)?;
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
        Ok(SampleResponse {
            request_id: request.request_id,
            series,
        })
    })
    .await?;
    Ok(Json(Envelope::new(response)))
}

pub async fn create_derived(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<DerivedRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = with_state(&ctx, move |data| data.create_derived_signal(request)).await?;
    Ok(Json(Envelope::new(response)))
}

pub async fn create_derived_bundle(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<CreateDerivedBundleRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = with_state(&ctx, move |data| data.create_derived_bundle(request)).await?;
    Ok(Json(Envelope::new(response)))
}

pub async fn remove_derived_bundle(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<RemoveDerivedBundleRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    with_state(&ctx, move |data| data.remove_derived_bundle(&request)).await?;
    Ok(Json(Envelope::new(())))
}

pub async fn remove_signal(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<RemoveSignalRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let path = request.path;
    with_state(&ctx, move |data| data.remove_derived_signal(&path)).await?;
    Ok(Json(Envelope::new(())))
}

pub async fn query_tiles_bin(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<TileRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let state = Arc::clone(&ctx.state);
    let bytes = tokio::task::spawn_blocking(move || {
        let data = state.lock().map_err(|error| error.to_string())?;
        let per_series = request.max_total_bins.map(|budget| {
            budget
                .checked_div(u32::try_from(request.signal_ids.len().max(1)).unwrap_or(u32::MAX))
                .unwrap_or(0)
                .max(64)
        });
        let mut owned = Vec::with_capacity(request.signal_ids.len());
        for raw_id in &request.signal_ids {
            let signal_id = SignalId(*raw_id);
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
            owned.push((
                *raw_id,
                signal.path.clone(),
                signal.unit.clone(),
                query.level,
                query.bins,
            ));
        }
        drop(data);
        let series = owned
            .iter()
            .map(|(id, path, unit, level, bins)| {
                scope_core::tile_wire::binary_series(*id, path, unit.as_deref(), *level, bins)
            })
            .collect::<Vec<_>>();
        Ok::<_, String>(scope_protocol::tile_binary::encode_tile_response(&series))
    })
    .await
    .map_err(|error| err(error.to_string()))?
    .map_err(err)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes))
}

const AUTOSAVE_FILE: &str = "session.autosave.json";

fn session_path(ctx: &AppContext, path: Option<String>) -> PathBuf {
    path.map_or_else(|| ctx.data_dir.join(AUTOSAVE_FILE), PathBuf::from)
}

fn normalized_session_save_path(mut path: PathBuf) -> PathBuf {
    if path.extension().is_none_or(std::ffi::OsStr::is_empty) {
        path.set_extension("signalscope");
    }
    path
}

pub async fn save_session(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<SaveSessionRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    ctx.gate.save_allowed(request.path.is_none()).map_err(err)?;
    let session =
        session::from_json(&request.session_json).map_err(|error| err(error.to_string()))?;
    let path = request.path.map_or_else(
        || session_path(&ctx, None),
        |path| normalized_session_save_path(PathBuf::from(path)),
    );
    session::save_to_path(&session, &path).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(path.display().to_string())))
}

pub async fn load_session(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<LoadSessionRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let explicit = request.path.is_some();
    let path = session_path(&ctx, request.path);
    if !explicit && !path.exists() {
        let session = session::Session::default();
        return Ok(Json(Envelope::new(LoadedSession {
            session_json: serde_json::to_string(&session)
                .map_err(|error| err(error.to_string()))?,
            path: None,
        })));
    }
    let session = session::load_from_path(&path).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(LoadedSession {
        session_json: serde_json::to_string(&session).map_err(|error| err(error.to_string()))?,
        path: explicit.then(|| path.display().to_string()),
    })))
}

pub async fn reset_session(State(ctx): State<AppContext>) -> Result<impl IntoResponse, ApiError> {
    let session = session::Session::default();
    let path = session_path(&ctx, None);
    session::save_to_path(&session, &path).map_err(|error| err(error.to_string()))?;
    ctx.state
        .lock()
        .map_err(|error| err(error.to_string()))?
        .reset();
    Ok(Json(Envelope::new(LoadedSession {
        session_json: serde_json::to_string(&session).map_err(|error| err(error.to_string()))?,
        path: None,
    })))
}

pub async fn export_estimate(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<ExportEstimateRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let session =
        session::from_json(&request.session_json).map_err(|error| err(error.to_string()))?;
    let template_bytes = template_path(&ctx)
        .and_then(|path| std::fs::metadata(path).map_err(|error| error.to_string()))
        .map_err(err)?
        .len();
    let data = ctx.state.lock().map_err(|error| err(error.to_string()))?;
    let response = estimate_for(
        &data,
        &session,
        &request.session_json,
        template_bytes,
        &request.selection,
    )
    .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(response)))
}

fn template_path(ctx: &AppContext) -> Result<PathBuf, String> {
    if let Some(frontend_dir) = &ctx.frontend_dir {
        let path = frontend_dir.join("snapshot-template.html");
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
    data: &host::DataState,
    session: &session::Session,
    session_json: &str,
    template_bytes: u64,
    selection: &scope_protocol::ExportSelection,
) -> Result<ExportEstimate, snapshot::SnapshotError> {
    let base = template_bytes + session_json.len() as u64;
    let mut entries = Vec::with_capacity(8);
    for range in [ExportRange::Visible, ExportRange::All] {
        for fidelity in [
            scope_protocol::ExportFidelity::Preview,
            scope_protocol::ExportFidelity::Standard,
            scope_protocol::ExportFidelity::High,
            scope_protocol::ExportFidelity::Full,
        ] {
            let plan = snapshot::plan_selected(
                session,
                &data.store,
                &data.pyramids,
                selection,
                range,
                fidelity,
            )?;
            entries.push(scope_protocol::ExportEstimateEntry {
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

pub async fn save_export_file_to_directory(
    Json(request): Json<Envelope<SaveExportFileToDirectoryRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let extension = match request.kind {
        ExportFileKind::Png => "png",
        ExportFileKind::Csv => "csv",
    };
    let directory = PathBuf::from(&request.directory);
    if !directory.is_dir() {
        return Err(err("export directory does not exist"));
    }
    let path = export_file_path(&directory, &request.file_name, extension).map_err(err)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data_base64)
        .map_err(|error| err(error.to_string()))?;
    std::fs::write(&path, bytes).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(path.display().to_string())))
}

fn export_file_path(directory: &Path, file_name: &str, extension: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(file_name).components();
    let Some(std::path::Component::Normal(_)) = components.next() else {
        return Err("export file name must be a single path component".to_owned());
    };
    if components.next().is_some() {
        return Err("export file name must be a single path component".to_owned());
    }
    let mut path = directory.join(file_name);
    if path.extension() != Some(std::ffi::OsStr::new(extension)) {
        path.set_extension(extension);
    }
    Ok(path)
}

fn load_preferences_value(ctx: &AppContext) -> Result<preferences::Preferences, String> {
    let path = ctx.data_dir.join("preferences.json");
    if !path.exists() {
        return Ok(preferences::Preferences::default());
    }
    preferences::load_from_path(&path).map_err(|error| error.to_string())
}

fn recipe_directory(ctx: &AppContext, preferences: &preferences::Preferences) -> Option<PathBuf> {
    preferences
        .recipe_directory
        .as_ref()
        .map(PathBuf::from)
        .or_else(|| Some(ctx.data_dir.join("recipes")))
}

pub async fn load_preferences(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let path = ctx.data_dir.join("preferences.json");
    if !path.exists() {
        return Ok(Json(Envelope::new(None::<String>)));
    }
    let mut preferences = load_preferences_value(&ctx).map_err(err)?;
    if preferences.cache_root.is_none() {
        preferences.cache_root = Some(ctx.data_dir.join("cache").display().to_string());
    }
    let json = serde_json::to_string(&preferences).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(Some(json))))
}

pub async fn save_preferences(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<String>>,
) -> Result<impl IntoResponse, ApiError> {
    let json = request.open().map_err(|error| err(error.to_string()))?;
    let mut preferences = preferences::from_json(&json).map_err(|error| err(error.to_string()))?;
    if preferences.cache_root.is_none() {
        preferences.cache_root = Some(ctx.data_dir.join("cache").display().to_string());
    }
    std::fs::create_dir_all(&ctx.data_dir).map_err(|error| err(error.to_string()))?;
    preferences::save_to_path(&preferences, &ctx.data_dir.join("preferences.json"))
        .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(())))
}

pub async fn effective_recipe_directory(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let preferences = load_preferences_value(&ctx).unwrap_or_default();
    let directory = recipe_directory(&ctx, &preferences)
        .ok_or_else(|| err("no recipe directory is available"))?;
    Ok(Json(Envelope::new(directory.display().to_string())))
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use scope_protocol::FormatDescriptor;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn list_formats_round_trips_envelope() {
        let router = crate::build_router(crate::AppContext::for_tests(None));
        let response = router
            .oneshot(
                Request::post("/api/list_formats")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let envelope: Envelope<Vec<FormatDescriptor>> = serde_json::from_slice(&body).unwrap();
        assert_eq!(envelope.protocol_version, scope_protocol::PROTOCOL_VERSION);
        assert!(!envelope.payload.is_empty());
    }

    #[tokio::test]
    async fn unknown_api_path_is_404() {
        let router = crate::build_router(crate::AppContext::for_tests(None));
        let response = router
            .oneshot(
                axum::http::Request::post("/api/no_such_endpoint")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn query_samples_rejects_wrong_protocol_version() {
        let router = crate::build_router(crate::AppContext::for_tests(None));
        let response = router
            .oneshot(
                Request::post("/api/query_samples")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"protocol_version":1,"payload":{"request_id":"r","signal_ids":[],"window":{"t0":0,"t1":1},"max_points":1}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("protocol version"));
    }

    #[tokio::test]
    async fn save_and_load_preferences_round_trip() {
        let dir = std::env::temp_dir().join(format!("scope-preferences-{}", std::process::id()));
        let ctx = crate::AppContext::new(dir.clone(), None, None);
        let save = save_preferences(
            State(ctx.clone()),
            Json(Envelope::new(r#"{"schema_version":4}"#.to_owned())),
        )
        .await
        .unwrap();
        let _ = save.into_response();
        let response = load_preferences(State(ctx.clone()))
            .await
            .unwrap()
            .into_response();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let envelope: Envelope<Option<String>> = serde_json::from_slice(&body).unwrap();
        assert!(envelope.payload.is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn tiles_bin_starts_with_magic() {
        let router = crate::build_router(crate::AppContext::for_tests(None));
        let request = Envelope::new(TileRequest {
            request_id: "empty".into(),
            signal_ids: Vec::new(),
            window: scope_protocol::TimeWindow { t0: 0.0, t1: 1.0 },
            pixel_width: 100,
            max_total_bins: Some(1000),
        });
        let response = router
            .oneshot(
                Request::post("/api/query_tiles_bin")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            &body[..4],
            &scope_protocol::tile_binary::TILE_BINARY_MAGIC.to_le_bytes()
        );
    }

    #[tokio::test]
    async fn pick_sources_uses_scripted_dialog_provider() {
        let mut ctx = crate::AppContext::for_tests(None);
        ctx.dialogs = Arc::new(crate::dialogs::Scripted::with_files(vec![
            PathBuf::from("/tmp/a.csv"),
            PathBuf::from("/tmp/b.mcap"),
        ]));
        let response = pick_sources(State(ctx)).await.unwrap().into_response();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let envelope: Envelope<Vec<String>> = serde_json::from_slice(&body).unwrap();
        assert_eq!(envelope.payload, vec!["/tmp/a.csv", "/tmp/b.mcap"]);
    }
}

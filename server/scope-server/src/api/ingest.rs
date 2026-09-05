use super::preferences_api::{load_preferences_value, recipe_directory};
use super::{ApiError, err};
use crate::{AppContext, host};
use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;
use scope_core::ingest::batch::JobId;
use scope_core::session;
use scope_protocol::{
    BatchDetail, BatchDetailRequest, BatchJob, Envelope, IngestBatchRequest, IntrospectRequest,
    RecipeDestination, RestoreFinalizeRequest, RestoreFinalizeResponse, RestoreSourcesRequest,
    SaveRecipeRequest, SaveRecipeResponse, ScanSourcesRequest,
};
use std::path::Path;
use std::sync::Arc;

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
    ctx.gate.clear();
    ctx.gate.begin();
    let job = ctx.jobs.submit(
        records.iter().map(|record| record.path.clone()).collect(),
        Arc::new(host::ServerCommitSink {
            state: Arc::clone(&ctx.state),
        }),
    );
    Ok(Json(Envelope::new(BatchJob { job_id: job.0 })))
}

pub async fn restore_finalize(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<RestoreFinalizeRequest>>,
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
        {
            let data = state.lock().map_err(|error| error.to_string())?;
            for record in &mut restored.sources {
                let Ok(uuid) = uuid::Uuid::parse_str(&record.key) else {
                    continue;
                };
                let key = scope_core::store::SourceKey(uuid);
                let Some(current) = data.registry.record(key) else {
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
            }
        }
        Ok::<_, String>(Envelope::new(RestoreFinalizeResponse {
            session_json: serde_json::to_string(&restored).map_err(|error| error.to_string())?,
        }))
    })
    .await
    .map_err(|error| err(error.to_string()))?
    .map_err(err)?;
    Ok(Json(response))
}

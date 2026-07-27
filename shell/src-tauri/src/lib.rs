use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
};

use scope_core::{
    cache, compute, expr,
    ingest::SUPPORTED_FORMATS,
    pyramid::Pyramid,
    store::{Signal, SignalId, SignalStore, Source, SourceId},
};
use scope_protocol::{
    DerivedRequest, Envelope, IngestJob, IngestRequest, IngestResponse, IngestStage, IngestState,
    IngestStatus, RemoveSignalRequest, SampleRequest, SampleResponse, SampleSeries, SignalSummary,
    SignalTile, SourceSummary, TileRequest, TileResponse,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct DataState {
    store: SignalStore,
    pyramids: BTreeMap<SignalId, Pyramid>,
    derived_source: Option<SourceId>,
}

#[derive(Default)]
struct IngestJobs {
    next_job_id: u64,
    jobs: BTreeMap<u64, IngestStatus>,
}

fn running(stage: IngestStage, fraction: f64) -> IngestStatus {
    IngestStatus {
        state: IngestState::Running,
        stage,
        fraction,
        response: None,
        error: None,
    }
}

fn signal_summary(signal: &Signal) -> SignalSummary {
    let (t_min, t_max) = signal.time_bounds();
    SignalSummary {
        signal_id: signal.id.0,
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
        path: source.path.display().to_string(),
        point_count: source.point_count as u64,
    }
}

fn set_job(app: &AppHandle, job_id: u64, status: IngestStatus) {
    if let Ok(mut jobs) = app.state::<Mutex<IngestJobs>>().inner().lock() {
        jobs.jobs.insert(job_id, status);
    }
}

fn run_ingest_job(app: &AppHandle, job_id: u64, path: &Path) {
    let status = match ingest_with_cache(app, job_id, path) {
        Ok(response) => IngestStatus {
            state: IngestState::Done,
            stage: IngestStage::Cache,
            fraction: 1.0,
            response: Some(response),
            error: None,
        },
        Err(error) => {
            let (stage, fraction) = last_progress(app, job_id);
            IngestStatus {
                state: IngestState::Failed,
                stage,
                fraction,
                response: None,
                error: Some(error),
            }
        }
    };
    set_job(app, job_id, status);
}

fn last_progress(app: &AppHandle, job_id: u64) -> (IngestStage, f64) {
    app.state::<Mutex<IngestJobs>>()
        .inner()
        .lock()
        .ok()
        .and_then(|jobs| {
            jobs.jobs
                .get(&job_id)
                .map(|status| (status.stage, status.fraction))
        })
        .unwrap_or((IngestStage::Decode, 0.0))
}

fn ingest_with_cache(app: &AppHandle, job_id: u64, path: &Path) -> Result<IngestResponse, String> {
    let state = app.state::<Mutex<DataState>>();
    let mut data = state.lock().map_err(|error| error.to_string())?;
    let DataState {
        store, pyramids, ..
    } = &mut *data;

    let mut on_progress = |stage, fraction| set_job(app, job_id, running(stage, fraction));
    let outcome =
        cache::ingest_or_load(path, store, &mut on_progress).map_err(|error| error.to_string())?;
    if let Some(error) = outcome.sidecar_error {
        eprintln!(
            "pyramid sidecar not written for {}: {error}",
            path.display()
        );
    }
    let summary = outcome.loaded.summary;
    for (id, pyramid) in outcome.loaded.pyramids {
        pyramids.insert(id, pyramid);
    }

    let source = store
        .sources()
        .find(|source| source.id == summary.source_id)
        .ok_or_else(|| "ingested source is missing".to_owned())?;
    let signals = summary
        .signals
        .iter()
        .filter_map(|id| store.signal(*id))
        .map(signal_summary)
        .collect();
    Ok(IngestResponse {
        source: source_summary(source),
        signals,
    })
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
fn ingest_source(
    request: Envelope<IngestRequest>,
    app: AppHandle,
    jobs: State<'_, Mutex<IngestJobs>>,
) -> Result<Envelope<IngestJob>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let job_id = {
        let mut jobs = jobs.lock().map_err(|error| error.to_string())?;
        jobs.next_job_id += 1;
        let id = jobs.next_job_id;
        jobs.jobs.insert(id, running(IngestStage::Decode, 0.0));
        id
    };
    let path = PathBuf::from(request.path);
    thread::spawn(move || run_ingest_job(&app, job_id, &path));
    Ok(Envelope::new(IngestJob { job_id }))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn ingest_status(
    request: Envelope<IngestJob>,
    jobs: State<'_, Mutex<IngestJobs>>,
) -> Result<Envelope<IngestStatus>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let jobs = jobs.lock().map_err(|error| error.to_string())?;
    let status = jobs
        .jobs
        .get(&request.job_id)
        .ok_or_else(|| format!("unknown ingest job: {}", request.job_id))?;
    Ok(Envelope::new(status.clone()))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_sources(
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<Vec<SourceSummary>>, String> {
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        data.store.sources().map(source_summary).collect(),
    ))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_signals(
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<Vec<SignalSummary>>, String> {
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        data.store.signals().map(signal_summary).collect(),
    ))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn query_tiles(
    request: Envelope<TileRequest>,
    state: State<'_, Mutex<DataState>>,
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
    state: State<'_, Mutex<DataState>>,
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

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn create_derived(
    request: Envelope<DerivedRequest>,
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<SignalSummary>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let path = if request.path.starts_with(DERIVED_PREFIX) {
        request.path
    } else {
        format!("{DERIVED_PREFIX}{}", request.path)
    };
    let mut data = state.lock().map_err(|error| error.to_string())?;

    let parsed = expr::parse(&request.expr).map_err(|error| error.to_string())?;
    let evaluated = expr::evaluate(&parsed, &data.store).map_err(|error| error.to_string())?;

    let source_id = if let Some(id) = data.derived_source {
        id
    } else {
        let id = data.store.register_source(DERIVED_PREFIX);
        data.derived_source = Some(id);
        id
    };
    if let Some(previous) = data.store.remove_signal(&path) {
        data.pyramids.remove(&previous);
    }
    let signal_id = data
        .store
        .insert_signal(source_id, path, None, evaluated.time, evaluated.values)
        .map_err(|error| error.to_string())?;
    let signal = data
        .store
        .signal(signal_id)
        .ok_or_else(|| "derived signal vanished after insertion".to_owned())?;
    let pyramid = Pyramid::from_signal(signal);
    let summary = signal_summary(signal);
    data.pyramids.insert(signal_id, pyramid);
    Ok(Envelope::new(summary))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn remove_signal(
    request: Envelope<RemoveSignalRequest>,
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<()>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    if !request.path.starts_with(DERIVED_PREFIX) {
        return Err(format!(
            "only derived signals can be removed individually: {}",
            request.path
        ));
    }
    let mut data = state.lock().map_err(|error| error.to_string())?;
    if let Some(id) = data.store.remove_signal(&request.path) {
        data.pyramids.remove(&id);
    }
    Ok(Envelope::new(()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the native `SignalScope` application.
///
/// # Panics
///
/// Panics when Tauri cannot initialize or run the application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(DataState::default()))
        .manage(Mutex::new(IngestJobs::default()))
        .invoke_handler(tauri::generate_handler![
            pick_sources,
            ingest_source,
            ingest_status,
            list_sources,
            list_signals,
            query_tiles,
            query_samples,
            create_derived,
            remove_signal
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SignalScope");
}

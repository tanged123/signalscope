use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
};

use scope_core::{
    cache,
    ingest::ingest_path,
    pyramid::Pyramid,
    store::{Signal, SignalId, SignalStore, Source},
};
use scope_protocol::{
    Envelope, IngestJob, IngestRequest, IngestResponse, IngestStage, IngestState, IngestStatus,
    SignalSummary, SignalTile, SourceSummary, TileRequest, TileResponse,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct DataState {
    store: SignalStore,
    pyramids: BTreeMap<SignalId, Pyramid>,
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
    let time = signal.time();
    let (t_min, t_max) = finite_time_bounds(time);
    SignalSummary {
        signal_id: signal.id.0,
        path: signal.path.clone(),
        unit: signal.unit.clone(),
        point_count: signal.len() as u64,
        t_min,
        t_max,
    }
}

fn finite_time_bounds(time: &[f64]) -> (f64, f64) {
    let mut finite = time.iter().copied().filter(|value| value.is_finite());
    let Some(first) = finite.next() else {
        return (0.0, 1.0);
    };
    finite.fold((first, first), |(min, max), value| {
        (min.min(value), max.max(value))
    })
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
        Err(error) => IngestStatus {
            state: IngestState::Failed,
            stage: IngestStage::Decode,
            fraction: 0.0,
            response: None,
            error: Some(error),
        },
    };
    set_job(app, job_id, status);
}

#[allow(clippy::cast_precision_loss)] // progress fractions tolerate rounding
fn ingest_with_cache(app: &AppHandle, job_id: u64, path: &Path) -> Result<IngestResponse, String> {
    let state = app.state::<Mutex<DataState>>();
    let mut data = state.lock().map_err(|error| error.to_string())?;
    let DataState { store, pyramids } = &mut *data;

    let mut on_cache = |fraction| set_job(app, job_id, running(IngestStage::Cache, fraction));
    let summary = if let Some(loaded) =
        cache::try_load(path, store, &mut on_cache).map_err(|error| error.to_string())?
    {
        for (id, pyramid) in loaded.pyramids {
            pyramids.insert(id, pyramid);
        }
        loaded.summary
    } else {
        let mut on_decode = |fraction| set_job(app, job_id, running(IngestStage::Decode, fraction));
        let summary =
            ingest_path(path, store, &mut on_decode).map_err(|error| error.to_string())?;
        let total = summary.signals.len().max(1);
        for (index, id) in summary.signals.iter().enumerate() {
            let signal = store
                .signal(*id)
                .ok_or_else(|| format!("ingested signal {id:?} is missing"))?;
            pyramids.insert(*id, Pyramid::from_signal(signal));
            set_job(
                app,
                job_id,
                running(IngestStage::Pyramid, (index + 1) as f64 / total as f64),
            );
        }
        let entries: Vec<(&Signal, &Pyramid)> = summary
            .signals
            .iter()
            .filter_map(|id| Some((store.signal(*id)?, pyramids.get(id)?)))
            .collect();
        let mut on_write = |fraction| set_job(app, job_id, running(IngestStage::Cache, fraction));
        if let Err(error) = cache::write(path, summary.row_count as u64, &entries, &mut on_write) {
            eprintln!(
                "pyramid sidecar not written for {}: {error}",
                path.display()
            );
        }
        summary
    };

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
        app.dialog()
            .file()
            .add_filter(
                "Supported telemetry (CSV, TSV, TXT, DAT, MCAP)",
                &["csv", "tsv", "txt", "dat", "mcap"],
            )
            .add_filter(
                "Delimited text (CSV, TSV, TXT, DAT)",
                &["csv", "tsv", "txt", "dat"],
            )
            .add_filter("MCAP recordings (MCAP)", &["mcap"])
            .blocking_pick_files()
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
            query_tiles
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SignalScope");
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use scope_core::store::SourceId;

    use super::*;

    #[test]
    #[allow(clippy::float_cmp)]
    fn signal_summary_uses_finite_time_extrema_and_safe_fallbacks() {
        let signal = Signal::new(
            SignalId(1),
            SourceId(1),
            "source/value",
            None,
            Arc::from(vec![f64::NAN, 5.0, -2.0, f64::INFINITY]),
            Arc::from(vec![0.0; 4]),
        )
        .unwrap();

        let summary = signal_summary(&signal);
        assert_eq!((summary.t_min, summary.t_max), (-2.0, 5.0));
        assert_eq!(finite_time_bounds(&[]), (0.0, 1.0));
        assert_eq!(
            finite_time_bounds(&[f64::NAN, f64::NEG_INFINITY]),
            (0.0, 1.0)
        );
    }
}

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
    session,
    store::{Signal, SignalId, SignalStore, Source, SourceId},
};
use scope_protocol::{
    DerivedRequest, Envelope, IngestJob, IngestRequest, IngestResponse, IngestStage, IngestState,
    IngestStatus, LoadSessionRequest, LoadedSession, PickSessionRequest, RemoveSignalRequest,
    SampleRequest, SampleResponse, SampleSeries, SaveSessionRequest, SessionDialogMode,
    SignalSummary, SignalTile, SourceSummary, TileRequest, TileResponse,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct DataState {
    store: SignalStore,
    pyramids: BTreeMap<SignalId, Pyramid>,
    derived_source: Option<SourceId>,
    derived_references: BTreeMap<String, Vec<String>>,
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
            let id = self.store.register_source(DERIVED_PREFIX);
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
                path.clone(),
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
        let summary = signal_summary(signal);
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
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<SignalSummary>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let mut data = state.lock().map_err(|error| error.to_string())?;
    data.create_derived_signal(request).map(Envelope::new)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn remove_signal(
    request: Envelope<RemoveSignalRequest>,
    state: State<'_, Mutex<DataState>>,
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
) -> Result<Envelope<String>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
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
    state: State<'_, Mutex<DataState>>,
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
            remove_signal,
            save_session,
            load_session,
            reset_session,
            pick_session_path
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SignalScope");
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn data_with_signal(path: &str) -> (DataState, SourceId) {
        let mut data = DataState::default();
        let source = data.store.register_source("input.csv");
        data.store
            .insert_signal(
                source,
                path,
                None,
                Arc::from(vec![0.0, 1.0]),
                vec![1.0, 2.0],
            )
            .expect("insert source signal");
        (data, source)
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

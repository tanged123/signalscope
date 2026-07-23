use std::{collections::BTreeMap, sync::Mutex};

use scope_ingest::ingest_csv_path;
use scope_protocol::{
    EnvelopeBin, IngestResponse, SignalSummary, SignalTile, SourceSummary, TileRequest,
    TileResponse, PROTOCOL_VERSION,
};
use scope_pyramid::Pyramid;
use scope_store::{SignalId, SignalStore};
use tauri::State;

#[derive(Default)]
struct DataState {
    store: SignalStore,
    pyramids: BTreeMap<SignalId, Pyramid>,
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn ingest_csv(path: String, state: State<'_, Mutex<DataState>>) -> Result<IngestResponse, String> {
    let mut data = state.lock().map_err(|error| error.to_string())?;
    let summary = {
        let DataState { store, .. } = &mut *data;
        ingest_csv_path(&path, store).map_err(|error| error.to_string())?
    };

    for id in &summary.signals {
        let pyramid = Pyramid::from_signal(
            data.store
                .signal(*id)
                .ok_or_else(|| format!("ingested signal {id:?} is missing"))?,
        );
        data.pyramids.insert(*id, pyramid);
    }

    let source = data
        .store
        .sources()
        .find(|source| source.id == summary.source_id)
        .ok_or_else(|| "ingested source is missing".to_owned())?;
    let signals = summary
        .signals
        .iter()
        .filter_map(|id| data.store.signal(*id))
        .map(|signal| SignalSummary {
            signal_id: signal.id.0,
            path: signal.path.clone(),
            unit: signal.unit.clone(),
            point_count: signal.len() as u64,
        })
        .collect();

    Ok(IngestResponse {
        protocol_version: PROTOCOL_VERSION,
        source: SourceSummary {
            source_id: source.id.0,
            path: source.path.display().to_string(),
            point_count: source.point_count as u64,
        },
        signals,
    })
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_signals(state: State<'_, Mutex<DataState>>) -> Result<Vec<SignalSummary>, String> {
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(data
        .store
        .signals()
        .map(|signal| SignalSummary {
            signal_id: signal.id.0,
            path: signal.path.clone(),
            unit: signal.unit.clone(),
            point_count: signal.len() as u64,
        })
        .collect())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn query_tiles(
    request: TileRequest,
    state: State<'_, Mutex<DataState>>,
) -> Result<TileResponse, String> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "protocol version {} is unsupported; expected {PROTOCOL_VERSION}",
            request.protocol_version
        ));
    }

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
            bins: query
                .bins
                .iter()
                .map(|bin| EnvelopeBin {
                    t0: bin.t0,
                    t1: bin.t1,
                    first: bin.first,
                    last: bin.last,
                    min: bin.min,
                    max: bin.max,
                    sample_count: bin.sample_count,
                    has_gap: bin.has_gap,
                })
                .collect(),
        });
    }

    Ok(TileResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id,
        series,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the native `SignalScope` application.
///
/// # Panics
///
/// Panics when Tauri cannot initialize or run the application.
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(DataState {
            store: SignalStore::new(),
            ..DataState::default()
        }))
        .invoke_handler(tauri::generate_handler![
            ingest_csv,
            list_signals,
            query_tiles
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SignalScope");
}

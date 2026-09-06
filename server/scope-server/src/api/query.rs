//! Data query handlers; new plot families add their typed endpoint here.

use super::{ApiError, err, with_state};
use crate::{AppContext, host};
use axum::Json;
use axum::extract::State;
use axum::http::header;
use axum::response::IntoResponse;
use scope_core::compute;
use scope_core::store::SignalId;
use scope_protocol::{
    Envelope, Line2DRequest, SampleRequest, SampleResponse, SampleSeries, TileRequest,
};
use std::collections::BTreeSet;
use std::sync::Arc;

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
        data.derived().reexpand_derived_bundles();
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
    let state = Arc::clone(&ctx.state);
    let response = tokio::task::spawn_blocking(move || {
        let signals = {
            let data = state.lock().map_err(|error| error.to_string())?;
            request
                .signal_ids
                .iter()
                .map(|raw_id| {
                    data.store
                        .signal(SignalId(*raw_id))
                        .cloned()
                        .ok_or_else(|| format!("unknown signal id: {raw_id}"))
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut series = Vec::new();
        for signal in signals {
            let (time, values) =
                host::windowed_slice(&signal, request.window.t0, request.window.t1)?;
            let slice = if request.max_points == 0 {
                compute::sample_window_full(&time, &values, request.window.t0, request.window.t1)
            } else {
                compute::sample_window(
                    &time,
                    &values,
                    request.window.t0,
                    request.window.t1,
                    request.max_points,
                )
            };
            series.push(SampleSeries {
                signal_id: signal.id.0,
                signal_path: signal.path.clone(),
                unit: signal.unit.clone(),
                time: slice.time,
                values: slice.values,
                stride: slice.stride,
            });
        }
        Ok::<_, String>(SampleResponse {
            request_id: request.request_id,
            series,
        })
    })
    .await
    .map_err(|error| err(error.to_string()))?
    .map_err(err)?;
    Ok(Json(Envelope::new(response)))
}

pub async fn query_tiles_bin(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<TileRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let state = Arc::clone(&ctx.state);
    let bytes = tokio::task::spawn_blocking(move || {
        let inputs = {
            let data = state.lock().map_err(|error| error.to_string())?;
            capture_tiles(&data, &request.signal_ids)?
        };
        let owned = inputs
            .iter()
            .map(|(signal, pyramid)| {
                let query =
                    pyramid.query(request.window.t0, request.window.t1, request.pixel_width);
                (
                    signal.id.0,
                    signal.path.clone(),
                    signal.unit.clone(),
                    query.level,
                    query.bins,
                )
            })
            .collect::<Vec<_>>();
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

pub async fn query_line2d_bin(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<Line2DRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    if request.y_signal_ids.is_empty() {
        return Err(err("line plot requires at least one y signal"));
    }
    if request.y_signal_ids.iter().collect::<BTreeSet<_>>().len() != request.y_signal_ids.len() {
        return Err(err("Line2D Y signals must be unique"));
    }
    if !request.window.t0.is_finite()
        || !request.window.t1.is_finite()
        || request.window.t1 <= request.window.t0
    {
        return Err(err("Line2D window must be finite and increasing"));
    }
    if request.pixel_width == 0 {
        return Err(err("Line2D pixel width must be positive"));
    }
    let state = Arc::clone(&ctx.state);
    let bytes = tokio::task::spawn_blocking(move || {
        let (x_signal, y_signals) = {
            let data = state.lock().map_err(|error| error.to_string())?;
            let x_signal = data
                .store
                .signal(SignalId(request.x_signal_id))
                .cloned()
                .ok_or_else(|| format!("unknown x signal id: {}", request.x_signal_id))?;
            let y_signals = request
                .y_signal_ids
                .iter()
                .map(|raw_id| {
                    data.store
                        .signal(SignalId(*raw_id))
                        .cloned()
                        .ok_or_else(|| format!("unknown y signal id: {raw_id}"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            (x_signal, y_signals)
        };
        let y_refs = y_signals.iter().collect::<Vec<_>>();
        let pyramid = scope_core::line2d::LinePyramid::from_signals_window(
            &x_signal,
            &y_refs,
            request.window.t0,
            request.window.t1,
        )
        .map_err(|error| error.to_string())?;
        let query = pyramid.query(request.window.t0, request.window.t1, request.pixel_width);
        let mut anchor = Vec::with_capacity(query.points.len());
        let mut x_values = Vec::with_capacity(query.points.len());
        let mut y_values = (0..y_signals.len())
            .map(|_| Vec::with_capacity(query.points.len()))
            .collect::<Vec<_>>();
        for point in query.points {
            anchor.push(point.anchor);
            x_values.push(point.x);
            for (values, value) in y_values.iter_mut().zip(point.ys) {
                values.push(value);
            }
        }
        let x = scope_protocol::BinaryLineColumn {
            signal_id: x_signal.id.0,
            signal_path: &x_signal.path,
            unit: x_signal.unit.as_deref(),
            values: &x_values,
        };
        let ys = y_signals
            .iter()
            .zip(&y_values)
            .map(|(signal, values)| scope_protocol::BinaryLineColumn {
                signal_id: signal.id.0,
                signal_path: &signal.path,
                unit: signal.unit.as_deref(),
                values,
            })
            .collect::<Vec<_>>();
        let response = scope_protocol::BinaryLineResponse {
            level: query.level,
            anchor: &anchor,
            x,
            ys: &ys,
        };
        scope_protocol::encode_line_response(&response).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| err(error.to_string()))?
    .map_err(err)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes))
}

fn capture_tiles(
    data: &host::DataState,
    ids: &[u64],
) -> Result<Vec<(scope_core::store::Signal, scope_core::pyramid::Pyramid)>, String> {
    ids.iter()
        .map(|raw_id| {
            let id = SignalId(*raw_id);
            let signal = data
                .store
                .signal(id)
                .cloned()
                .ok_or_else(|| format!("unknown signal id: {raw_id}"))?;
            let pyramid = data
                .pyramids
                .get(&id)
                .cloned()
                .ok_or_else(|| format!("pyramid is unavailable for signal id: {raw_id}"))?;
            Ok((signal, pyramid))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::capture_tiles;
    use scope_core::{
        cache::{CacheRoot, spill_columns},
        columns::{Column, TimebaseId},
        pyramid::Pyramid,
        store::SourceKey,
    };

    #[test]
    fn captured_queries_survive_reset_and_release_spills_after_the_last_reader() {
        let dir = std::env::temp_dir().join(format!("scope-query-{}", uuid::Uuid::new_v4()));
        let mut data = crate::host::DataState::default();
        let source = data
            .store
            .register_source("run.csv", SourceKey(uuid::Uuid::new_v4()), "run")
            .unwrap();
        let time = (0..64).map(f64::from).collect::<Vec<_>>();
        let handle =
            spill_columns(&CacheRoot::app_owned(&dir), TimebaseId(1), &time, &time).unwrap();
        let path = handle.path().to_owned();
        let id = data
            .store
            .insert_signal(source, "value", None, time, Column::paged(handle))
            .unwrap();
        data.pyramids
            .insert(id, Pyramid::from_signal(data.store.signal(id).unwrap()));
        let inputs = capture_tiles(&data, &[id.0]).unwrap();
        data.reset();
        assert!(data.store.signal(id).is_none());
        assert!(path.exists());
        let (signal, pyramid) = &inputs[0];
        let (_, values) = crate::host::windowed_slice(signal, 20.0, 24.0).unwrap();
        assert_eq!(&*values, &[19.0, 20.0, 21.0, 22.0, 23.0, 24.0, 25.0]);
        assert!(!pyramid.query(20.0, 24.0, 100).bins.is_empty());
        drop(inputs);
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

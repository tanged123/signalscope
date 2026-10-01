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
    Envelope, HistogramRequest, HistogramResponse, HistogramSeries, Line2DRequest, SampleRequest,
    SampleResponse, SampleSeries, TileRequest,
};
use std::collections::BTreeSet;
use std::mem::size_of;
use std::sync::Arc;

const MAX_HISTOGRAM_RESULT_BYTES: u64 = 64 * 1024 * 1024;

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

/// Computes an exact histogram from source values in an inclusive time window.
///
/// Signal handles are cloned while the state mutex is held; the reduction and
/// page reads happen after releasing it. The semaphore bounds concurrent scans
/// because a request may touch a large paged source window.
pub async fn query_histogram(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<HistogramRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    if request.signal_ids.iter().collect::<BTreeSet<_>>().len() != request.signal_ids.len() {
        return Err(err("histogram signals must be unique"));
    }
    if !request.window.t0.is_finite()
        || !request.window.t1.is_finite()
        || request.window.t0 > request.window.t1
    {
        return Err(err("histogram window must be finite and ordered"));
    }
    if !(1..=scope_core::compute::histogram::MAX_BIN_COUNT).contains(&request.bin_count) {
        return Err(err(format!(
            "histogram bin count must be between 1 and {}",
            scope_core::compute::histogram::MAX_BIN_COUNT
        )));
    }
    let matrix_bytes = u64::from(request.bin_count)
        .checked_mul(u64::try_from(request.signal_ids.len()).unwrap_or(u64::MAX))
        .and_then(|count| count.checked_mul(u64::try_from(size_of::<u64>()).unwrap_or(u64::MAX)))
        .ok_or_else(|| err("histogram result is too large"))?;
    if matrix_bytes > MAX_HISTOGRAM_RESULT_BYTES {
        return Err(err(format!(
            "histogram result exceeds the {} MiB output limit",
            MAX_HISTOGRAM_RESULT_BYTES / (1024 * 1024)
        )));
    }

    // An empty visible set is a valid panel state. Keep the result typed so
    // the presentation plane can settle on an empty plot without attempting
    // a native reduction with no signal handles.
    if request.signal_ids.is_empty() {
        let edges = Vec::new();
        return Ok(Json(Envelope::new(HistogramResponse {
            request_id: request.request_id,
            window: request.window,
            edges,
            series: Vec::new(),
        })));
    }

    let permit = ctx
        .histogram_scans
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| err(format!("histogram scan limiter unavailable: {error}")))?;
    let state = Arc::clone(&ctx.state);
    let response = tokio::task::spawn_blocking(move || {
        let _permit = permit;
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
        let references = signals.iter().collect::<Vec<_>>();
        let result = scope_core::compute::histogram::histogram(
            &references,
            request.window.clone(),
            request.bin_count,
        )
        .map_err(|error| error.to_string())?;
        let series = result
            .series
            .into_iter()
            .map(|series| HistogramSeries {
                signal_id: series.signal_id.0,
                signal_path: series.path,
                unit: series.unit,
                counts: series.counts,
                finite_count: series.finite_count,
                excluded_count: series.excluded_count,
            })
            .collect();
        Ok::<_, String>(HistogramResponse {
            request_id: request.request_id,
            window: request.window,
            edges: result.edges,
            series,
        })
    })
    .await
    .map_err(|error| err(error.to_string()))?
    .map_err(err)?;
    Ok(Json(Envelope::new(response)))
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
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use scope_core::{
        cache::{CacheRoot, spill_columns},
        columns::{Column, TimebaseId},
        pyramid::Pyramid,
        store::SourceKey,
    };
    use scope_protocol::{Envelope, HistogramRequest, HistogramResponse, TimeWindow};
    use tower::ServiceExt;

    fn histogram_context() -> (crate::AppContext, Vec<u64>) {
        let context = crate::AppContext::for_tests(None);
        let mut data = context.state.lock().unwrap();
        let source = data
            .store
            .register_source(
                "histogram.csv",
                SourceKey(uuid::Uuid::new_v4()),
                "histogram",
            )
            .unwrap();
        let first = data
            .store
            .insert_signal(
                source,
                "first",
                Some("V".into()),
                vec![0.0, 1.0, 2.0, 3.0],
                vec![-1.0, 0.0, 1.0, f64::NAN],
            )
            .unwrap();
        let second = data
            .store
            .insert_signal(
                source,
                "second",
                Some("V".into()),
                vec![0.0, 1.0, 2.0, 3.0],
                vec![-2.0, 0.0, 2.0, 3.0],
            )
            .unwrap();
        drop(data);
        (context, vec![first.0, second.0])
    }

    #[tokio::test]
    async fn histogram_endpoint_returns_exact_shared_edges_and_totals() {
        let (context, ids) = histogram_context();
        let router = crate::build_router(context);
        let request = Envelope::new(HistogramRequest {
            request_id: "hist-1".into(),
            signal_ids: ids,
            window: TimeWindow { t0: 0.0, t1: 3.0 },
            bin_count: 2,
        });
        let response = router
            .oneshot(
                Request::post("/api/query_histogram")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let response: Envelope<HistogramResponse> = serde_json::from_slice(&body).unwrap();
        assert_eq!(response.payload.request_id, "hist-1");
        assert_eq!(response.payload.edges[0].to_bits(), (-2.0_f64).to_bits());
        assert!((response.payload.edges[1] - 0.5).abs() < 1e-12);
        assert_eq!(response.payload.edges[2].to_bits(), 3.0_f64.to_bits());
        assert_eq!(response.payload.series[0].counts, vec![2, 1]);
        assert_eq!(response.payload.series[0].finite_count, 3);
        assert_eq!(response.payload.series[0].excluded_count, 1);
        assert_eq!(response.payload.series[1].counts, vec![2, 2]);
        assert_eq!(response.payload.series[1].finite_count, 4);
    }

    #[tokio::test]
    async fn histogram_endpoint_accepts_empty_visible_sets() {
        let router = crate::build_router(crate::AppContext::for_tests(None));
        let request = Envelope::new(HistogramRequest {
            request_id: "empty".into(),
            signal_ids: Vec::new(),
            window: TimeWindow { t0: 4.0, t1: 4.0 },
            bin_count: 3,
        });
        let response = router
            .oneshot(
                Request::post("/api/query_histogram")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let response: Envelope<HistogramResponse> = serde_json::from_slice(&body).unwrap();
        assert!(response.payload.edges.is_empty());
        assert!(response.payload.series.is_empty());
    }

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

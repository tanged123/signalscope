//! Data query handlers; new plot families add their typed endpoint here.

use super::{
    ApiError, AppContext, Arc, BTreeSet, Envelope, IntoResponse, Json, Line2DRequest,
    SampleRequest, SampleResponse, SampleSeries, SignalId, State, TileRequest, compute, err,
    header, host, with_state,
};

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

pub async fn query_tiles_bin(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<TileRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let state = Arc::clone(&ctx.state);
    let bytes = tokio::task::spawn_blocking(move || {
        let data = state.lock().map_err(|error| error.to_string())?;
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
            let query = pyramid.query(request.window.t0, request.window.t1, request.pixel_width);
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

pub async fn query_line2d_bin(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<Line2DRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    if request.y_signal_ids.is_empty() {
        return Err(err("line plot requires at least one y signal"));
    }
    if request.y_signal_ids.contains(&request.x_signal_id) {
        return Err(err("Line2D X signal cannot also be a Y signal"));
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

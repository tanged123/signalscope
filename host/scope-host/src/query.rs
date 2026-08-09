use std::sync::Arc;

use scope_core::{
    compute,
    store::{Signal, SignalId},
};
use scope_protocol::{SampleRequest, SampleResponse, SampleSeries, TileRequest};

use crate::{HostError, ScopeHost};

fn invalid(message: impl Into<String>) -> HostError {
    HostError::Invalid {
        code: "invalid_request",
        message: message.into(),
    }
}

impl ScopeHost {
    pub async fn query_tiles(&self, request: TileRequest) -> Result<Vec<u8>, HostError> {
        let state = Arc::clone(&self.inner().state);
        tokio::task::spawn_blocking(move || {
            let data = state.lock().map_err(|error| invalid(error.to_string()))?;
            let mut owned: Vec<(
                u64,
                String,
                Option<String>,
                scope_core::pyramid::PyramidQuery,
            )> = Vec::with_capacity(request.signal_ids.len());
            for raw_id in &request.signal_ids {
                let signal_id = SignalId(*raw_id);
                let signal = data
                    .store
                    .signal(signal_id)
                    .ok_or_else(|| invalid(format!("unknown signal id: {raw_id}")))?;
                let pyramid = data.pyramids.get(&signal_id).ok_or_else(|| {
                    invalid(format!("pyramid is unavailable for signal id: {raw_id}"))
                })?;
                let query = pyramid.query_with_target(
                    request.window.t0,
                    request.window.t1,
                    request.pixel_width.max(1),
                    None,
                );
                owned.push((*raw_id, signal.path.clone(), signal.unit.clone(), query));
            }
            drop(data);
            let series = owned
                .iter()
                .map(|(id, path, unit, query)| {
                    scope_core::tile_wire::binary_series(*id, path, unit.as_deref(), query)
                })
                .collect::<Vec<_>>();
            scope_protocol::tile_binary::encode_tile_response(&series)
                .map_err(|error| invalid(error.to_string()))
        })
        .await
        .map_err(|error| invalid(error.to_string()))?
    }

    pub fn query_samples(&self, request: SampleRequest) -> Result<SampleResponse, HostError> {
        let data = self
            .inner()
            .state
            .lock()
            .map_err(|error| invalid(error.to_string()))?;
        let mut series = Vec::new();
        for raw_id in request.signal_ids {
            let signal = data
                .store
                .signal(SignalId(raw_id))
                .ok_or_else(|| invalid(format!("unknown signal id: {raw_id}")))?;
            let (time, values) = windowed_slice(signal, request.window.t0, request.window.t1)?;
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
    }
}

fn windowed_slice(
    signal: &Signal,
    t0: f64,
    t1: f64,
) -> Result<
    (
        scope_core::columns::ColumnGuard,
        scope_core::columns::ColumnGuard,
    ),
    HostError,
> {
    let time_column = signal.time_column();
    let start = time_column
        .partition_point(|time| time < t0)
        .map_err(|error| invalid(error.to_string()))?
        .saturating_sub(1);
    let end = time_column
        .partition_point(|time| time <= t1)
        .map_err(|error| invalid(error.to_string()))?
        .saturating_add(1)
        .min(time_column.len());
    let time = time_column
        .range(start..end)
        .map_err(|error| invalid(error.to_string()))?;
    let values = signal
        .values_column()
        .range(start..end)
        .map_err(|error| invalid(error.to_string()))?;
    Ok((time, values))
}

#[cfg(test)]
mod tests {
    use crate::{HostConfig, HostPaths, ScopeHost};
    use scope_protocol::{SampleRequest, TileRequest, TimeWindow};

    fn host(root: &std::path::Path) -> ScopeHost {
        ScopeHost::open(HostConfig {
            paths: HostPaths {
                config_dir: root.join("config"),
                cache_dir: root.join("cache"),
                resource_dir: root.join("resources"),
            },
            available_memory_bytes: 8 * 1024 * 1024 * 1024,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn unknown_tile_ids_return_a_typed_host_error() {
        let root = tempfile::tempdir().unwrap();
        let error = host(root.path())
            .query_tiles(TileRequest {
                request_id: "request".into(),
                signal_ids: vec![42],
                window: TimeWindow { t0: 0.0, t1: 1.0 },
                pixel_width: 100,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), "invalid_request");
    }

    #[test]
    fn unknown_sample_ids_are_rejected_without_partial_response() {
        let root = tempfile::tempdir().unwrap();
        let error = host(root.path())
            .query_samples(SampleRequest {
                request_id: "request".into(),
                signal_ids: vec![42],
                window: TimeWindow { t0: 0.0, t1: 1.0 },
                max_points: 10,
            })
            .unwrap_err();
        assert_eq!(error.code(), "invalid_request");
    }
}

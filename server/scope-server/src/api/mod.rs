#![allow(clippy::missing_errors_doc)]

use crate::{AppContext, host};
use axum::http::StatusCode;
use std::sync::Arc;

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

mod derived;
mod dialogs;
mod export;
mod formats;
mod ingest;
#[path = "preferences.rs"]
mod preferences_api;
mod query;
#[path = "session.rs"]
mod session_api;

pub use derived::*;
pub use dialogs::*;
pub use export::*;
pub use formats::*;
pub use ingest::*;
pub use preferences_api::*;
pub use query::*;
pub use session_api::*;

#[cfg(test)]
use export::write_export_file;

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use scope_protocol::FormatDescriptor;
    use tower::ServiceExt;

    use super::{load_preferences, pick_sources, save_preferences};
    use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
    use base64::Engine;
    use scope_protocol::{
        Envelope, ExportFileKind, Line2DRequest, SampleRequest, SampleResponse,
        SaveExportFileToDirectoryRequest, TileRequest,
    };
    use std::{path::PathBuf, sync::Arc};

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

    #[test]
    fn export_write_replaces_via_rename_not_truncation() {
        let dir = std::env::temp_dir().join(format!("scope-export-stage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("report.html");
        std::fs::write(&path, "old export").unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();

        super::write_export_file(&path, "new export").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new export");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["report.html".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
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

    #[allow(clippy::float_cmp)]
    #[tokio::test]
    async fn query_samples_keeps_zero_uncapped_and_positive_values_bounded() {
        let ctx = crate::AppContext::for_tests(None);
        let signal_id = {
            let mut data = ctx.state.lock().unwrap();
            let source = data
                .store
                .register_source(
                    "/tmp/sample-query.csv",
                    scope_core::store::SourceKey(uuid::Uuid::new_v4()),
                    "sample-query",
                )
                .unwrap();
            let time = (0..100).map(f64::from).collect::<Vec<_>>();
            data.store
                .insert_signal(source, "value", None, time.clone(), time)
                .unwrap()
        };
        let router = crate::build_router(ctx);

        let request = |max_points| {
            Envelope::new(SampleRequest {
                request_id: "samples".into(),
                signal_ids: vec![signal_id.0],
                window: scope_protocol::TimeWindow { t0: 20.0, t1: 79.0 },
                max_points,
            })
        };

        let uncapped = router
            .clone()
            .oneshot(
                Request::post("/api/query_samples")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request(0)).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(uncapped.status(), StatusCode::OK);
        let body = uncapped.into_body().collect().await.unwrap().to_bytes();
        let uncapped: Envelope<SampleResponse> = serde_json::from_slice(&body).unwrap();
        assert_eq!(uncapped.payload.series[0].time.len(), 62);
        assert_eq!(uncapped.payload.series[0].stride, 1);
        assert_eq!(uncapped.payload.series[0].time.first(), Some(&19.0));
        assert_eq!(uncapped.payload.series[0].values.first(), Some(&19.0));
        assert_eq!(uncapped.payload.series[0].time[31], 50.0);
        assert_eq!(uncapped.payload.series[0].values[31], 50.0);
        assert_eq!(uncapped.payload.series[0].time.last(), Some(&80.0));
        assert_eq!(uncapped.payload.series[0].values.last(), Some(&80.0));

        let bounded = router
            .oneshot(
                Request::post("/api/query_samples")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request(10)).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bounded.status(), StatusCode::OK);
        let body = bounded.into_body().collect().await.unwrap().to_bytes();
        let bounded: Envelope<SampleResponse> = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            bounded.payload.series[0].time,
            vec![19.0, 26.0, 33.0, 40.0, 47.0, 54.0, 61.0, 68.0, 75.0, 80.0]
        );
        assert_eq!(
            bounded.payload.series[0].values,
            vec![19.0, 26.0, 33.0, 40.0, 47.0, 54.0, 61.0, 68.0, 75.0, 80.0]
        );
        assert_eq!(bounded.payload.series[0].stride, 7);
    }

    #[tokio::test]
    async fn save_export_file_to_directory_accepts_bodies_over_two_megabytes() {
        let router = crate::build_router(crate::AppContext::for_tests(None));
        let directory =
            std::env::temp_dir().join(format!("scope-export-body-limit-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let bytes = vec![b'x'; 2 * 1024 * 1024];
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let request = Envelope::new(SaveExportFileToDirectoryRequest {
            directory: directory.display().to_string(),
            file_name: "large.csv".into(),
            kind: ExportFileKind::Csv,
            data_base64,
        });
        let response = router
            .oneshot(
                Request::post("/api/save_export_file_to_directory")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let path = directory.join("large.csv");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), bytes.len() as u64);
        let _ = std::fs::remove_dir_all(directory);
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

    async fn request_tiles(
        router: &axum::Router,
        signal_id: u64,
        t0: f64,
        t1: f64,
        pixel_width: u32,
    ) -> scope_protocol::tile_binary::OwnedBinarySeries {
        let request = Envelope::new(TileRequest {
            request_id: "adaptive".into(),
            signal_ids: vec![signal_id],
            window: scope_protocol::TimeWindow { t0, t1 },
            pixel_width,
        });
        let response = router
            .clone()
            .oneshot(
                Request::post("/api/query_tiles_bin")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        scope_protocol::tile_binary::decode_tile_response(&body)
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
    }

    #[tokio::test]
    async fn query_tiles_bin_refines_from_envelope_to_raw() {
        let ctx = crate::AppContext::for_tests(None);
        let signal_id = {
            let mut data = ctx.state.lock().unwrap();
            let source = data
                .store
                .register_source(
                    "/tmp/raw-query.csv",
                    scope_core::store::SourceKey(uuid::Uuid::new_v4()),
                    "raw-query",
                )
                .unwrap();
            let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
            let signal_id = data
                .store
                .insert_signal(source, "value", None, time.clone(), time.clone())
                .unwrap();
            data.pyramids.insert(
                signal_id,
                scope_core::pyramid::Pyramid::from_samples(&time, &time),
            );
            signal_id
        };
        let router = crate::build_router(ctx);
        let overview = request_tiles(&router, signal_id.0, 0.0, 9_999.0, 200).await;
        assert!(overview.level > 0);
        assert!(overview.bin_count > 200);
        assert!(overview.bin_count <= 402);

        let detail = request_tiles(&router, signal_id.0, 4_900.0, 5_100.0, 400).await;
        assert_eq!(detail.level, 0);
        assert!(detail.sample_count.iter().all(|count| *count == 1));
    }

    #[tokio::test]
    async fn query_line2d_bin_keeps_x_y_rows_and_metadata_ordered() {
        let ctx = crate::AppContext::for_tests(None);
        let (x_signal_id, y0_signal_id, y1_signal_id) = {
            let mut data = ctx.state.lock().unwrap();
            let source = data
                .store
                .register_source(
                    "/tmp/line2d-query.csv",
                    scope_core::store::SourceKey(uuid::Uuid::new_v4()),
                    "line2d-query",
                )
                .unwrap();
            let time = (0..4).map(f64::from).collect::<Vec<_>>();
            let x = data
                .store
                .insert_signal(
                    source,
                    "x",
                    Some("s".into()),
                    time.clone(),
                    vec![10.0, 11.0, f64::NAN, 13.0],
                )
                .unwrap();
            let y0 = data
                .store
                .insert_signal(
                    source,
                    "y0",
                    Some("V".into()),
                    time.clone(),
                    vec![20.0, 21.0, 22.0, 23.0],
                )
                .unwrap();
            let y1 = data
                .store
                .insert_signal(source, "y1", None, time, vec![30.0, 31.0, 32.0, f64::NAN])
                .unwrap();
            (x.0, y0.0, y1.0)
        };
        let router = crate::build_router(ctx);
        let request = Envelope::new(Line2DRequest {
            request_id: "line2d".into(),
            x_signal_id,
            y_signal_ids: vec![y1_signal_id, y0_signal_id],
            window: scope_protocol::TimeWindow { t0: 0.0, t1: 3.0 },
            pixel_width: 100,
        });
        let response = router
            .oneshot(
                Request::post("/api/query_line2d_bin")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let response = scope_protocol::decode_line_response(&body).unwrap();
        assert_eq!(response.level, 0);
        assert_eq!(response.anchor, vec![0.0, 1.0, 2.0, 3.0]);
        assert_eq!(response.x.signal_id, x_signal_id);
        assert_eq!(response.x.signal_path, "line2d-query/x");
        assert_eq!(response.x.unit.as_deref(), Some("s"));
        assert!(response.x.values[2].is_nan());
        assert_eq!(
            response
                .ys
                .iter()
                .map(|series| series.signal_id)
                .collect::<Vec<_>>(),
            vec![y1_signal_id, y0_signal_id]
        );
        assert!(response.ys[0].values[3].is_nan());
        assert_eq!(response.ys[1].values, vec![20.0, 21.0, 22.0, 23.0]);
    }

    #[tokio::test]
    async fn query_line2d_bin_rejects_invalid_bindings_and_unknown_ids() {
        let ctx = crate::AppContext::for_tests(None);
        let (x_signal_id, y_signal_id) = {
            let mut data = ctx.state.lock().unwrap();
            let source = data
                .store
                .register_source(
                    "/tmp/line2d-errors.csv",
                    scope_core::store::SourceKey(uuid::Uuid::new_v4()),
                    "line2d-errors",
                )
                .unwrap();
            let x = data
                .store
                .insert_signal(source, "x", None, vec![0.0, 1.0], vec![10.0, 11.0])
                .unwrap();
            let y = data
                .store
                .insert_signal(source, "y", None, vec![0.0, 2.0], vec![20.0, 21.0])
                .unwrap();
            (x.0, y.0)
        };
        let router = crate::build_router(ctx);
        let request = |x_signal_id, y_signal_ids| {
            Envelope::new(Line2DRequest {
                request_id: "line2d-errors".into(),
                x_signal_id,
                y_signal_ids,
                window: scope_protocol::TimeWindow { t0: 0.0, t1: 2.0 },
                pixel_width: 100,
            })
        };
        for (request, message) in [
            (request(x_signal_id, Vec::new()), "at least one y signal"),
            (
                request(x_signal_id, vec![x_signal_id]),
                "cannot also be a Y signal",
            ),
            (
                request(x_signal_id, vec![y_signal_id, y_signal_id]),
                "must be unique",
            ),
            (request(x_signal_id, vec![y_signal_id]), "exact timebase"),
            (request(999_999, vec![y_signal_id]), "unknown x signal id"),
            (request(x_signal_id, vec![999_999]), "unknown y signal id"),
            (
                Envelope::new(Line2DRequest {
                    request_id: "line2d-errors".into(),
                    x_signal_id,
                    y_signal_ids: vec![y_signal_id],
                    window: scope_protocol::TimeWindow { t0: 2.0, t1: 0.0 },
                    pixel_width: 100,
                }),
                "finite and increasing",
            ),
            (
                Envelope::new(Line2DRequest {
                    request_id: "line2d-errors".into(),
                    x_signal_id,
                    y_signal_ids: vec![y_signal_id],
                    window: scope_protocol::TimeWindow { t0: 0.0, t1: 2.0 },
                    pixel_width: 0,
                }),
                "must be positive",
            ),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::post("/api/query_line2d_bin")
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&request).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            assert!(String::from_utf8_lossy(&body).contains(message));
        }
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

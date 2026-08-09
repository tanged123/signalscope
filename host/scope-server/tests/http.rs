use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    http::{Request, StatusCode},
};
use futures_util::stream;
use scope_host::{HostConfig, HostPaths, ScopeHost};
use scope_protocol::{
    Envelope, ExportFileKind, FileWriteDestination, FileWriteMetadata, encode_file_frame,
};
use tower::ServiceExt;

fn router() -> Router {
    let root = tempfile::tempdir().unwrap();
    let host = ScopeHost::open(HostConfig {
        paths: HostPaths {
            config_dir: root.path().join("config"),
            cache_dir: root.path().join("cache"),
            resource_dir: root.path().join("resources"),
        },
        available_memory_bytes: 8 * 1024 * 1024 * 1024,
    })
    .unwrap();
    scope_server::router(host, "test-token".into(), None)
}

fn router_at(root: &std::path::Path) -> Router {
    let host = ScopeHost::open(HostConfig {
        paths: HostPaths {
            config_dir: root.join("config"),
            cache_dir: root.join("cache"),
            resource_dir: root.join("resources"),
        },
        available_memory_bytes: 8 * 1024 * 1024 * 1024,
    })
    .unwrap();
    scope_server::router(host, "test-token".into(), None)
}

fn chunked_body(bytes: &[u8], boundaries: &[usize]) -> Body {
    let mut start = 0;
    let mut chunks = Vec::new();
    for &end in boundaries {
        chunks.push(Bytes::copy_from_slice(&bytes[start..end]));
        start = end;
    }
    chunks.push(Bytes::copy_from_slice(&bytes[start..]));
    Body::from_stream(stream::iter(
        chunks
            .into_iter()
            .map(Ok::<Bytes, std::convert::Infallible>),
    ))
}

fn export_frame(path: &std::path::Path, payload: &[u8]) -> Vec<u8> {
    encode_file_frame(
        &Envelope::new(FileWriteMetadata {
            destination: FileWriteDestination::ExactPath,
            path: path.display().to_string(),
            file_name: String::new(),
            kind: ExportFileKind::Png,
        }),
        payload,
    )
    .unwrap()
}

async fn post_export(root: &std::path::Path, body: Body) -> axum::response::Response {
    router_at(root)
        .oneshot(
            Request::builder()
                .uri("/v1/export/file")
                .method("POST")
                .header("authorization", "Bearer test-token")
                .header("content-type", "application/octet-stream")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap()
}

fn assert_no_temporary_files(root: &std::path::Path) {
    let files = std::fs::read_dir(root)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .collect::<Vec<_>>();
    assert!(files.is_empty(), "temporary files remain: {files:?}");
}

#[tokio::test]
async fn missing_and_wrong_bearer_tokens_are_unauthorized() {
    let app = router();
    let missing = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/catalog/formats")
                .method("POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
    let wrong = app
        .oneshot(
            Request::builder()
                .uri("/v1/catalog/formats")
                .method("POST")
                .header("authorization", "Bearer wrong")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn configured_origin_is_allowed_without_exposing_the_token() {
    let app = router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .header("origin", "app://signalscope")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert!(!String::from_utf8_lossy(&body).contains("test-token"));
}

#[tokio::test]
async fn authenticated_raw_export_writes_bytes_without_base64() {
    let root = tempfile::tempdir().unwrap();
    let host = ScopeHost::open(HostConfig {
        paths: HostPaths {
            config_dir: root.path().join("config"),
            cache_dir: root.path().join("cache"),
            resource_dir: root.path().join("resources"),
        },
        available_memory_bytes: 8 * 1024 * 1024 * 1024,
    })
    .unwrap();
    let path = root.path().join("plot.png");
    let frame = encode_file_frame(
        &Envelope::new(FileWriteMetadata {
            destination: FileWriteDestination::ExactPath,
            path: path.display().to_string(),
            file_name: String::new(),
            kind: ExportFileKind::Png,
        }),
        &[1, 2, 3],
    )
    .unwrap();
    let response = scope_server::router(host, "test-token".into(), None)
        .oneshot(
            Request::builder()
                .uri("/v1/export/file")
                .method("POST")
                .header("authorization", "Bearer test-token")
                .header("content-type", "application/octet-stream")
                .body(Body::from(frame))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(std::fs::read(path).unwrap(), [1, 2, 3]);
}

#[tokio::test]
async fn streamed_export_writes_a_payload_larger_than_the_json_limit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("large.png");
    let payload = vec![37_u8; 32 * 1024 * 1024];
    let frame = export_frame(&path, &payload);
    let split = [1, 7, 13, 24, 31, 64];
    let response = post_export(root.path(), chunked_body(&frame, &split)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(std::fs::read(path).unwrap(), payload);
}

#[tokio::test]
async fn header_and_metadata_boundaries_are_stream_safe() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("split.png");
    let frame = export_frame(&path, &[1, 2, 3]);
    for split in 1..frame.len() {
        let _ = std::fs::remove_file(&path);
        let response = post_export(root.path(), chunked_body(&frame, &[split])).await;
        assert_eq!(response.status(), StatusCode::OK, "split {split}");
        assert_eq!(std::fs::read(&path).unwrap(), [1, 2, 3]);
    }
}

#[tokio::test]
async fn oversized_declared_payload_is_rejected_before_file_creation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oversized.png");
    let mut frame = export_frame(&path, &[]);
    frame[16..24].copy_from_slice(&(scope_protocol::FILE_FRAME_PAYLOAD_LIMIT + 1).to_le_bytes());
    let response = post_export(root.path(), Body::from(frame)).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!path.exists());
    assert_no_temporary_files(root.path());
}

#[tokio::test]
async fn truncated_and_trailing_uploads_are_atomic() {
    let root = tempfile::tempdir().unwrap();
    let truncated_path = root.path().join("truncated.png");
    let frame = export_frame(&truncated_path, &[1, 2, 3]);
    let response = post_export(root.path(), Body::from(frame[..frame.len() - 1].to_vec())).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!truncated_path.exists());
    assert_no_temporary_files(root.path());

    let trailing_path = root.path().join("trailing.png");
    let mut trailing = export_frame(&trailing_path, &[1, 2, 3]);
    trailing.push(9);
    let response = post_export(root.path(), Body::from(trailing)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!trailing_path.exists());
    assert_no_temporary_files(root.path());
}

#[tokio::test]
async fn invalid_metadata_creates_no_file() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("invalid.png");
    let mut frame = export_frame(&path, &[1]);
    let header = scope_protocol::decode_file_frame_header(&frame).unwrap();
    frame[scope_protocol::FILE_FRAME_HEADER_BYTES] = b'{';
    let metadata_end = scope_protocol::FILE_FRAME_HEADER_BYTES + header.metadata_length as usize;
    for byte in &mut frame[scope_protocol::FILE_FRAME_HEADER_BYTES + 1..metadata_end] {
        *byte = b' ';
    }
    let response = post_export(root.path(), Body::from(frame)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!path.exists());
    assert_no_temporary_files(root.path());
}

#[tokio::test]
async fn ordinary_json_is_limited_but_raw_export_is_not() {
    let root = tempfile::tempdir().unwrap();
    let json = format!(
        "{{\"protocol_version\":{},\"payload\":\"{}\"}}",
        scope_protocol::PROTOCOL_VERSION,
        "x".repeat(16 * 1024 * 1024),
    );
    let response = router_at(root.path())
        .oneshot(
            Request::builder()
                .uri("/v1/catalog/formats")
                .method("POST")
                .header("authorization", "Bearer test-token")
                .header("content-type", "application/json")
                .body(Body::from(json))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let path = root.path().join("raw-large.png");
    let payload = vec![11_u8; 16 * 1024 * 1024 + 1];
    let response = post_export(root.path(), Body::from(export_frame(&path, &payload))).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(std::fs::metadata(path).unwrap().len(), payload.len() as u64);
}

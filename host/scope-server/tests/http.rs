use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use scope_host::{HostConfig, HostPaths, ScopeHost};
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

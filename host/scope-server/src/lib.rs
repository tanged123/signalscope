#![allow(
    clippy::missing_errors_doc,
    clippy::needless_pass_by_value,
    clippy::result_large_err
)]

use std::io::{Read, Write};

use axum::{
    Router,
    body::Body,
    extract::{Json, State},
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine;
use scope_host::{HostConfig, HostError, ScopeHost};
use scope_protocol::{Envelope, IngestBatchRequest, SampleRequest, TileRequest};
use serde::Serialize;

pub const TRANSPORT_VERSION: u32 = 1;

#[derive(Clone)]
struct AppState {
    host: ScopeHost,
    token: String,
    dev_origin: Option<String>,
}

#[derive(Debug, Serialize)]
struct NativeError {
    transport_version: u32,
    code: String,
    message: String,
}

pub fn router(host: ScopeHost, token: String, dev_origin: Option<String>) -> Router {
    let state = AppState {
        host,
        token,
        dev_origin,
    };
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/catalog/formats", post(list_formats))
        .route("/v1/catalog/sources", post(list_sources))
        .route("/v1/catalog/signals", post(list_signals))
        .route("/v1/ingest/scan", post(scan_sources))
        .route("/v1/ingest/start", post(start_batch))
        .route("/v1/ingest/status", post(batch_status))
        .route("/v1/ingest/detail", post(batch_detail))
        .route("/v1/ingest/cancel", post(cancel_batch))
        .route("/v1/ingest/release", post(release_batch))
        .route("/v1/ingest/introspect", post(introspect_container))
        .route("/v1/ingest/recipe", post(save_recipe))
        .route("/v1/query/tiles", post(query_tiles))
        .route("/v1/query/samples", post(query_samples))
        .route("/v1/derived/create", post(create_derived))
        .route("/v1/derived/remove", post(remove_signal))
        .route("/v1/derived-bundle/create", post(create_derived_bundle))
        .route("/v1/derived-bundle/remove", post(remove_derived_bundle))
        .route("/v1/session/save", post(save_session))
        .route("/v1/session/load", post(load_session))
        .route("/v1/session/reset", post(reset_session))
        .route("/v1/preferences/load", post(load_preferences))
        .route("/v1/preferences/save", post(save_preferences))
        .route("/v1/preferences/recipe-directory", post(recipe_directory))
        .route("/v1/export/estimate", post(export_estimate))
        .fallback(not_found)
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, transport_middleware))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
}

pub struct ServerConfig {
    pub host: HostConfig,
    pub dev_origin: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("host startup failed: {0}")]
    Host(#[from] HostError),
    #[error("server startup failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid server argument: {0}")]
    Invalid(String),
}

pub async fn serve(config: ServerConfig) -> Result<(), ServerError> {
    let host = ScopeHost::open(config.host)?;
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random)
        .map_err(|error| ServerError::Io(std::io::Error::other(error.to_string())))?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let handshake = serde_json::json!({
        "transport_version": TRANSPORT_VERSION,
        "port": port,
        "token": token,
        "protocol_version": scope_protocol::PROTOCOL_VERSION,
    });
    let mut stdout = std::io::BufWriter::new(std::io::stdout().lock());
    serde_json::to_writer(&mut stdout, &handshake).map_err(std::io::Error::other)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    let app = router(
        host,
        handshake["token"].as_str().unwrap_or_default().to_owned(),
        config.dev_origin,
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(ServerError::from)
}

async fn shutdown_signal() {
    let eof = tokio::task::spawn_blocking(|| {
        let mut input = std::io::stdin().lock();
        let mut buffer = Vec::new();
        let _ = input.read_to_end(&mut buffer);
    });
    #[cfg(unix)]
    {
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .expect("install SIGINT handler");
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = eof => {}, _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        tokio::select! { _ = eof => {}, _ = tokio::signal::ctrl_c() => {} }
    }
}

async fn transport_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if request.method() == axum::http::Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors(
            response.headers_mut(),
            origin.as_deref(),
            state.dev_origin.as_deref(),
        );
        return response;
    }
    if request.uri().path() != "/v1/health" {
        let expected = format!("Bearer {}", state.token);
        let actual = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok());
        if actual != Some(expected.as_str()) {
            let mut response = error_response(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "native host authorization failed",
            );
            apply_cors(
                response.headers_mut(),
                origin.as_deref(),
                state.dev_origin.as_deref(),
            );
            return response;
        }
    }
    let mut response = next.run(request).await;
    apply_cors(
        response.headers_mut(),
        origin.as_deref(),
        state.dev_origin.as_deref(),
    );
    response
}

fn apply_cors(headers: &mut HeaderMap, origin: Option<&str>, dev_origin: Option<&str>) {
    let allowed =
        origin.filter(|origin| *origin == "app://signalscope" || Some(*origin) == dev_origin);
    let Some(origin) = allowed else { return };
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(NativeError {
            transport_version: TRANSPORT_VERSION,
            code: code.into(),
            message: message.into(),
        }),
    )
        .into_response()
}

fn host_error(error: HostError) -> Response {
    let status = match error.kind() {
        "invalid" => StatusCode::BAD_REQUEST,
        "conflict" => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error_response(status, error.code(), &error.to_string())
}

fn open<T: serde::de::DeserializeOwned>(request: Envelope<T>) -> Result<T, Response> {
    request.open().map_err(|error| {
        error_response(
            StatusCode::BAD_REQUEST,
            "protocol_version",
            &error.to_string(),
        )
    })
}

async fn health() -> Response {
    Json(serde_json::json!({ "transport_version": TRANSPORT_VERSION })).into_response()
}

async fn list_formats(
    State(state): State<AppState>,
    Json(request): Json<Envelope<()>>,
) -> Response {
    if let Err(error) = open(request) {
        return error;
    }
    Json(Envelope::new(state.host.list_formats())).into_response()
}

async fn list_sources(
    State(state): State<AppState>,
    Json(request): Json<Envelope<()>>,
) -> Response {
    if let Err(error) = open(request) {
        return error;
    }
    match state.host.list_sources() {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}

async fn list_signals(
    State(state): State<AppState>,
    Json(request): Json<Envelope<()>>,
) -> Response {
    if let Err(error) = open(request) {
        return error;
    }
    match state.host.list_signals() {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}

async fn scan_sources(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::ScanSourcesRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.scan_sources(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn start_batch(
    State(state): State<AppState>,
    Json(request): Json<Envelope<IngestBatchRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.start_batch(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn batch_status(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::BatchJob>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.batch_status(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn batch_detail(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::BatchDetailRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.batch_detail(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn cancel_batch(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::BatchJob>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.cancel_batch(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn release_batch(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::BatchJob>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.release_batch(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn introspect_container(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::IntrospectRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.introspect_container(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn save_recipe(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::SaveRecipeRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.save_recipe(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn query_samples(
    State(state): State<AppState>,
    Json(request): Json<Envelope<SampleRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.query_samples(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn query_tiles(
    State(state): State<AppState>,
    Json(request): Json<Envelope<TileRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.query_tiles(request).await {
        Ok(value) => ([(header::CONTENT_TYPE, "application/octet-stream")], value).into_response(),
        Err(error) => host_error(error),
    }
}
async fn create_derived(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::DerivedRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.create_derived(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn remove_signal(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::RemoveSignalRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.remove_signal(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn create_derived_bundle(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::CreateDerivedBundleRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.create_derived_bundle(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn remove_derived_bundle(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::RemoveDerivedBundleRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.remove_derived_bundle(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn save_session(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::SaveSessionRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.save_session(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn load_session(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::LoadSessionRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.load_session(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn reset_session(
    State(state): State<AppState>,
    Json(request): Json<Envelope<()>>,
) -> Response {
    if let Err(error) = open(request) {
        return error;
    }
    match state.host.reset_session() {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn load_preferences(
    State(state): State<AppState>,
    Json(request): Json<Envelope<()>>,
) -> Response {
    if let Err(error) = open(request) {
        return error;
    }
    match state.host.load_preferences() {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn save_preferences(
    State(state): State<AppState>,
    Json(request): Json<Envelope<String>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.save_preferences(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn recipe_directory(
    State(state): State<AppState>,
    Json(request): Json<Envelope<()>>,
) -> Response {
    if let Err(error) = open(request) {
        return error;
    }
    match state.host.effective_recipe_directory() {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}
async fn export_estimate(
    State(state): State<AppState>,
    Json(request): Json<Envelope<scope_protocol::ExportEstimateRequest>>,
) -> Response {
    let request = match open(request) {
        Ok(request) => request,
        Err(error) => return error,
    };
    match state.host.export_estimate(request) {
        Ok(value) => Json(Envelope::new(value)).into_response(),
        Err(error) => host_error(error),
    }
}

async fn not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, "not_found", "native route not found")
}

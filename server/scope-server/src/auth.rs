use crate::AppContext;
use axum::{
    Router,
    body::Body,
    extract::{OriginalUri, Query, State},
    http::{HeaderMap, Request, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
    routing::get,
};
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

const COOKIE_NAME: &str = "scope_token";

pub async fn require_auth(
    State(ctx): State<AppContext>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if authorized(&ctx, request.headers(), None) {
        next.run(request).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

pub fn page_routes() -> Router<AppContext> {
    Router::new().route("/", get(page)).fallback(static_asset)
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

async fn page(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Query(query): Query<TokenQuery>,
) -> Response {
    if let Some(token) = query.token
        && ctx.token.as_deref() == Some(token.as_str())
    {
        let mut response = Redirect::to("/").into_response();
        let value = format!("{COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/");
        response
            .headers_mut()
            .insert(header::SET_COOKIE, value.parse().expect("valid cookie"));
        return response;
    }
    if authorized(&ctx, &headers, None) {
        frontend_response(&ctx, "/").await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

async fn static_asset(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
) -> Response {
    if !authorized(&ctx, &headers, None) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    frontend_response(&ctx, uri.path()).await
}

async fn frontend_response(ctx: &AppContext, request_path: &str) -> Response {
    let root = ctx
        .frontend_dir
        .clone()
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../frontend/dist"));
    let relative = request_path.trim_start_matches('/');
    let path = if relative.is_empty() {
        root.join("index.html")
    } else {
        let mut path = root.clone();
        for component in Path::new(relative).components() {
            let Component::Normal(component) = component else {
                return StatusCode::NOT_FOUND.into_response();
            };
            path.push(component);
        }
        path
    };
    let path = if path.is_file() {
        path
    } else if !relative.contains('.') {
        root.join("index.html")
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = match request_path.rsplit('.').next() {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        _ => "text/html; charset=utf-8",
    };
    ([(header::CONTENT_TYPE, content_type)], Body::from(bytes)).into_response()
}

fn authorized(ctx: &AppContext, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    let Some(expected) = ctx.token.as_deref() else {
        return true;
    };
    query_token == Some(expected)
        || bearer_token(headers).is_some_and(|token| token == expected)
        || cookie_token(headers).is_some_and(|token| token == expected)
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value.split(';').find_map(|entry| {
                let (name, value) = entry.trim().split_once('=')?;
                (name == COOKIE_NAME).then_some(value)
            })
        })
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn router() -> axum::Router {
        crate::build_router(crate::AppContext::for_tests(Some("sekret".into())))
    }

    #[tokio::test]
    async fn health_needs_no_auth() {
        let res = router()
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn api_without_cookie_is_unauthorized() {
        let res = router()
            .oneshot(
                Request::post("/api/list_formats")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn token_query_sets_cookie_and_redirects() {
        let res = router()
            .oneshot(Request::get("/?token=sekret").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::SEE_OTHER);
        let cookie = res.headers().get("set-cookie").unwrap().to_str().unwrap();
        assert!(cookie.starts_with("scope_token=sekret"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
    }

    #[tokio::test]
    async fn bearer_token_passes() {
        let res = router()
            .oneshot(
                Request::post("/api/list_formats")
                    .header("authorization", "Bearer sekret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn authenticated_root_serves_frontend_and_unauthenticated_is_rejected() {
        let dir = std::env::temp_dir().join(format!("scope-frontend-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "hello").unwrap();
        let mut context = crate::AppContext::for_tests(Some("sekret".into()));
        context.frontend_dir = Some(dir.clone());

        let response = crate::build_router(context.clone())
            .oneshot(
                Request::get("/")
                    .header("cookie", "scope_token=sekret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            b"hello".as_slice()
        );

        let response = crate::build_router(context)
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let _ = std::fs::remove_dir_all(dir);
    }
}

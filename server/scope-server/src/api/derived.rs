use super::{ApiError, err, with_state};
use crate::AppContext;
use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;
use scope_protocol::{
    CreateDerivedBundleRequest, DerivedRequest, Envelope, RemoveDerivedBundleRequest,
    RemoveSignalRequest,
};

pub async fn create_derived(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<DerivedRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = with_state(&ctx, move |data| {
        let id = data
            .derived()
            .create_derived_signal(&request.path, &request.expr)?;
        summary(data, id)
    })
    .await?;
    Ok(Json(Envelope::new(response)))
}

pub async fn create_derived_bundle(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<CreateDerivedBundleRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = with_state(&ctx, move |data| {
        let result = data
            .derived()
            .create_derived_bundle(&request.name, &request.expr)?;
        Ok(scope_protocol::DerivedBundleResponse {
            local_path: result.local_path,
            created: result
                .created
                .into_iter()
                .map(|id| summary(data, id))
                .collect::<Result<_, _>>()?,
            skipped: result
                .skipped
                .into_iter()
                .map(|member| scope_protocol::SkippedMemberSummary {
                    prefix: member.prefix,
                    missing: member.missing,
                })
                .collect(),
        })
    })
    .await?;
    Ok(Json(Envelope::new(response)))
}

pub async fn remove_derived_bundle(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<RemoveDerivedBundleRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    with_state(&ctx, move |data| {
        data.derived().remove_derived_bundle(&request.name)
    })
    .await?;
    Ok(Json(Envelope::new(())))
}

pub async fn remove_signal(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<RemoveSignalRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let path = request.path;
    with_state(&ctx, move |data| {
        data.derived().remove_derived_signal(&path)
    })
    .await?;
    Ok(Json(Envelope::new(())))
}

fn summary(
    data: &crate::host::DataState,
    id: scope_core::store::SignalId,
) -> Result<scope_protocol::SignalSummary, String> {
    let signal = data
        .store
        .signal(id)
        .ok_or("derived signal vanished after insertion")?;
    let source = data
        .store
        .sources()
        .find(|source| source.id == signal.source_id)
        .ok_or("derived source vanished after insertion")?;
    Ok(crate::host::signal_summary(
        signal,
        source.key,
        data.pyramids
            .get(&id)
            .and_then(scope_core::pyramid::Pyramid::last_finite_value),
    ))
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use scope_protocol::{DerivedRequest, Envelope};
    use tower::ServiceExt;

    #[tokio::test]
    async fn bounded_expression_depth_returns_bad_request_without_publication() {
        let context = crate::AppContext::for_tests(Some("depth-test".into()));
        let router = crate::build_router(context.clone());
        for expression in [
            format!("{}1", "-".repeat(10_000)),
            format!("{}1{}", "(".repeat(10_000), ")".repeat(10_000)),
            format!("1{}", "+1".repeat(10_000)),
        ] {
            let request = Envelope::new(DerivedRequest {
                path: "too-deep".into(),
                expr: expression,
            });
            let response = router
                .clone()
                .oneshot(
                    Request::post("/api/create_derived")
                        .header("authorization", "Bearer depth-test")
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&request).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            assert!(
                String::from_utf8_lossy(&bytes)
                    .contains("expression nesting or tree depth exceeds 128")
            );
            let data = context.state.lock().unwrap();
            assert_eq!(data.store.signals().count(), 0);
            assert_eq!(data.store.sources().count(), 0);
            assert!(data.pyramids.is_empty());
        }
        let response = router
            .oneshot(
                Request::post("/api/list_signals")
                    .header("authorization", "Bearer depth-test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}

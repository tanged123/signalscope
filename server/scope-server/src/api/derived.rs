use super::*;

pub async fn create_derived(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<DerivedRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = with_state(&ctx, move |data| data.create_derived_signal(request)).await?;
    Ok(Json(Envelope::new(response)))
}

pub async fn create_derived_bundle(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<CreateDerivedBundleRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let response = with_state(&ctx, move |data| data.create_derived_bundle(request)).await?;
    Ok(Json(Envelope::new(response)))
}

pub async fn remove_derived_bundle(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<RemoveDerivedBundleRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    with_state(&ctx, move |data| data.remove_derived_bundle(&request)).await?;
    Ok(Json(Envelope::new(())))
}

pub async fn remove_signal(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<RemoveSignalRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let path = request.path;
    with_state(&ctx, move |data| data.remove_derived_signal(&path)).await?;
    Ok(Json(Envelope::new(())))
}

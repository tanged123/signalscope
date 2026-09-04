use super::{
    ApiError, AppContext, Arc, Envelope, IntoResponse, Json, PickSessionRequest, State, err, host,
};

pub async fn pick_sources(State(ctx): State<AppContext>) -> Result<impl IntoResponse, ApiError> {
    let descriptors = scope_core::ingest::registry::ProviderRegistry::builtin();
    let dialogs = Arc::clone(&ctx.dialogs);
    let paths = tokio::task::spawn_blocking(move || {
        let owned = host::format_descriptors(&descriptors);
        let supported = owned
            .iter()
            .flat_map(|descriptor| descriptor.extensions.iter().map(String::as_str))
            .collect::<Vec<_>>();
        let filters = owned
            .iter()
            .map(|descriptor| {
                (
                    descriptor.label.as_str(),
                    descriptor
                        .extensions
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>();
        let mut filter_refs = Vec::with_capacity(filters.len() + 1);
        filter_refs.push(("Supported telemetry", supported.as_slice()));
        filter_refs.extend(
            filters
                .iter()
                .map(|(name, extensions)| (*name, extensions.as_slice())),
        );
        dialogs.pick_files("Open telemetry sources", &filter_refs)
    })
    .await
    .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        paths
            .unwrap_or_default()
            .into_iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>(),
    )))
}

pub async fn pick_source_folder(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || dialogs.pick_folder("Open source folder"))
        .await
        .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        path.map(|path| path.display().to_string()),
    )))
}

pub async fn pick_session_path(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<PickSessionRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || match request.mode {
        scope_protocol::SessionDialogMode::Open => {
            dialogs.pick_files("Open SignalScope workspace", &[])
        }
        scope_protocol::SessionDialogMode::Save => dialogs
            .save_file(
                "Save SignalScope workspace",
                "workspace.signalscope",
                &[("SignalScope workspace", &["signalscope", "json"])],
            )
            .map(|path| vec![path]),
    })
    .await
    .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        path.and_then(|paths| paths.into_iter().next())
            .map(|path| path.display().to_string()),
    )))
}

pub async fn pick_export_directory(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || dialogs.pick_folder("Choose export directory"))
        .await
        .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        path.map(|path| path.display().to_string()),
    )))
}

pub async fn pick_recipe_directory(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || dialogs.pick_folder("Choose recipe directory"))
        .await
        .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(
        path.map(|path| path.display().to_string()),
    )))
}

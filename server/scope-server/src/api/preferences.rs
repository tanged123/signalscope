use super::*;

pub(super) fn load_preferences_value(ctx: &AppContext) -> Result<preferences::Preferences, String> {
    let path = ctx.data_dir.join("preferences.json");
    if !path.exists() {
        return Ok(preferences::Preferences::default());
    }
    preferences::load_from_path(&path).map_err(|error| error.to_string())
}

pub(super) fn recipe_directory(
    ctx: &AppContext,
    preferences: &preferences::Preferences,
) -> Option<PathBuf> {
    preferences
        .recipe_directory
        .as_ref()
        .map(PathBuf::from)
        .or_else(|| Some(ctx.data_dir.join("recipes")))
}

pub async fn load_preferences(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let path = ctx.data_dir.join("preferences.json");
    if !path.exists() {
        return Ok(Json(Envelope::new(None::<String>)));
    }
    let mut preferences = load_preferences_value(&ctx).map_err(err)?;
    if preferences.cache_root.is_none() {
        preferences.cache_root = Some(ctx.data_dir.join("cache").display().to_string());
    }
    let json = serde_json::to_string(&preferences).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(Some(json))))
}

pub async fn save_preferences(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<String>>,
) -> Result<impl IntoResponse, ApiError> {
    let json = request.open().map_err(|error| err(error.to_string()))?;
    let mut preferences = preferences::from_json(&json).map_err(|error| err(error.to_string()))?;
    if preferences.cache_root.is_none() {
        preferences.cache_root = Some(ctx.data_dir.join("cache").display().to_string());
    }
    std::fs::create_dir_all(&ctx.data_dir).map_err(|error| err(error.to_string()))?;
    preferences::save_to_path(&preferences, &ctx.data_dir.join("preferences.json"))
        .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(())))
}

pub async fn effective_recipe_directory(
    State(ctx): State<AppContext>,
) -> Result<impl IntoResponse, ApiError> {
    let preferences = load_preferences_value(&ctx).unwrap_or_default();
    let directory = recipe_directory(&ctx, &preferences)
        .ok_or_else(|| err("no recipe directory is available"))?;
    Ok(Json(Envelope::new(directory.display().to_string())))
}

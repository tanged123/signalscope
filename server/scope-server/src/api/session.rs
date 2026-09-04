use super::{
    ApiError, AppContext, Envelope, IntoResponse, Json, LoadSessionRequest, LoadedSession, PathBuf,
    SaveSessionRequest, State, err, session,
};

const AUTOSAVE_FILE: &str = "session.autosave.json";

fn session_path(ctx: &AppContext, path: Option<String>) -> PathBuf {
    path.map_or_else(|| ctx.data_dir.join(AUTOSAVE_FILE), PathBuf::from)
}

fn normalized_session_save_path(mut path: PathBuf) -> PathBuf {
    if path.extension().is_none_or(std::ffi::OsStr::is_empty) {
        path.set_extension("signalscope");
    }
    path
}

pub async fn save_session(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<SaveSessionRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    ctx.gate.save_allowed(request.path.is_none()).map_err(err)?;
    let session =
        session::from_json(&request.session_json).map_err(|error| err(error.to_string()))?;
    let path = request.path.map_or_else(
        || session_path(&ctx, None),
        |path| normalized_session_save_path(PathBuf::from(path)),
    );
    session::save_to_path(&session, &path).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(path.display().to_string())))
}

pub async fn load_session(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<LoadSessionRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let explicit = request.path.is_some();
    let path = session_path(&ctx, request.path);
    if !explicit && !path.exists() {
        let session = session::Session::default();
        return Ok(Json(Envelope::new(LoadedSession {
            session_json: serde_json::to_string(&session)
                .map_err(|error| err(error.to_string()))?,
            path: None,
        })));
    }
    let session = session::load_from_path(&path).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(LoadedSession {
        session_json: serde_json::to_string(&session).map_err(|error| err(error.to_string()))?,
        path: explicit.then(|| path.display().to_string()),
    })))
}

pub async fn reset_session(State(ctx): State<AppContext>) -> Result<impl IntoResponse, ApiError> {
    let session = session::Session::default();
    let path = session_path(&ctx, None);
    session::save_to_path(&session, &path).map_err(|error| err(error.to_string()))?;
    ctx.state
        .lock()
        .map_err(|error| err(error.to_string()))?
        .reset();
    ctx.gate.clear();
    Ok(Json(Envelope::new(LoadedSession {
        session_json: serde_json::to_string(&session).map_err(|error| err(error.to_string()))?,
        path: None,
    })))
}

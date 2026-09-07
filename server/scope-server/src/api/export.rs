use super::{ApiError, err};
use crate::{AppContext, host};
use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;
use base64::Engine;
use scope_core::{session, snapshot};
use scope_protocol::{
    Envelope, ExportEstimate, ExportEstimateRequest, ExportFileKind, ExportRange,
    ExportWriteRequest, SaveExportFileRequest, SaveExportFileToDirectoryRequest,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub async fn export_write(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<ExportWriteRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let dialogs = Arc::clone(&ctx.dialogs);
    let path = tokio::task::spawn_blocking(move || {
        dialogs.save_file(
            "Export HTML snapshot",
            "snapshot.html",
            &[("HTML snapshot", &["html"])],
        )
    })
    .await
    .map_err(|error| err(error.to_string()))?;
    let Some(path) = path else {
        return Ok(Json(Envelope::new(None::<String>)));
    };
    let path = normalized_export_save_path(path, "html");
    let template = std::fs::read_to_string(template_path(&ctx).map_err(err)?)
        .map_err(|error| err(error.to_string()))?;
    let session =
        session::from_json(&request.session_json).map_err(|error| err(error.to_string()))?;
    let mut manifest = {
        let data = ctx.state.lock().map_err(|error| err(error.to_string()))?;
        let export = snapshot::plan_selected(
            &session,
            &data.store,
            &data.pyramids,
            &request.selection,
            request.range,
            request.fidelity,
        )
        .map_err(|error| err(error.to_string()))?;
        snapshot::bake(&export, &session).map_err(|error| err(error.to_string()))?
    };
    manifest.preferences_json = request.preferences_json;
    let html = snapshot::inject(&template, manifest).map_err(|error| err(error.to_string()))?;
    write_export_file(&path, &html).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(Some(path.display().to_string()))))
}

pub async fn save_export_file(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<SaveExportFileRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let (label, extension) = match request.kind {
        ExportFileKind::Png => ("PNG image", "png"),
        ExportFileKind::Csv => ("CSV", "csv"),
    };
    let dialogs = Arc::clone(&ctx.dialogs);
    let file_name = request.file_name.clone();
    let path = tokio::task::spawn_blocking(move || {
        dialogs.save_file(label, &file_name, &[(label, &[extension])])
    })
    .await
    .map_err(|error| err(error.to_string()))?;
    let Some(path) = path else {
        return Ok(Json(Envelope::new(None::<String>)));
    };
    let path = normalized_export_save_path(path, extension);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data_base64)
        .map_err(|error| err(error.to_string()))?;
    std::fs::write(&path, bytes).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(Some(path.display().to_string()))))
}

fn normalized_export_save_path(mut path: PathBuf, extension: &str) -> PathBuf {
    if path.extension() != Some(std::ffi::OsStr::new(extension)) {
        path.set_extension(extension);
    }
    path
}

pub(super) fn write_export_file(path: &Path, contents: &str) -> Result<(), std::io::Error> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);
    let file_name = path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("export"))
        .to_string_lossy();
    let staged = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(error) = std::fs::write(&staged, contents) {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&staged, path) {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    Ok(())
}

pub async fn export_estimate(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<ExportEstimateRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let session =
        session::from_json(&request.session_json).map_err(|error| err(error.to_string()))?;
    let template_bytes = template_path(&ctx)
        .and_then(|path| std::fs::metadata(path).map_err(|error| error.to_string()))
        .map_err(err)?
        .len();
    let data = ctx.state.lock().map_err(|error| err(error.to_string()))?;
    let response = estimate_for(
        &data,
        &session,
        &request.session_json,
        template_bytes,
        &request.selection,
    )
    .map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(response)))
}

fn template_path(ctx: &AppContext) -> Result<PathBuf, String> {
    if let Some(frontend_dir) = &ctx.frontend_dir {
        let path = frontend_dir.join("snapshot-template.html");
        if path.exists() {
            return Ok(path);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../frontend/dist/snapshot-template.html");
    if development.exists() {
        return Ok(development);
    }
    Err("snapshot template is missing; run ./scripts/build.sh web".to_owned())
}

fn estimate_for(
    data: &host::DataState,
    session: &session::Session,
    session_json: &str,
    template_bytes: u64,
    selection: &scope_protocol::ExportSelection,
) -> Result<ExportEstimate, snapshot::SnapshotError> {
    let base = template_bytes + session_json.len() as u64;
    let mut entries = Vec::with_capacity(8);
    for range in [ExportRange::Visible, ExportRange::All] {
        for fidelity in [
            scope_protocol::ExportFidelity::Preview,
            scope_protocol::ExportFidelity::Standard,
            scope_protocol::ExportFidelity::High,
            scope_protocol::ExportFidelity::Full,
        ] {
            let plan = snapshot::plan_selected(
                session,
                &data.store,
                &data.pyramids,
                selection,
                range,
                fidelity,
            )?;
            entries.push(scope_protocol::ExportEstimateEntry {
                range,
                fidelity,
                bytes: base + snapshot::estimated_bytes(&plan),
                series_total: plan.series_total,
                series_decimated: plan.series_decimated,
                series_full_rate: plan.series_full_rate,
                coarsest_ratio: plan.coarsest_ratio,
            });
        }
    }
    Ok(ExportEstimate { entries })
}

pub async fn save_export_file_to_directory(
    Json(request): Json<Envelope<SaveExportFileToDirectoryRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|error| err(error.to_string()))?;
    let extension = match request.kind {
        ExportFileKind::Png => "png",
        ExportFileKind::Csv => "csv",
    };
    let directory = PathBuf::from(&request.directory);
    if !directory.is_dir() {
        return Err(err("export directory does not exist"));
    }
    let path = export_file_path(&directory, &request.file_name, extension).map_err(err)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data_base64)
        .map_err(|error| err(error.to_string()))?;
    std::fs::write(&path, bytes).map_err(|error| err(error.to_string()))?;
    Ok(Json(Envelope::new(path.display().to_string())))
}

fn export_file_path(directory: &Path, file_name: &str, extension: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(file_name).components();
    let Some(std::path::Component::Normal(_)) = components.next() else {
        return Err("export file name must be a single path component".to_owned());
    };
    if components.next().is_some() {
        return Err("export file name must be a single path component".to_owned());
    }
    let mut path = directory.join(file_name);
    if path.extension() != Some(std::ffi::OsStr::new(extension)) {
        path.set_extension(extension);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn html_export_preserves_appearance_and_accepts_older_requests() {
        let directory = std::env::temp_dir().join(format!("scope-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let slot = "<script id=\"signalscope-baked-data\" type=\"application/json\">";
        std::fs::write(
            directory.join("snapshot-template.html"),
            format!("{slot}null</script>"),
        )
        .unwrap();
        let path = directory.join("review.html");
        let mut ctx = AppContext::for_tests(None);
        ctx.frontend_dir = Some(directory.clone());
        let dialogs = crate::dialogs::Scripted::default();
        *dialogs.save.lock().unwrap() = Some(path.clone());
        ctx.dialogs = Arc::new(dialogs);
        let router = crate::build_router(ctx);
        let preferences =
            r#"{"schema_version":6,"plot_line_width_scale":1.75,"plot_font_size":12.5}"#;
        for appearance in [Some(preferences), None] {
            let mut payload = serde_json::json!({
                "session_json": serde_json::to_string(&session::Session::default()).unwrap(),
                "range": "all", "fidelity": "full", "selection": { "source_keys": [] }
            });
            if let Some(json) = appearance {
                payload["preferences_json"] = json.into();
            }
            let response = router
                .clone()
                .oneshot(
                    Request::post("/api/export_write")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::to_vec(&Envelope::new(payload)).unwrap(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            let html = std::fs::read_to_string(&path).unwrap();
            let json = html
                .strip_prefix(slot)
                .unwrap()
                .strip_suffix("</script>")
                .unwrap();
            let envelope: Envelope<scope_protocol::SnapshotManifest> =
                serde_json::from_str(json).unwrap();
            let manifest = envelope.open().unwrap();
            assert_eq!(manifest.preferences_json.as_deref(), appearance);
            session::from_json(&manifest.session_json).unwrap();
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}

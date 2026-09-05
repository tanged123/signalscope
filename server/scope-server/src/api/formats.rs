use super::ApiError;
use crate::host;
use axum::Json;
use axum::response::IntoResponse;
use scope_protocol::Envelope;

pub async fn list_formats() -> Result<impl IntoResponse, ApiError> {
    let registry = scope_core::ingest::registry::ProviderRegistry::builtin();
    Ok(Json(Envelope::new(host::format_descriptors(&registry))))
}

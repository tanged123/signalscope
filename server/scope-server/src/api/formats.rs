use super::*;

pub async fn list_formats() -> Result<impl IntoResponse, ApiError> {
    let registry = scope_core::ingest::registry::ProviderRegistry::builtin();
    Ok(Json(Envelope::new(host::format_descriptors(&registry))))
}

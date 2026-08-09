use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use base64::Engine;
use scope_core::{session, snapshot};
use scope_protocol::{
    ExportEstimate, ExportEstimateEntry, ExportEstimateRequest, ExportFidelity, ExportFileKind,
    ExportRange, ExportSelection, ExportWriteRequest, SaveExportFileRequest,
    SaveExportFileToDirectoryRequest,
};

use crate::{HostError, ScopeHost, state::DataState};

fn invalid(message: impl Into<String>) -> HostError {
    HostError::Invalid {
        code: "invalid_request",
        message: message.into(),
    }
}

impl ScopeHost {
    pub fn export_template_bytes(&self) -> Result<u64, HostError> {
        Ok(std::fs::metadata(self.snapshot_template()?)
            .map_err(|error| invalid(error.to_string()))?
            .len())
    }

    pub fn export_estimate(
        &self,
        request: ExportEstimateRequest,
    ) -> Result<ExportEstimate, HostError> {
        let parsed = session::from_json(&request.session_json)
            .map_err(|error| invalid(error.to_string()))?;
        let template_bytes = self.export_template_bytes()?;
        let data = self
            .inner()
            .state
            .lock()
            .map_err(|error| invalid(error.to_string()))?;
        estimate_for(
            &data,
            &parsed,
            &request.session_json,
            template_bytes,
            &request.selection,
        )
        .map_err(|error| invalid(error.to_string()))
    }

    pub fn export_html_to_path(
        &self,
        request: ExportWriteRequest,
        destination: PathBuf,
    ) -> Result<String, HostError> {
        let template = std::fs::read_to_string(self.snapshot_template()?)
            .map_err(|error| invalid(error.to_string()))?;
        let parsed = session::from_json(&request.session_json)
            .map_err(|error| invalid(error.to_string()))?;
        let manifest = {
            let data = self
                .inner()
                .state
                .lock()
                .map_err(|error| invalid(error.to_string()))?;
            let export = snapshot::plan_selected(
                &parsed,
                &data.store,
                &data.pyramids,
                &request.selection,
                request.range,
                request.fidelity,
            )
            .map_err(|error| invalid(error.to_string()))?;
            snapshot::bake(&export, &parsed).map_err(|error| invalid(error.to_string()))?
        };
        let html =
            snapshot::inject(&template, manifest).map_err(|error| invalid(error.to_string()))?;
        let path = normalized_export_save_path(destination, "html");
        write_atomic(&path, html.as_bytes()).map_err(|error| invalid(error.to_string()))?;
        Ok(path.display().to_string())
    }

    pub fn write_export_file(
        &self,
        request: &SaveExportFileRequest,
        destination: PathBuf,
    ) -> Result<PathBuf, HostError> {
        let extension = extension_for(request.kind);
        validate_file_name(&request.file_name)?;
        let path = normalized_export_save_path(destination, extension);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&request.data_base64)
            .map_err(|error| invalid(error.to_string()))?;
        write_atomic(&path, &bytes).map_err(|error| invalid(error.to_string()))?;
        Ok(path)
    }

    pub fn write_export_file_to_directory(
        &self,
        request: &SaveExportFileToDirectoryRequest,
    ) -> Result<String, HostError> {
        let directory = PathBuf::from(&request.directory);
        if !directory.is_dir() {
            return Err(invalid("export directory does not exist"));
        }
        let path = export_file_path(&directory, &request.file_name, extension_for(request.kind))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&request.data_base64)
            .map_err(|error| invalid(error.to_string()))?;
        write_atomic(&path, &bytes).map_err(|error| invalid(error.to_string()))?;
        Ok(path.display().to_string())
    }
}

fn extension_for(kind: ExportFileKind) -> &'static str {
    match kind {
        ExportFileKind::Png => "png",
        ExportFileKind::Csv => "csv",
    }
}

fn validate_file_name(file_name: &str) -> Result<(), HostError> {
    let mut components = Path::new(file_name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
        || file_name.is_empty()
    {
        return Err(invalid("export file name must be a single path component"));
    }
    Ok(())
}

fn export_file_path(
    directory: &Path,
    file_name: &str,
    extension: &str,
) -> Result<PathBuf, HostError> {
    validate_file_name(file_name)?;
    Ok(normalized_export_save_path(
        directory.join(file_name),
        extension,
    ))
}

fn normalized_export_save_path(mut path: PathBuf, extension: &str) -> PathBuf {
    if path.extension() != Some(std::ffi::OsStr::new(extension)) {
        path.set_extension(extension);
    }
    path
}

fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(std::io::Error::other("destination is a symlink"));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("export"))
        .to_string_lossy();
    let staged = path.with_file_name(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
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

fn estimate_for(
    data: &DataState,
    parsed: &session::Session,
    session_json: &str,
    template_bytes: u64,
    selection: &ExportSelection,
) -> Result<ExportEstimate, snapshot::SnapshotError> {
    let base = template_bytes + session_json.len() as u64;
    let mut entries = Vec::with_capacity(8);
    for range in [ExportRange::Visible, ExportRange::All] {
        for fidelity in [
            ExportFidelity::Preview,
            ExportFidelity::Standard,
            ExportFidelity::High,
            ExportFidelity::Full,
        ] {
            let plan = snapshot::plan_selected(
                parsed,
                &data.store,
                &data.pyramids,
                selection,
                range,
                fidelity,
            )?;
            entries.push(ExportEstimateEntry {
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

#[cfg(test)]
mod tests {
    use crate::{HostConfig, HostPaths, ScopeHost};
    use scope_protocol::{ExportFileKind, SaveExportFileRequest};

    fn host(root: &std::path::Path) -> ScopeHost {
        ScopeHost::open(HostConfig {
            paths: HostPaths {
                config_dir: root.join("config"),
                cache_dir: root.join("cache"),
                resource_dir: root.join("resources"),
            },
            available_memory_bytes: 8 * 1024 * 1024 * 1024,
        })
        .unwrap()
    }

    #[test]
    fn raw_export_write_rejects_path_traversal_and_writes_bytes() {
        let root = tempfile::tempdir().unwrap();
        let host = host(root.path());
        let request = SaveExportFileRequest {
            file_name: "plot.png".into(),
            kind: ExportFileKind::Png,
            data_base64: "AAEC".into(),
        };
        let path = host
            .write_export_file(&request, root.path().join("plot.png"))
            .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), [0, 1, 2]);
        let traversal = SaveExportFileRequest {
            file_name: "../plot.png".into(),
            ..request
        };
        assert!(
            host.write_export_file(&traversal, root.path().join("plot.png"))
                .is_err()
        );
    }

    #[test]
    fn missing_template_is_typed_at_export_use() {
        let root = tempfile::tempdir().unwrap();
        let error = host(root.path()).export_template_bytes().unwrap_err();
        assert_eq!(error.code(), "missing_snapshot_template");
    }
}

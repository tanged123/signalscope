use std::{collections::BTreeMap, path::Path};

use scope_core::{
    ingest::registry::ProviderRegistry,
    pyramid::Pyramid,
    store::{Signal, Source, SourceKey},
};
use scope_protocol::{
    FormatDescriptor, ScanSourcesRequest, ScanSourcesResponse, SignalSummary, SourceSummary,
};

use crate::{HostError, ScopeHost, state::DataState};

fn invalid(message: impl Into<String>) -> HostError {
    HostError::Invalid {
        code: "invalid_request",
        message: message.into(),
    }
}

pub(crate) fn format_descriptors(registry: &ProviderRegistry) -> Vec<FormatDescriptor> {
    registry
        .descriptors()
        .into_iter()
        .map(|descriptor| FormatDescriptor {
            id: descriptor.id,
            label: descriptor.label,
            extensions: descriptor.extensions,
        })
        .collect()
}

pub(crate) fn source_summary(source: &Source) -> SourceSummary {
    SourceSummary {
        source_id: source.id.0,
        source_key: source.key.0.to_string(),
        prefix: source.prefix.clone(),
        path: source.path.display().to_string(),
        point_count: source.point_count as u64,
    }
}

pub(crate) fn signal_summary(
    signal: &Signal,
    source_key: SourceKey,
    last_value: Option<f64>,
) -> SignalSummary {
    let (t_min, t_max) = signal.time_bounds();
    SignalSummary {
        signal_id: signal.id.0,
        source_id: signal.source_id.0,
        source_key: source_key.0.to_string(),
        local_path: signal.local_path.clone(),
        path: signal.path.clone(),
        unit: signal.unit.clone(),
        point_count: signal.len() as u64,
        t_min,
        t_max,
        last_value,
    }
}

pub(crate) fn signal_summaries(data: &DataState) -> Vec<SignalSummary> {
    data.store
        .signals()
        .map(|signal| {
            let key = data
                .store
                .sources()
                .find(|source| source.id == signal.source_id)
                .expect("signal source")
                .key;
            signal_summary(
                signal,
                key,
                data.pyramids
                    .get(&signal.id)
                    .and_then(Pyramid::last_finite_value),
            )
        })
        .collect()
}

impl ScopeHost {
    #[must_use]
    pub fn list_formats(&self) -> Vec<FormatDescriptor> {
        format_descriptors(&ProviderRegistry::builtin())
    }

    pub fn list_sources(&self) -> Result<Vec<SourceSummary>, HostError> {
        let data = self
            .inner()
            .state
            .lock()
            .map_err(|error| HostError::Internal {
                code: "state_lock",
                message: error.to_string(),
            })?;
        Ok(data.store.sources().map(source_summary).collect())
    }

    pub fn list_signals(&self) -> Result<Vec<SignalSummary>, HostError> {
        let mut data = self
            .inner()
            .state
            .lock()
            .map_err(|error| HostError::Internal {
                code: "state_lock",
                message: error.to_string(),
            })?;
        reexpand_derived_bundles(&mut data);
        Ok(signal_summaries(&data))
    }

    pub fn scan_sources(
        &self,
        request: ScanSourcesRequest,
    ) -> Result<ScanSourcesResponse, HostError> {
        let registry = ProviderRegistry::builtin();
        let descriptors = registry.descriptors();
        let mut paths = Vec::new();
        expand_source(
            Path::new(&request.path),
            request.recursive,
            &mut paths,
            &descriptors,
        )?;
        paths.retain(|path| supported_path(&descriptors, path));
        paths.sort();
        let mut total_bytes = 0_u64;
        let mut counts = BTreeMap::<String, u32>::new();
        let files = paths
            .into_iter()
            .filter_map(|path| {
                let metadata = std::fs::metadata(&path).ok()?;
                total_bytes = total_bytes.saturating_add(metadata.len());
                let label = format_label(&descriptors, &path)?;
                *counts.entry(label).or_default() += 1;
                Some(path.display().to_string())
            })
            .collect();
        Ok(ScanSourcesResponse {
            files,
            total_bytes,
            format_counts: counts
                .into_iter()
                .map(|(label, count)| scope_protocol::FormatCount { label, count })
                .collect(),
        })
    }
}

pub(crate) fn expand_sources(paths: Vec<String>) -> Result<Vec<std::path::PathBuf>, HostError> {
    let registry = ProviderRegistry::builtin();
    let descriptors = registry.descriptors();
    let mut expanded = Vec::new();
    for path in paths {
        expand_source(Path::new(&path), true, &mut expanded, &descriptors)?;
    }
    expanded.sort();
    Ok(expanded)
}

fn expand_source(
    path: &Path,
    recursive: bool,
    expanded: &mut Vec<std::path::PathBuf>,
    descriptors: &[scope_core::ingest::registry::ProviderDescriptor],
) -> Result<(), HostError> {
    if !path.is_dir() {
        expanded.push(path.to_owned());
        return Ok(());
    }
    let mut entries = std::fs::read_dir(path)
        .map_err(|error| invalid(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| invalid(error.to_string()))?;
    entries.sort_by_key(std::fs::DirEntry::path);
    for entry in entries {
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|error| invalid(error.to_string()))?
            .is_dir()
        {
            if recursive {
                expand_source(&path, true, expanded, descriptors)?;
            }
        } else if supported_path(descriptors, &path) {
            expanded.push(path);
        }
    }
    Ok(())
}

fn supported_path(
    descriptors: &[scope_core::ingest::registry::ProviderDescriptor],
    path: &Path,
) -> bool {
    format_label(descriptors, path).is_some()
}

fn format_label(
    descriptors: &[scope_core::ingest::registry::ProviderDescriptor],
    path: &Path,
) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .and_then(|extension| {
            descriptors.iter().find_map(|descriptor| {
                descriptor
                    .extensions
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(extension))
                    .then(|| descriptor.label.clone())
            })
        })
}

fn reexpand_derived_bundles(data: &mut DataState) {
    data.reexpand_derived_bundles();
}

#[cfg(test)]
mod tests {
    use crate::{HostConfig, HostPaths, ScopeHost};
    use scope_protocol::ScanSourcesRequest;

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
    fn catalog_formats_are_provider_derived() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            host(root.path())
                .list_formats()
                .iter()
                .any(|format| format.id == "csv")
        );
    }

    #[test]
    fn scan_reports_supported_files_in_sorted_order() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("b.csv"), "time,value\n0,1\n").unwrap();
        std::fs::write(root.path().join("a.csv"), "time,value\n0,1\n").unwrap();
        std::fs::write(root.path().join("ignored.json"), "{}").unwrap();
        let response = host(root.path())
            .scan_sources(ScanSourcesRequest {
                path: root.path().display().to_string(),
                recursive: false,
            })
            .unwrap();
        assert_eq!(response.files.len(), 2);
        assert!(response.files[0].ends_with("a.csv"));
        assert!(response.files[1].ends_with("b.csv"));
    }
}

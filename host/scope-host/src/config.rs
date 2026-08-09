use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostPaths {
    pub config_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub resource_dir: PathBuf,
}

impl HostPaths {
    #[must_use]
    pub fn preferences_file(&self) -> PathBuf {
        self.config_dir.join("scope-preferences.json")
    }

    #[must_use]
    pub fn cache_root(&self) -> PathBuf {
        self.cache_dir.join("cache")
    }

    #[must_use]
    pub fn recipe_directory(&self) -> PathBuf {
        self.config_dir.join("recipes")
    }

    #[must_use]
    pub fn snapshot_template(&self) -> PathBuf {
        self.resource_dir.join("snapshot-template.html")
    }
}

#[derive(Clone, Debug)]
pub struct HostConfig {
    pub paths: HostPaths,
    pub available_memory_bytes: u64,
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use scope_core::preferences::{self, Preferences};

    use crate::{HostConfig, HostPaths, ScopeHost};

    fn config(root: &std::path::Path) -> HostConfig {
        HostConfig {
            paths: HostPaths {
                config_dir: root.join("config"),
                cache_dir: root.join("cache"),
                resource_dir: root.join("resources"),
            },
            available_memory_bytes: 8 * 1024 * 1024 * 1024,
        }
    }

    #[test]
    fn host_paths_use_stable_default_locations() {
        let root = tempfile::tempdir().unwrap();
        let paths = config(root.path()).paths;
        assert_eq!(
            paths.preferences_file(),
            paths.config_dir.join("scope-preferences.json")
        );
        assert_eq!(paths.cache_root(), paths.cache_dir.join("cache"));
        assert_eq!(paths.recipe_directory(), paths.config_dir.join("recipes"));
    }

    #[test]
    fn stored_cache_override_wins() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let override_root = root.path().join("override");
        let preferences = Preferences {
            cache_root: Some(override_root.display().to_string()),
            ..Preferences::default()
        };
        preferences::save_to_path(&preferences, &config.paths.preferences_file()).unwrap();
        let host = ScopeHost::open(config).unwrap();
        assert_eq!(host.cache_root(), override_root);
    }

    #[test]
    fn future_preferences_are_rejected_before_opening() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        std::fs::create_dir_all(&config.paths.config_dir).unwrap();
        std::fs::write(config.paths.preferences_file(), r#"{"schema_version":999}"#).unwrap();
        let error = ScopeHost::open(config).err().unwrap();
        assert_eq!(error.code(), "invalid_preferences");
        assert_eq!(error.kind(), "invalid");
    }

    #[test]
    fn preferences_override_available_memory_defaults() {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path());
        let preferences = Preferences {
            ingest_working_bytes: Some(1234),
            ingest_resident_bytes: Some(5678),
            ..Preferences::default()
        };
        preferences::save_to_path(&preferences, &config.paths.preferences_file()).unwrap();
        let host = ScopeHost::open(config).unwrap();
        assert_eq!(host.budget_config(), (1234, 5678));
    }

    #[test]
    fn missing_template_is_not_an_open_failure() {
        let root = tempfile::tempdir().unwrap();
        let host = ScopeHost::open(config(root.path())).unwrap();
        let error = host.snapshot_template().unwrap_err();
        assert_eq!(error.code(), "missing_snapshot_template");
    }

    #[allow(dead_code)]
    fn _path_type_is_explicit() -> PathBuf {
        PathBuf::new()
    }
}

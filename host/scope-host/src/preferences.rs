use scope_core::preferences;

use crate::{HostError, ScopeHost};

fn invalid(message: impl Into<String>) -> HostError {
    HostError::Invalid {
        code: "invalid_preferences",
        message: message.into(),
    }
}

impl ScopeHost {
    pub fn load_preferences(&self) -> Result<Option<String>, HostError> {
        let path = self.inner().config.paths.preferences_file();
        if !path.exists() {
            return Ok(None);
        }
        let mut value =
            preferences::load_from_path(&path).map_err(|error| invalid(error.to_string()))?;
        if value.cache_root.is_none() {
            value.cache_root = Some(self.inner().config.paths.cache_root().display().to_string());
        }
        Ok(Some(
            serde_json::to_string(&value).map_err(|error| invalid(error.to_string()))?,
        ))
    }

    pub fn save_preferences(&self, json: String) -> Result<(), HostError> {
        let mut value =
            preferences::from_json(&json).map_err(|error| invalid(error.to_string()))?;
        if value.cache_root.is_none() {
            value.cache_root = Some(self.inner().config.paths.cache_root().display().to_string());
        }
        preferences::save_to_path(&value, &self.inner().config.paths.preferences_file())
            .map_err(|error| invalid(error.to_string()))?;
        Ok(())
    }

    pub fn effective_recipe_directory(&self) -> Result<String, HostError> {
        let value = self
            .load_preferences()?
            .and_then(|json| preferences::from_json(&json).ok())
            .unwrap_or_default();
        Ok(value
            .recipe_directory
            .map_or_else(
                || self.inner().config.paths.recipe_directory(),
                std::path::PathBuf::from,
            )
            .display()
            .to_string())
    }
}

#[cfg(test)]
mod tests {
    use crate::{HostConfig, HostPaths, ScopeHost};
    use scope_core::preferences::Preferences;

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
    fn preferences_round_trip_and_report_effective_recipe_directory() {
        let root = tempfile::tempdir().unwrap();
        let host = host(root.path());
        let json = serde_json::to_string(&Preferences::default()).unwrap();
        host.save_preferences(json.clone()).unwrap();
        assert!(host.load_preferences().unwrap().is_some());
        assert_eq!(
            host.effective_recipe_directory().unwrap(),
            root.path().join("config/recipes").display().to_string()
        );
    }
}

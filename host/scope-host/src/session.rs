use std::path::PathBuf;

use scope_core::session;
use scope_protocol::{LoadSessionRequest, LoadedSession, SaveSessionRequest};

use crate::{HostError, ScopeHost};

fn invalid(message: impl Into<String>) -> HostError {
    HostError::Invalid {
        code: "invalid_request",
        message: message.into(),
    }
}

const AUTOSAVE_FILE: &str = "session.autosave.json";

impl ScopeHost {
    pub fn save_session(&self, request: SaveSessionRequest) -> Result<String, HostError> {
        self.inner().gate.save_allowed(request.path.is_none())?;
        let parsed = session::from_json(&request.session_json)
            .map_err(|error| invalid(error.to_string()))?;
        let path = request.path.map_or_else(
            || self.inner().config.paths.config_dir.join(AUTOSAVE_FILE),
            |path| normalized_session_save_path(PathBuf::from(path)),
        );
        session::save_to_path(&parsed, &path).map_err(|error| invalid(error.to_string()))?;
        Ok(path.display().to_string())
    }

    pub fn load_session(&self, request: LoadSessionRequest) -> Result<LoadedSession, HostError> {
        let explicit = request.path.is_some();
        let path = request.path.map_or_else(
            || self.inner().config.paths.config_dir.join(AUTOSAVE_FILE),
            PathBuf::from,
        );
        if !explicit && !path.exists() {
            let parsed = session::Session::default();
            return Ok(LoadedSession {
                session_json: serde_json::to_string(&parsed)
                    .map_err(|error| invalid(error.to_string()))?,
                path: None,
            });
        }
        let parsed = session::load_from_path(&path).map_err(|error| invalid(error.to_string()))?;
        Ok(LoadedSession {
            session_json: serde_json::to_string(&parsed)
                .map_err(|error| invalid(error.to_string()))?,
            path: explicit.then(|| path.display().to_string()),
        })
    }

    pub fn reset_session(&self) -> Result<LoadedSession, HostError> {
        let parsed = session::Session::default();
        let path = self.inner().config.paths.config_dir.join(AUTOSAVE_FILE);
        session::save_to_path(&parsed, &path).map_err(|error| invalid(error.to_string()))?;
        self.inner()
            .state
            .lock()
            .map_err(|error| invalid(error.to_string()))?
            .reset();
        Ok(LoadedSession {
            session_json: serde_json::to_string(&parsed)
                .map_err(|error| invalid(error.to_string()))?,
            path: None,
        })
    }
}

fn normalized_session_save_path(mut path: PathBuf) -> PathBuf {
    if path.extension().is_none_or(std::ffi::OsStr::is_empty) {
        path.set_extension("signalscope");
    }
    path
}

#[cfg(test)]
mod tests {
    use crate::{HostConfig, HostPaths, ScopeHost};
    use scope_core::session::Session;
    use scope_protocol::{LoadSessionRequest, SaveSessionRequest};

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
    fn autosave_round_trips_without_an_explicit_path() {
        let root = tempfile::tempdir().unwrap();
        let host = host(root.path());
        let json = serde_json::to_string(&Session::default()).unwrap();
        host.save_session(SaveSessionRequest {
            session_json: json.clone(),
            path: None,
        })
        .unwrap();
        let loaded = host
            .load_session(LoadSessionRequest { path: None })
            .unwrap();
        assert_eq!(loaded.session_json, json);
        assert!(loaded.path.is_none());
    }
}

use std::{
    fs,
    path::{Path, PathBuf},
};

use thiserror::Error;

use crate::preferences::Preferences;

use super::{ContainerKind, Recipe, RecipeError, content_digest, parse_recipe};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecipeOrigin {
    Sidecar(PathBuf),
    UserDirectory(PathBuf),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedRecipe {
    pub recipe: Recipe,
    pub digest: String,
    pub origin: RecipeOrigin,
}

#[derive(Debug, Error)]
pub enum ResolveError {
    #[error("could not read recipe {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("recipe {path} is invalid: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: RecipeError,
    },
    #[error("recipe {path} does not match source container")]
    ContainerMismatch { path: PathBuf },
}

/// Resolves a sidecar recipe before the configured user recipe directory.
///
/// # Errors
///
/// Returns [`ResolveError`] when a candidate recipe cannot be read or parsed.
pub fn resolve_for(
    source: &Path,
    preferences: &Preferences,
) -> Result<Option<ResolvedRecipe>, ResolveError> {
    let Some(container) = container_kind(source) else {
        return Ok(None);
    };
    let sidecar = sidecar_path(source);
    if sidecar.is_file() {
        return load_recipe(&sidecar, RecipeOrigin::Sidecar(sidecar.clone()), &container).map(Some);
    }

    let Some(directory) = preferences.recipe_directory.as_deref() else {
        return Ok(None);
    };
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(ResolveError::Io {
                path: directory.into(),
                source,
            });
        }
    };
    let mut recipes = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "toml")
        })
        .collect::<Vec<_>>();
    recipes.sort_unstable();
    for path in recipes {
        let recipe = load_recipe(&path, RecipeOrigin::UserDirectory(path.clone()), &container);
        match recipe {
            Ok(recipe) => return Ok(Some(recipe)),
            Err(ResolveError::ContainerMismatch { .. }) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

fn load_recipe(
    path: &Path,
    origin: RecipeOrigin,
    expected: &ContainerKind,
) -> Result<ResolvedRecipe, ResolveError> {
    let source = fs::read_to_string(path).map_err(|source| ResolveError::Io {
        path: path.to_owned(),
        source,
    })?;
    let recipe = parse_recipe(&source).map_err(|source| ResolveError::Parse {
        path: path.to_owned(),
        source,
    })?;
    if !container_matches(expected, &recipe.container) {
        return Err(ResolveError::ContainerMismatch {
            path: path.to_owned(),
        });
    }
    let digest = content_digest(&recipe);
    Ok(ResolvedRecipe {
        recipe,
        digest,
        origin,
    })
}

fn sidecar_path(source: &Path) -> PathBuf {
    let file_name = source.file_name().map_or_else(
        || "source.scope.toml".into(),
        |file_name| format!("{}.scope.toml", file_name.to_string_lossy()),
    );
    source.with_file_name(file_name)
}

fn container_kind(source: &Path) -> Option<ContainerKind> {
    let extension = source.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "h5" | "hdf5" => Some(ContainerKind::Hdf5),
        "mat" => Some(ContainerKind::Mat),
        "parquet" | "pq" => Some(ContainerKind::Parquet),
        _ => None,
    }
}

fn container_matches(expected: &ContainerKind, actual: &ContainerKind) -> bool {
    matches!(
        (expected, actual),
        (ContainerKind::Hdf5, ContainerKind::Hdf5)
            | (ContainerKind::Mat, ContainerKind::Mat | ContainerKind::Hdf5)
            | (ContainerKind::Parquet, ContainerKind::Parquet)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const RECIPE: &str = r#"
id = "flight-h5"
container = "hdf5"
[[selection]]
datasets = "run/*"
name = "keep"
[selection.time]
kind = "index"
dt = 1.0
t0 = 0.0
"#;

    fn preferences(directory: Option<&Path>) -> Preferences {
        Preferences {
            recipe_directory: directory.map(Path::to_string_lossy).map(Into::into),
            ..Preferences::default()
        }
    }

    fn source(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, b"source").unwrap();
        path
    }

    #[test]
    fn a_sidecar_recipe_beside_the_data_wins() {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "foo.h5");
        let sidecar = directory.path().join("foo.h5.scope.toml");
        fs::write(&sidecar, RECIPE.replace("flight-h5", "sidecar-h5")).unwrap();
        let user = tempfile::tempdir().unwrap();
        fs::write(user.path().join("flight.toml"), RECIPE).unwrap();

        let resolved = resolve_for(&source, &preferences(Some(user.path())))
            .unwrap()
            .unwrap();
        assert!(matches!(resolved.origin, RecipeOrigin::Sidecar(_)));
        assert_eq!(resolved.recipe.id, "sidecar-h5");
    }

    #[test]
    fn the_user_directory_is_the_fallback_and_matches_on_container() {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "foo.h5");
        let user = tempfile::tempdir().unwrap();
        fs::write(user.path().join("flight.toml"), RECIPE).unwrap();
        let resolved = resolve_for(&source, &preferences(Some(user.path())))
            .unwrap()
            .unwrap();
        assert!(matches!(resolved.origin, RecipeOrigin::UserDirectory(_)));
    }

    #[test]
    fn no_matching_recipe_is_none_not_an_error() {
        let directory = tempfile::tempdir().unwrap();
        assert!(
            resolve_for(&source(directory.path(), "foo.h5"), &preferences(None))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_malformed_sidecar_recipe_fails_loudly_instead_of_falling_through() {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "foo.h5");
        fs::write(directory.path().join("foo.h5.scope.toml"), "id = ").unwrap();
        assert!(matches!(
            resolve_for(&source, &preferences(None)),
            Err(ResolveError::Parse { .. })
        ));
    }

    #[test]
    fn a_recipe_directory_outside_the_configured_root_is_ignored() {
        let directory = tempfile::tempdir().unwrap();
        let result = resolve_for(
            &source(directory.path(), "foo.h5"),
            &preferences(Some(Path::new("/nonexistent/recipes"))),
        )
        .unwrap();
        assert!(result.is_none());
    }
}

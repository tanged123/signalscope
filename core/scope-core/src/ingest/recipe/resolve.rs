use std::{
    fs,
    path::{Path, PathBuf},
};

use thiserror::Error;

use crate::preferences::Preferences;

use super::{ContainerKind, Recipe, content_digest, parse_recipe};

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
    #[error("recipe {path} is invalid: {message}")]
    Parse { path: PathBuf, message: String },
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
    resolve_for_recipe(source, preferences, None)
}

/// Resolves a recipe, optionally requiring a specific recipe id from the user
/// recipe directory.
///
/// # Errors
///
/// Returns [`ResolveError`] when a candidate recipe cannot be read or parsed.
pub fn resolve_for_recipe(
    source: &Path,
    preferences: &Preferences,
    requested_id: Option<&str>,
) -> Result<Option<ResolvedRecipe>, ResolveError> {
    let Some(container) = container_kind(source) else {
        return Ok(None);
    };
    let sidecar = sidecar_path(source);
    if matches!(
        fs::symlink_metadata(&sidecar),
        Ok(metadata) if metadata.file_type().is_file()
    ) {
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
    let mut user_directory_error = None;
    for path in recipes {
        let recipe = load_recipe(&path, RecipeOrigin::UserDirectory(path.clone()), &container);
        match recipe {
            Ok(recipe)
                if requested_id.is_none_or(|requested_id| recipe.recipe.id == requested_id) =>
            {
                return Ok(Some(recipe));
            }
            Ok(_) | Err(ResolveError::ContainerMismatch { .. }) => {}
            Err(error) => {
                user_directory_error.get_or_insert(error);
            }
        }
    }
    user_directory_error.map_or(Ok(None), Err)
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
    let recipe = parse_recipe(&source).map_err(|error| ResolveError::Parse {
        path: path.to_owned(),
        message: error
            .to_string()
            .lines()
            .next()
            .unwrap_or("invalid recipe")
            .into(),
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
    // MATLAB v7.3 files use HDF5 containers, so HDF5 recipes also match MAT sources.
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
    fn the_requested_user_recipe_id_wins_over_directory_order() {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "foo.h5");
        let user = tempfile::tempdir().unwrap();
        fs::write(
            user.path().join("a.toml"),
            RECIPE.replace("flight-h5", "first"),
        )
        .unwrap();
        fs::write(
            user.path().join("z.toml"),
            RECIPE.replace("flight-h5", "wanted"),
        )
        .unwrap();

        let resolved = resolve_for_recipe(&source, &preferences(Some(user.path())), Some("wanted"))
            .unwrap()
            .unwrap();
        assert_eq!(resolved.recipe.id, "wanted");
    }

    #[test]
    fn malformed_user_recipe_is_skipped_when_a_later_recipe_is_valid() {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "foo.h5");
        let user = tempfile::tempdir().unwrap();
        fs::write(user.path().join("a-malformed.toml"), "id = ").unwrap();
        fs::write(user.path().join("z-valid.toml"), RECIPE).unwrap();

        let resolved = resolve_for(&source, &preferences(Some(user.path())))
            .unwrap()
            .unwrap();
        assert_eq!(resolved.recipe.id, "flight-h5");
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

    #[cfg(unix)]
    #[test]
    fn a_symlinked_sidecar_is_not_resolved() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "foo.h5");
        let target = directory.path().join("recipe.toml");
        fs::write(&target, RECIPE).unwrap();
        symlink(&target, directory.path().join("foo.h5.scope.toml")).unwrap();
        assert!(resolve_for(&source, &preferences(None)).unwrap().is_none());
    }

    #[test]
    fn malformed_recipe_errors_do_not_echo_source_contents() {
        let directory = tempfile::tempdir().unwrap();
        let source = source(directory.path(), "foo.h5");
        let secret = "private-content-that-must-not-be-disclosed";
        fs::write(
            directory.path().join("foo.h5.scope.toml"),
            format!("id = {secret}"),
        )
        .unwrap();
        let error = resolve_for(&source, &preferences(None))
            .unwrap_err()
            .to_string();
        assert!(!error.contains(secret));
        assert!(!error.contains('|'));
    }

    #[test]
    fn a_missing_recipe_directory_resolves_to_none() {
        let directory = tempfile::tempdir().unwrap();
        let result = resolve_for(
            &source(directory.path(), "foo.h5"),
            &preferences(Some(Path::new("/nonexistent/recipes"))),
        )
        .unwrap();
        assert!(result.is_none());
    }
}

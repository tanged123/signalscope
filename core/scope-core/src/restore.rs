//! Source restore validation.

use thiserror::Error;

use crate::{ingest::recipe::resolve::ResolvedRecipe, sources::SourceRecord};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecipeStatus {
    Matched,
    Changed,
    Missing,
}

#[must_use]
pub fn recipe_status(record: &SourceRecord, resolved: Option<&ResolvedRecipe>) -> RecipeStatus {
    match (
        record.recipe_id.as_deref(),
        record.recipe_digest.as_deref(),
        resolved,
    ) {
        (None, None, _) => RecipeStatus::Matched,
        (Some(id), Some(digest), Some(resolved))
            if id == resolved.recipe.id && digest == resolved.digest =>
        {
            RecipeStatus::Matched
        }
        (Some(_), Some(_), None) => RecipeStatus::Missing,
        _ => RecipeStatus::Changed,
    }
}

#[derive(Debug, Error)]
pub enum RecipeRestoreError {
    #[error("recipe changed; reconfirm the recipe before restoring this source")]
    Changed,
    #[error("recipe is missing; relink the recipe before restoring this source")]
    Missing,
}

/// Rejects a source until its recorded recipe has been resolved and compared.
///
/// # Errors
///
/// Returns `RecipeRestoreError::Changed` when the resolved digest differs,
/// or `RecipeRestoreError::Missing` when the recorded recipe cannot be resolved.
pub fn restore_source(
    record: &SourceRecord,
    resolved: Option<&ResolvedRecipe>,
) -> Result<(), RecipeRestoreError> {
    match recipe_status(record, resolved) {
        RecipeStatus::Matched => Ok(()),
        RecipeStatus::Changed => Err(RecipeRestoreError::Changed),
        RecipeStatus::Missing => Err(RecipeRestoreError::Missing),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SourceKey;

    fn record_without_recipe() -> SourceRecord {
        SourceRecord {
            key: SourceKey(uuid::Uuid::from_bytes([7; 16])),
            path: "/data/flight.h5".into(),
            prefix: "flight".into(),
            provider_id: Some("hdf5".into()),
            decode_provenance: None,
            recipe_id: None,
            recipe_digest: None,
        }
    }

    fn record_with_recipe(id: &str, digest: &str) -> SourceRecord {
        SourceRecord {
            recipe_id: Some(id.into()),
            recipe_digest: Some(digest.into()),
            ..record_without_recipe()
        }
    }

    fn resolved(id: &str, digest: &str) -> ResolvedRecipe {
        let source = format!(
            "id = {id:?}\ncontainer = \"hdf5\"\n\n[[selection]]\ndatasets = \"signal\"\nname = \"keep\"\n\n[selection.time]\nkind = \"index\"\ndt = 1.0\nt0 = 0.0\n"
        );
        ResolvedRecipe {
            recipe: crate::ingest::recipe::parse_recipe(&source).unwrap(),
            digest: digest.into(),
            origin: crate::ingest::recipe::resolve::RecipeOrigin::Sidecar(
                "/data/flight.h5.scope.toml".into(),
            ),
        }
    }

    #[test]
    fn a_source_with_no_recorded_recipe_that_now_resolves_one_is_a_first_import() {
        let record = record_without_recipe();
        assert_eq!(
            recipe_status(&record, Some(&resolved("flight-h5", "aaaa"))),
            RecipeStatus::Matched
        );
    }

    #[test]
    fn a_changed_digest_or_id_requires_reconfirmation() {
        let record = record_with_recipe("flight-h5", "aaaa");
        assert_eq!(
            recipe_status(&record, Some(&resolved("flight-h5", "bbbb"))),
            RecipeStatus::Changed
        );
        assert_eq!(
            recipe_status(&record, Some(&resolved("other-h5", "aaaa"))),
            RecipeStatus::Changed
        );
        assert!(
            restore_source(&record, Some(&resolved("flight-h5", "bbbb")))
                .unwrap_err()
                .to_string()
                .contains("reconfirm")
        );
    }

    #[test]
    fn a_missing_recipe_requires_a_relink() {
        let record = record_with_recipe("flight-h5", "aaaa");
        assert_eq!(recipe_status(&record, None), RecipeStatus::Missing);
        assert!(
            restore_source(&record, None)
                .unwrap_err()
                .to_string()
                .contains("relink")
        );
    }

    #[test]
    fn a_matching_recipe_restores_cleanly() {
        let record = record_with_recipe("flight-h5", "aaaa");
        assert_eq!(
            recipe_status(&record, Some(&resolved("flight-h5", "aaaa"))),
            RecipeStatus::Matched
        );
        assert!(restore_source(&record, Some(&resolved("flight-h5", "aaaa"))).is_ok());
    }
}

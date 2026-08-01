use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;

use crate::{expr, store::SourceKey};

#[derive(Clone, Debug, PartialEq)]
pub struct MemberExpansion {
    pub source_key: SourceKey,
    pub prefix: String,
    pub expr: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SkippedMember {
    pub prefix: String,
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BundleExpansion {
    pub members: Vec<MemberExpansion>,
    pub skipped: Vec<SkippedMember>,
    pub bundle_refs: Vec<String>,
}

#[derive(Clone, Debug, Error, PartialEq)]
pub enum DerivedBundleError {
    #[error("invalid expression: {0}")]
    InvalidExpression(#[from] expr::ExprError),
    #[error("expression references no bundle local path")]
    NoBundleReferences,
    #[error("no source contains every bundle reference")]
    NoEligibleSources,
}

/// Expands an expression containing bundle-local paths across eligible sources.
///
/// # Errors
///
/// Returns [`DerivedBundleError`] when the expression is invalid or no source
/// can satisfy its bundle-local references.
pub fn expand(
    source: &str,
    full_paths: &BTreeSet<String>,
    locals_by_source: &BTreeMap<SourceKey, (String, BTreeSet<String>)>,
) -> Result<BundleExpansion, DerivedBundleError> {
    let parsed = expr::parse(source)?;
    let references = expr::references(&parsed);
    let local_paths: BTreeSet<String> = locals_by_source
        .values()
        .flat_map(|(_, paths)| paths.iter().cloned())
        .collect();
    let bundle_refs: Vec<String> = references
        .iter()
        .filter(|path| !full_paths.contains(*path) && local_paths.contains(*path))
        .cloned()
        .collect();
    if bundle_refs.is_empty() {
        return Err(DerivedBundleError::NoBundleReferences);
    }

    let mut members = Vec::new();
    let mut skipped = Vec::new();
    for (source_key, (prefix, locals)) in locals_by_source {
        let missing: Vec<String> = bundle_refs
            .iter()
            .filter(|path| !locals.contains(*path))
            .cloned()
            .collect();
        if !missing.is_empty() {
            skipped.push(SkippedMember {
                prefix: prefix.clone(),
                missing,
            });
            continue;
        }
        let replacements = bundle_refs
            .iter()
            .map(|path| (path.clone(), format!("{prefix}/{path}")))
            .collect();
        members.push(MemberExpansion {
            source_key: *source_key,
            prefix: prefix.clone(),
            expr: expr::rename_references(source, &replacements)?,
        });
    }
    members.sort_by(|left, right| left.prefix.cmp(&right.prefix));
    skipped.sort_by(|left, right| left.prefix.cmp(&right.prefix));
    if members.is_empty() {
        return Err(DerivedBundleError::NoEligibleSources);
    }
    Ok(BundleExpansion {
        members,
        skipped,
        bundle_refs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn key(value: u128) -> SourceKey {
        SourceKey(Uuid::from_u128(value))
    }

    fn locals(
        entries: &[(u128, &str, &[&str])],
    ) -> BTreeMap<SourceKey, (String, BTreeSet<String>)> {
        entries
            .iter()
            .map(|(id, prefix, paths)| {
                (
                    key(*id),
                    (
                        (*prefix).into(),
                        paths.iter().map(|path| (*path).into()).collect(),
                    ),
                )
            })
            .collect()
    }

    #[test]
    fn full_paths_take_precedence_over_bundle_locals() {
        let result = expand(
            "'temp' + 'run_01/temp'",
            &BTreeSet::from(["run_01/temp".into()]),
            &locals(&[(1, "run_01", &["temp"]), (2, "run_02", &["temp"])]),
        )
        .expect("bundle expansion");
        assert_eq!(result.bundle_refs, vec!["temp"]);
        assert_eq!(result.members[0].expr, "'run_01/temp' + 'run_01/temp'");
        assert_eq!(result.members[1].expr, "'run_02/temp' + 'run_01/temp'");
    }

    #[test]
    fn skips_sources_missing_a_bundle_reference() {
        let result = expand(
            "'temp' + 'alt'",
            &BTreeSet::new(),
            &locals(&[
                (1, "run_01", &["temp", "alt"]),
                (2, "run_02", &["temp", "alt"]),
                (3, "run_03", &["temp"]),
            ]),
        )
        .expect("bundle expansion");
        assert_eq!(result.members.len(), 2);
        assert_eq!(
            result.skipped,
            vec![SkippedMember {
                prefix: "run_03".into(),
                missing: vec!["alt".into()],
            }]
        );
    }

    #[test]
    fn orders_members_by_prefix() {
        let result = expand(
            "'temp'",
            &BTreeSet::new(),
            &locals(&[(2, "run_02", &["temp"]), (1, "run_01", &["temp"])]),
        )
        .expect("bundle expansion");
        assert_eq!(
            result
                .members
                .iter()
                .map(|member| member.prefix.as_str())
                .collect::<Vec<_>>(),
            ["run_01", "run_02"]
        );
    }

    #[test]
    fn rejects_expressions_without_bundle_references() {
        let error = expand(
            "'run_01/temp'",
            &BTreeSet::from(["run_01/temp".into()]),
            &locals(&[(1, "run_01", &["temp"])]),
        )
        .expect_err("ordinary signal expression");
        assert_eq!(error, DerivedBundleError::NoBundleReferences);
    }

    #[test]
    fn rejects_when_no_source_has_every_bundle_reference() {
        let error = expand(
            "'temp' + 'alt'",
            &BTreeSet::new(),
            &locals(&[(1, "run_01", &["temp"]), (2, "run_02", &["alt"])]),
        )
        .expect_err("no eligible source");
        assert_eq!(error, DerivedBundleError::NoEligibleSources);
    }
}

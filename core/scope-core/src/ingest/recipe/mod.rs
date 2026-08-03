use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as DeError};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub mod decode;
pub mod resolve;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerKind {
    Hdf5,
    Mat,
    Parquet,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Recipe {
    pub id: String,
    pub container: ContainerKind,
    #[serde(rename = "selection")]
    pub selections: Vec<Selection>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub datasets: String,
    pub time: TimeSource,
    pub name: NameRule,
    pub unit: Option<String>,
    pub unit_attribute: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TimeSource {
    Dataset(DatasetTime),
    Sibling(SiblingTime),
    Index(IndexTime),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetTime {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SiblingTime {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IndexTime {
    pub dt: f64,
    pub t0: f64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NameRule {
    Keep,
    Strip(String),
    Replace { from: String, to: String },
    Template(String),
}

impl Serialize for NameRule {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = match self {
            Self::Keep => "keep".to_owned(),
            Self::Strip(prefix) => format!("strip:{prefix}"),
            Self::Replace { from, to } => format!("replace:{from}=>{to}"),
            Self::Template(template) => format!("template:{template}"),
        };
        serializer.serialize_str(&value)
    }
}

impl<'de> Deserialize<'de> for NameRule {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == "keep" {
            return Ok(Self::Keep);
        }
        if let Some(prefix) = value.strip_prefix("strip:") {
            return Ok(Self::Strip(prefix.to_owned()));
        }
        if let Some(replacement) = value.strip_prefix("replace:") {
            let Some((from, to)) = replacement.split_once("=>") else {
                return Err(D::Error::custom("replace name rule needs from=>to"));
            };
            return Ok(Self::Replace {
                from: from.into(),
                to: to.into(),
            });
        }
        if let Some(template) = value.strip_prefix("template:") {
            return Ok(Self::Template(template.to_owned()));
        }
        Err(D::Error::custom("unknown name rule"))
    }
}

#[derive(Debug, Error)]
pub enum RecipeError {
    #[error("recipe contains an unknown field: {0}")]
    UnknownField(String),
    #[error("recipe contains an unknown container: {0}")]
    UnknownContainer(String),
    #[error("invalid recipe selector: {0}")]
    InvalidSelector(String),
    #[error("invalid recipe: {0}")]
    Invalid(String),
    #[error("recipe parse failed: {0}")]
    Parse(String),
    #[error("container read failed: {0}")]
    Container(String),
    #[error("dataset {dataset} has length {values}, but time has length {time}")]
    LengthMismatch {
        dataset: String,
        values: usize,
        time: usize,
    },
    #[error("recipe produced duplicate signal name: {0}")]
    DuplicateName(String),
    #[error("recipe selection matched no numeric datasets: {0}")]
    NoMatches(String),
    #[error("time dataset is missing: {0}")]
    MissingTime(String),
}

/// Parses and validates a declarative container recipe.
///
/// # Errors
///
/// Returns [`RecipeError`] when TOML parsing or recipe validation fails.
pub fn parse_recipe(source: &str) -> Result<Recipe, RecipeError> {
    let recipe = toml::from_str::<Recipe>(source).map_err(|error| {
        let message = error.to_string();
        if message.contains("unknown field") {
            RecipeError::UnknownField(message)
        } else if message.contains("unknown variant") && message.contains("container") {
            RecipeError::UnknownContainer(message)
        } else {
            RecipeError::Parse(message)
        }
    })?;
    validate(&recipe)?;
    Ok(recipe)
}

/// Computes a stable digest of the normalized recipe model.
///
/// # Panics
///
/// Panics only if serialization of the closed, derived recipe model fails.
#[must_use]
pub fn content_digest(recipe: &Recipe) -> String {
    let normalized = serde_json::to_vec(recipe).expect("recipe serialization is infallible");
    let mut hasher = Sha256::new();
    field(&mut hasher, b"scope-recipe-1");
    field(&mut hasher, &normalized);
    format!("{:x}", hasher.finalize())
}

fn field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn validate(recipe: &Recipe) -> Result<(), RecipeError> {
    if recipe.id.trim().is_empty()
        || recipe.id.contains('\0')
        || recipe.id.contains('/')
        || recipe.id.contains('\\')
        || recipe.id == "."
        || recipe.id == ".."
    {
        return Err(RecipeError::Invalid(
            "id must be a non-empty file-safe name without NUL or path separators".into(),
        ));
    }
    if recipe.selections.is_empty() {
        return Err(RecipeError::Invalid(
            "at least one selection is required".into(),
        ));
    }
    for selection in &recipe.selections {
        validate_selector(&selection.datasets)?;
        if let Some(unit) = &selection.unit {
            if unit.contains('\0') {
                return Err(RecipeError::Invalid("unit contains NUL".into()));
            }
        }
        if let Some(attribute) = &selection.unit_attribute {
            if attribute.contains('\0') {
                return Err(RecipeError::Invalid("unit attribute contains NUL".into()));
            }
        }
        match &selection.time {
            TimeSource::Dataset(dataset) => validate_selector(&dataset.path)?,
            TimeSource::Sibling(sibling) => validate_selector(&sibling.name)?,
            TimeSource::Index(index) => {
                if !index.dt.is_finite() || index.dt <= 0.0 || !index.t0.is_finite() {
                    return Err(RecipeError::Invalid(
                        "index time requires finite dt > 0 and finite t0".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_selector(value: &str) -> Result<(), RecipeError> {
    let path = std::path::Path::new(value);
    if value.is_empty()
        || value.contains('\0')
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(RecipeError::InvalidSelector(value.into()));
    }
    Ok(())
}

impl fmt::Display for NameRule {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Keep => formatter.write_str("keep"),
            Self::Strip(prefix) => write!(formatter, "strip:{prefix}"),
            Self::Replace { from, to } => write!(formatter, "replace:{from}=>{to}"),
            Self::Template(template) => write!(formatter, "template:{template}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
id = "flight-h5"
container = "hdf5"

[[selection]]
datasets = "run/*/telemetry/*"
name = "strip:run/"
unit_attribute = "units"

[selection.time]
kind = "dataset"
path = "run/time"

[[selection]]
datasets = "sweep/**"
name = "keep"

[selection.time]
kind = "index"
dt = 0.01
t0 = 0.0
"#;

    #[test]
    fn a_recipe_parses_selections_time_sources_and_naming() {
        let recipe = parse_recipe(SAMPLE).unwrap();
        assert_eq!(recipe.id, "flight-h5");
        assert_eq!(recipe.selections.len(), 2);
        assert!(matches!(
            &recipe.selections[0].time,
            TimeSource::Dataset(dataset) if dataset.path == "run/time"
        ));
        assert!(matches!(
            &recipe.selections[1].time,
            TimeSource::Index(index) if (index.dt - 0.01).abs() < 1e-12
        ));
        assert_eq!(
            recipe.selections[0].unit_attribute.as_deref(),
            Some("units")
        );
    }

    #[test]
    fn a_recipe_can_never_name_executable_code_at_any_nesting_level() {
        const HOSTILE_KEYS: [&str; 4] = ["command", "plugin", "decoder", "exec"];
        const SITES: [(&str, &str); 5] = [
            ("top level", "id=\"x\"\ncontainer=\"hdf5\"\n{hostile}\n"),
            (
                "selection",
                "id=\"x\"\ncontainer=\"hdf5\"\n[[selection]]\ndatasets=\"a\"\nname=\"keep\"\n{hostile}\n[selection.time]\nkind=\"index\"\ndt=1.0\nt0=0.0\n",
            ),
            (
                "index time",
                "id=\"x\"\ncontainer=\"hdf5\"\n[[selection]]\ndatasets=\"a\"\nname=\"keep\"\n[selection.time]\nkind=\"index\"\ndt=1.0\nt0=0.0\n{hostile}\n",
            ),
            (
                "dataset time",
                "id=\"x\"\ncontainer=\"hdf5\"\n[[selection]]\ndatasets=\"a\"\nname=\"keep\"\n[selection.time]\nkind=\"dataset\"\npath=\"t\"\n{hostile}\n",
            ),
            (
                "sibling time",
                "id=\"x\"\ncontainer=\"hdf5\"\n[[selection]]\ndatasets=\"a\"\nname=\"keep\"\n[selection.time]\nkind=\"sibling\"\nname=\"t\"\n{hostile}\n",
            ),
        ];

        for (label, template) in SITES {
            for key in HOSTILE_KEYS {
                let hostile = format!("{key} = \"/usr/bin/python\"");
                let recipe = template.replace("{hostile}", &hostile);
                let error = parse_recipe(&recipe)
                    .err()
                    .unwrap_or_else(|| panic!("hostile key `{key}` accepted at {label}"));
                assert!(
                    matches!(error, RecipeError::UnknownField(_)),
                    "hostile key `{key}` at {label} produced {error:?}, not UnknownField"
                );
            }
        }
    }

    #[test]
    fn selectors_cannot_escape_the_container() {
        let recipe = r#"id="x"
container="hdf5"

[[selection]]
datasets = "../../etc/passwd"
name = "keep"

[selection.time]
kind = "index"
dt = 1.0
t0 = 0.0"#;
        assert!(matches!(
            parse_recipe(recipe),
            Err(RecipeError::InvalidSelector(_))
        ));
    }

    #[test]
    fn recipe_ids_cannot_escape_the_user_recipe_directory() {
        for id in ["../outside", "nested/name", "\\\\outside"] {
            let source = format!(
                "id = {id:?}\ncontainer = \"hdf5\"\n\n[[selection]]\ndatasets = \"run/*\"\nname = \"keep\"\n\n[selection.time]\nkind = \"index\"\ndt = 1.0\nt0 = 0.0"
            );
            assert!(matches!(
                parse_recipe(&source),
                Err(RecipeError::Invalid(_))
            ));
        }
    }

    #[test]
    fn the_digest_is_content_addressed_and_whitespace_sensitive_only_where_it_matters() {
        let recipe = parse_recipe(SAMPLE).unwrap();
        assert_eq!(
            content_digest(&recipe),
            content_digest(&parse_recipe(SAMPLE).unwrap())
        );
        let mut changed = recipe.clone();
        changed.selections[0].unit = Some("V".into());
        assert_ne!(content_digest(&recipe), content_digest(&changed));
    }
}

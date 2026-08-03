use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
};

use crate::{
    columns::Column,
    ingest::{
        DecodeContext, DecodedSignal, DecodedSource, Decoder, IngestError, apply_permutation,
        sort_permutation,
    },
    naming::normalize_segment,
};

use super::{ContainerKind, NameRule, Recipe, RecipeError, Selection, TimeSource};
use crate::ingest::container::{ContainerError, ContainerReader, DatasetKind};

#[derive(Clone)]
pub struct RecipeDecoder {
    recipe: Recipe,
}

impl RecipeDecoder {
    #[must_use]
    pub fn new(recipe: Recipe) -> Self {
        Self { recipe }
    }
}

impl Decoder for RecipeDecoder {
    fn decode(
        &self,
        path: &Path,
        context: &mut DecodeContext<'_>,
    ) -> Result<DecodedSource, IngestError> {
        match self.recipe.container {
            ContainerKind::Hdf5 | ContainerKind::Mat => {
                let container = crate::ingest::container::hdf5::Hdf5Container::open(path)
                    .map_err(|error| container_error(&error))?;
                decode_with(&container, &self.recipe, context)
            }
            ContainerKind::Parquet => {
                let container = crate::ingest::container::parquet::ParquetContainer::open(path)
                    .map_err(|error| container_error(&error))?;
                decode_with(&container, &self.recipe, context)
            }
        }
    }
}

#[must_use]
pub fn provider(
    recipe: Recipe,
    digest: impl Into<String>,
) -> super::super::registry::FormatProvider {
    let digest = digest.into();
    let provider_id = format!("recipe:{}", recipe.id);
    let (label, extensions) = match &recipe.container {
        ContainerKind::Hdf5 => (format!("Recipe: {}", recipe.id), vec!["h5", "hdf5", "mat"]),
        ContainerKind::Mat => (format!("Recipe: {}", recipe.id), vec!["mat"]),
        ContainerKind::Parquet => (format!("Recipe: {}", recipe.id), vec!["parquet", "pq"]),
    };
    let sniff_container = recipe.container.clone();
    let cache_abi = u32::from_str_radix(&digest[..8.min(digest.len())], 16).unwrap_or(1);
    let decoder_recipe = recipe;
    super::super::registry::FormatProvider::new(
        provider_id,
        label,
        &extensions,
        10,
        cache_abi,
        move |probe| match &sniff_container {
            ContainerKind::Hdf5 | ContainerKind::Mat => {
                if crate::ingest::container::hdf5::is_hdf5_magic(probe) {
                    super::super::registry::Confidence::Certain
                } else {
                    super::super::registry::Confidence::No
                }
            }
            ContainerKind::Parquet => {
                if crate::ingest::container::parquet::is_parquet_magic(probe) {
                    super::super::registry::Confidence::Certain
                } else {
                    super::super::registry::Confidence::No
                }
            }
        },
        move || Box::new(RecipeDecoder::new(decoder_recipe.clone())),
    )
}

/// Decodes selected numeric datasets and aligns them to validated timebases.
///
/// # Errors
///
/// Returns an [`IngestError`] when a selection, timebase, name, or container
/// read is invalid, or when cancellation is requested.
pub fn decode_with<R: ContainerReader + ?Sized>(
    container: &R,
    recipe: &Recipe,
    context: &mut DecodeContext<'_>,
) -> Result<DecodedSource, IngestError> {
    let mut timebases = HashMap::<String, Timebase>::new();
    let mut names = HashSet::new();
    let mut signals = Vec::new();

    for selection in &recipe.selections {
        let matches = container
            .datasets()
            .iter()
            .filter(|entry| entry.kind == DatasetKind::Numeric)
            .filter(|entry| glob_matches(&selection.datasets, &entry.path))
            .collect::<Vec<_>>();
        if matches.is_empty() {
            return Err(RecipeError::NoMatches(selection.datasets.clone()).into());
        }
        for entry in matches {
            context.check()?;
            let values = container
                .read_f64(&entry.path)
                .map_err(|error| container_error(&error))?;
            let key = timebase_key(selection, &entry.path, values.len());
            let timebase = if let Some(timebase) = timebases.get(&key) {
                timebase.clone()
            } else {
                let values = read_time(selection, &entry.path, values.len(), container)?;
                let timebase = make_timebase(&values, &key)?;
                timebases.insert(key, timebase.clone());
                timebase
            };
            if values.len() != timebase.values.len() {
                return Err(RecipeError::LengthMismatch {
                    dataset: entry.path.clone(),
                    values: values.len(),
                    time: timebase.values.len(),
                }
                .into());
            }
            let values = timebase
                .order
                .as_deref()
                .map_or(values.clone(), |order| apply_permutation(order, &values));
            let name = signal_name(&selection.name, &entry.path, signals.len());
            if !names.insert(name.clone()) {
                return Err(RecipeError::DuplicateName(name).into());
            }
            let unit = selection.unit.clone().or_else(|| {
                selection
                    .unit_attribute
                    .as_deref()
                    .and_then(|attribute| container.attribute(&entry.path, attribute))
            });
            signals.push(DecodedSignal {
                local_path: name,
                unit,
                time: Column::from(Arc::clone(&timebase.values)),
                values: values.into(),
            });
        }
    }
    if signals.is_empty() {
        return Err(IngestError::NoDataRows);
    }
    let row_count = signals[0].values.len();
    if row_count == 0 {
        return Err(IngestError::NoDataRows);
    }
    Ok(DecodedSource { row_count, signals })
}

#[derive(Clone)]
struct Timebase {
    values: Arc<[f64]>,
    order: Option<Vec<usize>>,
}

fn make_timebase(values: &[f64], label: &str) -> Result<Timebase, IngestError> {
    if values.iter().any(|value| !value.is_finite()) {
        return Err(
            RecipeError::Invalid(format!("timebase {label} contains non-finite values")).into(),
        );
    }
    let order = sort_permutation(values);
    let values = order
        .as_deref()
        .map_or_else(|| values.to_vec(), |order| apply_permutation(order, values));
    Ok(Timebase {
        values: values.into(),
        order,
    })
}

#[allow(clippy::cast_precision_loss)]
fn read_time<R: ContainerReader + ?Sized>(
    selection: &Selection,
    dataset: &str,
    length: usize,
    container: &R,
) -> Result<Vec<f64>, IngestError> {
    match &selection.time {
        TimeSource::Dataset(dataset_time) => container
            .read_f64(&dataset_time.path)
            .map_err(|error| match error {
            ContainerError::NoSuchDataset(_) => {
                RecipeError::MissingTime(dataset_time.path.clone()).into()
            }
            other => container_error(&other),
        }),
        TimeSource::Sibling(sibling_time) => {
            let group = dataset.rsplit_once('/').map_or("", |(group, _)| group);
            let path = if group.is_empty() {
                sibling_time.name.clone()
            } else {
                format!("{group}/{}", sibling_time.name)
            };
            container.read_f64(&path).map_err(|error| match error {
                ContainerError::NoSuchDataset(_) => RecipeError::MissingTime(path).into(),
                other => container_error(&other),
            })
        }
        TimeSource::Index(index_time) => {
            Ok((0..length)
                .map(|index| index_time.t0 + index as f64 * index_time.dt)
                .collect())
        }
    }
}

fn timebase_key(selection: &Selection, dataset: &str, length: usize) -> String {
    match &selection.time {
        TimeSource::Dataset(dataset_time) => format!("dataset:{}", dataset_time.path),
        TimeSource::Sibling(sibling_time) => {
            let group = dataset.rsplit_once('/').map_or("", |(group, _)| group);
            format!("sibling:{group}/{}", sibling_time.name)
        }
        TimeSource::Index(index_time) => {
            format!("index:{:?}:{:?}:{length}", index_time.dt, index_time.t0)
        }
    }
}

fn signal_name(rule: &NameRule, dataset: &str, index: usize) -> String {
    let leaf = dataset.rsplit_once('/').map_or(dataset, |(_, leaf)| leaf);
    let raw = match rule {
        NameRule::Keep => dataset.to_owned(),
        NameRule::Strip(prefix) => dataset.strip_prefix(prefix).unwrap_or(dataset).to_owned(),
        NameRule::Replace { from, to } => dataset.replace(from, to),
        NameRule::Template(template) => template
            .replace("{dataset}", dataset)
            .replace("{leaf}", leaf)
            .replace("{index}", &index.to_string()),
    };
    raw.split('/')
        .map(normalize_segment)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.split('/').collect::<Vec<_>>();
    let path = path.split('/').collect::<Vec<_>>();
    let mut pending = vec![(0_usize, 0_usize)];
    let mut seen = HashSet::new();
    while let Some((pattern_index, path_index)) = pending.pop() {
        if !seen.insert((pattern_index, path_index)) {
            continue;
        }
        if pattern_index == pattern.len() {
            if path_index == path.len() {
                return true;
            }
            continue;
        }
        if pattern[pattern_index] == "**" {
            pending.push((pattern_index + 1, path_index));
            if path_index < path.len() {
                pending.push((pattern_index, path_index + 1));
            }
        } else if path_index < path.len()
            && (pattern[pattern_index] == "*" || pattern[pattern_index] == path[path_index])
        {
            pending.push((pattern_index + 1, path_index + 1));
        }
    }
    false
}

fn container_error(error: &ContainerError) -> IngestError {
    RecipeError::Container(error.to_string()).into()
}

#[cfg(test)]
mod tests {
    use crate::ingest::container::{ContainerError, DatasetEntry, DatasetPath};

    use super::*;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct FakeContainer {
        entries: Vec<DatasetEntry>,
        columns: BTreeMap<String, Vec<f64>>,
    }

    impl ContainerReader for FakeContainer {
        fn open(_: &Path) -> Result<Self, ContainerError> {
            Ok(Self::default())
        }

        fn datasets(&self) -> &[DatasetEntry] {
            &self.entries
        }

        fn read_f64(&self, path: &DatasetPath) -> Result<Vec<f64>, ContainerError> {
            self.columns
                .get(path)
                .cloned()
                .ok_or_else(|| ContainerError::NoSuchDataset(path.to_owned()))
        }

        fn attribute(&self, _: &DatasetPath, _: &str) -> Option<String> {
            None
        }
    }

    fn fake_container(columns: &[(&str, Vec<f64>)]) -> FakeContainer {
        let mut container = FakeContainer::default();
        for (path, values) in columns {
            container.entries.push(DatasetEntry {
                path: (*path).into(),
                kind: DatasetKind::Numeric,
                len: values.len(),
                shape: vec![values.len()],
            });
            container.columns.insert((*path).into(), values.clone());
        }
        container
            .entries
            .sort_by(|left, right| left.path.cmp(&right.path));
        container
    }

    fn context() -> DecodeContext<'static> {
        let progress: &'static mut dyn FnMut(f64) = Box::leak(Box::new(|_| {}));
        let cancel = Box::leak(Box::new(crate::ingest::CancelToken::default()));
        DecodeContext { progress, cancel }
    }

    fn recipe(source: &str) -> Recipe {
        super::super::parse_recipe(source).unwrap()
    }

    const SHARED_TIME: &str = r#"
id = "shared"
container = "hdf5"
[[selection]]
datasets = "run/telemetry/*"
name = "strip:run/"
[selection.time]
kind = "dataset"
path = "run/time"
"#;

    const INDEX_TIME: &str = r#"
id = "index"
container = "hdf5"
[[selection]]
datasets = "sweep/*"
name = "keep"
[selection.time]
kind = "index"
dt = 0.01
t0 = 5.0
"#;

    const SIBLING_TIME: &str = r#"
id = "sibling"
container = "hdf5"
[[selection]]
datasets = "*/v"
name = "keep"
[selection.time]
kind = "sibling"
name = "t"
"#;

    #[test]
    fn a_shared_time_dataset_serves_every_selected_signal() {
        let container = fake_container(&[
            ("run/time", vec![0.0, 1.0, 2.0]),
            ("run/telemetry/ax", vec![1.0, 2.0, 3.0]),
            ("run/telemetry/ay", vec![4.0, 5.0, 6.0]),
        ]);
        let decoded = decode_with(&container, &recipe(SHARED_TIME), &mut context()).unwrap();
        assert_eq!(decoded.row_count, 3);
        assert_eq!(decoded.signals.len(), 2);
        assert_eq!(decoded.signals[0].local_path, "telemetry/ax");
        assert!(
            decoded.signals[0]
                .time
                .same_values(&decoded.signals[1].time)
        );
    }

    #[test]
    fn a_synthesized_index_timebase_uses_dt_and_t0() {
        let container = fake_container(&[("sweep/v", vec![9.0, 8.0])]);
        let decoded = decode_with(&container, &recipe(INDEX_TIME), &mut context()).unwrap();
        assert_eq!(decoded.signals[0].time.as_slice().as_ref(), &[5.0, 5.01]);
    }

    #[test]
    fn a_sibling_time_column_is_resolved_per_group() {
        let container = fake_container(&[
            ("a/t", vec![0.0, 1.0]),
            ("a/v", vec![1.0, 2.0]),
            ("b/t", vec![0.0, 2.0]),
            ("b/v", vec![3.0, 4.0]),
        ]);
        let decoded = decode_with(&container, &recipe(SIBLING_TIME), &mut context()).unwrap();
        assert_eq!(decoded.signals.len(), 2);
        assert_eq!(decoded.signals[1].time.as_slice().as_ref(), &[0.0, 2.0]);
    }

    #[test]
    fn an_unsorted_or_non_finite_time_dataset_is_rejected_like_csv() {
        let container = fake_container(&[
            ("run/time", vec![1.0, 0.0]),
            ("run/telemetry/ax", vec![1.0, 2.0]),
        ]);
        let decoded = decode_with(&container, &recipe(SHARED_TIME), &mut context()).unwrap();
        assert_eq!(decoded.signals[0].time.as_slice().as_ref(), &[0.0, 1.0]);
        assert_eq!(decoded.signals[0].values.as_slice().as_ref(), &[2.0, 1.0]);

        let bad = fake_container(&[
            ("run/time", vec![f64::NAN, 1.0]),
            ("run/telemetry/ax", vec![1.0, 2.0]),
        ]);
        assert!(decode_with(&bad, &recipe(SHARED_TIME), &mut context()).is_err());
    }

    #[test]
    fn a_length_mismatch_between_time_and_values_is_an_error() {
        let container = fake_container(&[
            ("run/time", vec![0.0, 1.0]),
            ("run/telemetry/ax", vec![1.0]),
        ]);
        assert!(matches!(
            decode_with(&container, &recipe(SHARED_TIME), &mut context()),
            Err(IngestError::Recipe(RecipeError::LengthMismatch { .. }))
        ));
    }

    #[test]
    fn hostile_dataset_names_are_normalized_and_never_collide_silently() {
        let container = fake_container(&[
            ("run/time", vec![0.0]),
            ("run/telemetry/A B", vec![1.0]),
            ("run/telemetry/a_b", vec![2.0]),
        ]);
        let error = decode_with(&container, &recipe(SHARED_TIME), &mut context()).unwrap_err();
        assert!(matches!(
            error,
            IngestError::Recipe(RecipeError::DuplicateName(_))
        ));
    }
}

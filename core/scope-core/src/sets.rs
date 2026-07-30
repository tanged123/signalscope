//! Source grouping and aligned time-domain metadata.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};

use uuid::Uuid;

use crate::store::SourceKey;

const MIN_SCHEMA_OVERLAP: f64 = 0.8;
const SET_NAMESPACE: Uuid = Uuid::from_bytes([
    0x0d, 0x69, 0x99, 0xb8, 0xc1, 0xf7, 0x4d, 0xd8, 0xb8, 0x1f, 0x0a, 0xb4, 0xf3, 0x1e, 0x82, 0xb2,
]);
static EMPTY_PATHS: LazyLock<BTreeSet<String>> = LazyLock::new(BTreeSet::new);

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SetKey(pub Uuid);

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct SetId(pub u64);

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SchemaFingerprint {
    pub local_paths: BTreeSet<String>,
}

impl SchemaFingerprint {
    #[must_use]
    pub fn digest(&self) -> Uuid {
        let mut bytes = Vec::new();
        for path in &self.local_paths {
            bytes.extend_from_slice(&(path.len() as u64).to_le_bytes());
            bytes.extend_from_slice(path.as_bytes());
        }
        Uuid::new_v5(&SET_NAMESPACE, &bytes)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AffineTransform {
    pub scale: f64,
    pub offset: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SetMember {
    pub source_key: SourceKey,
    pub local_paths: BTreeSet<String>,
    pub missing: BTreeSet<String>,
    pub transform: Option<AffineTransform>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SourceSet {
    pub key: SetKey,
    pub id: SetId,
    pub fingerprint: SchemaFingerprint,
    pub members: BTreeMap<SourceKey, SetMember>,
    pub generation: u64,
}

impl SourceSet {
    pub fn bump_generation(&mut self) {
        self.generation = self.generation.saturating_add(1);
    }

    pub fn add_member(&mut self, source_key: SourceKey, local_paths: BTreeSet<String>) {
        self.members.insert(
            source_key,
            SetMember {
                source_key,
                local_paths,
                missing: BTreeSet::new(),
                transform: Some(AffineTransform {
                    scale: 1.0,
                    offset: 0.0,
                }),
            },
        );
        self.recompute_schema();
        self.bump_generation();
    }

    pub fn remove_member(&mut self, source_key: SourceKey) {
        if self.members.remove(&source_key).is_some() {
            self.recompute_schema();
            self.bump_generation();
        }
    }

    pub fn set_transform(&mut self, source_key: SourceKey, transform: AffineTransform) {
        if let Some(member) = self.members.get_mut(&source_key) {
            member.transform = Some(transform);
            self.bump_generation();
        }
    }

    #[must_use]
    pub fn missing_for(&self, source_key: SourceKey) -> &BTreeSet<String> {
        self.members
            .get(&source_key)
            .map_or(&EMPTY_PATHS, |member| &member.missing)
    }

    fn recompute_schema(&mut self) {
        self.fingerprint.local_paths = self
            .members
            .values()
            .flat_map(|member| member.local_paths.iter().cloned())
            .collect();
        for member in self.members.values_mut() {
            member.missing = self
                .fingerprint
                .local_paths
                .difference(&member.local_paths)
                .cloned()
                .collect();
        }
    }
}

#[must_use]
pub fn propose_sets(candidates: &[(SourceKey, Vec<String>)]) -> Vec<SourceSet> {
    let schemas = candidates
        .iter()
        .map(|(_, paths)| paths.iter().cloned().collect::<BTreeSet<_>>())
        .collect::<Vec<_>>();
    let mut parents = (0..candidates.len()).collect::<Vec<_>>();
    for left in 0..schemas.len() {
        for right in left + 1..schemas.len() {
            if schema_overlap(&schemas[left], &schemas[right]) >= MIN_SCHEMA_OVERLAP {
                union(&mut parents, left, right);
            }
        }
    }

    let mut groups = BTreeMap::<usize, Vec<usize>>::new();
    for index in 0..candidates.len() {
        let root = find(&mut parents, index);
        groups.entry(root).or_default().push(index);
    }

    groups
        .into_values()
        .enumerate()
        .map(|(set_index, indices)| {
            let paths = indices
                .iter()
                .flat_map(|index| schemas[*index].iter().cloned())
                .collect();
            let fingerprint = SchemaFingerprint { local_paths: paths };
            let members = indices
                .into_iter()
                .map(|index| {
                    let source_key = candidates[index].0;
                    let local_paths = schemas[index].clone();
                    let missing = fingerprint
                        .local_paths
                        .difference(&local_paths)
                        .cloned()
                        .collect();
                    (
                        source_key,
                        SetMember {
                            source_key,
                            local_paths,
                            missing,
                            transform: Some(AffineTransform {
                                scale: 1.0,
                                offset: 0.0,
                            }),
                        },
                    )
                })
                .collect();
            SourceSet {
                key: SetKey(fingerprint.digest()),
                id: SetId(set_index as u64 + 1),
                fingerprint,
                members,
                generation: 1,
            }
        })
        .collect()
}

fn schema_overlap(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f64 {
    let smaller = left.len().min(right.len());
    if smaller == 0 {
        return f64::from(left.is_empty() && right.is_empty());
    }
    left.intersection(right).count() as f64 / smaller as f64
}

fn find(parents: &mut [usize], index: usize) -> usize {
    if parents[index] != index {
        parents[index] = find(parents, parents[index]);
    }
    parents[index]
}

fn union(parents: &mut [usize], left: usize, right: usize) {
    let left = find(parents, left);
    let right = find(parents, right);
    parents[right] = left;
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::store::SourceKey;

    fn key(byte: u8) -> SourceKey {
        SourceKey(uuid::Uuid::from_bytes([byte; 16]))
    }

    #[test]
    fn a_run_with_a_dead_sensor_is_a_partial_member_not_a_separate_set() {
        let full = vec![
            "imu/ax".to_owned(),
            "imu/ay".to_owned(),
            "imu/az".to_owned(),
        ];
        let partial = vec!["imu/ax".to_owned(), "imu/az".to_owned()];
        let proposed = propose_sets(&[(key(1), full.clone()), (key(2), partial), (key(3), full)]);

        assert_eq!(proposed.len(), 1);
        let set = &proposed[0];
        assert_eq!(set.members.len(), 3);
        assert_eq!(set.fingerprint.local_paths.len(), 3);
        assert_eq!(
            set.missing_for(key(2)),
            &BTreeSet::from(["imu/ay".to_owned()])
        );
        assert!(set.missing_for(key(1)).is_empty());
    }

    #[test]
    fn disjoint_schemas_propose_separate_sets() {
        let proposed = propose_sets(&[
            (key(1), vec!["imu/ax".to_owned()]),
            (key(2), vec!["gps/lat".to_owned()]),
        ]);
        assert_eq!(proposed.len(), 2);
    }

    #[test]
    fn membership_and_alignment_changes_bump_the_generation() {
        let mut set = propose_sets(&[
            (key(1), vec!["a".to_owned()]),
            (key(2), vec!["a".to_owned()]),
        ])
        .pop()
        .unwrap();
        let first = set.generation;
        set.remove_member(key(2));
        assert_eq!(set.generation, first + 1);
        set.set_transform(
            key(1),
            AffineTransform {
                scale: 1.0,
                offset: 5.0,
            },
        );
        assert_eq!(set.generation, first + 2);
    }
}

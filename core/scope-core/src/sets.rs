//! Source grouping and aligned time-domain metadata.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};

use uuid::Uuid;

use crate::store::SourceKey;

const MIN_SCHEMA_OVERLAP_NUMERATOR: usize = 4;
const MIN_SCHEMA_OVERLAP_DENOMINATOR: usize = 5;
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

impl AffineTransform {
    #[must_use]
    pub fn normalizing(unit: TimeUnit) -> Self {
        Self {
            scale: unit.to_seconds_scale(),
            offset: 0.0,
        }
    }

    #[must_use]
    pub fn apply(self, time: f64) -> f64 {
        self.scale.mul_add(time, self.offset)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimeUnit {
    Seconds,
    Milliseconds,
    Microseconds,
    Nanoseconds,
    Unsupported,
}

impl TimeUnit {
    #[must_use]
    pub fn to_seconds_scale(self) -> f64 {
        match self {
            Self::Seconds => 1.0,
            Self::Milliseconds => 1e-3,
            Self::Microseconds => 1e-6,
            Self::Nanoseconds => 1e-9,
            Self::Unsupported => f64::NAN,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OriginKind {
    Relative,
    AbsoluteEpoch,
    EventAligned,
    SyntheticIndex,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimeDomain {
    pub unit: TimeUnit,
    pub origin: OriginKind,
    pub alignment_origin: f64,
}

impl Default for TimeDomain {
    fn default() -> Self {
        Self {
            unit: TimeUnit::Seconds,
            origin: OriginKind::Relative,
            alignment_origin: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, thiserror::Error, Eq, PartialEq)]
pub enum AlignmentError {
    #[error("synthetic index and physical time cannot share a set")]
    MixedOrigins,
    #[error("source {key:?} requires an explicit offset")]
    OffsetRequired { key: SourceKey },
    #[error("source {key:?} uses an unsupported time unit")]
    UnsupportedUnit { key: SourceKey },
}

#[derive(Clone, Debug, PartialEq)]
pub struct SetMember {
    pub source_key: SourceKey,
    pub local_paths: BTreeSet<String>,
    pub missing: BTreeSet<String>,
    pub time_domain: TimeDomain,
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
                time_domain: TimeDomain::default(),
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

    pub fn set_time_domain(&mut self, source_key: SourceKey, domain: TimeDomain) {
        if let Some(member) = self.members.get_mut(&source_key) {
            member.time_domain = domain;
            member.transform = default_transform(domain);
            self.bump_generation();
        }
    }

    pub fn set_member_origin(&mut self, source_key: SourceKey, origin: OriginKind) {
        let Some(member) = self.members.get(&source_key) else {
            return;
        };
        self.set_time_domain(
            source_key,
            TimeDomain {
                origin,
                ..member.time_domain
            },
        );
    }

    /// # Errors
    ///
    /// Returns an alignment error when members cannot share a time grid.
    pub fn alignment(&self) -> Result<(), AlignmentError> {
        let synthetic = self
            .members
            .values()
            .filter(|member| member.time_domain.origin == OriginKind::SyntheticIndex)
            .count();
        if synthetic != 0 && synthetic != self.members.len() {
            return Err(AlignmentError::MixedOrigins);
        }
        for member in self.members.values() {
            let key = member.source_key;
            if !member.time_domain.unit.to_seconds_scale().is_finite() {
                return Err(AlignmentError::UnsupportedUnit { key });
            }
            if matches!(
                member.time_domain.origin,
                OriginKind::AbsoluteEpoch | OriginKind::EventAligned
            ) && member.transform.is_none()
            {
                return Err(AlignmentError::OffsetRequired { key });
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn transform(&self, source_key: SourceKey) -> Option<AffineTransform> {
        self.members
            .get(&source_key)
            .and_then(|member| member.transform)
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
            if schemas_match(&schemas[left], &schemas[right]) {
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
                            time_domain: TimeDomain::default(),
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

fn default_transform(domain: TimeDomain) -> Option<AffineTransform> {
    matches!(
        domain.origin,
        OriginKind::Relative | OriginKind::SyntheticIndex
    )
    .then(|| AffineTransform::normalizing(domain.unit))
}

fn schemas_match(left: &BTreeSet<String>, right: &BTreeSet<String>) -> bool {
    let smaller = left.len().min(right.len());
    if smaller == 0 {
        return left.is_empty() && right.is_empty();
    }
    left.intersection(right).count() * MIN_SCHEMA_OVERLAP_DENOMINATOR
        >= smaller * MIN_SCHEMA_OVERLAP_NUMERATOR
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

    fn two_member_set(origin: OriginKind) -> SourceSet {
        let mut set = propose_sets(&[
            (key(1), vec!["a".to_owned()]),
            (key(2), vec!["a".to_owned()]),
        ])
        .pop()
        .unwrap();
        set.set_member_origin(key(1), origin);
        set.set_member_origin(key(2), origin);
        set
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

    #[test]
    fn supported_units_normalize_to_seconds_by_default() {
        assert!((TimeUnit::Milliseconds.to_seconds_scale() - 1e-3).abs() < f64::EPSILON);
        assert!((TimeUnit::Nanoseconds.to_seconds_scale() - 1e-9).abs() < f64::EPSILON);
        let transform = AffineTransform::normalizing(TimeUnit::Milliseconds);
        assert!((transform.apply(2_000.0) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn absolute_epochs_require_an_explicit_offset() {
        let mut set = two_member_set(OriginKind::AbsoluteEpoch);
        assert!(matches!(
            set.alignment(),
            Err(AlignmentError::OffsetRequired { .. })
        ));
        set.set_transform(
            key(1),
            AffineTransform {
                scale: 1.0,
                offset: -1_700_000_000.0,
            },
        );
        assert!(matches!(
            set.alignment(),
            Err(AlignmentError::OffsetRequired { .. })
        ));
        set.set_transform(
            key(2),
            AffineTransform {
                scale: 1.0,
                offset: -1_700_000_060.0,
            },
        );
        assert!(set.alignment().is_ok());
    }

    #[test]
    fn relative_origins_align_with_the_default_transform() {
        assert!(two_member_set(OriginKind::Relative).alignment().is_ok());
    }

    #[test]
    fn synthetic_index_and_physical_time_cannot_mix() {
        let mut set = two_member_set(OriginKind::Relative);
        set.set_member_origin(key(2), OriginKind::SyntheticIndex);
        assert!(matches!(set.alignment(), Err(AlignmentError::MixedOrigins)));
    }
}

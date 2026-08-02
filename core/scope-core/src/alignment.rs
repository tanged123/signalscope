//! Per-source time-domain normalization and affine alignment.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum OriginKind {
    Relative,
    AbsoluteEpoch,
    EventAligned,
    SyntheticIndex,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
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
    #[error("source uses an unsupported time unit")]
    UnsupportedUnit,
    #[error("absolute or event-aligned time requires an explicit offset")]
    OffsetRequired,
}

pub(crate) fn default_transform(domain: TimeDomain) -> Option<AffineTransform> {
    matches!(
        domain.origin,
        OriginKind::Relative | OriginKind::SyntheticIndex
    )
    .then(|| AffineTransform::normalizing(domain.unit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_units_normalize_to_seconds_by_default() {
        assert!((TimeUnit::Milliseconds.to_seconds_scale() - 1e-3).abs() < f64::EPSILON);
        assert!((TimeUnit::Nanoseconds.to_seconds_scale() - 1e-9).abs() < f64::EPSILON);
    }

    #[test]
    fn relative_origins_align_with_the_default_transform() {
        let transform = default_transform(TimeDomain {
            unit: TimeUnit::Milliseconds,
            origin: OriginKind::Relative,
            alignment_origin: 0.0,
        })
        .unwrap();
        assert!((transform.scale - 1e-3).abs() < f64::EPSILON);
        assert!(transform.offset.abs() < f64::EPSILON);
    }
}

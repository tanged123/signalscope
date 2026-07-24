//! Transport wrapper validated at one choke point per host.
//!
//! Every IPC payload and baked manifest crosses hosts inside an
//! [`Envelope`], so the protocol version is stamped and checked in exactly
//! one place instead of per message type.

use serde::{Deserialize, Serialize};

use crate::PROTOCOL_VERSION;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub protocol_version: u32,
    pub payload: T,
}

impl<T> Envelope<T> {
    #[must_use]
    pub fn new(payload: T) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            payload,
        }
    }

    /// Returns the payload when the envelope's version matches this build.
    ///
    /// # Errors
    ///
    /// Returns [`VersionError`] when the envelope was produced by an
    /// incompatible protocol version.
    pub fn open(self) -> Result<T, VersionError> {
        if self.protocol_version == PROTOCOL_VERSION {
            Ok(self.payload)
        } else {
            Err(VersionError {
                expected: PROTOCOL_VERSION,
                actual: self.protocol_version,
            })
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("unsupported protocol version {actual}; expected {expected}")]
pub struct VersionError {
    pub expected: u32,
    pub actual: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_version_opens() {
        assert_eq!(Envelope::new(7_u32).open(), Ok(7));
    }

    #[test]
    fn mismatched_version_is_rejected() {
        let envelope = Envelope {
            protocol_version: PROTOCOL_VERSION + 1,
            payload: (),
        };
        let error = envelope.open().unwrap_err();
        assert_eq!(error.actual, PROTOCOL_VERSION + 1);
    }
}

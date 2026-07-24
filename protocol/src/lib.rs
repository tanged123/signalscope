//! Versioned data-plane protocol generated from the repository schema.

mod envelope;
mod generated;

pub use envelope::{Envelope, VersionError};
pub use generated::*;

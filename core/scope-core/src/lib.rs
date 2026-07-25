//! `SignalScope` native data-plane core.
//!
//! ADR 0002's layer boundaries are module boundaries here: `ingest`,
//! `pyramid`, and `compute` may depend on `store`; `session` is an
//! independent schema boundary; nothing depends on the shell.

pub mod cache;
pub mod compute;
pub mod ingest;
pub mod pyramid;
pub mod session;
pub mod store;

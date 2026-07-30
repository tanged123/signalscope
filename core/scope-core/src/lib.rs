//! `SignalScope` native data-plane core.
//!
//! ADR 0002's layer boundaries are module boundaries here: `ingest`,
//! `pyramid`, `compute`, and `expr` may depend on `store`; `session` is an
//! independent schema boundary; nothing depends on the shell.

pub mod cache;
pub mod compute;
pub mod expr;
pub mod ingest;
pub mod naming;
pub mod preferences;
pub mod pyramid;
pub mod session;
pub mod snapshot;
pub mod sources;
pub mod store;

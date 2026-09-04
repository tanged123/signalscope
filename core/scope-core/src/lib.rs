//! `SignalScope` native data-plane core.
//!
//! ADR 0002's layer boundaries are module boundaries here: `ingest`,
//! `pyramid`, `compute`, and `expr` may depend on `store`; `session` is an
//! independent schema boundary; nothing depends on the shell.

pub mod bins;
pub mod cache;
pub mod columns;
pub mod compute;
pub mod derived_bundle;
pub mod expr;
pub mod ingest;
pub mod line2d;
pub mod naming;
pub mod paging;
pub mod preferences;
pub mod pyramid;
pub mod restore;
pub mod series_ref;
pub mod session;
pub mod snapshot;
pub mod sources;
pub mod store;
pub mod tile_wire;
pub mod time_window;

#[cfg(test)]
mod benchmarks;

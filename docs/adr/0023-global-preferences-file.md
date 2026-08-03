# ADR 0023: Global preferences file

- Status: Accepted
- Date: 2026-07-28

## Context

ADR 0022 made the per-workspace session the only durable store; theme lives
there. The design handoff calls for appearance settings that follow the user,
not the workspace. Font family and size preferences forced the decision.

## Decision

Appearance preferences (UI font family and size, plot font family and size)
persist in `preferences.json` in the app data directory, governed by a
dedicated versioned schema (`protocol/schema/scope-preferences.json`), code
generation per ADR 0004, a migration ladder per ADR 0005, and atomic writes per
ADR 0022.

The frontend reaches it through a nullable `preferences` data-plane port; the
baked snapshot host keeps in-memory defaults. Load failures and future schema
versions fall back to defaults without rewriting the stored file.
Command-usage frecency stays in local storage: it is a disposable cache, not
user state. Theme remains in the session for now; migrating it to global
preferences is an open follow-up.

## Consequences

Two durable stores exist with a clear split: session for workspace state and
preferences for user appearance. Every preferences schema change needs a
schema bump, migration rung, and TypeScript-to-Rust conformance fixture, like
the session.

## 2026-07-30 amendment: cache and ingest budgets

Schema 2 adds the app-owned cache root, its byte limit, and optional ingest
working and resident limits. Missing limits retain automatic sizing. Native
preferences resolve a missing cache root to the app data `cache/` directory.

Writable source directories may keep beside-source sidecars. Read-only
directories use the app-owned root, where entries are keyed by decode
provenance so relocation does not invalidate them. App-owned cache writes are
required; beside-source write failures remain non-fatal.

ADR 0029 extends this root to page-backed columns, derived spills, and
generation-keyed ensemble materializations. Live page leases prevent eviction
and deletion.

## 2026-08-03 amendment: user recipe directory

Schema 3 adds an optional read-only `recipe_directory` for declarative HDF5,
MATLAB v7.3, and Parquet recipes. Resolution checks a source sidecar before
this directory; files are parsed as data and never executed. Missing or
malformed recipes do not change appearance or cache preferences, but a
malformed candidate is reported to the caller rather than silently skipped.

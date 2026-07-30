# ADR 0027: Durable source identity and restore reconciliation

- Status: Accepted
- Date: 2026-07-30
- Amends: [ADR 0022](0022-durable-session-persistence.md)

## Context

Sessions stored paths, while signal identity depended on display paths derived
from filenames. Moving a source or loading same-stem files could change durable
references. Legacy CSV and MCAP naming rules also differed.

## Decision

`SourceKey` is the durable UUID; `SourceId` is process-local. Signal storage
identity is `(SourceId, local_path)`. Display identity is
`prefix/local_path`. Prefixes use normalized file stems and key digests only;
parent-directory text is never exposed.

Session v11 stores source records. The v10 migration assigns deterministic
UUIDv5 keys and collision-safe prefixes without filesystem access, then marks
records for reconciliation.

Restore has two asynchronous stages:

1. Re-ingest every source as one batch using its saved key and prefix.
2. Build provider-specific legacy aliases and atomically rewrite favorites,
   panels, annotations, and derived expressions in `scope-core::restore`.

Ambiguous aliases are not rewritten. They remain marked and are reported for
manual relinking. Autosave pauses between the two stages; named saves remain
available.

`session`, `store`, `ingest`, and `expr` do not depend on `restore`. The
application service depends inward on them.

## Consequences

Relocation no longer changes durable identity or display prefixes. Legacy
sessions migrate deterministically across machines. A missing or ambiguous
source cannot cause a partial reference rewrite, and the marker allows a later
retry.

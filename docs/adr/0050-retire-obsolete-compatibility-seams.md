# ADR 0050: Retire obsolete compatibility seams

Status: Accepted

## Decision

SignalScope supports the current time-series presentation model directly.
Session schema 24 removes the single-value panel mode, annotation domain,
facet split, and legacy reconciliation marker. Loading schema 22 or 23 drops
those fields during migration.

Protocol 19 removes the ignored tile budget and replaces source reconciliation
with restore finalization. Finalization waits for ingest, updates saved source
metadata, settles the restore gate, and returns the session. Alias rewriting
for session versions older than the supported migration floor is deleted.

## Consequences

- Current sessions retain explicit migrations; older unsupported sessions fail
  before restore.
- Panels and annotations no longer carry discriminators for alternatives that
  do not exist.
- Source identity remains the durable source key plus local channel path.
- Protocol 19 and session 24 require a major release.

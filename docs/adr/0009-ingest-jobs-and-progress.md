# ADR 0009: Ingest jobs, progress reporting, and MCAP scope

- Status: Accepted
- Date: 2026-07-24

## Context

Phase 1 needs native file dialogs, MCAP ingest, and visible progress for
multi-second ingests. The frontend has zero runtime dependencies and talks
to the shell exclusively through versioned request/response envelopes; the
same presentation code must keep working inside snapshots, which have no
shell at all.

## Decision

Ingest runs as a background job. `ingest_source` registers a job and
returns its id immediately; a worker thread decodes, builds pyramids, and
maintains the sidecar cache, publishing `IngestStatus { state, stage,
fraction }` into a job table. The frontend polls `ingest_status` (~150 ms)
until `done` or `failed`. No Tauri events or channels: that would pull
`@tauri-apps/api` (or fragile raw-internals code) into a dependency-free
frontend, and polling composes with the existing envelope discipline. A
push channel can replace the poll loop later without changing job
semantics.

Format dispatch sniffs content (MCAP magic `\x89MCAP0\r\n`; everything else
is CSV-like). MCAP v1 decodes channels whose `message_encoding` is `json`:
numeric and boolean leaves flatten to `topic/field/subfield` signals on the
`log_time` timebase (ns → f64 seconds), rows sorted by time, ragged fields
NaN-backfilled so they surface as pyramid gaps. Other encodings are counted
and reported; a file with no ingestible channels fails with the encodings
it does contain. Decode-stage progress is byte-accurate for CSV and
endpoint-only for MCAP (the message stream has no cheap byte total).

Host-only abilities surface on the frontend `DataPlane` as capability
ports (`ingest: IngestPort | null`); UI may branch on a port's presence,
never on host identity (ADR 0001 amendment).

## Consequences

The store mutex is held for a job's duration, so tile queries block while
a new file ingests — acceptable while first-load dominates; revisit with
the out-of-core store. The MCAP reader currently loads the whole file into
memory, matching the in-memory Phase 1 store; the `Decoder` seam hides the
change when mmap-backed columns land. Live sources later become long-lived
jobs publishing the same status shape.

# ADR 0032: Forward native window drag-drop events

- Status: Accepted
- Date: 2026-08-03
- Amends: [ADR 0004](0004-versioned-protocol-and-codegen.md)

## Context

The native window receives file drag-drop events, but the shared frontend must
handle them without depending on Tauri APIs or adding runtime dependencies to
the snapshot. The frontend also needs the same ingest routing for files,
folders, and workspace files.

## Decision

Protocol v15 adds the first push-style surface: the shell forwards window
`Enter`, `Drop`, and `Leave` events as `Envelope<DragDropForward>` on
`scope://drag-drop`. `Over` events are not forwarded because they arrive at
pointer-move frequency. The frontend listens through the raw Tauri internals
event plugin and exposes the event only through `IngestPort`.

Snapshots have no event source and keep `BakedPlane.ingest` inert. The
frontend classifies one `.signalscope` or `.json` path as a workspace open and
expands all other drops through `scan_sources` before batch ingest.

## Consequences

The presentation plane remains independent of the native host and the
snapshot remains offline and dependency-free. Protocol consumers must handle
the new version explicitly; native drag-drop forwarding is tested at the
envelope boundary, while classification and expansion remain pure frontend
logic.

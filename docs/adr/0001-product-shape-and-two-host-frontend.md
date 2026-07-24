# ADR 0001: Product shape and two-host frontend

- Status: Accepted
- Date: 2026-07-23

## Context

The workbench must open logs larger than browser memory while exported analyses must remain single-file, offline, and interactive. Visual or behavioral drift between those surfaces would make snapshots unreliable.

## Decision

SignalScope is centralized native software with a portable export. One TypeScript/canvas presentation plane runs in a Tauri webview and in an exported browser snapshot. The workbench uses `TauriPlane`; snapshots use `BakedPlane`. Both implement the same versioned `DataPlane` interface and feed the same application and renderer.

The native Rust plane owns ingest, out-of-core storage, pyramid construction, compute, and persistence. Browser snapshots receive only selected tiles and session state. The UI cannot branch on its host except when selecting the `DataPlane` implementation.

## Consequences

Native memory and filesystem capabilities remain available for multi-GB logs. Snapshot fidelity is architectural rather than a second implementation. The frontend must keep zero network and zero runtime-package assumptions so it can be inlined.

## Amendment (2026-07-24, Phase 1)

Host-only abilities are expressed as capability ports on `DataPlane`
(first: `ingest: IngestPort | null`). UI behavior may branch on a port's
presence — never on host identity — so snapshot builds simply present no
entry points for capabilities their plane lacks.

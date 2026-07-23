# ADR 0007: Snapshot injection mechanism

- Status: Accepted
- Date: 2026-07-23

## Decision

The frontend build produces `snapshot-template.html` with all JavaScript, CSS, and fonts inlined and one inert JSON script element named `signalscope-baked-data`. It contains `null` in the template. Export serializes a versioned manifest, escapes closing script sequences, and replaces that exact slot atomically.

At startup, absence of Tauri selects `BakedPlane`, which reads the slot. The workbench selects `TauriPlane`. Snapshot code makes no network requests. CI scans the artifact for external resource attributes, enforces a ratcheted size ceiling, opens an injected snapshot headlessly, and checks the canvas renderer.

## Consequences

Snapshots are one portable file and use the production presentation plane. Data budgeting occurs before injection. Schema and protocol versions remain visible in the artifact and can be migrated or rejected intentionally.

# ADR 0005: Session schema versioning

- Status: Accepted
- Date: 2026-07-23

## Decision

Sessions are tagged with `app: "signalscope"` and an integer `schema_version`. Version 1 stores global time state, linked state, theme, focused panel, layout, and complete per-panel display state. It references signal paths but contains no source samples. Snapshot manifests pair the same session with baked tiles.

Deserialization first parses a small version envelope, then dispatches to a version-specific schema and migrates forward. The current version is always the only type exposed to application code. Unknown future versions fail with an actionable error and never partially restore.

## Consequences

Theme, axis style, annotations, and zoom state survive round trips. Migration tests become mandatory for every schema bump. Prototype-session import may be a separate adapter and does not constrain this schema.

## Amendment (2026-07-24)

The session schema is now source-of-truth'd in
`protocol/schema/scope-session.json` and generated into both hosts by the
same script as the protocol (ADR 0004), eliminating hand-maintained
duplicates of session shapes in TypeScript. Deserialization dispatches
through a `migrate(version, value)` ladder with a v1 identity rung; every
schema bump adds one rung and one migration test.

## Amendment (2026-07-24, Phase 1)

Session schema version 2 adds fractional layout rows/cells and favorite signal
paths. Workspace state now mutates this generated session shape directly even
though durable autosave remains Phase 3. The v1-to-v2 migration preserves panel
order in one equal-width row and initializes favorites as empty, so current
application code only consumes the v2 shape.

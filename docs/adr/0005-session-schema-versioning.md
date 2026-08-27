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

## Amendment (2026-07-24, Workspace tabs)

Session schema version 3 moves the single top-level panel grid into
`WorkspaceTab[]` and records the active tab. The v2-to-v3 migration wraps the
existing panels, focus, and layout in `Workspace 1`. Theme, linked time, and
favorites remain session-global. See ADR 0010 for the product and chrome
decision.

## Amendment (2026-07-26, plot domains)

Session schema version 6 replaces time-only annotation coordinates with a
domain-tagged anchor: `time`, `frequency`, or `distribution`. The stored anchor
identifies the source-domain location while `pinned_value` is retained as
historical context. Plot adapters resolve the current display position after
FFT recomputation or histogram rebinning. The v5-to-v6 migration maps existing
`time`/`value` annotations to the `time` domain without changing their meaning.

## Amendment (2026-07-26, cursor modes)

Session schema version 7 adds `cursor_mode` to each workspace tab. The
v6-to-v7 migration initializes every tab to `none`; `track` and `measure`
remain independent as users switch workspaces. See ADR 0020 for the chrome and
interaction decision.

## Amendment (2026-07-27, durable workspace state)

Session schema version 9 stores the maximized panel per workspace and separates
XY colour-by-time from signal paths. The v8-to-v9 migration converts the
`color_signal: "time"` sentinel into `color_by_time: true`.

## Amendment (2026-07-27, derived signals and sources)

Session schema version 10 adds `derived` — ordered `{path, expr}` definitions —
and `source_paths`. Both are required arrays, so the v9-to-v10 migration
initializes each as empty rather than relying on `#[serde(default)]`. Sessions
still contain no samples: a derived signal is restored by re-evaluating its
expression after its sources are re-ingested.

## Amendment (2026-08-18, ladder reset)

Schema version 22 removes the non-time panel modes and their fields. The
migration ladder was reset rather than extended: every rung is deleted and
any version other than the current one is rejected through
`UnsupportedVersion`. Sessions and snapshots written by earlier versions no
longer load. This is a single deliberate break accepted for that change and
does not relax the rule for future bumps, which continue to require a rung
and a migration test. See [ADR 0043](0043-time-only-presentation.md).

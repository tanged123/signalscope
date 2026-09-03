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

## Amendment (2026-08-30, legend console)

Schema version 23 stores each panel's legend state, including the docked rail,
position, size, snapped corner, and empty-focus hint dismissal. Version 22
sessions migrate to the default keys state with no custom geometry. See
[ADR 0048](0048-legend-console.md).

## Amendment (2026-09-01, style cascade and legend statistics)

Schema version 25 stores panel line defaults, color/dash/width encoding
bindings, visible statistic columns, and statistic sort state. Version 24
sessions migrate to the prior source-color rule, flat dash and width rules,
1.4 px lines, 50% ghost opacity, and the prior visible statistic set. See
[ADR 0051](0051-style-cascade-and-legend-statistics.md).

## Amendment (2026-09-02, data tips and unified focus)

Schema version 26 stores each data tip's panel-local pixel offset and each
panel's tip display mode (`labels`, `markers`, or `hidden`). Version 25
sessions migrate to visible labels with the prior default label offset. Focus
remains the serialized series/source/channel set, but its presentation now
marks the canonical legend rows instead of creating a duplicate focus stack.
See [ADR 0051](0051-style-cascade-and-legend-statistics.md).

## Amendment (2026-09-02, four-edge legend docking)

Schema version 27 stores the legend dock edge independently from its `rail`
presentation state. Version 26 rails migrate to `right`, preserving their prior
geometry, while floating legends migrate with no dock edge. New rails may be
persisted on the left, right, top, or bottom. See
[ADR 0051](0051-style-cascade-and-legend-statistics.md).

## Amendment (2026-09-03, explicit Line2D X-axis source)

Schema version 28 stores an explicit `x_axis` source on each panel. The source
kind is `time` or `signal`; time sources have no series reference, while signal
sources carry the referenced `SeriesRef`. Version 27 panels migrate to the
time source default. Session parsing rejects a source whose kind and reference
do not satisfy that invariant. Annotations also store an optional `pinned_x`
so a tip remains at its plotted coordinate when X is not time; old annotations
default it to null and retain their time anchor behavior.

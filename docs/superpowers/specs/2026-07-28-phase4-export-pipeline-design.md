# Phase 4 Export Pipeline Design

**Status:** Approved

**Date:** 2026-07-28

## Goal

Ship the export pipeline: a versioned snapshot manifest that pairs the
Phase 3 session with baked pyramid data, a Rust bake module with an
in-app export dialog and a headless CLI as its two consumers, and PNG
and visible-CSV exports. Export is the foundation the rest of Phase 4
stands on.

## Scope decisions

Phase 4 decomposes into three chunks; this spec covers only the first.

- **A — export pipeline (this spec).** Bake path, manifest, size-budget
  dialog, HTML/PNG/CSV exports, CLI.
- **B — fidelity harness (own spec later).** Renderer screenshot
  matrices across themes and axis styles; pixel-compared snapshot
  parity.
- **C — demo artifacts (design already approved).** Blocked on A's CLI;
  see `2026-07-27-automated-demo-artifacts-design.md`.

Resolved design-source conflict: the export dialog has **three** radio
rows (HTML snapshot, PNG, visible CSV). F6·2's fourth row, Session
JSON, shipped in Phase 3 as Save Workspace As…; the July 2026 audit's
File menu already drops it. The audit wins.

Acceptance bar for A: a CI end-to-end round trip asserting state and
envelope values, not pixels (see Testing).

## Framing

A workspace file is `session + source_paths`, re-ingested on load. A
snapshot is `session + baked data`, self-contained. Phase 3 solved the
session half — serializer, schema v10, migrations, round-trip coverage.
Phase 4 bakes the data half. The bake module treats the session as an
opaque, already-solved input.

## Architecture

### Manifest schema

`BakedManifest` today is an ad-hoc TypeScript type inside
`frontend/src/app/data-plane.ts`. It graduates into the existing
`protocol/schema/scope-protocol.json` (which already defines
`Envelope`, `EnvelopeBin`, and `SignalSummary`), codegen'd into TS and
Rust like every other protocol type. The `Envelope`'s protocol version
is the manifest version — no separate version number:

```
SnapshotManifest (inside Envelope; the envelope's protocol version stamps it)
├── session_json:  string      // schema-v10 Session, Phase 3's serializer
└── signals:       BakedSignal[]
    └── { summary: SignalSummary, levels: EnvelopeBin[][] }
```

The session crosses as an opaque JSON string, not a typed field: the
protocol and session schemas are isolated codegen units, and `Session`
lives in `scope-core`, which depends on `protocol` — a typed reference
would invert the crate direction. `SaveSessionRequest` and
`LoadedSession` already set this precedent.

`levels` is positional: index 0 is the finest _baked_ level, and
decimation drops the finest logical levels — `BakedPlane` already
treats "the finest baked level stands in for raw samples" (ADR 0015).
`SignalSummary` carries both `signal_id` and `path`, so the session's
path references resolve against baked ids.

Implementation records the manifest schema and budget model in a new
ADR.

### Bake module

`scope-core::snapshot` owns three pure functions over
`(store, pyramids, session)`:

- `plan(session, scope)` — resolves the scope choice into per-signal
  windows and level sets (see Budget model).
- `estimate(plan)` — byte estimate from level metadata alone; no
  serialization.
- `bake(plan)` — the manifest; plus `inject(template, manifest)` doing
  ADR 0007's atomic slot replacement, with `</script` escaping, in
  Rust, in one place.

### Consumers

- **Tauri commands:** `export_estimate` (powers the dialog's live
  numbers) and `export_write` (bakes, injects, saves via native
  dialog). The packaged app bundles `snapshot-template.html` as a Tauri
  resource.
- **CLI:** a minimal, internal bin target on `scope-core` — a thin
  `main()` over the bake module with no stability promise.
  `--data <file>...` ingests, `--workspace <file>` optionally supplies
  the session (absent: a synthesized minimal session),
  `--template <path>`, `--out <path>`. It always bakes all-loaded
  scope; there is no scope flag, and visible-window baking is in-app
  only. No dialogs, no Tauri. A `./scripts/` wrapper builds the
  template first, then invokes the bin; chunk C's `demo.sh` calls the
  same wrapper and hardens the CLI when the demo's real needs are
  known.

### Semantic forks at bake time

- **Derived signals** cannot re-evaluate in a browser (expression eval
  is native-only, ADR 0008). The bake materializes them as ordinary
  baked signals; the session's `derived` definitions remain as
  provenance.
- **`source_paths` is cleared** in the baked session. It is inert in a
  snapshot, and absolute local paths would leak usernames into a
  shareable file.

### BakedPlane

On snapshot boot, the shell applies the manifest's baked session,
replacing today's `emptySession()` boot. Validation checks the `app`
field and that `schema_version` matches the build's — a snapshot's
code and session ship together, so the version always matches by
construction and migration never runs inside a snapshot; the check is
defensive. An empty `session_json` (the built-in demo manifest) keeps
today's demo boot. The session port stays `null`: edits inside a
snapshot are live but not durable, and autosave stays off for free.

## Budget model

### Scopes

- **Visible window** — only signals referenced by some panel (series,
  `x_signal`, `color_signal`), all clipped to **one export window**:
  the union of every panel's effective window (linked panels use
  `linked_time`; unlinked panels their own `time_window`). No
  per-signal windows — one window clips everything, at the cost of
  slightly larger files when unlinked panels view disjoint ranges.
  Signals on no panel are excluded, and the snapshot's tree lists only
  baked signals.
- **All loaded** — every signal in the store, full range, all levels
  including level 0.

### Level selection

The mock's "decimated to ≤2k pts/px/series" caption is pinned to a
deterministic rule: for each baked signal, include levels from the
coarsest down to the finest level whose bin count over the export
window is **≤ 2,048** (≈2 bins/px at a full-width panel, the density
the renderer targets). Zoom inside a snapshot re-runs the
conformance-tested level selection and bottoms out at the finest baked
level; "all loaded" is the escape hatch.

Two overrides:

- **Level-0 override.** Signals used by an XY/FFT/histogram panel bake
  level 0 clipped to their window — `querySamples` in a snapshot
  reconstructs from `levels[0]` (ADR 0015). This can dominate the
  budget and is visibly reflected in the estimate.
- **Honesty rule.** If raw sample count within the window is already
  ≤ 2,048, bake level 0 outright; never decimate below the raw data.

### Estimation

HTML bytes ≈ Σ(bin counts × a rough bytes-per-serialized-bin
constant) + session size + template size, computed from level metadata
only — cheap enough to recompute live as the user flips scope, and
displayed with `~`; the written file is authoritative. PNG and CSV
sizes are **exact by construction**: the focused panel's composite and
the visible samples are already in memory, so the dialog generates the
artifact and measures it — no heuristics.

## UI surface

One dialog, three entry points. The File menu's
`Export ▸ HTML snapshot · PNG · visible CSV` entries and their command
palette twins all open the F6·2 dialog with that format's radio
preselected (the audit cut the flat export menu). The dialog owns the
three radio rows with live estimates, the visible/all-loaded segmented
control (enabled only for the HTML row), the decimation caption, and
the Export button that runs the native save dialog. The single
`export` planned stub in the command registry is replaced by these
commands with real handlers and `status: "available"`.

- **PNG — focused panel.** Frontend-side, prototype semantics:
  composite a title header + plot canvas + overlay canvas at dpr 2,
  filename from the panel title, saved via Tauri dialog. No focused
  panel → row disabled with a hint.
- **Visible CSV.** Frontend-side from already-fetched window samples:
  focused panel; the first series (or the XY x-signal) is the
  timebase, other series lerp-interpolated onto it; header
  `time,"path",…`. Lerp semantics are already fixture-pinned
  cross-language.
- **Inside a snapshot,** the export commands stay disabled as today.
  A browser-download save path for PNG/CSV is deferred; the snapshot
  recipient's promise is interactive inspection, not re-export.

## Error handling

- The HTML estimate is approximate by contract (`~`); PNG and CSV
  sizes are exact because the dialog generates them.
- CLI errors clearly on a missing template or missing
  `#signalscope-baked-data` slot; in-app, a missing slot is a hard
  error (build regression, not user error).
- A signal with zero samples in the export window bakes empty levels;
  `has_gap` semantics carry through unchanged.
- Injection escaping is tested against adversarial signal paths and
  labels containing `</script>` sequences.
- Write failures (disk full, permissions) surface through the existing
  status-strip pattern; the dialog stays open for retry.
- `check-snapshot.mjs` is unchanged and keeps gating only the empty
  template. It does not run against exported files — the template
  already proves the shared code makes no external requests, and
  `source_paths` clearing removes the path-leak vector.

## Testing

Follows the repo's Rust-generated-fixture discipline.

1. **Rust unit tests** on `plan` (window resolution, level selection,
   level-0 override) and `inject` (escaping, atomic replacement).
2. **CI round trip (the done bar):** ingest a fixture CSV, apply a
   known workspace file, bake via the CLI, open the snapshot headlessly,
   assert session state (layout, theme, zoom, annotations, panel modes)
   and queried envelope values match the source — by value, not pixels.
3. **Size sanity ceiling** on the CI-exported snapshot, separate from
   the template's existing 750 kB ratchet (which measures the empty
   template and is unchanged).

No new conformance fixture: level selection and sample reconstruction
are already pinned by the pyramid/sample/lerp fixtures that
`BakedPlane` delegates to, and the round trip covers the pipe
end-to-end. A fixture is a three-artifact liability (generator +
JSON + harness) this spec declines to add.

## Out of scope

- Chunk B: screenshot matrices, pixel-compared parity.
- Chunk C: demo GIF and hosted live demo (blocked on this spec's CLI).
- Any export from inside a snapshot (HTML re-bake, or a
  browser-download path for PNG/CSV).
- Visible-window scope in the CLI (in-app only until chunk C needs
  it).
- Automatic ratchet recording for artifact sizes (the manual constant
  stays).
- Layout presets in exports (presets themselves remain v2).

## Maintenance posture

Simplifications applied by design review: the manifest lives in the
existing protocol schema (the envelope's protocol version is its
version), one export window instead of per-signal windows, no new
conformance fixture, a minimal internal CLI, exact PNG/CSV sizes
instead of heuristics, and no gate changes. New session features flow
into snapshots automatically (session baked verbatim, migrations
included). Adding a panel mode regenerates the Rust session types and
breaks the bake module's exhaustive `match` at compile time, forcing
the "does this mode need level 0" decision. The one known maintenance
tax: `plan()` duplicates the frontend's "which signals does a panel
reference" rule (series + `x_signal` + `color_signal`) in Rust — keep
it one dumb function; the round trip catches drift.

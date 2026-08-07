# WebGPU Line Renderer Phase 1: Time-Only Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete XY, FFT, histogram, density aggregation, and the generic mode framework while preserving a fully working Canvas2D time-series plot.

**Architecture:** The session and frontend become time-series-only. Panels acquire one per-series pyramid response, prepare one time plot, render it through the existing Canvas2D stroke path, and retain exact `query_samples` only for CSV export. This phase deliberately keeps the current renderer so every later data-plane change has a working visual oracle.

**Tech Stack:** Rust 2024, TypeScript 5.9, Canvas2D, JSON schema code generation, Vitest, Playwright.

## Global Constraints

- Every visible series remains individually represented; no density field, ensemble merge, band substitution, or series cutoff survives.
- Keep `Pyramid::query_with_target`; remove only panel-wide budget division and `max_total_bins`.
- Keep `DataPlane.querySamples` and native `query_samples` because visible CSV export consumes exact samples.
- Session schema v22 and protocol v19 are breaking. Reject every older session; add no migration.
- Do not add a compatibility alias, deprecated mode field, feature flag, or Canvas fallback abstraction.
- Do not touch `refs/ChartGPU`.
- Before Task 1, run `git status --short`, inspect the listed target files and nearby tests, and preserve every unrelated change.
- Use repository scripts for generation, formatting, testing, and builds.
- Do not bump the application version in this phase; the completed four-phase PR gets one major bump in Phase 4.

---

## Resulting File Structure

- `docs/adr/0039-time-series-webgpu-renderer.md` — accepted product and architecture decision superseding mode and density ADRs.
- `protocol/schema/scope-session.json` — time-only panel/session shape.
- `protocol/schema/scope-protocol.json` — tile request without a panel-wide bin budget.
- `core/scope-core/src/session.rs` — exact-current-version session loading only.
- `core/scope-core/src/snapshot.rs` — time-only export planning.
- `frontend/src/app/time-plot.ts` — time-specific ranges, cursor values, stats, annotations, and temporary CPU hit testing.
- `frontend/src/ui/panel.ts` — direct time preparation and Canvas rendering; no mode registry.
- `frontend/src/ui/app-shell.ts` — one tile acquisition path plus separate CSV sample acquisition.
- `frontend/src/render/canvas-renderer.ts` — temporary time-series Canvas renderer and axes only.
- Deleted: `frontend/src/ui/modes/`, `frontend/src/app/{xy,xy-hit,xy-samples,spectrum,histogram,sample-window-cache,budgets}*`, and `frontend/src/render/{density-policy,density-raster}*`.

### Task 1: Record the Superseding Architecture Decision

**Files:**

- Create: `docs/adr/0039-time-series-webgpu-renderer.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/implementation-roadmap.md`

**Interfaces:**

- Consumes: approved design `docs/superpowers/specs/2026-08-07-webgpu-line-renderer-design.md`.
- Produces: the architectural authority used by all four phases.

- [ ] **Step 1: Write ADR 0039**

Use these decision headings and statements verbatim, expanding only consequences that already appear in the approved design:

```markdown
# ADR 0039: Time-series-only identity-preserving WebGPU renderer

- Status: Accepted
- Date: 2026-08-07
- Supersedes: ADR 0017, ADR 0018, ADR 0019, ADR 0037, and ADR 0038; amends the render-path portion of ADR 0036

## Decision

SignalScope v1 plots time series only. XY, FFT, histogram, the generic mode
registry, and their session fields are removed without migration.

Every visible series is represented at every LOD. A pyramid level may reduce
samples within a series, but no panel-wide budget, aggregate density field,
band, merged geometry, or cardinality cutoff may remove or combine series.

Series rendering requires WebGPU. Rust remains the owner of out-of-core
storage and ordered extrema-preserving LOD. ChartGPU is an MIT-licensed
reference for device lifetime, packed coordinates, GPU-resident buffers, and
line shaders; it is not a runtime dependency or chart backend.

## Consequences

Sessions older than the new schema are rejected. Hosts without the required
WebGPU capabilities show an unsupported-host screen. Exact sample queries
remain available for CSV export, while ordinary plotting consumes bounded
pyramid tiles.
```

- [ ] **Step 2: Index the ADR and revise the roadmap**

Add ADR 0039 to `docs/adr/README.md`. Replace the roadmap paragraphs claiming XY/FFT/histogram are shipped with one sentence that they were removed by ADR 0039, and replace the density-tier direction with the approved four-phase WebGPU sequence.

- [ ] **Step 3: Format and inspect the documentation diff**

Run: `./scripts/format.sh`

Run: `git diff --check`

Run: `git diff -- docs/adr docs/implementation-roadmap.md`

Expected: no whitespace errors; ADR 0039 is additive and accepted ADR files 0017/0018/0019/0037/0038 are unchanged.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0039-time-series-webgpu-renderer.md docs/adr/README.md docs/implementation-roadmap.md
git commit -m "docs(adr): choose time-only WebGPU plotting"
```

### Task 2: Break the Session and Tile-Request Schemas Cleanly

**Files:**

- Modify: `protocol/schema/scope-session.json`
- Modify: `protocol/schema/scope-protocol.json`
- Regenerate: `frontend/src/generated/session.ts`
- Regenerate: `frontend/src/generated/protocol.ts`
- Regenerate: `core/scope-core/src/session/generated.rs`
- Regenerate: `protocol/src/generated.rs`
- Modify: `protocol/testdata/session-conformance.json`
- Modify: `protocol/src/lib.rs`
- Modify: `core/scope-core/src/session.rs`
- Modify: `core/scope-core/src/session.rs` tests
- Modify: `frontend/src/app/session-conformance.test.ts`
- Modify: `frontend/src/app/baked-session.ts`
- Modify: `frontend/src/app/baked-session.test.ts`

**Interfaces:**

- Produces: `PanelState` with no plot-mode discriminator and `TileRequest` with one independent `pixel_width` target per series.
- Preserves: `SampleRequest`, `SampleResponse`, and `DataPlane.querySamples`.

- [ ] **Step 1: Add failing current-only session tests**

In `core/scope-core/src/session.rs`, replace migration expectations with these behaviors:

```rust
#[test]
fn rejects_every_older_session_without_migration() {
    let mut value = serde_json::to_value(Session::default()).unwrap();
    value["schema_version"] = serde_json::json!(SESSION_SCHEMA_VERSION - 1);
    assert!(matches!(
        from_json(&value.to_string()),
        Err(SessionError::UnsupportedVersion(version)) if version == SESSION_SCHEMA_VERSION - 1
    ));
}

#[test]
fn current_time_only_session_round_trips() {
    let session = Session::default();
    assert_eq!(from_json(&serde_json::to_string(&session).unwrap()).unwrap(), session);
}
```

In `frontend/src/app/baked-session.test.ts`, add a v21 rejection assertion and a v22 fixture with only time-panel fields.

- [ ] **Step 2: Run the focused tests to prove the old behavior fails**

Run: `./scripts/test.sh core rejects_every_older_session_without_migration`

Expected: FAIL because v21 currently migrates.

Run: `./scripts/test.sh unit frontend/src/app/baked-session.test.ts`

Expected: FAIL because generated schema version and panel validation still accept mode fields.

- [ ] **Step 3: Change the schemas**

Set `schema_version` to `22`. Delete `PanelMode`, `ColorAxis`, and `AnnotationDomain`. Change `Annotation` to:

```json
"Annotation": {
  "kind": "object",
  "fields": {
    "id": "string",
    "series_path": "string",
    "anchor": "f64",
    "pinned_value": "f64",
    "label": "string"
  }
}
```

Change `PanelState.fields` to exactly:

```json
{
  "id": "string",
  "title": "string",
  "axis_style": "AxisStyle",
  "bindings": "Binding[]",
  "color_by": "StyleDimension",
  "overrides": "SeriesOverride[]",
  "focus": "FocusEntry[]",
  "ghost_mode": "GhostMode",
  "split_by": "SplitDimension",
  "y_range": "f64[2]?",
  "x_label": "string?",
  "y_label": "string?",
  "time_window": "f64[2]?",
  "annotations": "Annotation[]",
  "show_stats": "bool"
}
```

Set `protocol_version` to `19` and remove only `max_total_bins` from `TileRequest`. Do not remove sample request types.

- [ ] **Step 4: Regenerate committed types**

Run: `./scripts/codegen.sh`

Expected generated signatures:

```ts
export interface TileRequest {
  request_id: string;
  signal_ids: string[];
  window: TimeWindow;
  pixel_width: number;
}
```

- [ ] **Step 5: Delete the migration ladder and tighten baked validation**

Replace `migrate` with exact-version parsing:

```rust
fn migrate(version: u32, value: serde_json::Value) -> Result<Session, SessionError> {
    if version != SESSION_SCHEMA_VERSION {
        return Err(SessionError::UnsupportedVersion(version));
    }
    Ok(serde_json::from_value(value)?)
}
```

Delete every migration helper and migration-only test below it. In `baked-session.ts`, validate only the resulting `PanelState` keys and annotation shape. Keep wrong-app and unknown-current-structure failures.

- [ ] **Step 6: Update conformance data and verify generation**

Rewrite `protocol/testdata/session-conformance.json` as one valid v22 time-only session. Run:

`./scripts/test.sh core session`

`./scripts/test.sh unit frontend/src/app/session-conformance.test.ts frontend/src/app/baked-session.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add protocol/schema/scope-session.json protocol/schema/scope-protocol.json protocol/testdata/session-conformance.json protocol/src/generated.rs protocol/src/lib.rs core/scope-core/src/session/generated.rs core/scope-core/src/session.rs frontend/src/generated/session.ts frontend/src/generated/protocol.ts frontend/src/app/baked-session.ts frontend/src/app/baked-session.test.ts frontend/src/app/session-conformance.test.ts
git commit -m "refactor(session): make panels time-series only"
```

### Task 3: Remove Mode State from the Workspace and Commands

**Files:**

- Modify: `frontend/src/app/workspace.ts`
- Modify: `frontend/src/app/workspace.test.ts`
- Modify: `frontend/src/app/workspace-save.ts`
- Modify: `frontend/src/app/workspace-save.test.ts`
- Modify: `frontend/src/app/commands.ts`
- Modify: `frontend/src/app/commands.test.ts`
- Modify: `frontend/src/ui/app-menu.ts`
- Modify: `frontend/src/ui/command-palette.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Produces: every new panel is implicitly a time panel.
- Deletes: `setMode`, `promoteSeriesToX`, `setXSignal`, `setColorSignal`, `toggleAxisEqual`, local x-range mutation, and all mode-switch commands.

- [ ] **Step 1: Rewrite workspace construction tests first**

Make the panel factory expectation exactly match the v22 fields:

```ts
expect(model.addPanelRow()).toMatchObject({
  axis_style: "gutter",
  bindings: [],
  y_range: null,
  x_label: null,
  y_label: null,
  time_window: null,
  annotations: [],
  show_stats: false,
});
expect("mode" in model.panels()[0]!).toBe(false);
```

Delete tests whose behavior exists only for XY/FFT/histogram. Change annotation fixtures to omit `domain`.

- [ ] **Step 2: Run the workspace tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/app/workspace.test.ts frontend/src/app/commands.test.ts`

Expected: FAIL on stale generated fields and mode commands.

- [ ] **Step 3: Simplify `WorkspaceModel`**

Delete the mode-specific methods and field initialization. Keep linked/unlinked time behavior; simplify every `panel.mode === "time"` condition to the time behavior. `setPanelXRange` and `clearPanelXRange` disappear; y-range methods remain.

- [ ] **Step 4: Delete mode commands and callbacks**

Remove command IDs `panel-switch-xy`, `panel-switch-fft`, `panel-switch-histogram`, color-signal commands, equal-axis commands, and mode gesture help. Remove their keyboard/palette/menu entries rather than hiding them. Remove `PanelMode` imports.

- [ ] **Step 5: Verify workspace and command behavior**

Run: `./scripts/test.sh unit frontend/src/app/workspace.test.ts frontend/src/app/workspace-save.test.ts frontend/src/app/commands.test.ts frontend/src/ui/app-shell.test.ts`

Expected: PASS, with no mode-switch snapshot or assertion remaining.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts frontend/src/app/workspace-save.ts frontend/src/app/workspace-save.test.ts frontend/src/app/commands.ts frontend/src/app/commands.test.ts frontend/src/ui/app-menu.ts frontend/src/ui/command-palette.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts
git commit -m "refactor(workspace): remove non-time panel state"
```

### Task 4: Replace the Mode Registry with One Time Plot

**Files:**

- Create: `frontend/src/app/time-plot.ts`
- Create: `frontend/src/app/time-plot.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/panel.test.ts`
- Delete: `frontend/src/app/plot-capabilities.ts`
- Delete: `frontend/src/app/plot-capabilities.test.ts`
- Delete: `frontend/src/ui/modes/contract.ts`
- Delete: `frontend/src/ui/modes/contract.test.ts`
- Delete: `frontend/src/ui/modes/index.ts`
- Delete: `frontend/src/ui/modes/index.test.ts`
- Delete: `frontend/src/ui/modes/shared.ts`
- Delete: `frontend/src/ui/modes/shared.test.ts`
- Delete: `frontend/src/ui/modes/time.ts`
- Delete: `frontend/src/ui/modes/time.test.ts`
- Delete: `frontend/src/ui/modes/xy.ts`
- Delete: `frontend/src/ui/modes/xy.test.ts`
- Delete: `frontend/src/ui/modes/fft.ts`
- Delete: `frontend/src/ui/modes/fft.test.ts`
- Delete: `frontend/src/ui/modes/histogram.ts`
- Delete: `frontend/src/ui/modes/histogram.test.ts`

**Interfaces:**

- Produces: `prepareTimePlot(input: TimePlotInput): PreparedTimePlot`.
- `PreparedTimePlot` retains `autoRange`, `cursorAt`, `annotationAt`, `resolveAnnotation`, `stats`, `delta`, and temporary `seriesAt` behavior needed before GPU picking lands.

- [ ] **Step 1: Extract failing time-only capability tests**

Move only the time-series assertions from `plot-capabilities.test.ts` into `time-plot.test.ts`. Define the intended interface in the test:

```ts
export interface PreparedTimePlot {
  autoRange(): {
    x: readonly [number, number];
    y: readonly [number, number];
  } | null;
  cursorAt(
    layout: PlotLayout,
    point: { x: number; y: number },
  ): PlotCursor | null;
  annotationAt(
    layout: PlotLayout,
    point: { x: number; y: number },
    radius: number,
  ): AnnotationAnchor | null;
  resolveAnnotation(annotation: Annotation): ResolvedAnnotation | null;
  stats(): readonly PlotStatGroup[];
  delta(resolved: readonly ResolvedAnnotation[]): PlotDelta | null;
  seriesAt(
    layout: PlotLayout,
    x: number,
    y: number,
    threshold: number,
  ): SeriesHit | null;
}
```

Use `anchor` as time; no annotation-domain checks remain.

- [ ] **Step 2: Run the new test to verify it fails**

Run: `./scripts/test.sh unit frontend/src/app/time-plot.test.ts`

Expected: FAIL because `time-plot.ts` does not exist.

- [ ] **Step 3: Move the time implementation without generic mode policy**

Move time-specific logic from `prepareTimePlot` into the new file. Hard-code linked-time interaction in the panel controller; do not retain `Record<PanelMode, ...>` or a one-entry registry.

- [ ] **Step 4: Simplify `PanelView`**

Delete mode pills, XY chips/drop strip/colorbar state, local-domain series, sample fallback, `geometryFor`, `renderViaModule`, and `plotModeModule`. `renderData` becomes:

```ts
renderData(
  state: PanelState,
  tiles: ColumnarTileResponse | null,
  window: { t0: number; t1: number },
  missing: readonly string[] = [],
  revision: number | null = null,
): number
```

Prepare visible series directly, resolve y through `YAxisPolicy`, call `CanvasRenderer.render`, then update time cursor/stats/annotations. Keep focus, mute, style, axis label, drag/drop, and keyboard paths.

- [ ] **Step 5: Delete the registry and mode modules**

Delete the entire `frontend/src/ui/modes/` directory after imports are gone. Delete `MAX_SERIES_PER_PANEL`; it is unused and conflicts with the 10,000-series acceptance case.

- [ ] **Step 6: Verify panel behavior**

Run: `./scripts/test.sh unit frontend/src/app/time-plot.test.ts frontend/src/ui/panel.test.ts frontend/src/ui/panel-prep-cache.test.ts`

Expected: PASS. If `panel-prep-cache.test.ts` only tests the deleted mode cache, delete that file instead of recreating a one-mode cache.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts frontend/src/ui/panel-prep-cache.test.ts frontend/src/ui/modes
git commit -m "refactor(plot): collapse the mode pipeline to time series"
```

### Task 5: Delete Sample-Mode Acquisition and Panel-Wide Tile Budgets

**Files:**

- Modify: `shell/src-tauri/src/lib.rs`
- Modify: `core/scope-core/src/benchmarks/mod.rs`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `frontend/src/app/pyramid-query.ts`
- Modify: `frontend/src/app/pyramid-query.test.ts`
- Modify: `frontend/src/app/tile-window-cache.ts`
- Modify: `frontend/src/app/tile-window-cache.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/ui/workspace-view.ts`
- Delete: `frontend/src/app/budgets.ts`
- Delete: `frontend/src/app/budgets.test.ts`
- Delete: `frontend/src/app/sample-window-cache.ts`
- Delete: `frontend/src/app/sample-window-cache.test.ts`
- Delete: `frontend/src/app/xy-samples.ts`
- Delete: `frontend/src/app/xy-samples.test.ts`

**Interfaces:**

- Plot acquisition: `queryTiles({request_id, signal_ids, window, pixel_width})`.
- CSV acquisition: unchanged one-off `querySamples({request_id, signal_ids, window, max_points})`.

- [ ] **Step 1: Add a shell regression test for independent targets**

Extract the tile query calculation into a private helper and test that 1 and 10,000 signals receive the same target:

```rust
#[test]
fn tile_target_does_not_shrink_with_series_count() {
    assert_eq!(per_series_target(1_920), 1_920);
}
```

The helper is intentionally cardinality-free:

```rust
fn per_series_target(pixel_width: u32) -> u32 { pixel_width.max(1) }
```

- [ ] **Step 2: Run the shell test to verify the old request code fails to compile against v19**

Run: `./scripts/test.sh shell tile_target_does_not_shrink_with_series_count`

Expected: FAIL while `request.max_total_bins` remains referenced.

- [ ] **Step 3: Remove budget division in both hosts**

Native calls:

```rust
let query = pyramid.query_with_target(
    request.window.t0,
    request.window.t1,
    per_series_target(request.pixel_width),
    None,
);
```

Update `bench_tile_wire_cost` to request the full 1,920-pixel target for every
series; it must not divide a panel budget by the series count. Update protocol
default/request tests in `protocol/src/lib.rs` to assert `pixel_width` and no
longer mention `max_total_bins`.

`BakedPlane.queryTiles` calls `queryPyramidRange` without `maxBins`. Remove the
optional `maxBins` parameter from `queryPyramidRange` and
`queryPyramidColumns`; no time-only caller retains a panel budget.

- [ ] **Step 4: Collapse `AppShell.refreshTilesPass`**

Delete `MODE_DATA`, `sampleCapFor`, `sampleCapForPanel`, XY fallback/context caches, hi-resolution merge, density-emphasis fetches, `samplesByPanel`, and all sample-mode request branches. For each panel, resolve plotted IDs, query one padded tile window at `TileWindowCache.requestPixelWidth(...)`, and cache it. Keep the separate CSV export method that calls `plane.querySamples`.

- [ ] **Step 5: Simplify workspace rendering signatures**

Change `WorkspaceView.renderData` to accept only tile map, window resolver, missing resolver, and revision. Delete `setLocalCursor` and local-axis edit support; x-axis editing remains the time label only.

- [ ] **Step 6: Verify acquisition and export**

Run: `./scripts/test.sh shell query_tiles`

Run: `./scripts/test.sh unit frontend/src/app/data-plane.test.ts frontend/src/app/tile-window-cache.test.ts frontend/src/app/csv-export.test.ts frontend/src/ui/app-shell.test.ts`

Expected: PASS; `querySamples` tests remain because CSV still uses them.

- [ ] **Step 7: Commit**

```bash
git add shell/src-tauri/src/lib.rs core/scope-core/src/benchmarks/mod.rs frontend/src/app/data-plane.ts frontend/src/app/data-plane.test.ts frontend/src/app/pyramid-query.ts frontend/src/app/pyramid-query.test.ts frontend/src/app/tile-window-cache.ts frontend/src/app/tile-window-cache.test.ts frontend/src/app/budgets.ts frontend/src/app/budgets.test.ts frontend/src/app/sample-window-cache.ts frontend/src/app/sample-window-cache.test.ts frontend/src/app/xy-samples.ts frontend/src/app/xy-samples.test.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/ui/workspace-view.ts
git commit -m "perf(plot): give every time series a viewport target"
```

### Task 6: Remove Density and Arbitrary-Path Rendering

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`
- Modify: `frontend/src/render/canvas-renderer.test.ts`
- Delete: `frontend/src/render/density-policy.ts`
- Delete: `frontend/src/render/density-policy.test.ts`
- Delete: `frontend/src/render/density-raster.ts`
- Delete: `frontend/src/render/density-raster.test.ts`
- Delete: `frontend/src/app/xy.ts`
- Delete: `frontend/src/app/xy.test.ts`
- Delete: `frontend/src/app/xy-hit.ts`
- Delete: `frontend/src/app/xy-hit.test.ts`
- Delete: `frontend/src/app/spectrum.ts`
- Delete: `frontend/src/app/spectrum.test.ts`
- Delete: `frontend/src/app/histogram.ts`
- Delete: `frontend/src/app/histogram.test.ts`
- Modify: `frontend/src/app/csv-export.ts`

**Interfaces:**

- Preserves: `CanvasRenderer.render(response, xRange, options): number`, `lastLayout`, theme invalidation, and palette injection.
- Deletes: `renderPaths`, density canvas/factory, band/ribbon paths, colorbar, sequential ramp, and arbitrary `PlotPath` types.

- [ ] **Step 1: Delete non-time renderer tests**

Keep tests for axes, clipped time strokes, gaps, extrema, style/emphasis, theme, and deterministic layout. Delete tests for raster density, starved ribbons, XY vertex paths, markers, logarithmic FFT axes, histogram stairs, and colorbars.

- [ ] **Step 2: Simplify the renderer**

In `render`, remove `densityMode`, `drawDensity`, `starvedEnvelope`, all band grouping, and the style-homogeneous `Path2D` merge that changes alpha membership. Every series calls `drawSeries` once in response order. This is intentionally slower but faithful until Phase 3 replaces it.

- [ ] **Step 3: Preserve CSV interpolation locally**

Move the small `lerpSample` function needed by `csv-export.ts` into that file. Do not retain `xy.ts` merely for one helper.

- [ ] **Step 4: Run renderer and CSV tests**

Run: `./scripts/test.sh unit frontend/src/render/canvas-renderer.test.ts frontend/src/app/csv-export.test.ts`

Expected: PASS, and no density/path test files remain.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/render frontend/src/app/csv-export.ts frontend/src/app/xy.ts frontend/src/app/xy.test.ts frontend/src/app/xy-hit.ts frontend/src/app/xy-hit.test.ts frontend/src/app/spectrum.ts frontend/src/app/spectrum.test.ts frontend/src/app/histogram.ts frontend/src/app/histogram.test.ts
git commit -m "refactor(renderer): remove aggregate and non-time drawing"
```

### Task 7: Make Snapshot Export and End-to-End Fixtures Time-Only

**Files:**

- Modify: `core/scope-core/src/snapshot.rs`
- Modify: `frontend/tests/e2e/fixtures/roundtrip.signalscope`
- Modify: `examples/bench/smoke.workspace.json`
- Modify: `examples/bench/mc1000.workspace.json`
- Delete: `examples/bench/mc1000-modes.workspace.json`
- Delete: `frontend/tests/e2e/modes.spec.ts`
- Delete: `frontend/tests/bench/bench-modes.spec.ts`
- Modify: `frontend/tests/e2e/workbench.spec.ts`
- Modify: `frontend/tests/e2e/interactions.spec.ts`
- Modify: `frontend/tests/e2e/snapshot-roundtrip.spec.ts`
- Modify: `scripts/test.sh`

**Interfaces:**

- Snapshot selection resolves panel bindings only; there are no mode-only axis signals and no sample-mode raw-level override.

- [ ] **Step 1: Rewrite snapshot tests before implementation**

Delete tests for sample-mode raw forcing and XY axis/color signal selection. Keep tests for binding selection, named sets, visible/all range, fidelity ceilings, deterministic injection, escaping, and size estimation. Panel fixtures use the v22 shape.

- [ ] **Step 2: Simplify snapshot planning**

`effective_window` uses linked time whenever linked, otherwise `panel.time_window`. `panel_signal_ids` resolves bindings only. `signal_plan` chooses by export fidelity only. Remove all `PanelMode` imports and `needs_raw` sets.

- [ ] **Step 3: Update every checked-in workspace fixture**

Remove the deleted panel keys rather than setting them to null/default. Change annotations to omit `domain`. Delete the modes workspace.

- [ ] **Step 4: Remove the modes benchmark bake**

Delete the `modes_args`, `SIGNALSCOPE_BENCH_MODES_FILES`, `mc1000-modes.html`, and `bake_modes` section from `bench_e2e` in `scripts/test.sh`. Keep the full mc1000 time benchmark.

- [ ] **Step 5: Run phase validation**

Run: `./scripts/format.sh`

Run: `./scripts/test.sh core snapshot`

Run: `./scripts/test.sh frontend`

Run: `./scripts/test.sh quick`

Run: `./scripts/test.sh shell`

Expected: all non-GUI checks PASS. GUI, platform-build, and end-to-end testing remain deferred until Phase 4 completes the full implementation plan.

- [ ] **Step 6: Run deletion gates**

Run:

```bash
! rg -n 'PanelMode|mode-pill|plotModeModule|MODE_DATA|TILE_BIN_BUDGET|max_total_bins|densityMode|renderPaths|x_ref|color_ref|color_axis|c_label|axis_equal|mc1000-modes' frontend core shell protocol examples scripts
! rg -n 'xy|fft|histogram' frontend/src frontend/tests protocol/schema core/scope-core/src/session.rs core/scope-core/src/snapshot.rs
```

Expected: both commands exit 0. Any match must be removed or, for a legitimate unrelated substring, narrowed with an explicit path-specific gate rather than ignored.

- [ ] **Step 7: Commit**

```bash
git add core/scope-core/src/snapshot.rs frontend/tests examples/bench scripts/test.sh
git commit -m "test(plot): retire non-time fixtures and benchmarks"
```

## Phase 1 Completion Gate

Run:

```bash
./scripts/format.sh --check
./scripts/test.sh quick
./scripts/test.sh shell
git diff --check
git status --short
```

Expected: formatting, core/frontend quick checks, and shell tests pass; only intentional work is present. Do not bump the application version and do not begin Phase 2 unless the temporary Canvas time-plot behavior is covered and passing.

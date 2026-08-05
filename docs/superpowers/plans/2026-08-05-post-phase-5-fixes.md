# Post-Phase 5 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the nine defects in `docs/issues/post-phase-5-issues.md` (plus the tile-density staircase found while investigating them) as one reviewable PR, without restructuring the renderer.

**Architecture:** Nine independent tasks on one branch, ordered smallest-blast-radius first. Two carry schema changes: session v20 → v21 (`axis_equal` on `PanelState`) and preferences v3 → v4 (`theme`). Everything else is additive or local. The renderer keeps its two entry points (`render` for envelope bins, `renderPaths` for vertex polylines); unifying them is explicitly out of scope and deferred to a separate architecture spec.

**Tech Stack:** Rust (`scope-core`, `scope-protocol`, `signalscope-shell`), TypeScript (frontend, Vitest), Canvas2D. No new workspace dependencies.

## Global Constraints

- Every command goes through a `./scripts/` wrapper. Run `./scripts/format.sh` before staging each commit; the pre-commit hook formats but does not re-stage.
- No new workspace dependencies. `unsafe_code = "forbid"`; clippy `all` + `pedantic` at warn; CI runs `-D warnings`.
- `protocol/schema/*.json` are the only schema sources. Regenerate with `./scripts/codegen.sh`. Never hand-edit `protocol/src/generated.rs`, `core/scope-core/src/session/generated.rs`, `core/scope-core/src/preferences/generated.rs`, `frontend/src/generated/*.ts`.
- Session schema changes need a migration rung in `core/scope-core/src/session.rs::migrate`. Additive **optional** fields need no rung; a new **required** field does.
- Pyramid invariants are law: parent bins preserve first/last/finite min-max/count/gap-OR; `has_gap` breaks a stroke and never discards extrema; query density is bounded by viewport width; the renderer never scans raw arrays for ordinary pan/zoom.
- The renderer stays deterministic from tiles + viewport + tokens. `TauriPlane` and `BakedPlane` implement the same `DataPlane` contract; UI code never branches on host identity.
- Snapshots stay self-contained, offline, and within the export budget.
- Chrome is achromatic; amber is interaction-only. New controls reuse the existing `.panel-action` treatment — no new visual language.
- Defer GUI, platform-build, and e2e testing until every task is done. Run `./scripts/ci.sh e2e` once at the end.
- The PR ends with `./scripts/version.sh bump minor` + `./scripts/version.sh check` as its final commit (Task 10). No intermediate bumps.

## File Structure

**New files**

- `frontend/src/app/sample-window-cache.ts` — per-panel sample-response cache (Task 4)
- `frontend/src/app/sample-window-cache.test.ts` — its unit tests (Task 4)
- `docs/adr/0037-per-mode-sample-budgets.md` — records the per-mode cap policy and the deferred 2D reduction (Task 10)

**Modified**

- `frontend/src/app/tile-window-cache.ts` — density-corrected request width (Task 1)
- `frontend/src/render/canvas-renderer.ts` — ramp bucketing, inlined projection, equal-aspect (Tasks 2, 3)
- `frontend/src/app/colormap.ts` — expose the ramp's step quantiser (Task 2)
- `protocol/schema/scope-session.json` + `core/scope-core/src/session.rs` — `axis_equal` (Task 3)
- `frontend/src/app/workspace.ts`, `frontend/src/ui/panel.ts`, `frontend/src/ui/app-shell.ts` — `axis_equal` plumbing (Task 3)
- `frontend/src/ui/app-shell.ts` — sample cache, ingest banner, theme, caps (Tasks 4, 5, 6, 9)
- `protocol/schema/scope-preferences.json` + `core/scope-core/src/preferences.rs` — `theme` (Task 6)
- `core/scope-core/src/ingest/batch.rs` — parallel admission (Task 7)
- `frontend/src/app/spectrum.ts` — `MAX_SIZE` (Task 9)
- `docs/issues/post-phase-5-issues.md` — close out (Task 10)

## Scope boundaries

**In scope:** the nine defects below, at the smallest correct fix for each.

**Explicitly deferred to the renderer architecture spec — do not build here:**

- Unifying `render()` and `renderPaths()` behind one `VertexBatch` primitive.
- 2D trajectory-preserving reduction for XY (a panel-level reduction over a shared index set; per-signal min/max is wrong — see Task 9's note).
- Device-pixel (rather than CSS-pixel) column snapping in `appendSeriesPath`.
- Density/aggregate raster rendering for >138-series panels, where the `TILE_BIN_BUDGET / N` split genuinely starves resolution below one bin per pixel.
- Welch or core-side FFT decimation.

---

## Task 1: Correct tile density across the padded cache window

`TileWindowCache.padWindow` requests a window 2×–4× the visible span but `refreshTilesPass` still passes the unmodified panel width as `pixel_width`. The server spreads `2 × pixel_width` bins across the padded window; the client slices out the visible quarter-to-half, leaving 0.5–1 bin per CSS pixel. That is the staircase.

**Files:**

- Modify: `frontend/src/app/tile-window-cache.ts` (after `padWindow`, ~line 19)
- Modify: `frontend/src/ui/app-shell.ts:2624-2640`
- Test: `frontend/src/app/tile-window-cache.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `TileWindowCache.requestPixelWidth(panelWidth: number, visible: {t0: number, t1: number}, padded: {t0: number, t1: number}): number`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/app/tile-window-cache.test.ts`:

```ts
describe("requestPixelWidth", () => {
  it("scales the request by the padding ratio so the visible slice keeps its density", () => {
    const visible = { t0: 0, t1: 100 };
    const padded = TileWindowCache.padWindow(visible.t0, visible.t1);
    const paddedSpan = padded.t1 - padded.t0;
    expect(paddedSpan).toBeGreaterThanOrEqual(2 * 100);

    const requested = TileWindowCache.requestPixelWidth(800, visible, padded);
    expect(requested).toBe(Math.ceil(800 * (paddedSpan / 100)));
  });

  it("never returns less than the panel width", () => {
    const visible = { t0: 0, t1: 100 };
    expect(
      TileWindowCache.requestPixelWidth(800, visible, { t0: 0, t1: 100 }),
    ).toBe(800);
  });

  it("falls back to the panel width on a degenerate span", () => {
    const visible = { t0: 5, t1: 5 };
    expect(
      TileWindowCache.requestPixelWidth(800, visible, { t0: 0, t1: 16 }),
    ).toBe(800);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `./scripts/test.sh unit tile-window-cache`
Expected: FAIL — `TileWindowCache.requestPixelWidth is not a function`

- [ ] **Step 3: Implement**

In `frontend/src/app/tile-window-cache.ts`, add directly below `padWindow`:

```ts
  /**
   * The `pixel_width` a padded request must ask for so the visible slice
   * still carries the density the panel asked for. `padWindow` widens the
   * request 2x-4x; without this correction the sliced response renders at a
   * quarter to a half of pixel resolution and the trace reads as a staircase.
   */
  static requestPixelWidth(
    panelWidth: number,
    visible: { t0: number; t1: number },
    padded: { t0: number; t1: number },
  ): number {
    const visibleSpan = visible.t1 - visible.t0;
    const paddedSpan = padded.t1 - padded.t0;
    if (
      !Number.isFinite(visibleSpan) ||
      !Number.isFinite(paddedSpan) ||
      visibleSpan <= 0 ||
      paddedSpan <= visibleSpan
    ) {
      return panelWidth;
    }
    return Math.ceil(panelWidth * (paddedSpan / visibleSpan));
  }
```

- [ ] **Step 4: Wire it into the refresh pass**

In `frontend/src/ui/app-shell.ts`, replace the `queryTiles` call in `refreshTilesPass` (currently lines 2624-2634) with:

```ts
const paddedWindow = TileWindowCache.padWindow(window.t0, window.t1);
const response = await this.plane.queryTiles({
  request_id: crypto.randomUUID(),
  signal_ids: ids,
  window: paddedWindow,
  pixel_width: TileWindowCache.requestPixelWidth(
    pixelWidth,
    window,
    paddedWindow,
  ),
  max_total_bins: TILE_BIN_BUDGET,
});
```

Leave the `this.tileWindowCache.store(...)` call below it unchanged — it stores `pixelWidth` (the panel width), which is what `slice()` compares against on later frames, and that comparison must keep using the panel width.

- [ ] **Step 5: Run the tests**

Run: `./scripts/test.sh unit tile-window-cache && ./scripts/test.sh unit app-shell`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
./scripts/format.sh
git add frontend/src/app/tile-window-cache.ts frontend/src/app/tile-window-cache.test.ts frontend/src/ui/app-shell.ts
git commit -m "fix(frontend): keep tile density across the padded cache window

padWindow widens a request 2x-4x but the request kept the panel pixel
width, so the sliced visible response carried 0.5-1 bin per CSS pixel and
rendered as a staircase."
```

---

## Task 2: Bucket colour-mapped paths by ramp step

`drawColorMappedPath` issues `beginPath`/`moveTo`/`lineTo`/`stroke` per vertex pair. The ramp is already quantised to 64 steps, so a path of any length needs at most 65 strokes.

**Files:**

- Modify: `frontend/src/app/colormap.ts` (after `RAMP_STEPS`, line 60)
- Modify: `frontend/src/render/canvas-renderer.ts:494-530`
- Test: `frontend/src/app/colormap.test.ts`, `frontend/src/render/canvas-renderer.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `ColormapRamp.stepAt(t: number): number` (integer in `[0, RAMP_STEPS]`), `ColormapRamp.atStep(step: number): string`, exported `RAMP_STEPS`.

- [ ] **Step 1: Write the failing ramp test**

Append to `frontend/src/app/colormap.test.ts`:

```ts
describe("ColormapRamp.stepAt", () => {
  const ramp = new ColormapRamp(["#000000", "#ffffff"]);

  it("quantises to the ramp's fixed steps", () => {
    expect(ramp.stepAt(0)).toBe(0);
    expect(ramp.stepAt(1)).toBe(RAMP_STEPS);
    expect(ramp.stepAt(0.5)).toBe(RAMP_STEPS / 2);
  });

  it("clamps outside [0,1] and on NaN", () => {
    expect(ramp.stepAt(-3)).toBe(0);
    expect(ramp.stepAt(9)).toBe(RAMP_STEPS);
    expect(ramp.stepAt(Number.NaN)).toBe(0);
  });

  it("agrees with at() for every step", () => {
    for (let step = 0; step <= RAMP_STEPS; step += 1) {
      expect(ramp.atStep(step)).toBe(ramp.at(step / RAMP_STEPS));
    }
  });
});
```

Add `RAMP_STEPS` and `ColormapRamp` to the file's existing import from `./colormap`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `./scripts/test.sh unit colormap`
Expected: FAIL — `RAMP_STEPS` is not exported / `stepAt is not a function`

- [ ] **Step 3: Implement the quantiser**

In `frontend/src/app/colormap.ts`, change line 60 from `const RAMP_STEPS = 64;` to:

```ts
export const RAMP_STEPS = 64;
```

and replace the body of `ColormapRamp` below the constructor with:

```ts
  /** The step index `t` falls in; clamped outside [0,1] and on NaN. */
  stepAt(t: number): number {
    if (!Number.isFinite(t)) return 0;
    return Math.round(clamp(t, 0, 1) * RAMP_STEPS);
  }

  atStep(step: number): string {
    return this.steps[step] ?? this.steps[0] ?? "#000000";
  }

  at(t: number): string {
    return this.atStep(this.stepAt(t));
  }
```

- [ ] **Step 4: Run the ramp test**

Run: `./scripts/test.sh unit colormap`
Expected: PASS

- [ ] **Step 5: Write the failing renderer test**

Append to `frontend/src/render/canvas-renderer.test.ts`, following the fake-context pattern already used in that file:

```ts
it("strokes a colour-mapped path once per ramp bucket, not once per segment", () => {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 600 });
  Object.defineProperty(canvas, "clientHeight", { value: 400 });
  const renderer = new CanvasRenderer(canvas);
  renderer.setPalette(testPalette());

  const vertices = 5000;
  const points: number[] = [];
  const colorValues: number[] = [];
  for (let index = 0; index < vertices; index += 1) {
    points.push(index, Math.sin(index / 50));
    colorValues.push(index / (vertices - 1));
  }

  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  const strokes = vi.spyOn(context, "stroke");

  renderer.renderPaths(
    [{ points, colorValues, hue: 1, dash: "solid", width: 1.2, alpha: 1 }],
    {
      xLabel: "x",
      yLabel: "y",
      xRange: [0, vertices],
      yRange: [-1, 1],
    },
  );

  // 64 ramp steps -> at most 65 buckets, plus the axis furniture's strokes.
  expect(strokes.mock.calls.length).toBeLessThanOrEqual(80);
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `./scripts/test.sh unit canvas-renderer`
Expected: FAIL — the stroke count is in the thousands

- [ ] **Step 7: Replace `drawColorMappedPath`**

In `frontend/src/render/canvas-renderer.ts`, replace the whole method (lines 494-530) with:

```ts
  /**
   * Strokes a `c:` path in one pass per ramp bucket. The ramp is quantised to
   * `RAMP_STEPS`, so a path of any length carries at most `RAMP_STEPS + 1`
   * distinct colours; bucketing turns thousands of per-segment strokes into
   * that many.
   */
  private drawColorMappedPath(
    context: CanvasRenderingContext2D,
    project: Projection,
    path: PlotPath,
    colors: Palette,
  ): void {
    const values = path.colorValues ?? [];
    const vertices = path.points.length >> 1;
    if (vertices < 2) return;
    // Destructured once, as `appendSeriesPath` already does: this loop would
    // otherwise re-read both properties off `project` per vertex.
    const { toX, toY } = project;
    const ramp = this.ramp(colors);
    const buckets: (Path2D | undefined)[] = new Array<Path2D | undefined>(
      RAMP_STEPS + 1,
    );
    let previousX = Number.NaN;
    let previousY = Number.NaN;
    let previousFinite = false;
    for (let index = 0; index < vertices; index += 1) {
      const x = path.points[index * 2] ?? Number.NaN;
      const y = path.points[index * 2 + 1] ?? Number.NaN;
      const finite = Number.isFinite(x) && Number.isFinite(y);
      const px = finite ? toX(x) : Number.NaN;
      const py = finite ? toY(y) : Number.NaN;
      if (finite && previousFinite) {
        // Midpoint of the segment's two scalars keeps the ramp continuous.
        const scalar =
          ((values[index - 1] ?? 0) + (values[index] ?? 0)) * 0.5;
        const step = ramp.stepAt(scalar);
        const bucket = (buckets[step] ??= new Path2D());
        bucket.moveTo(previousX, previousY);
        bucket.lineTo(px, py);
      }
      previousX = px;
      previousY = py;
      previousFinite = finite;
    }
    context.lineWidth = path.width;
    context.setLineDash(dashPattern(path.dash));
    context.lineCap = "round";
    for (let step = 0; step <= RAMP_STEPS; step += 1) {
      const bucket = buckets[step];
      if (bucket === undefined) continue;
      context.strokeStyle = ramp.atStep(step);
      context.stroke(bucket);
    }
    context.lineCap = "butt";
    context.setLineDash([]);
  }
```

Add `RAMP_STEPS` to the existing `../app/colormap` import at the top of the file.

Note the behaviour change this locks in: segments are now stroked in ramp order rather than path order, so where a trajectory crosses itself the higher ramp step wins. That is stable frame to frame and therefore still deterministic.

- [ ] **Step 8: Hoist the projection lookups in `drawPath`**

Issue 1 also names the plain XY path. `drawPath` (`canvas-renderer.ts:427`) reads `project.toX` and `project.toY` off the object per vertex, and again per marker. Destructure once at the top of the method, matching `appendSeriesPath:775`:

```ts
const { toX, toY } = project;
```

and replace every `project.toX(` / `project.toY(` in the method body with `toX(` / `toY(`. There are four call sites: two in the stroke loop, two in the marker loop.

This is a property-lookup fix, not a projection rewrite. Eliminating the closure call itself needs the plot rectangle and range threaded into the loop, which is the unified-vertex-path work deferred to the architecture spec.

- [ ] **Step 9: Run the renderer tests**

Run: `./scripts/test.sh unit canvas-renderer && ./scripts/test.sh unit colormap`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
./scripts/format.sh
git add frontend/src/app/colormap.ts frontend/src/app/colormap.test.ts frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts
git commit -m "perf(render): bucket colour-mapped paths by ramp step

The ramp already quantises to 64 steps, so a c: path needs at most 65
strokes rather than one per vertex pair."
```

---

## Task 3: `axis equal` for XY panels

No aspect control exists; XY x and y ranges resolve independently. Add a MATLAB-style per-panel toggle applied in `beginFrame`, after the plot rectangle is known, so it survives zoom, pan, fit, and resize without any caller recomputing ranges.

**Files:**

- Modify: `protocol/schema/scope-session.json:121-146`
- Modify: `core/scope-core/src/session.rs` (migration ladder, ~line 218)
- Modify: `frontend/src/render/canvas-renderer.ts` (`FrameSpec`, `PathRenderOptions`, `beginFrame`)
- Modify: `frontend/src/app/workspace.ts` (after `toggleAxisStyle`, ~line 886)
- Modify: `frontend/src/ui/panel.ts` (header markup ~line 2854, listeners ~line 685, sync ~line 903, XY options ~line 1188)
- Modify: `frontend/src/ui/app-shell.ts` (panel callbacks ~line 438, command ~line 823)
- Test: `core/scope-core/src/session.rs` tests, `frontend/src/app/workspace.test.ts`, `frontend/src/render/canvas-renderer.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `PanelState.axis_equal: boolean`; `Workspace.toggleAxisEqual(id: string): void`; `PathRenderOptions.equalAspect?: boolean`; `PanelCallbacks.onToggleAxisEqual(id: string): void`.

- [ ] **Step 1: Add the field to the schema and bump the version**

In `protocol/schema/scope-session.json`, change `"schema_version": 20` to `"schema_version": 21`, and add to `PanelState.fields` immediately after `"show_stats": "bool"`:

```json
        "axis_equal": "bool"
```

(remember the comma after `"show_stats": "bool"`).

- [ ] **Step 2: Regenerate**

Run: `./scripts/codegen.sh`
Expected: `core/scope-core/src/session/generated.rs` gains `pub axis_equal: bool` and `SESSION_SCHEMA_VERSION` becomes 21; `frontend/src/generated/session.ts` gains `axis_equal: boolean`.

- [ ] **Step 3: Write the failing migration test**

Append to the `tests` module in `core/scope-core/src/session.rs`:

```rust
    #[test]
    fn v20_panels_gain_axis_equal_disabled() {
        let mut value = serde_json::to_value(Session::default()).unwrap();
        value["schema_version"] = serde_json::json!(20);
        for tab in value["tabs"].as_array_mut().unwrap() {
            for panel in tab["panels"].as_array_mut().unwrap() {
                panel.as_object_mut().unwrap().remove("axis_equal");
            }
        }
        let restored = from_json(&value.to_string()).expect("migrates from v20");
        assert_eq!(restored.schema_version, SESSION_SCHEMA_VERSION);
        assert!(restored.tabs.iter().flat_map(|tab| &tab.panels).all(|panel| !panel.axis_equal));
    }
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `./scripts/test.sh core v20_panels_gain_axis_equal`
Expected: FAIL — `UnsupportedVersion(20)`

- [ ] **Step 5: Add the migration rung**

In `core/scope-core/src/session.rs::migrate`, insert this arm immediately before the `SESSION_SCHEMA_VERSION => ...` arm:

```rust
        20 => {
            if let Some(tabs) = value.get_mut("tabs").and_then(serde_json::Value::as_array_mut) {
                for tab in tabs {
                    let Some(panels) = tab.get_mut("panels").and_then(serde_json::Value::as_array_mut)
                    else {
                        continue;
                    };
                    for panel in panels {
                        if let Some(object) = panel.as_object_mut() {
                            object
                                .entry("axis_equal")
                                .or_insert(serde_json::Value::Bool(false));
                        }
                    }
                }
            }
            value["schema_version"] = serde_json::json!(21);
            migrate(21, value)
        }
```

- [ ] **Step 6: Run the Rust tests**

Run: `./scripts/test.sh core session`
Expected: PASS. Regenerate the cross-host fixture if `session_conformance` fails:
`REGENERATE_FIXTURES=1 ./scripts/test.sh core session_conformance` then re-run without the variable.

- [ ] **Step 7: Write the failing renderer test**

Append to `frontend/src/render/canvas-renderer.test.ts`:

```ts
it("equalises the pixel scale of both axes when equalAspect is set", () => {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 600 });
  Object.defineProperty(canvas, "clientHeight", { value: 300 });
  const renderer = new CanvasRenderer(canvas);
  renderer.setPalette(testPalette());

  renderer.renderPaths(
    [{ points: [0, 0, 10, 10], hue: 1, dash: "solid", width: 1, alpha: 1 }],
    {
      xLabel: "x",
      yLabel: "y",
      xRange: [0, 10],
      yRange: [0, 10],
      equalAspect: true,
    },
  );

  const layout = renderer.lastLayout();
  expect(layout).not.toBeNull();
  const { plot, xRange, yRange } = layout as NonNullable<
    ReturnType<CanvasRenderer["lastLayout"]>
  >;
  const xScale = plot.width / (xRange.max - xRange.min);
  const yScale = plot.height / (yRange.max - yRange.min);
  expect(xScale).toBeCloseTo(yScale, 6);
  // The wider axis is padded, never narrowed.
  expect(xRange.max - xRange.min).toBeGreaterThanOrEqual(10);
  expect(yRange.max - yRange.min).toBeGreaterThanOrEqual(10);
});

it("leaves ranges untouched when equalAspect is absent", () => {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 600 });
  Object.defineProperty(canvas, "clientHeight", { value: 300 });
  const renderer = new CanvasRenderer(canvas);
  renderer.setPalette(testPalette());
  renderer.renderPaths(
    [{ points: [0, 0, 10, 10], hue: 1, dash: "solid", width: 1, alpha: 1 }],
    { xLabel: "x", yLabel: "y", xRange: [0, 10], yRange: [0, 10] },
  );
  const layout = renderer.lastLayout();
  expect(layout?.xRange).toEqual({ min: 0, max: 10 });
  expect(layout?.yRange).toEqual({ min: 0, max: 10 });
});
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `./scripts/test.sh unit canvas-renderer`
Expected: FAIL — `equalAspect` is not a known property / scales differ

- [ ] **Step 9: Implement equal aspect in the renderer**

In `frontend/src/render/canvas-renderer.ts`:

Add to `interface FrameSpec` (after `rightGutter?: number`):

```ts
  /** Pads the axis with the smaller pixel-per-unit scale so both match. */
  equalAspect?: boolean;
```

Add the same field to the exported `PathRenderOptions` interface.

In `beginFrame`, immediately after the `plot` rectangle is computed and **before** the `layout` object is built, insert:

```ts
const ranges =
  spec.equalAspect === true
    ? equalisedRanges(spec.xRange, spec.yRange, plot)
    : { xRange: spec.xRange, yRange: spec.yRange };
```

Then build `layout` from `ranges.xRange` / `ranges.yRange` instead of `spec.xRange` / `spec.yRange`, and use `ranges.yRange` in place of `spec.yRange` in the `drawGrid` and `finishAxes` calls below it.

Add this module-level helper near the other geometry helpers:

```ts
/**
 * Pads the axis with the coarser pixel-per-unit scale until both axes agree,
 * so one data unit is the same number of pixels horizontally and vertically
 * (MATLAB's `axis equal`). Only ever widens: narrowing would hide data that
 * the stored range says is in view.
 */
function equalisedRanges(
  xRange: Range,
  yRange: Range,
  plot: PlotRect,
): { xRange: Range; yRange: Range } {
  const xSpan = xRange.max - xRange.min;
  const ySpan = yRange.max - yRange.min;
  if (!(xSpan > 0) || !(ySpan > 0) || !(plot.width > 0) || !(plot.height > 0)) {
    return { xRange, yRange };
  }
  const xScale = plot.width / xSpan;
  const yScale = plot.height / ySpan;
  if (xScale === yScale) return { xRange, yRange };
  if (xScale > yScale) {
    // x is drawn finer: widen x until its scale drops to y's.
    const target = plot.width / yScale;
    const pad = (target - xSpan) / 2;
    return {
      xRange: { min: xRange.min - pad, max: xRange.max + pad },
      yRange,
    };
  }
  const target = plot.height / xScale;
  const pad = (target - ySpan) / 2;
  return {
    xRange,
    yRange: { min: yRange.min - pad, max: yRange.max + pad },
  };
}
```

Because `this.layout` is published from the equalised ranges, hit testing, cursor readout, pan, and zoom all operate on what is actually drawn. No gesture code changes.

- [ ] **Step 10: Run the renderer tests**

Run: `./scripts/test.sh unit canvas-renderer`
Expected: PASS

- [ ] **Step 11: Write the failing workspace test**

Append to `frontend/src/app/workspace.test.ts`, alongside the existing `toggleStats` test:

```ts
it("toggles axis_equal per panel", () => {
  const model = new Workspace();
  const panel = model.panels()[0]!;
  expect(panel.axis_equal).toBe(false);
  model.toggleAxisEqual(panel.id);
  expect(model.panel(panel.id)?.axis_equal).toBe(true);
  model.toggleAxisEqual(panel.id);
  expect(model.panel(panel.id)?.axis_equal).toBe(false);
});
```

- [ ] **Step 12: Run it to confirm it fails**

Run: `./scripts/test.sh unit workspace`
Expected: FAIL — `model.toggleAxisEqual is not a function`

- [ ] **Step 13: Implement the workspace toggle**

In `frontend/src/app/workspace.ts`, add `axis_equal: false` to the panel factory (beside `show_stats: false`, ~line 1000), and add directly after `toggleAxisStyle`:

```ts
  toggleAxisEqual(id: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) {
      panel.axis_equal = !panel.axis_equal;
      this.touch();
    }
  }
```

- [ ] **Step 14: Add the panel control**

In `frontend/src/ui/panel.ts`:

Markup — insert immediately after the `.panel-axis-toggle` button (~line 2854):

```html
<button
  class="panel-action panel-aspect-toggle"
  type="button"
  aria-pressed="false"
  hidden
  title="Equal axis scaling (XY only)"
>
  1:1
</button>
```

Listener — insert after the `.panel-axis-toggle` listener (~line 685):

```ts
required(this.element, ".panel-aspect-toggle").addEventListener("click", () => {
  this.callbacks.onToggleAxisEqual(this.id);
});
```

Sync — insert after the `axisToggle` block (~line 907):

```ts
const aspectToggle = required<HTMLButtonElement>(
  this.element,
  ".panel-aspect-toggle",
);
aspectToggle.hidden = rendered.mode !== "xy";
aspectToggle.setAttribute("aria-pressed", String(rendered.axis_equal));
```

Render — in the XY `options` object (~line 1202, beside `axisStyle`), add:

```ts
      ...(state.axis_equal ? { equalAspect: true } : {}),
```

Add `axis_equal: boolean` to `RenderPanelState` and set it from the panel state wherever that interface is populated.

Add `onToggleAxisEqual(id: string): void` to the panel callbacks interface.

`RenderPanelState` is `Omit<PanelState, "x_ref" | "color_ref"> & {...}` (`panel.ts:187`), so it inherits `axis_equal` from the regenerated `PanelState` with no edit.

- [ ] **Step 15: Wire the shell**

In `frontend/src/ui/app-shell.ts`, beside the existing `onToggleAxisStyle` callback (~line 438):

```ts
        onToggleAxisEqual: (id) => {
          this.workspace.toggleAxisEqual(id);
          this.markHistoryDirty(`aspect:${id}`);
          this.afterLayoutChange();
        },
```

and beside the `toggleAxisStyle` command (~line 823):

```ts
this.workspace.toggleAxisEqual(id);
```

registered as a command with the id `panel.toggle-axis-equal` and the label `Toggle equal axis scaling`, following the shape of the neighbouring command entries. Keyboard access comes free through the command palette, satisfying the "right-click is never the only path" rule.

- [ ] **Step 16: Run the affected suites**

Run: `./scripts/test.sh unit workspace && ./scripts/test.sh unit panel && ./scripts/test.sh unit app-shell && ./scripts/test.sh core session`
Expected: PASS

- [ ] **Step 17: Commit**

```bash
./scripts/format.sh
git add protocol/schema/scope-session.json core/scope-core/src/session.rs core/scope-core/src/session/generated.rs frontend/src/generated/session.ts frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts protocol/testdata/session-conformance.json
git commit -m "feat(panels): add axis equal for XY panels

Session v21 carries axis_equal per panel. The renderer pads the axis with
the coarser pixel scale in beginFrame, so the equalised ranges are the
ones published to layout and every gesture follows them."
```

---

## Task 4: Cache sample responses across mode switches

Time panels have `tileWindowCache`; sample-mode panels have nothing, so tabbing through plot types re-queries everything on each switch.

**Files:**

- Create: `frontend/src/app/sample-window-cache.ts`
- Create: `frontend/src/app/sample-window-cache.test.ts`
- Modify: `frontend/src/ui/app-shell.ts` (field beside `tileWindowCache` line 168; `reloadSignals` line 2554; `refreshTilesPass` lines 2651-2676)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `SampleWindowCache` with `get(panelId, key): SampleResponse | null`, `store(panelId, key, response): void`, `invalidate(panelId?): void`, and the static `SampleWindowCache.key(parts: {ids: readonly string[], mode: string, window: {t0: number, t1: number}, cap: number}): string`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/sample-window-cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SampleWindowCache } from "./sample-window-cache";
import type { SampleResponse } from "../generated/protocol";

const response = (id: string): SampleResponse => ({
  request_id: id,
  series: [],
});

const key = (over: Partial<Parameters<typeof SampleWindowCache.key>[0]> = {}) =>
  SampleWindowCache.key({
    ids: ["1", "2"],
    mode: "xy",
    window: { t0: 0, t1: 10 },
    cap: 8192,
    ...over,
  });

describe("SampleWindowCache", () => {
  it("returns a stored response for an identical key", () => {
    const cache = new SampleWindowCache();
    cache.store("panel", key(), response("a"));
    expect(cache.get("panel", key())?.request_id).toBe("a");
  });

  it("is insensitive to signal id order", () => {
    const cache = new SampleWindowCache();
    cache.store("panel", key({ ids: ["1", "2"] }), response("a"));
    expect(cache.get("panel", key({ ids: ["2", "1"] }))?.request_id).toBe("a");
  });

  it("misses on a different mode, window, or cap", () => {
    const cache = new SampleWindowCache();
    cache.store("panel", key(), response("a"));
    expect(cache.get("panel", key({ mode: "fft" }))).toBeNull();
    expect(cache.get("panel", key({ window: { t0: 0, t1: 11 } }))).toBeNull();
    expect(cache.get("panel", key({ cap: 32768 }))).toBeNull();
  });

  it("retains entries for other panels when one is invalidated", () => {
    const cache = new SampleWindowCache();
    cache.store("a", key(), response("a"));
    cache.store("b", key(), response("b"));
    cache.invalidate("a");
    expect(cache.get("a", key())).toBeNull();
    expect(cache.get("b", key())?.request_id).toBe("b");
  });

  it("clears everything when invalidated without a panel", () => {
    const cache = new SampleWindowCache();
    cache.store("a", key(), response("a"));
    cache.invalidate();
    expect(cache.get("a", key())).toBeNull();
  });

  it("keeps at most one entry per panel", () => {
    const cache = new SampleWindowCache();
    cache.store("panel", key({ mode: "xy" }), response("a"));
    cache.store("panel", key({ mode: "fft" }), response("b"));
    expect(cache.get("panel", key({ mode: "xy" }))).toBeNull();
    expect(cache.get("panel", key({ mode: "fft" }))?.request_id).toBe("b");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `./scripts/test.sh unit sample-window-cache`
Expected: FAIL — cannot resolve `./sample-window-cache`

- [ ] **Step 3: Implement the cache**

Create `frontend/src/app/sample-window-cache.ts`:

```ts
import type { SampleResponse } from "../generated/protocol";

/**
 * One sample response per panel, keyed by everything the request depends on.
 * Sample-mode panels re-query on every `afterLayoutChange`, and a mode switch
 * is one, so tabbing xy -> fft -> histogram -> xy re-fetched the same window
 * four times. One entry per panel is enough to make the round trip free
 * without holding several copies of a capped response per panel.
 */
export class SampleWindowCache {
  private readonly entries = new Map<
    string,
    { key: string; response: SampleResponse }
  >();

  static key(parts: {
    ids: readonly string[];
    mode: string;
    window: { t0: number; t1: number };
    cap: number;
  }): string {
    return [
      [...parts.ids].sort().join(","),
      parts.mode,
      parts.window.t0,
      parts.window.t1,
      parts.cap,
    ]
      .map(String)
      .join(" ");
  }

  get(panelId: string, key: string): SampleResponse | null {
    const entry = this.entries.get(panelId);
    return entry !== undefined && entry.key === key ? entry.response : null;
  }

  store(panelId: string, key: string, response: SampleResponse): void {
    this.entries.set(panelId, { key, response });
  }

  invalidate(panelId?: string): void {
    if (panelId === undefined) this.entries.clear();
    else this.entries.delete(panelId);
  }
}
```

- [ ] **Step 4: Run the test**

Run: `./scripts/test.sh unit sample-window-cache`
Expected: PASS

- [ ] **Step 5: Wire it into the shell**

In `frontend/src/ui/app-shell.ts`:

Add beside `tileWindowCache` (line 168):

```ts
  private readonly sampleWindowCache = new SampleWindowCache();
```

Add to `reloadSignals`, directly after `this.tileWindowCache.invalidate();` (line 2554):

```ts
this.sampleWindowCache.invalidate();
```

Replace the `else` branch of `refreshTilesPass` (lines 2651-2676) with:

```ts
          } else {
            const contextWindow = this.sampleWindow(panel);
            const cap = sampleCapFor(panel.mode);
            const cacheKey = SampleWindowCache.key({
              ids,
              mode: panel.mode,
              window: panel.mode === "xy" ? window : contextWindow,
              cap,
            });
            const cached = this.sampleWindowCache.get(panel.id, cacheKey);
            if (cached !== null) {
              nextSamples.set(panel.id, cached);
              return;
            }
            const contextRequest = {
              request_id: crypto.randomUUID(),
              signal_ids: ids,
              window: contextWindow,
              max_points: cap,
            };
            let merged: SampleResponse;
            if (panel.mode === "xy") {
              const detailRequest = {
                request_id: crypto.randomUUID(),
                signal_ids: ids,
                window,
                max_points: cap,
              };
              const [context, detail] = await Promise.all([
                this.plane.querySamples(contextRequest),
                this.plane.querySamples(detailRequest),
              ]);
              merged = mergeSampleResponses(context, detail);
            } else {
              merged = await this.plane.querySamples(contextRequest);
            }
            this.sampleWindowCache.store(panel.id, cacheKey, merged);
            nextSamples.set(panel.id, merged);
          }
```

`sampleCapFor` arrives in Task 9; until then define it beside `SAMPLE_CAP` as `const sampleCapFor = (_mode: PanelMode): number => SAMPLE_CAP;`.

Note the key uses the **visible** window for XY (the detail request) because `sampleWindow(panel)` returns the full data extent there, which does not change as the user pans — keying on it alone would serve stale detail.

Import `SampleWindowCache` from `../app/sample-window-cache`.

- [ ] **Step 6: Run the affected suites**

Run: `./scripts/test.sh unit sample-window-cache && ./scripts/test.sh unit app-shell`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
./scripts/format.sh
git add frontend/src/app/sample-window-cache.ts frontend/src/app/sample-window-cache.test.ts frontend/src/ui/app-shell.ts
git commit -m "perf(frontend): cache sample responses per panel

Sample-mode panels re-queried on every layout change, so cycling plot
modes refetched the same window on each switch."
```

---

## Task 5: Dismiss and reset the ingest failure banner

`.ingest-progress` stays visible whenever `recent_failures` is non-empty, has no dismiss control, and `newWorkspace` never touches it.

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`renderBatchProgress` ~line 3313; `newWorkspace` ~line 2310; `loadSession` ~line 2385)
- Test: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `clearIngestProgress(root: HTMLElement): void` exported from `app-shell.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/ui/app-shell.test.ts`:

```ts
describe("ingest failure banner", () => {
  it("renders a dismiss control alongside failures", () => {
    const progress = document.createElement("div");
    renderBatchProgress(
      progress,
      {
        state: "done",
        done: 1,
        total: 2,
        current_paths: [],
        recent_failures: [
          {
            path: "/a/broken.csv",
            error: "no data rows",
            recipe_required: false,
          },
        ],
      },
      () => {},
    );
    const dismiss =
      progress.querySelector<HTMLButtonElement>(".ingest-dismiss");
    expect(dismiss).not.toBeNull();
    dismiss?.click();
    expect(progress.hidden).toBe(true);
    expect(progress.childElementCount).toBe(0);
  });

  it("renders no dismiss control while a batch is running", () => {
    const progress = document.createElement("div");
    renderBatchProgress(
      progress,
      {
        state: "running",
        done: 1,
        total: 4,
        current_paths: ["/a/one.csv"],
        recent_failures: [],
      },
      () => {},
    );
    expect(progress.querySelector(".ingest-dismiss")).toBeNull();
  });

  it("clearIngestProgress hides and empties the banner", () => {
    const root = document.createElement("div");
    const progress = document.createElement("div");
    progress.className = "ingest-progress";
    progress.hidden = false;
    progress.append(document.createElement("span"));
    root.append(progress);
    clearIngestProgress(root);
    expect(progress.hidden).toBe(true);
    expect(progress.childElementCount).toBe(0);
  });
});
```

Add `renderBatchProgress` and `clearIngestProgress` to the file's existing import from `./app-shell`.

- [ ] **Step 2: Run them to confirm they fail**

Run: `./scripts/test.sh unit app-shell`
Expected: FAIL — `clearIngestProgress` is not exported; no `.ingest-dismiss`

- [ ] **Step 3: Implement**

In `frontend/src/ui/app-shell.ts`, add beside the other exported helpers:

```ts
/** Hides and empties the ingest banner. Workspace reset and load both need
 * this: the banner is deliberately kept visible while failures are recent,
 * and nothing else ever takes it down. */
export function clearIngestProgress(root: HTMLElement): void {
  const progress = root.querySelector<HTMLElement>(".ingest-progress");
  if (progress === null) return;
  progress.hidden = true;
  progress.replaceChildren();
}
```

In `renderBatchProgress`, inside the existing `if (status.recent_failures.length > 0)` block, after `children.push(failures);`, add:

```ts
if (status.state !== "running") {
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ingest-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.title = "Dismiss ingest failures";
  dismiss.addEventListener("click", () => {
    progress.hidden = true;
    progress.replaceChildren();
  });
  children.push(dismiss);
}
```

In `newWorkspace`, after `this.missingByPanel.clear();` (line 2312), add:

```ts
clearIngestProgress(this.root);
```

In `loadSession`, in the same place the theme is applied after a successful load (~line 2385), add the same call so a restored workspace never inherits the previous one's failures.

- [ ] **Step 4: Style the control**

In `frontend/src/styles/app.css`, add `.ingest-dismiss` to the selector list of the rule that already styles `.ingest-cancel`. It is an achromatic secondary action and needs no new tokens.

- [ ] **Step 5: Run the tests**

Run: `./scripts/test.sh unit app-shell`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
./scripts/format.sh
git add frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/styles
git commit -m "fix(ingest): let the failure banner be dismissed and reset

The banner is kept visible while failures are recent and nothing took it
down, so errors survived Ctrl+N and every later workspace load."
```

---

## Task 6: Move the theme to global preferences

Theme lives in the session (ADR 0022), so `newWorkspace` reverts it. ADR 0023 already records migrating it to preferences as the open follow-up. The session keeps its `theme` field: `BakedPlane` has no preferences port, so a snapshot must carry the theme it was exported with.

**Files:**

- Modify: `protocol/schema/scope-preferences.json`
- Modify: `core/scope-core/src/preferences.rs` (`migrate` line 128, `repair_current` line 135)
- Modify: `frontend/src/app/preferences.ts` (`defaultPreferences`, `applyPreferences`)
- Modify: `frontend/src/ui/app-shell.ts` (`toggleTheme` line 3135, `newWorkspace` line 2313, `loadPreferences` line 1973)
- Test: `core/scope-core/src/preferences.rs` tests, `frontend/src/app/preferences.test.ts`, `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Consumes: `clearIngestProgress` (Task 5) is already in `newWorkspace`; do not remove it.
- Produces: `Preferences.theme: "dark" | "light"`; preferences schema version 4.

- [ ] **Step 1: Extend the preferences schema**

In `protocol/schema/scope-preferences.json`, set `"schema_version": 4`, add a `Theme` enum beside `FontFamily`:

```json
    "Theme": {
      "kind": "enum",
      "variants": ["dark", "light"],
      "default": "dark"
    },
```

and add `"theme": "Theme"` to `Preferences.fields`, immediately after `"schema_version": "u32"`.

The enum is declared locally rather than shared with the session schema: each schema file generates independently, and they version independently.

- [ ] **Step 2: Regenerate**

Run: `./scripts/codegen.sh`
Expected: `core/scope-core/src/preferences/generated.rs` gains `pub theme: Theme` and `PREFERENCES_SCHEMA_VERSION` becomes 4; `frontend/src/generated/preferences.ts` gains `theme: Theme`.

- [ ] **Step 3: Write the failing Rust test**

Append to the `tests` module in `core/scope-core/src/preferences.rs`:

```rust
    #[test]
    fn v3_preferences_gain_the_default_theme() {
        let stored = serde_json::json!({
            "schema_version": 3,
            "ui_font_family": "inter",
            "plot_font_family": "jetbrains",
            "ui_font_size": 13.0,
            "plot_font_size": 9.0,
            "cache_max_bytes": 1_024_u64,
        });
        let restored = from_json(&stored.to_string()).expect("migrates from v3");
        assert_eq!(restored.schema_version, PREFERENCES_SCHEMA_VERSION);
        assert_eq!(restored.theme, Theme::Dark);
    }

    #[test]
    fn a_stored_theme_survives_a_round_trip() {
        let stored = serde_json::json!({
            "schema_version": 4,
            "theme": "light",
            "ui_font_family": "inter",
            "plot_font_family": "jetbrains",
            "ui_font_size": 13.0,
            "plot_font_size": 9.0,
            "cache_max_bytes": 1_024_u64,
        });
        assert_eq!(
            from_json(&stored.to_string()).expect("parses v4").theme,
            Theme::Light
        );
    }
```

- [ ] **Step 4: Run them to confirm they fail**

Run: `./scripts/test.sh core preferences`
Expected: FAIL — `theme` is absent from the repaired value

- [ ] **Step 5: Implement the Rust side**

In `core/scope-core/src/preferences.rs`, extend the `migrate` arm to accept version 3 (it already accepts `1 | 2`):

```rust
        PREFERENCES_SCHEMA_VERSION | 1 | 2 | 3 => Ok(repair_current(value)),
```

and add to the `Preferences { .. }` literal inside `repair_current`:

```rust
        theme: match value.get("theme").and_then(serde_json::Value::as_str) {
            Some("light") => Theme::Light,
            _ => defaults.theme,
        },
```

`repair_current` already falls back to defaults field by field, which is exactly the behaviour a missing `theme` needs.

- [ ] **Step 6: Run the Rust tests**

Run: `./scripts/test.sh core preferences`
Expected: PASS. If `preferences_conformance` fails, regenerate:
`REGENERATE_FIXTURES=1 ./scripts/test.sh core preferences_conformance` then re-run without the variable.

- [ ] **Step 7: Write the failing frontend test**

Append to `frontend/src/app/preferences.test.ts`:

```ts
it("defaults the theme to dark", () => {
  expect(defaultPreferences().theme).toBe("dark");
});

it("applies the stored theme to the document root", () => {
  const root = document.createElement("html");
  applyPreferences({ ...defaultPreferences(), theme: "light" }, root);
  expect(root.dataset.theme).toBe("light");
});
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `./scripts/test.sh unit preferences`
Expected: FAIL — `theme` is missing from the defaults

- [ ] **Step 9: Implement the frontend side**

In `frontend/src/app/preferences.ts`, add `theme: "dark",` to the object returned by `defaultPreferences()`, and in `applyPreferences` set `root.dataset.theme = prefs.theme;` alongside the font custom properties.

In `frontend/src/ui/app-shell.ts`, replace `toggleTheme` (line 3135) with:

```ts
  private toggleTheme(): void {
    const theme =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    // Preferences are authoritative for the running app; the session keeps a
    // copy so an exported snapshot bakes the theme it was exported with.
    this.workspace.setTheme(theme);
    this.updatePreferences({ theme });
  }
```

`updatePreferences` already calls `applyPreferences`, `invalidateTheme`, `renderTiles`, and schedules the save, so no other call is needed.

In `newWorkspace` (line 2313), replace

```ts
document.documentElement.dataset.theme = this.workspace.theme();
```

with

```ts
// The theme follows the user, not the workspace (ADR 0023).
this.workspace.setTheme(this.prefs.theme);
applyPreferences(this.prefs, document.documentElement);
```

Apply the same replacement at line 1903. Leave line 2385 (`loadSession`) as-is only if the loaded session should win; it should not — replace it identically, so opening a workspace never changes the user's theme.

In `loadPreferences`, no change is needed: it already ends with `applyPreferences(this.prefs, document.documentElement)`, which now carries the theme.

- [ ] **Step 10: Write the failing shell test**

Append to `frontend/src/ui/app-shell.test.ts` a test asserting that a new workspace keeps a light theme, following the mounting pattern the neighbouring shell tests use:

```ts
it("keeps the user's theme across a new workspace", async () => {
  const shell = await mountTestShell();
  shell.setPreferencesForTest({ ...defaultPreferences(), theme: "light" });
  await shell.newWorkspaceForTest();
  expect(document.documentElement.dataset.theme).toBe("light");
});
```

If the existing test harness exposes no such hooks, drive it through the public command instead (`toggle theme`, then the new-workspace command) rather than adding test-only methods to the shell.

- [ ] **Step 11: Run the suites**

Run: `./scripts/test.sh unit preferences && ./scripts/test.sh unit app-shell && ./scripts/test.sh core preferences`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
./scripts/format.sh
git add protocol/schema/scope-preferences.json core/scope-core/src/preferences.rs core/scope-core/src/preferences/generated.rs frontend/src/generated/preferences.ts frontend/src/app/preferences.ts frontend/src/app/preferences.test.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts protocol/testdata/preferences-conformance.json
git commit -m "feat(preferences): make the theme follow the user

Preferences v4 carries the theme, so Ctrl+N and workspace loads no longer
revert it. The session keeps its copy so snapshots bake the exported theme."
```

---

## Task 7: Parallelise batch admission

The issue doc blames `BatchOptions::worker_count` defaulting to 4. That is only `for_tests()`; production already passes `available_parallelism()` (`shell/src-tauri/src/lib.rs:1836`). The real serial cost is `submit()` walking every path through `SourceRegistry::admit`, which does a `canonicalize()` syscall per file while holding the registry lock, before any worker starts. At 26k files that is 26k blocking syscalls on the calling thread.

**Files:**

- Modify: `core/scope-core/src/ingest/batch.rs:373-392`
- Test: `core/scope-core/src/ingest/batch.rs` tests

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: no public API change. `submit` keeps its signature and its ordering guarantees.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `core/scope-core/src/ingest/batch.rs`:

```rust
    #[test]
    fn admission_preserves_input_order_and_reports_every_path() {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for index in 0..64 {
            let path = dir.path().join(format!("run_{index}.csv"));
            std::fs::write(&path, "t,v\n0,1\n1,2\n").unwrap();
            paths.push(path);
        }
        // A path that cannot be canonicalized must still be reported, at its
        // own index, rather than shifting its neighbours.
        paths.insert(32, dir.path().join("missing.csv"));

        let sink = Arc::new(RecordingSink::default());
        let jobs = BatchJobs::new(BatchOptions::for_tests());
        let job = jobs.submit(paths.clone(), sink.clone());
        let status = jobs.wait_for_tests(job);

        assert_eq!(status.total, u32::try_from(paths.len()).unwrap());
        assert_eq!(status.recent_failures.len(), 1);
        assert_eq!(
            status.recent_failures[0].path,
            paths[32].display().to_string()
        );
    }
```

`RecordingSink` (`batch.rs:793`) and `wait_for_tests` (`batch.rs:516`) already exist in that module; the neighbouring cancellation test shows the exact `Arc::new(RecordingSink::default())` construction.

- [ ] **Step 2: Run it to confirm it passes on the current code**

Run: `./scripts/test.sh core admission_preserves_input_order`
Expected: PASS — this is a characterisation test that pins current behaviour before the change. If it fails, stop: the ordering contract is not what this task assumes, and the parallelisation below would change observable behaviour.

- [ ] **Step 3: Parallelise the canonicalisation**

In `core/scope-core/src/ingest/batch.rs::submit`, replace the admission block (lines 373-392) with a two-phase version: canonicalise off-lock across threads, then admit in input order under one lock.

```rust
        let worker_count = self.options.worker_count.max(1);
        // `canonicalize` is a blocking syscall per path and `admit` needs the
        // registry lock, so 26k files previously meant 26k serial syscalls on
        // the calling thread before any worker started. Resolve them in
        // parallel, then admit in input order so failures keep their index and
        // prefix allocation stays deterministic.
        let resolved: Vec<Result<PathBuf, String>> = std::thread::scope(|scope| {
            let chunk = paths.len().div_ceil(worker_count).max(1);
            let handles: Vec<_> = paths
                .chunks(chunk)
                .map(|slice| {
                    scope.spawn(move || {
                        slice
                            .iter()
                            .map(|path| {
                                path.canonicalize().map_err(|error| error.to_string())
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|handle| handle.join().unwrap_or_default())
                .collect()
        });

        let mut work = VecDeque::new();
        {
            let mut registry = lock(&self.registry);
            for (index, resolved) in resolved.into_iter().enumerate() {
                match resolved {
                    Err(error) => progress.failed(index, error),
                    Ok(canonical) => match registry.admit_canonical(&canonical) {
                        Ok(Admission::New(record)) => {
                            work.push_back(WorkItem { index, record });
                        }
                        Ok(Admission::Existing(key)) => {
                            if let Some(record) = registry.record(key).cloned() {
                                work.push_back(WorkItem { index, record });
                            }
                        }
                        Err(error) => progress.failed(index, error.to_string()),
                    },
                }
            }
        }
```

- [ ] **Step 4: Split `admit` in the registry**

In `core/scope-core/src/sources.rs`, split `admit` so the syscall and the bookkeeping are separable, keeping `admit` itself working for every existing caller:

```rust
    /// Canonicalizes `path` and admits it.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the path cannot be canonicalized, or
    /// [`SourceError::PrefixExhausted`] when no prefix is available.
    pub fn admit(&mut self, path: &Path) -> Result<Admission, SourceError> {
        let canonical = path.canonicalize()?;
        self.admit_canonical(&canonical)
    }

    /// Admits an already-canonicalized path. Batch admission resolves paths
    /// off-lock in parallel and then calls this in input order.
    ///
    /// # Errors
    ///
    /// Returns [`SourceError::PrefixExhausted`] when no prefix is available.
    pub fn admit_canonical(&mut self, canonical: &Path) -> Result<Admission, SourceError> {
        if let Some(key) = self.by_path.get(canonical) {
            return Ok(Admission::Existing(*key));
        }

        let key = SourceKey(Uuid::new_v4());
        let prefix = naming::allocate_prefix(&self.prefixes, canonical, key.0)
            .ok_or_else(|| SourceError::PrefixExhausted(canonical.display().to_string()))?;
        let record = SourceRecord {
            key,
            path: canonical.to_path_buf(),
            prefix: prefix.clone(),
            provider_id: None,
            decode_provenance: None,
            recipe_id: None,
            recipe_digest: None,
            reconcile_legacy: false,
        };
        self.prefixes.insert(prefix);
        self.by_path.insert(canonical.to_path_buf(), key);
        self.by_key.insert(key, record.clone());
        Ok(Admission::New(record))
    }
```

- [ ] **Step 5: Run the tests**

Run: `./scripts/test.sh core batch && ./scripts/test.sh core sources`
Expected: PASS, including the characterisation test from Step 1 unchanged.

- [ ] **Step 6: Record the measurement**

Run: `./scripts/test.sh core bench_batch_ingests_one_thousand_synthetic_runs -- --ignored --nocapture`

Capture the JSON report line before and after the change and put both numbers in the commit body. If the bench does not move, say so in the commit rather than claiming an improvement — the syscall cost scales with file count, and 1000 files may be below the point where it shows.

- [ ] **Step 7: Commit**

```bash
./scripts/format.sh
git add core/scope-core/src/ingest/batch.rs core/scope-core/src/sources.rs
git commit -m "perf(ingest): resolve batch paths in parallel before admission

submit() canonicalized every path serially on the calling thread while
holding the registry lock, so 26k files meant 26k blocking syscalls before
the first worker started. Resolve off-lock across threads, then admit in
input order so failure indices and prefix allocation stay deterministic.

worker_count was never the bottleneck: only BatchOptions::for_tests uses
4, and production already passes available_parallelism()."
```

---

## Task 8: Profile the CSV float-parse path

Issue 7's third candidate. Measure before changing anything; `parse_cell` uses `str::parse::<f64>`, and whether that is hot at 26k files is unverified.

**Files:**

- Modify: `core/scope-core/src/benchmarks/mod.rs`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `bench_csv_parse_throughput`, report-only.

- [ ] **Step 1: Add a report-only bench**

Append to `core/scope-core/src/benchmarks/mod.rs`, following the shape of the neighbouring benches (one JSON line via `report::write_report`, no banner, `#[ignore = "release benchmark"]`):

```rust
#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_csv_parse_throughput() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wide.csv");
    let mut text = String::from("t,a,b,c,d,e,f,g,h\n");
    for row in 0..200_000 {
        let value = row as f64 * 0.001;
        text.push_str(&format!(
            "{value},{value},{value},{value},{value},{value},{value},{value},{value}\n"
        ));
    }
    std::fs::write(&path, &text).unwrap();

    let cancel = CancelToken::default();
    let mut progress = |_: f64| {};
    let mut context = DecodeContext {
        progress: &mut progress,
        cancel: &cancel,
    };

    let started = std::time::Instant::now();
    let decoded = CsvDecoder
        .decode(&path, &mut context)
        .expect("decodes");
    let elapsed = started.elapsed();

    report::write_report(
        "csv_parse_throughput",
        &serde_json::json!({
            "rows": decoded.row_count,
            "signals": decoded.signals.len(),
            "bytes": text.len(),
            "elapsed_ms": elapsed.as_secs_f64() * 1000.0,
            "mb_per_s": (text.len() as f64 / 1_048_576.0) / elapsed.as_secs_f64(),
        }),
    );
}
```

`CsvDecoder::decode` comes from the `Decoder` trait (`ingest/csv.rs:148`); the `DecodeContext` literal matches the one in that module's own tests (`ingest/csv.rs:335`). Import `Decoder`, `CsvDecoder`, `DecodeContext`, and `CancelToken` alongside the benchmarks module's existing ingest imports. Match the neighbouring benches' `report::write_report` call shape exactly.

- [ ] **Step 2: Run it**

Run: `./scripts/test.sh core bench_csv_parse_throughput -- --ignored --nocapture`
Expected: one JSON line with a throughput figure.

- [ ] **Step 3: Decide, and record the decision**

If throughput is above roughly 200 MB/s the parser is not the bottleneck for a 26k-file batch — per-file open/decode/commit overhead is. Record that in the commit body and change nothing else in this task. Do **not** add a hand-rolled float parser or a new dependency on the strength of a hunch; `AGENTS.md` forbids both the dependency and the speculative work.

- [ ] **Step 4: Commit**

```bash
./scripts/format.sh
git add core/scope-core/src/benchmarks/mod.rs
git commit -m "test(bench): measure CSV float-parse throughput

Report-only. Issue 7 listed the parse path as a candidate; this makes the
claim checkable before anyone optimises it."
```

---

## Task 9: Per-mode sample budgets

Sample-mode panels all request `SAMPLE_CAP = 8192`. At 50M points in a window the stride is ~6k and XY/FFT/histogram alias.

**What this task deliberately does not do.** Per-signal min/max reduction was considered and rejected: `pairSamples` (`frontend/src/app/xy.ts:60`) takes an exact fast path when x and y share a timebase, which stride decimation preserves (identical raw time array in, identical decimated times out) and min/max destroys (each signal picks its own extrema times). XY would fall back to `lerpSample` across its own min/max zigzag and fabricate paired values. Min/max also biases a histogram's tails and breaks the FFT's uniform-sampling assumption. Extrema preservation for a trajectory is a 2D, panel-level reduction over one shared index set — deferred to the renderer architecture spec.

Raising the FFT cap alone does nothing while `spectrum()` caps the transform at `MAX_SIZE = 4096`, so that moves too.

**Files:**

- Modify: `frontend/src/ui/app-shell.ts:101` and the `sampleCapFor` stub from Task 4
- Modify: `frontend/src/app/spectrum.ts:16`
- Test: `frontend/src/ui/app-shell.test.ts`, `frontend/src/app/spectrum.test.ts`

**Interfaces:**

- Consumes: `sampleCapFor(mode: PanelMode): number` — the stub introduced in Task 4, now given its real body. `SampleWindowCache.key` already includes `cap`, so a cap change invalidates cached responses for free.
- Produces: no protocol change.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/ui/app-shell.test.ts`:

```ts
describe("sampleCapFor", () => {
  it("gives sample-mode panels more headroom than the legacy cap", () => {
    expect(sampleCapFor("xy")).toBe(32_768);
    expect(sampleCapFor("fft")).toBe(32_768);
    expect(sampleCapFor("histogram")).toBe(32_768);
  });

  it("leaves time panels on the tile path", () => {
    expect(sampleCapFor("time")).toBe(SAMPLE_CAP);
  });
});
```

Append to `frontend/src/app/spectrum.test.ts`:

```ts
it("uses a transform larger than the legacy 4096 cap when samples allow", () => {
  const count = 40_000;
  const time = Array.from({ length: count }, (_, index) => index / 1000);
  const values = time.map((t) => Math.sin(2 * Math.PI * 50 * t));
  const result = spectrum(
    { signal_id: "1", signal_path: "a", unit: null, time, values, stride: 1 },
    time[0]!,
    time[count - 1]!,
  );
  expect(result).not.toBeNull();
  expect(result?.size).toBe(16_384);
});
```

Export `sampleCapFor` and `SAMPLE_CAP` from `app-shell.ts` and add them to the test file's import.

- [ ] **Step 2: Run them to confirm they fail**

Run: `./scripts/test.sh unit app-shell && ./scripts/test.sh unit spectrum`
Expected: FAIL — caps are 8192 and 4096

- [ ] **Step 3: Implement**

In `frontend/src/ui/app-shell.ts`, replace the Task 4 stub with:

```ts
/**
 * Points a sample-mode panel may request. Time panels never take this path
 * (the pyramid bounds their density by pixel width). The sample modes all
 * reduce by plain stride, which is what keeps x and y on one timebase for
 * `pairSamples`; the only lever available without a 2D reduction is the cap.
 *
 * 32768 x 2 columns x ~20 B of JSON is roughly 1.3 MB per series per query;
 * `SAMPLE_POINT_BUDGET` keeps a many-series panel from multiplying that out.
 */
const SAMPLE_CAP = 8192;
const SAMPLE_MODE_CAP = 32_768;
const SAMPLE_POINT_BUDGET = 500_000;

export function sampleCapFor(mode: PanelMode): number {
  return mode === "time" ? SAMPLE_CAP : SAMPLE_MODE_CAP;
}

/** The per-series cap once a panel's series count is taken into account. */
export function sampleCapForPanel(
  mode: PanelMode,
  seriesCount: number,
): number {
  const cap = sampleCapFor(mode);
  const share = Math.floor(SAMPLE_POINT_BUDGET / Math.max(1, seriesCount));
  return Math.max(SAMPLE_CAP, Math.min(cap, share));
}
```

In `refreshTilesPass`, change the Task 4 wiring to use the budgeted form:

```ts
const cap = sampleCapForPanel(panel.mode, ids.length);
```

In `frontend/src/app/spectrum.ts`, change `const MAX_SIZE = 4096;` to `const MAX_SIZE = 16_384;`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh unit app-shell && ./scripts/test.sh unit spectrum && ./scripts/test.sh unit sample-window-cache`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
./scripts/format.sh
git add frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/app/spectrum.ts frontend/src/app/spectrum.test.ts
git commit -m "fix(panels): raise sample budgets for xy, fft, and histogram

Sample-mode panels capped at 8192 points, so a 50M-point window strode
~6000:1 and aliased. Raise the cap to 32768 under a 500k per-panel budget,
and lift the FFT transform cap, which otherwise discarded the extra input.

Per-signal min/max reduction was rejected: it breaks the shared timebase
pairSamples relies on, biases histogram tails, and violates the FFT's
uniform-sampling assumption. Trajectory extrema need a 2D panel-level
reduction, which is deferred to the renderer architecture spec."
```

---

## Task 10: Documentation, ADR, and version bump

**Files:**

- Create: `docs/adr/0037-per-mode-sample-budgets.md`
- Modify: `docs/adr/README.md`, `docs/adr/0023-global-preferences-file.md`
- Modify: `docs/issues/post-phase-5-issues.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0037-per-mode-sample-budgets.md` in the house style — Status, Date, Context, Decision, Consequences, decisions and their consequences only, no deliberation:

```markdown
# ADR 0037: Per-mode sample budgets

- Status: Accepted
- Date: 2026-08-05

## Context

Sample-mode panels (xy, fft, histogram) shared one 8192-point cap and reduce
by integer stride. At 50M points in a window the stride reaches ~6000 and all
three alias. Time panels are unaffected: the pyramid bounds their density by
pixel width and preserves finite extrema per bin.

## Decision

Sample queries keep stride reduction and gain a per-mode cap of 32768 points,
bounded by a 500k per-panel budget across series. The FFT transform cap rises
to 16384 so the extra input is not discarded.

Per-signal min/max reduction is rejected. `pairSamples` takes an exact path
only when an XY panel's x and y signals share a timebase; stride preserves
that (same raw time array, same decimated times), min/max does not. Min/max
additionally biases histogram tails and breaks the FFT's uniform-sampling
assumption.

Extrema-preserving reduction for XY requires a 2D, panel-level reduction over
one shared index set across the panel's x and y signals. It is deferred.

## Consequences

XY, FFT, and histogram resolve four times more detail per query at roughly
1.3 MB of JSON per series. Panels with many series fall back toward the legacy
cap through the budget rather than multiplying wire cost. Very large windows
still alias; the fix is the deferred 2D reduction, not a larger cap.
```

Add the row to `docs/adr/README.md`.

- [ ] **Step 2: Amend ADR 0023**

Append to `docs/adr/0023-global-preferences-file.md`:

```markdown
## 2026-08-05 amendment: theme

Schema 4 moves the theme to preferences, closing the follow-up this ADR left
open. The session keeps its `theme` field: `BakedPlane` has no preferences
port, so a snapshot must carry the theme it was exported with. Preferences are
authoritative for the running application; a theme change writes both, and
loading or resetting a workspace no longer changes the user's theme.
```

- [ ] **Step 3: Close out the issue backlog**

Rewrite `docs/issues/post-phase-5-issues.md` so each of the nine entries records what landed and what did not. Correct issue 7's diagnosis (`worker_count` was never the production default) and issue 8's (per-signal min/max is wrong; the real fix is 2D and deferred). Add the tile-density staircase as a tenth entry marked fixed in Task 1. Keep the deferrals list from this plan's "Scope boundaries" section so the renderer architecture spec has its input.

- [ ] **Step 4: Run the full gate**

```bash
./scripts/format.sh
./scripts/ci.sh all
./scripts/ci.sh e2e
```

Expected: green. This is the first e2e run of the plan, per `AGENTS.md`.

- [ ] **Step 5: Bump the version**

```bash
./scripts/version.sh bump minor
./scripts/version.sh check
```

`minor`: `axis_equal` and the theme preference are backward-compatible user-facing capabilities, and both schemas migrate forward.

- [ ] **Step 6: Commit**

```bash
git add docs/ package.json Cargo.toml Cargo.lock shell frontend
git commit -m "docs: record post-Phase 5 fixes and bump to the next minor

ADR 0037 records the per-mode sample budgets and the deferred 2D reduction;
ADR 0023 gains the theme amendment."
```

---

## Handoff checklist

- [ ] `./scripts/ci.sh all` green
- [ ] `./scripts/ci.sh e2e` green
- [ ] `./scripts/version.sh check` green
- [ ] Both conformance fixtures regenerated and committed (`session-conformance.json`, `preferences-conformance.json`)
- [ ] No generated file hand-edited
- [ ] Bench numbers from Tasks 7 and 8 reported in their commit bodies, including "no measurable change" where that is the honest result
- [ ] Deferred items listed in `docs/issues/post-phase-5-issues.md` for the renderer architecture spec

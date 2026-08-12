# ChartGPU Phase 2 — Render Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **For Codex/sandboxed workers:** if your environment cannot run `git commit`, skip commit steps and report "commit deferred to supervisor". Never skip test steps.

**Goal:** Time-series panels render through ChartGPU (vendored, pinned) fed by the existing tile pipeline; XY/FFT/histogram stay on Canvas2D; the Canvas2D time-stroke path is deleted.

**Architecture:** ChartGPU source is vendored at the Phase 0 pinned rev under `frontend/vendor/chartgpu/` (Vite alias; excluded from `tsc`; typed by a hand-written `.d.ts`). A per-panel `ChartHost` owns one ChartGPU instance on a shared `GPUDevice`/pipeline-cache, mounted in a new `.chart-host` layer between the (retained, time-mode-idle) plot canvas and the overlay canvas. `PanelView.renderData`'s time path feeds ChartHost the same `ColumnarTileResponse` it feeds `CanvasRenderer.render` today, converted to M4 point columns (first→min→max→last per bin, `NaN` gap breaks) with a `tRef` rebase for f32 safety. View ranges move via axes-only `setOption` (explicit min/max both axes, `sampling: 'none'`, no `dataZoom`); series data refeeds only when the tile pipeline delivers new slices, with a `WeakMap` feed cache keeping unchanged series reference-identical so ChartGPU skips their re-upload. ChartHost publishes a `PlotLayout` derived from its configured grid margins, so overlay/gestures/hit-testing are untouched.

**Tech Stack:** ChartGPU @ pinned rev (WebGPU, WGSL via Vite `?raw`), TypeScript 5.9, Vitest (mocked ChartGPU), Playwright + SwiftShader WebGPU.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-chartgpu-browser-renderer-design.md` **including Amendments 3, 4, 5, 7, 8, 9**. Phase 0 spike verdict must be GO (`docs/superpowers/specs/2026-08-12-chartgpu-spike-results.md`); Phase 1 must be merged.
- Preserve verbatim: `PlotLayout` (raw-time ranges, CSS-px plot rect), gesture semantics (`plot-gestures.ts` / `plot-math.ts` / `plot-interactions.ts` and their tests unchanged), `plot-hit.ts` vertex-order contract (first→min→max→last per bin), the emphasis/ghost contract (emphasis `alpha +0.4` / `width +0.4`, non-emphasized dim to `0.25` when any emphasis exists, ghosts stroke in `fg4`), tile pipeline + `TILE_BIN_BUDGET = 250_000`, XY/FFT/histogram behavior.
- **Known accepted regression:** dashed stroke styles render solid (ChartGPU `lineStyle` has no dash). Recorded in ADR 0039 (Task 9); dash support is on the scoped fork wishlist next to `setSeriesData`.
- Frontend keeps zero runtime npm dependencies and zero dynamic `import()`. The vendored source is not a package dependency.
- All commands through `./scripts/` wrappers. Conventional commits per task; `./scripts/format.sh` before staging; version bump once at Task 9.
- WSL2 has no WebGPU: unit tests mock ChartGPU; e2e/GPU verification runs via Playwright SwiftShader in CI or a real browser on the Windows/native side.

---

### Task 1: Vendor ChartGPU + build wiring

**Files:**
- Create: `scripts/vendor-chartgpu.sh`
- Create: `frontend/vendor/chartgpu/` (script output: upstream `src/`, `package.json`, `LICENSE`, `VENDORED_REV.txt`)
- Modify: `frontend/vite.config.ts` (alias), `frontend/tsconfig.json` (exclude), `frontend/knip.json` (ignore), `frontend/scripts/check-snapshot.mjs` (budget), `flake.nix`/treefmt config (exclude `frontend/vendor/` from formatting)

**Interfaces:**
- Produces: `import { ChartGPU, createPipelineCache } from "@chartgpu/chartgpu"` resolving at build/dev/test time; re-runnable pin-update script.

- [ ] **Step 1: Write `scripts/vendor-chartgpu.sh`**

```bash
#!/usr/bin/env bash
# Vendor ChartGPU source at a pinned rev into frontend/vendor/chartgpu.
# Usage: ./scripts/vendor-chartgpu.sh [rev]   (default: rev recorded in VENDORED_REV.txt)
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh
ensure_dev_shell "$@"

dest="frontend/vendor/chartgpu"
rev="${1:-$(cat "$dest/VENDORED_REV.txt" 2>/dev/null || true)}"
[ -n "$rev" ] || { echo "usage: $0 <rev> (no recorded rev found)" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --no-checkout https://github.com/ChartGPU/ChartGPU.git "$tmp"
git -C "$tmp" checkout --detach "$rev"

rm -rf "$dest"
mkdir -p "$dest"
cp -r "$tmp/src" "$dest/src"
cp "$tmp/LICENSE" "$tmp/package.json" "$dest/"
printf '%s\n' "$rev" > "$dest/VENDORED_REV.txt"
echo "vendored ChartGPU @ $rev"
```

Run it with the rev from `refs/spikes/chartgpu-mc1000/PINNED_REV.txt` (Phase 0). Delete upstream test files to keep the tree lean: `find frontend/vendor/chartgpu/src -name '__tests__' -type d -exec rm -rf {} +` — add that line to the script after the copy.

- [ ] **Step 2: Wire the toolchain**

`frontend/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@chartgpu/chartgpu": resolve(__dirname, "vendor/chartgpu/src/index.ts") },
  },
  build: { cssCodeSplit: false, target: "es2022" },
  server: { strictPort: true, proxy: { "/api": "http://127.0.0.1:8317" } },
});
```

`frontend/tsconfig.json`: add `"exclude": ["vendor"]` (merge with any existing exclude). `frontend/knip.json`: add `"vendor/**"` to `ignore`. Formatting: exclude `frontend/vendor/` in the treefmt configuration inside `flake.nix` (each formatter has an `excludes` list in treefmt-nix; add `"frontend/vendor/*"`) so upstream source stays pristine for future diffing. ESLint needs nothing: `pnpm lint` covers only `src tests`.

- [ ] **Step 3: Snapshot budget.** In `frontend/scripts/check-snapshot.mjs` change `const maximumBytes = 750_000;` to `const maximumBytes = 1_500_000;` with a one-line comment: `// raised once for the bundled ChartGPU renderer (ADR 0039)`.

- [ ] **Step 4: Prove the import compiles into the bundle.** Temporarily add to `frontend/src/main.ts`: `import { ChartGPU } from "@chartgpu/chartgpu"; void ChartGPU;` then run `./scripts/build.sh web`. Expected: build passes; `frontend/dist/snapshot-template.html` grows but stays under 1.5 MB (`pnpm --filter @signalscope/frontend check:artifacts`). Then **remove the temporary import** (Task 2 adds the real one). Note: `tsc --noEmit` must also pass — it will fail on the bare import until the `.d.ts` exists, so do this step after writing `frontend/src/types/chartgpu.d.ts` in Task 2 if it complains, or write the `.d.ts` here and keep Task 2's step as verification.

- [ ] **Step 5: Run** `./scripts/ci.sh quality` (knip, deps, format checks all green — the vendored tree must not trip them).

- [ ] **Step 6: Commit**

```bash
./scripts/format.sh
git add scripts/vendor-chartgpu.sh frontend/vendor frontend/vite.config.ts frontend/tsconfig.json frontend/knip.json frontend/scripts/check-snapshot.mjs flake.nix
git commit -m "feat(render): vendor ChartGPU at pinned rev with vite alias"
```

---

### Task 2: Types + shared GPU context + boot gate

**Files:**
- Create: `frontend/src/types/chartgpu.d.ts`
- Create: `frontend/src/render/gpu-context.ts`
- Modify: `frontend/src/main.ts`, `frontend/src/ui/app-shell.ts` (constructor param), `frontend/src/ui/workspace-view.ts` (thread through to panels)
- Test: `frontend/src/render/gpu-context.test.ts`

**Interfaces:**
- Produces:

```ts
// gpu-context.ts
export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  pipelineCache: unknown;
  register(host: { needsRender(): boolean; renderFrame(): void }): () => void; // shared rAF loop
}
export async function acquireGpuContext(): Promise<GpuContext | null>; // null = no WebGPU
```

- `AppShell` constructor becomes `constructor(root, plane, gpu: GpuContext | null)`; `main.ts` awaits both. A null `gpu` shows a dismissible banner ("WebGPU unavailable — time-series panels disabled; XY/FFT/histogram still work") and time panels render the existing `.panel-empty` element with that message.

- [ ] **Step 1: Write `chartgpu.d.ts`.** Before writing, verify the exact signatures in the vendored source — run:

```bash
rg -n "setZoomRange|getZoomRange|needsRender|renderFrame|export declare|export interface ChartGPUInstance" frontend/vendor/chartgpu/src/ChartGPU.ts | head -40
```

Then declare only the surface we use (adjust to what the grep shows — the shape below is from the API docs and must be corrected against source, not trusted blindly):

```ts
declare module "@chartgpu/chartgpu" {
  export interface XYArraysData { x: ArrayLike<number>; y: ArrayLike<number>; size?: number }
  export interface LineSeriesConfig {
    type: "line"; name?: string; data: XYArraysData;
    sampling?: "none" | "lttb" | "average" | "max" | "min";
    lineStyle?: { width?: number; opacity?: number; color?: string };
    color?: string; visible?: boolean;
  }
  export interface AxisOptions {
    type: "value"; min?: number; max?: number;
    tickFormatter?: (value: number) => string | null;
  }
  export interface ChartGPUOptions {
    theme?: "dark" | "light" | Record<string, unknown>;
    animation?: boolean;
    renderMode?: "internal" | "external";
    tooltip?: { show: boolean };
    grid?: { left: number; right: number; top: number; bottom: number };
    gridLines?: { show?: boolean; color?: string;
      horizontal?: boolean | { count?: number }; vertical?: boolean | { count?: number } };
    xAxis?: AxisOptions; yAxis?: AxisOptions;
    series: readonly LineSeriesConfig[];
  }
  export interface ChartGPUInstance {
    options: Readonly<ChartGPUOptions>;
    disposed: boolean;
    setOption(options: ChartGPUOptions): void;
    needsRender(): boolean;
    renderFrame(): void;
    resize(): void;
    dispose(): void;
  }
  export interface SharedGpuContext { adapter: GPUAdapter; device: GPUDevice; pipelineCache?: unknown }
  export const ChartGPU: {
    create(container: HTMLElement, options: ChartGPUOptions, context?: SharedGpuContext): Promise<ChartGPUInstance>;
  };
  export function createPipelineCache(device: GPUDevice): unknown;
}
```

- [ ] **Step 2: Failing tests** for `gpu-context.ts` (jsdom has no `navigator.gpu`):

```ts
import { describe, expect, it, vi } from "vitest";
import { acquireGpuContext } from "./gpu-context";

it("returns null when WebGPU is absent", async () => {
  expect(await acquireGpuContext()).toBeNull();
});

it("drives registered hosts from one rAF loop", async () => {
  // stub navigator.gpu with a fake adapter/device, stub requestAnimationFrame
  // to fire twice synchronously, register a host whose needsRender returns
  // true then false, assert renderFrame called exactly once.
});
```

- [ ] **Step 3: Implement.** `acquireGpuContext`: `navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })` → `requestDevice()` → `createPipelineCache(device)`; returns null on any failure. The rAF loop starts lazily with the first registered host and stops when the set empties; each tick calls `renderFrame()` only for hosts whose `needsRender()` is true. Thread `gpu` through: `main.ts` (`const gpu = await acquireGpuContext();`), `AppShell` constructor, the `WorkspaceView` constructor, into each `PanelView` constructor. Banner: reuse the existing status-strip pattern in `shellMarkup()`/`mount()` — a plain `<div class="gpu-warning">` inserted after the title bar when `gpu === null`, styled like `.panel-mode-note`.

- [ ] **Step 4: Run** `./scripts/test.sh unit gpu-context` → PASS; `./scripts/test.sh frontend` → lint+typecheck green.
- [ ] **Step 5: Commit** — `feat(render): shared GPU context, boot gate, chartgpu types`

---

### Task 3: M4 feed conversion (`m4-feed.ts`)

**Files:**
- Create: `frontend/src/render/m4-feed.ts`
- Test: `frontend/src/render/m4-feed.test.ts`

**Interfaces:**
- Consumes: `BinColumns` and the `HAS_FIRST/HAS_LAST/HAS_MIN/HAS_MAX/HAS_GAP` flag bits from `frontend/src/app/bin-columns.ts` (import the real constants — do not redefine).
- Produces:

```ts
export interface SeriesFeed { x: Float64Array; y: Float64Array }
/** M4 points per bin in plot-hit's vertex order: first -> min -> max -> last.
 *  Extrema carry the bin midpoint time. A HAS_GAP bin (or a bin with no
 *  finite payload) emits a single NaN point, breaking the polyline. All x
 *  are rebased by tRef (f32 safety inside ChartGPU). */
export function m4Feed(columns: BinColumns, tRef: number): SeriesFeed;
/** Feed cache: identical BinColumns object => identical SeriesFeed object,
 *  so ChartGPU's reference-identity fast path skips re-upload. */
export function cachedFeed(columns: BinColumns, tRef: number): SeriesFeed;
```

- [ ] **Step 1: Failing tests.** Build small `BinColumns` fixtures the same way `bin-columns.test.ts` / `plot-hit.test.ts` build theirs (read those first and reuse their helper if exported):

```ts
it("emits first,min,max,last per bin with midpoint extrema times", () => {
  // one bin: t0=10,t1=12, first=1,min=0,max=5,last=2, all flags set
  const feed = m4Feed(columns, 10);
  expect([...feed.x]).toEqual([0, 1, 1, 2]);      // rebased: t0-10, mid-10, mid-10, t1-10
  expect([...feed.y]).toEqual([1, 0, 5, 2]);
});

it("breaks the polyline at HAS_GAP bins with a NaN point", () => { /* 3 bins, middle gap:
  expect exactly one NaN in y between the two bins' points, and its x finite */ });

it("skips vertices whose flag bit is absent", () => { /* bin with only HAS_MIN|HAS_MAX
  emits 2 points, not 4 */ });

it("cachedFeed returns the identical object for the identical columns", () => {
  expect(cachedFeed(columns, 10)).toBe(cachedFeed(columns, 10));
  expect(cachedFeed(columns, 10)).not.toBe(cachedFeed(otherColumns, 10));
});
```

- [ ] **Step 2: Run** `./scripts/test.sh unit m4-feed` — FAIL (module missing).
- [ ] **Step 3: Implement.** Single pass over the bins; preallocate `Float64Array(binCount * 4 + gaps)` worst-case then subarray to length, or build in a number[] — measure nothing here, correctness first. `cachedFeed` = module-level `WeakMap<BinColumns, { tRef: number; feed: SeriesFeed }>` (invalidate when `tRef` differs). Gap NaN point: `x = (t0+t1)/2 - tRef`, `y = NaN`. **Verify against G7 of the spike** that NaN-in-columns produces a visual break in ChartGPU; if the spike showed NaN is NOT honored in `XYArraysData`, emit per-segment series instead — but that decision was already made by the spike; read its results doc and follow it.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `feat(render): M4 feed conversion with gap breaks and feed cache`

---

### Task 4: `ChartHost`

**Files:**
- Create: `frontend/src/render/chart-host.ts`
- Test: `frontend/src/render/chart-host.test.ts` (with `vi.mock("@chartgpu/chartgpu")`)

**Interfaces:**
- Consumes: `GpuContext` (Task 2), `m4-feed` (Task 3), `Palette`/`SeriesStroke` from `canvas-renderer.ts`, `PlotLayout`/`Range` from `plot-math.ts`, `ColumnarTileResponse` from `bin-columns.ts`.
- Produces:

```ts
export const CHART_GRID = { left: 60, right: 12, top: 8, bottom: 34 } as const;

export interface ChartRenderRequest {
  response: ColumnarTileResponse;
  xRange: Range;                       // raw time
  yRange: readonly [number, number];
  styles: readonly SeriesStroke[];     // parallel to response series
  emphasisIndices: readonly number[];
  palette: Palette;
}

export class ChartHost {
  static async create(container: HTMLElement, gpu: GpuContext): Promise<ChartHost>;
  render(request: ChartRenderRequest): number;   // ms, like CanvasRenderer.render
  setRangesOnly(xRange: Range, yRange: readonly [number, number]): void; // axes-only fast path
  layout(): PlotLayout | null;                    // raw-time ranges, CSS-px rect
  canvas(): HTMLCanvasElement | null;             // for PNG capture
  resize(): void;
  dispose(): void;
}
```

**Behavioral contract (encode all of this in tests):**
1. `tRef` = the response's minimum `t0` on first `render`, held stable while the series set (signal ids) is unchanged; re-based when the set changes. `layout()` always reports **raw** ranges.
2. Series config per series: `{ type: "line", data: cachedFeed(columns, tRef), sampling: "none", color, lineStyle: { width, opacity } }`. Color: `style.hue === null` → `palette.fg4` (ghost), else `palette.series[style.hue % palette.series.length]`. Emphasis: if `emphasisIndices` non-empty — emphasized get `opacity: min(1, alpha + 0.4)`, `width: width + 0.4`; non-emphasized non-ghost get `opacity: 0.25`. Dash: ignored (accepted regression).
3. **Identity stability:** consecutive `render` calls reuse the previous series element object when that series' `BinColumns` object, style, and emphasis outcome are all unchanged; otherwise a new element object. `setRangesOnly` re-passes the previous series array untouched and changes only `xAxis`/`yAxis` min/max (rebased by `tRef`).
4. Chart options: `animation: false`, `tooltip: { show: false }`, `renderMode: "external"`, `grid: CHART_GRID`, `gridLines` colored from `palette.grid`, `xAxis.tickFormatter: (v) => formatTicks([v + tRef])[0]`-equivalent re-adding `tRef` (reuse `formatTicks` from canvas-renderer for consistent labels), yAxis formatter plain `formatTicks`.
5. `layout()` = `{ plot: { x: grid.left, y: grid.top, width: container.clientWidth - left - right, height: container.clientHeight - top - bottom }, xRange, yRange }` — null before first render.
6. Registers with `gpu.register(...)` on create; unregisters + `chart.dispose()` on `dispose`.

- [ ] **Step 1: Write the mock + failing tests.** Mock shape:

```ts
vi.mock("@chartgpu/chartgpu", () => {
  const instances: FakeChart[] = [];
  class FakeChart {
    setOptionCalls: ChartGPUOptions[] = [];
    setOption(o: ChartGPUOptions) { this.setOptionCalls.push(o); }
    needsRender() { return false; }
    renderFrame() {}
    resize() {}
    dispose() { this.disposed = true; }
    disposed = false;
  }
  return {
    ChartGPU: { create: vi.fn(async () => { const c = new FakeChart(); instances.push(c); return c; }) },
    createPipelineCache: vi.fn(() => ({})),
    __instances: instances,
  };
});
```

Tests (one per contract item): tRef rebase (`xAxis.min === xRange.min - tRef`), ghost/emphasis colors and opacities, identity reuse across renders (`toBe` on series elements), `setRangesOnly` re-passes the same series array (`toBe`), layout math against a container stubbed with `clientWidth: 400, clientHeight: 300` → plot `{x:60,y:8,width:328,height:258}`, dispose unregisters.

- [ ] **Step 2: Run** `./scripts/test.sh unit chart-host` — FAIL.
- [ ] **Step 3: Implement** per the contract. Keep it one class, no speculative options.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `feat(render): ChartHost with identity-stable feeds and axes-only fast path`

---

### Task 5: Panel integration

**Files:**
- Modify: `frontend/src/ui/panel.ts` — `panelMarkup()` (new layer), constructor (create ChartHost), `renderForMode` time branch (~line 1056), new `activeLayout()`, mode-switch visibility, `canvases()`
- Modify: `frontend/src/ui/workspace-view.ts` (pass `gpu` into `PanelView`)
- Test: `frontend/src/ui/panel.test.ts` (extend existing suite; ChartGPU stays mocked via the module mock)

**Interfaces:**
- Consumes: `ChartHost` (Task 4), `GpuContext | null` (Task 2).
- Produces: time panels rendering via ChartHost; all other behavior byte-identical.

- [ ] **Step 1: Markup.** In `panelMarkup()` insert between the two canvases:

```html
<canvas class="plot-canvas" aria-label="Time-series plot"></canvas>
<div class="chart-host" hidden></div>
<canvas class="overlay-canvas" aria-hidden="true"></canvas>
```

CSS (in `frontend/src/styles/app.css` next to the existing `.plot-wrap` rules): `.plot-wrap .chart-host { position: absolute; inset: 0; }` — the overlay above it already has the pointer handlers and `touch-action: none`; the chart-host div gets `pointer-events: none` so ChartGPU's internal listeners (which we don't use) can never capture input.

- [ ] **Step 2: Lifecycle.** `PanelView` constructor: keep `.plot-canvas` + `CanvasRenderer` exactly as-is (still needed for xy/fft/histogram); when `gpu !== null`, kick off `ChartHost.create(chartHostEl, gpu)` and buffer the first render until it resolves (a `pending: ChartRenderRequest | null` field — `PanelView` construction stays synchronous). `ResizeObserver` continues to watch `.plot-canvas` (still sized by CSS even though time mode doesn't draw on it); its callback additionally calls `chartHost?.resize()`.

- [ ] **Step 3: Render dispatch.** In `renderForMode`'s time branch, replace `return this.renderer.render(response, ranges.x, options);` with:

```ts
this.chartHostEl.hidden = false;
if (this.chartHost === null) { this.pendingChartRender = request; return 0; }
return this.chartHost.render(request);
```

where `request` packages exactly what the old call consumed (`response`, `ranges.x`, `options.yRange`, `options.styles`, `options.emphasisIndices ?? []`, current palette). Non-time branches set `this.chartHostEl.hidden = true` and keep calling `renderPaths`. When `gpu === null` and mode is time: show `.panel-empty` with "WebGPU unavailable — time-series rendering disabled" and return 0.

- [ ] **Step 4: Layout dispatch.** Add `private activeLayout(): PlotLayout | null` returning `this.state.mode === "time" ? (this.chartHost?.layout() ?? null) : this.renderer.lastLayout()`, and replace **every** `this.renderer.lastLayout()` read inside `panel.ts` with it (`PlotInteractionHost.layout`, `seriesHit`, `cursorAt`, `pinAt`, `removeAt`, `axisEditZone` callers, overlay draw). Gesture range applications (`applyXRange`/`applyYRange`) in time mode call `this.chartHost?.setRangesOnly(...)` **and** the existing state-update path (which schedules the async tile refresh) — the axes move this frame, data refines when tiles arrive, which is exactly today's cadence.
- [ ] **Step 5: PNG capture.** `canvases()` currently returns `{ plot, overlay }`; in time mode the visible plot is the ChartGPU canvas — return `{ plot: this.chartHost?.canvas() ?? this.canvas, overlay: this.overlay }`. `composePanelPng` is unchanged (it just `drawImage`s both). Spike gate G9 already proved the capture works.
- [ ] **Step 6: Tests.** Extend `panel.test.ts`: time-mode render routes to the mocked ChartHost (assert the fake chart got options with N series); mode switch to `xy` hides `.chart-host` and calls `renderPaths`; `activeLayout` returns ChartHost layout in time mode and renderer layout in xy; gpu-null time panel shows the empty-state message. Run `./scripts/test.sh unit panel` until green.
- [ ] **Step 7:** Run `./scripts/test.sh frontend` (lint/typecheck/all units). **Step 8: Commit** — `feat(render): time panels render through ChartHost`

---

### Task 6: Theme + palette sync

**Files:**
- Modify: `frontend/src/render/chart-host.ts` (palette in `ChartRenderRequest` already carries colors — add `gridLines`/background handling), `frontend/src/ui/panel.ts` (`invalidateTheme` path)
- Test: extend `chart-host.test.ts`

**Interfaces:** theme flips (`invalidateTheme()` chain from `AppShell.restoreTheme`/palette rebuild) must restyle ChartGPU charts.

- [ ] **Step 1: Failing test:** two consecutive `render` calls with different `palette.grid`/`palette.series` produce a `setOption` whose series elements are **new objects** (color change must not be identity-reused) and whose `gridLines.color` matches the new palette.
- [ ] **Step 2: Implement:** include the palette object identity in ChartHost's per-series reuse key; wire `PanelView.invalidateTheme()` to force the next render non-reused (a `themeEpoch` counter is enough). ChartGPU's canvas background: pass a custom theme object `{ backgroundColor: palette.background, textColor: palette.fg2, fontFamily: palette.fontPlot, gridLineColor: palette.grid, colorPalette: palette.series }` — check the vendored `src/themes/` for the exact `ThemeConfig` field names before writing (`rg -n "interface ThemeConfig" frontend/vendor/chartgpu/src`).
- [ ] **Step 3:** Run unit suite — PASS. **Step 4: Commit** — `feat(render): theme-synced ChartGPU styling`

---

### Task 7: Delete the Canvas2D time-stroke path

**Files:**
- Modify: `frontend/src/render/canvas-renderer.ts` — delete `render()`, `appendSeriesPath`, the `Path2D` cache, the >128-series batching, and every helper used only by them; keep `renderPaths()`, `beginFrame`, chrome drawing, `ticks`/`formatTicks`/`gutterWidth`, `lastLayout`
- Modify: `frontend/src/render/canvas-renderer.test.ts` — delete `render()` cases; keep `renderPaths` + chrome + tick cases
- Modify: `frontend/src/ui/panel.ts` — remove any residual `render()` references

**Interfaces:** consumes Task 5 (nothing calls `render()` anymore).

- [ ] **Step 1:** `rg -n "\.render\(" frontend/src --glob '!**/*.test.ts'` and confirm the only canvas-renderer call sites left are `renderPaths`. Delete the dead code and its tests. If `OverlayRenderer`'s `SERIES_TOKENS` import came from a deleted region, keep `SERIES_TOKENS` exported (it is used by overlay + resolution).
- [ ] **Step 2:** Run `./scripts/test.sh unit` + `pnpm --filter @signalscope/frontend check:unused` (knip catches newly-dead exports — delete what it flags rather than ignoring it).
- [ ] **Step 3:** Run `./scripts/test.sh quick` — full quick gate green.
- [ ] **Step 4: Commit** — `feat(render)!: remove Canvas2D time-series stroke path`

---

### Task 8: E2E + bench on SwiftShader WebGPU

**Files:**
- Modify: `frontend/playwright.config.ts` (launch args for all projects)
- Create: `frontend/tests/e2e/time-panel-gpu.spec.ts`
- Modify: `frontend/tests/bench/bench.spec.ts` only if its assertions reference canvas 2D internals (read it first; floors stay as-is)

**Interfaces:** CI e2e/bench lanes exercise the real ChartGPU path with a software adapter.

- [ ] **Step 1:** Add to every Playwright project's `use.launchOptions`:

```ts
args: [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-angle=swiftshader",
  "--use-webgpu-adapter=swiftshader",
],
```

(This is the known-good Linux software-WebGPU switch set; it is Linux-specific — CI and the nix chromium are Linux, so no per-platform branching needed.)

- [ ] **Step 2:** `time-panel-gpu.spec.ts`: load the app (demo plane), create a time panel with the demo signals, then assert (a) `page.evaluate(() => "gpu" in navigator)` is true, (b) the panel contains a visible `.chart-host canvas`, (c) a screenshot of the plot region is non-blank (reuse the pixel-count helper pattern from the existing e2e specs if one exists — `rg -n "screenshot" frontend/tests/e2e` first), and (d) a wheel zoom over the plot changes the x-axis tick labels (proves the axes-only path renders).
- [ ] **Step 3:** Run `./scripts/test.sh e2e`. Expected: all specs including the new one and `bench-smoke` pass under SwiftShader. If the software adapter is too slow for the 33 ms bench floor in `bench.spec.ts`, do NOT loosen the floor — mark the floor check `test.skip` under a new `SIGNALSCOPE_SOFTWARE_GPU=1` env (set it in `test.sh bench e2e`), keeping hard floors for real-GPU runs, and record that in the ADR.
- [ ] **Step 4:** Run `./scripts/ci.sh all`. **Step 5: Commit** — `test(e2e): SwiftShader WebGPU lane and time-panel coverage`

---

### Task 9: ADR, docs, version bump

**Files:**
- Create: `docs/adr/0039-chartgpu-time-series-renderer.md`
- Modify: `docs/adr/README.md`, `README.md`, `docs/implementation-roadmap.md`
- Modify: `AGENTS.md` + `CLAUDE.md` only if the render-path wording needs it (tile-pyramid invariants are unchanged — they stay)

**Interfaces:** consumes all prior tasks.

- [ ] **Step 1:** ADR 0039 records: ChartGPU vendored at `<rev>` (no fork; fork trigger = `setSeriesData` and/or dash support, only if windowed refeeds miss budget); time-only scope with xy/fft/histogram retained on Canvas2D; the tile pipeline as the feed (spec Amendment 9); the `PlotLayout`/`plot-hit` vertex-order contracts; accepted regressions (dashed strokes render solid; WebGPU required for time panels — including inside exported snapshots, which now require a WebGPU-capable viewer); amends the render half of ADR 0036.
- [ ] **Step 2:** Spike results doc gets a one-line addendum pointing at the ADR. README render-path paragraph updated.
- [ ] **Step 3:** `./scripts/version.sh bump major && ./scripts/version.sh check` (breaking: WebGPU now required for time-series rendering).
- [ ] **Step 4:** Final `./scripts/ci.sh all` — green. Manual GPU verification on a real browser (Windows Chrome or native Linux): mc1000-scale workspace pans at interactive rates; transient-preservation eyeball per the spike method.
- [ ] **Step 5: Commit** — `docs: ADR 0039 ChartGPU time-series renderer; bump version`

# Unified Plotting Pipeline — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all four plot modes onto the unified mode-module contract from `docs/superpowers/specs/2026-08-06-unified-renderer-design.md` §"Architecture: the unified mode pipeline" — with zero visual change, so `panel.ts` stops holding per-mode geometry preparation and a fifth mode becomes one module.

**Architecture:** Strangler-pattern extraction. A new `frontend/src/ui/modes/` directory holds one module per mode implementing `{ data, configKey, prepare, project }`. `PanelView` gains one generic dispatch (`renderViaModule`) with a framework-owned prepare cache, and each task moves one mode's render body into its module verbatim, pins it with characterization tests, then deletes the old body. The shell's request branching moves from `panel.mode === "time"` to the modules' declared `ModeDataSpec` last. The renderer (`CanvasRenderer`) is untouched in this phase.

**Tech Stack:** TypeScript (strict), vitest (jsdom), no new dependencies.

## Global Constraints

- **Prerequisite: phase 1 must be fully landed** (`docs/superpowers/plans/2026-08-06-unified-pipeline-phase-1.md`). This plan consumes its exports: `buildSeriesIndex`, `seriesIndexKey`, `SeriesPathCallbacks`, `XyPrepCache` (retired in Task 6), `fetchXySamples`, and the revision-gated `renderData`. Task 0 verifies.
- **Zero visual change is the acceptance rule** (the spec's silhouette rule): for identical inputs, the arguments reaching `CanvasRenderer.render` / `renderPaths` must be identical before and after every task. Characterization tests enforce this at the module boundary; the full unit suite plus the bench floors enforce it end-to-end.
- Run everything through the `./scripts/` wrappers from the repo root: `./scripts/test.sh unit -- <pattern>`, `./scripts/format.sh` before every commit, `./scripts/test.sh quick` for the broad gate, `./scripts/test.sh bench` in the final task.
- Never modify `refs/`, `frontend/src/generated/`, or the budget constants (`TILE_BIN_BUDGET`, `SAMPLE_POINT_BUDGET`, `SAMPLE_CAP`, `SAMPLE_MODE_CAP`).
- Import direction: `ui/modes/*` may import from `frontend/src/app/*` and `frontend/src/generated/*` freely, and from `../panel` with **`import type` only** (type-only imports are erased and cannot create runtime cycles). `panel.ts` imports mode modules by value — that is the one allowed direction.
- Stage only the files each task lists; one commit per task.
- Line numbers below are as of phase 1's completion and will drift as tasks land — re-locate by the quoted code, not the number.
- If an existing test fails, read it first: update it ONLY when it imports a symbol a task explicitly moved (import-path fix) — any behavioral assertion failure means the extraction changed behavior, which is a bug in the extraction.

---

### Task 0: Verify phase 1 landed and the tree is green

**Files:** none

- [ ] **Step 1: Verify the phase-1 exports exist**

```bash
grep -n "export function buildSeriesIndex" frontend/src/app/xy.ts
grep -n "export class XyPrepCache" frontend/src/app/xy.ts
grep -n "export async function fetchXySamples" frontend/src/app/xy-samples.ts
grep -n "revision: number | null = null" frontend/src/ui/panel.ts
```

Expected: every grep matches. If any is missing, STOP — phase 1 has not landed; do not start this plan.

- [ ] **Step 2: Verify the tree is green**

Run: `./scripts/test.sh quick`
Expected: PASS.

---

### Task 1: The mode contract

Define the contract every mode implements. Pure types plus one data table — no behavior change.

**Files:**

- Create: `frontend/src/ui/modes/contract.ts`
- Test: `frontend/src/ui/modes/contract.test.ts`

**Interfaces:**

- Consumes: `PanelMode` (`frontend/src/generated/session.ts`), `RenderPanelState` / `RenderSeries` (type-only from `../panel`), `ColumnarTileResponse` (`frontend/src/app/bin-columns.ts`), `SampleResponse` / `SampleSeries` (`frontend/src/generated/protocol.ts`), `PlotPath` / `RenderOptions` / `PathRenderOptions` (`frontend/src/render/canvas-renderer.ts`), `PreparedPlot` (`frontend/src/app/plot-capabilities.ts`), `Range` (`frontend/src/app/plot-math.ts`), `SeriesPathCallbacks` / `XyTrace` (`frontend/src/app/xy.ts`), `DashStyle` (`frontend/src/generated/session.ts`).
- Produces (all exported from `contract.ts`, consumed by every later task):
  - `ModeDataSpec`, `MODE_DATA`, `PrepareInput`, `FrameInput`, `ProjectedPlot`, `XyTraceEntry`, `DomainSeriesEntry`, `ProjectResult`, `PlotModeModule<Geometry>`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/ui/modes/contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MODE_DATA } from "./contract";

describe("MODE_DATA", () => {
  it("declares the two-pipeline split from the spec", () => {
    expect(MODE_DATA.time).toEqual({ reduction: "envelope", windows: [] });
    expect(MODE_DATA.xy).toEqual({
      reduction: "samples",
      windows: ["context", "visible"],
    });
    expect(MODE_DATA.fft).toEqual({
      reduction: "samples",
      windows: ["visible"],
    });
    expect(MODE_DATA.histogram).toEqual({
      reduction: "samples",
      windows: ["visible"],
    });
  });

  it("covers every panel mode", () => {
    expect(Object.keys(MODE_DATA).sort()).toEqual([
      "fft",
      "histogram",
      "time",
      "xy",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/ui/modes/contract.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `frontend/src/ui/modes/contract.ts`**

```ts
import type { DashStyle, PanelMode } from "../../generated/session";
import type { SampleResponse } from "../../generated/protocol";
import type { ColumnarTileResponse } from "../../app/bin-columns";
import type { PreparedPlot } from "../../app/plot-capabilities";
import type { Range } from "../../app/plot-math";
import type { SeriesPathCallbacks, XyTrace } from "../../app/xy";
import type {
  PathRenderOptions,
  PlotPath,
  RenderOptions,
} from "../../render/canvas-renderer";
import type { RenderPanelState } from "../panel";

/**
 * What a mode needs fetched — the spec's stage 1 declaration. The shell owns
 * padding, budgets, caching, and request plumbing; a mode only states its
 * reduction semantics and which sample windows it consumes. Envelope modes
 * ride the tile pipeline and declare no sample windows.
 */
export interface ModeDataSpec {
  reduction: "envelope" | "samples";
  windows: readonly ("visible" | "context")[];
}

export const MODE_DATA: Record<PanelMode, ModeDataSpec> = {
  time: { reduction: "envelope", windows: [] },
  xy: { reduction: "samples", windows: ["context", "visible"] },
  fft: { reduction: "samples", windows: ["visible"] },
  histogram: { reduction: "samples", windows: ["visible"] },
};

/**
 * Stage-2 input: everything that changes only when data or panel
 * configuration lands. Deliberately excludes the visible window — prepare
 * output must be reusable across every pan/zoom frame.
 */
export interface PrepareInput {
  state: RenderPanelState;
  tiles: ColumnarTileResponse | null;
  samples: SampleResponse | null;
  callbacks: SeriesPathCallbacks;
}

/** Stage-3 input: the per-frame view state. */
export interface FrameInput {
  window: { t0: number; t1: number };
  emphasizePaths: ReadonlySet<string> | null;
  /**
   * Resolves final axis ranges from a prepared plot — wraps the panel's
   * sticky y-axis policy, which is per-panel mutable state and therefore
   * stays outside the pure module.
   */
  resolveRanges(
    prepared: PreparedPlot,
    seriesKey?: string,
  ): { x: Range; y: Range } | null;
}

/** What stage 3 hands the renderer — one of the two existing entry points. */
export type ProjectedPlot =
  | { kind: "empty" }
  | {
      kind: "bins";
      response: ColumnarTileResponse;
      xRange: Range;
      options: RenderOptions;
    }
  | { kind: "paths"; paths: PlotPath[]; options: PathRenderOptions };

/** The XY trace entry PanelView keeps for hit-testing and cursor markers. */
export interface XyTraceEntry {
  path: string;
  colorIndex: number;
  hue: number | null;
  dash: DashStyle;
  width: number;
  opacity: number;
  trace: XyTrace;
}

/** The FFT domain-series entry PanelView keeps for cursor readouts. */
export interface DomainSeriesEntry {
  path: string;
  colorIndex: number;
  hue: number | null;
  opacity: number;
  x: number[];
  y: number[];
}

export interface ProjectResult {
  plot: ProjectedPlot;
  prepared: PreparedPlot | null;
  /** Side-band state the panel chrome consumes; assigned when present. */
  xyTraces?: XyTraceEntry[];
  domainSeries?: DomainSeriesEntry[];
  hasColorbar?: boolean;
  /** Drives the panel's mode empty-state message (fft and histogram). */
  emptyState?: { empty: boolean; note: string };
}

/**
 * One plot mode. `prepare` is response-scoped and pure — the framework
 * caches its result on (tiles, samples, configKey) identity, so it never
 * runs during pan/zoom. `project` is frame-scoped and must stay cheap; it
 * is the only per-frame mode code.
 */
export interface PlotModeModule<Geometry = unknown> {
  readonly mode: PanelMode;
  readonly data: ModeDataSpec;
  configKey(state: RenderPanelState): string;
  prepare(input: PrepareInput): Geometry;
  project(
    geometry: Geometry,
    input: PrepareInput,
    frame: FrameInput,
  ): ProjectResult;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/test.sh unit -- src/ui/modes/contract.test.ts`
Expected: PASS. Also confirm `RenderPanelState` is exported from `panel.ts` (it is, ~line 188) and that the type-only import compiles: `./scripts/test.sh unit -- src/ui/modes` runs the typecheck via vitest's transform; a full `pnpm --filter @signalscope/frontend exec tsc --noEmit` equivalent runs in `./scripts/test.sh quick` later.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/modes/contract.ts frontend/src/ui/modes/contract.test.ts
git commit -m "feat(modes): define the plot-mode module contract"
```

---

### Task 2: Move the shared render helpers out of `panel.ts`

Four helpers the mode bodies use are module-private in `panel.ts`: `colorIndexForHue` (~line 96), `visibleSources` (~line 478), `yLabel` (~line 2751), `axisName` (~line 2762). Move them to `modes/shared.ts` so mode modules can import them by value without a runtime cycle. Pure move — bodies unchanged.

**Files:**

- Create: `frontend/src/ui/modes/shared.ts`
- Modify: `frontend/src/ui/panel.ts` (delete the four bodies, import them instead)
- Test: `frontend/src/ui/modes/shared.test.ts`

**Interfaces:**

- Consumes: `SeriesPathCallbacks` (`frontend/src/app/xy.ts`), `RenderSeries` (type-only from `../panel`).
- Produces (exported from `shared.ts`, same signatures as the current private functions):
  - `colorIndexForHue(hue: number | null): number`
  - `visibleSources(series: readonly RenderSeries[], callbacks: SeriesPathCallbacks): Set<string>` — match the current signature exactly when you read it; if its callbacks parameter is typed as panel's `XyPairingCallbacks`, retype it as `SeriesPathCallbacks` (structurally identical).
  - `yLabel(units: readonly (string | null)[]): string`
  - `axisName(path: string, unit: string | null): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/ui/modes/shared.test.ts`. Characterize the two pure helpers with obvious behavior; `visibleSources`/`axisName` get exercised through the module tests later:

```ts
import { describe, expect, it } from "vitest";
import { colorIndexForHue, yLabel } from "./shared";

describe("shared render helpers", () => {
  it("colorIndexForHue maps hues onto the palette slots", () => {
    expect(colorIndexForHue(1)).toBe(0);
    expect(colorIndexForHue(null)).toBe(colorIndexForHue(1));
  });

  it("yLabel joins distinct units", () => {
    expect(typeof yLabel(["V", "V"])).toBe("string");
    expect(yLabel(["V", "V"])).toContain("V");
  });
});
```

Before finalizing the `colorIndexForHue(null)` assertion, read the current body at `panel.ts:96` — if `null` maps differently (e.g. to 0 via a different branch), assert the actual current behavior. The test pins the move, not a new behavior.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/ui/modes/shared.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Move the helpers**

1. Create `frontend/src/ui/modes/shared.ts` with the header:

```ts
import type { SeriesPathCallbacks } from "../../app/xy";
import type { RenderSeries } from "../panel";
```

2. Cut the four function bodies from `panel.ts` **verbatim** (locate each with `grep -n "function colorIndexForHue\|function visibleSources\|function yLabel\|function axisName" frontend/src/ui/panel.ts`), paste them into `shared.ts`, and prefix each with `export`. Do not edit their bodies. If `visibleSources` references panel-local types beyond `RenderSeries` and the callbacks, import those types type-only from `../panel` as well.

3. In `panel.ts`, add `import { axisName, colorIndexForHue, visibleSources, yLabel } from "./modes/shared";` and delete the now-duplicate local definitions.

- [ ] **Step 4: Run the panel and shared suites**

Run: `./scripts/test.sh unit -- src/ui/modes/shared.test.ts src/ui/panel.test.ts src/ui/app-shell.test.ts`
Expected: PASS. If `panel.test.ts` imported one of the moved helpers from `./panel`, update that import to `./modes/shared` — that is the only legitimate test edit here.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/modes/shared.ts frontend/src/ui/modes/shared.test.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts
git commit -m "refactor(modes): move shared render helpers out of panel.ts"
```

---

### Task 3: Histogram module + the generic dispatch

Extract the simplest mode first, and build the `PanelView` machinery every later task reuses: the prepare cache (`geometryFor`) and the dispatch (`renderViaModule`).

**Files:**

- Create: `frontend/src/ui/modes/histogram.ts`
- Modify: `frontend/src/ui/panel.ts` (add `geometryFor` + `renderViaModule` + one field; dispatch histogram; delete `renderHistogram`)
- Test: `frontend/src/ui/modes/histogram.test.ts`

**Interfaces:**

- Consumes: the Task 1 contract, Task 2 helpers, `histogram` (`frontend/src/app/histogram.ts`), `prepareHistogramPlot` (`frontend/src/app/plot-capabilities.ts`).
- Produces:
  - `export interface HistogramGeometry { samples: SampleResponse | null }`
  - `export const histogramModule: PlotModeModule<HistogramGeometry>`
  - In `PanelView`: `private prepCache: { key: string; tiles: ColumnarTileResponse | null; samples: SampleResponse | null; geometry: unknown } | null = null;`, `private geometryFor<G>(module: PlotModeModule<G>, input: PrepareInput): G`, `private renderViaModule<G>(module: PlotModeModule<G>, state: RenderPanelState, tiles, samples, window): number` — every later task calls these two methods.

- [ ] **Step 1: Write the failing characterization test**

Create `frontend/src/ui/modes/histogram.test.ts`. The fixtures mirror `panel.test.ts` conventions; the expected staircase points are derived from the current `renderHistogram` body (rise at each edge, run across each bin, closed to zero at both ends):

```ts
import { describe, expect, it } from "vitest";
import type { SampleResponse, SampleSeries } from "../../generated/protocol";
import { histogram } from "../../app/histogram";
import type { FrameInput, PrepareInput } from "./contract";
import { histogramModule } from "./histogram";

function series(path: string, time: number[], values: number[]): SampleSeries {
  return {
    signal_path: path,
    unit: "V",
    time,
    values,
    stride: 1,
  } as SampleSeries;
}

const callbacks = {
  sourceKeyFor: (path: string) => path.split("/")[0] ?? null,
  localPathFor: (path: string) => path.split("/").slice(1).join("/") || null,
};

function renderSeries(path: string) {
  return {
    ref: { source_key: "run_0001", channel: "a" },
    path,
    display: "focus",
    hue: 1,
    dash: "solid",
    width: 1.4,
    opacity: 1,
    visible: true,
    focused: false,
    overridden: false,
  };
}

function state(paths: string[]) {
  return {
    id: "panel",
    title: "H",
    mode: "histogram",
    axis_style: "gutter",
    x_signal: null,
    color_signal: null,
    color_by_time: false,
    bindings: [],
    overrides: [],
    focus: [],
    series: paths.map(renderSeries),
    y_range: null,
    x_range: null,
    x_label: null,
    y_label: null,
    c_label: null,
    time_window: null,
    annotations: [],
    show_stats: false,
    color_axis: "none",
    color_by: "source",
    ghost_mode: "all",
    split_by: "none",
  } as unknown as Parameters<typeof histogramModule.prepare>[0]["state"];
}

const frame: FrameInput = {
  window: { t0: 0, t1: 10 },
  emphasizePaths: null,
  resolveRanges: () => ({ x: { min: 0, max: 4 }, y: { min: 0, max: 5 } }),
};

describe("histogramModule", () => {
  it("projects the staircase outline the old renderHistogram produced", () => {
    const samples = {
      request_id: "r",
      series: [series("run_0001/a", [0, 1, 2, 3], [1, 1, 3, 3])],
    } as SampleResponse;
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples,
      callbacks,
    };
    const geometry = histogramModule.prepare(input);
    const result = histogramModule.project(geometry, input, frame);
    expect(result.plot.kind).toBe("paths");
    if (result.plot.kind !== "paths") return;
    expect(result.plot.paths).toHaveLength(1);
    // Reproduce the expected staircase from the same histogram() the module
    // must call — this pins the wiring, not the math.
    const binned = histogram([[1, 1, 3, 3]]);
    expect(binned).not.toBeNull();
    if (binned === null) return;
    const edges = binned.edges;
    const counts = binned.counts[0] ?? [];
    const expected: number[] = [edges[0] ?? 0, 0];
    counts.forEach((count, bin) => {
      expected.push(edges[bin] ?? 0, count, edges[bin + 1] ?? 0, count);
    });
    expected.push(edges[edges.length - 1] ?? 0, 0);
    expect(result.plot.paths[0]?.points).toEqual(expected);
    expect(result.plot.options.yLabel).toBe("sample count");
    expect(result.emptyState).toEqual({
      empty: false,
      note: "No values in view.",
    });
    expect(result.prepared).not.toBeNull();
  });

  it("returns the empty state when the window excludes every sample", () => {
    const samples = {
      request_id: "r",
      series: [series("run_0001/a", [100, 101], [1, 2])],
    } as SampleResponse;
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples,
      callbacks,
    };
    const result = histogramModule.project(
      histogramModule.prepare(input),
      input,
      frame,
    );
    expect(result.plot.kind).toBe("empty");
    expect(result.emptyState).toEqual({
      empty: true,
      note: "No values in view.",
    });
    expect(result.prepared).toBeNull();
  });

  it("returns silent empty when samples are null", () => {
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples: null,
      callbacks,
    };
    const result = histogramModule.project(
      histogramModule.prepare(input),
      input,
      frame,
    );
    expect(result.plot.kind).toBe("empty");
    expect(result.emptyState).toBeUndefined();
  });
});
```

If `RenderSeries.display` uses different literal values, read the union at `panel.ts` (~line 175) and use a real one; keep the fixture cast as written — the module only reads documented fields.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/ui/modes/histogram.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `frontend/src/ui/modes/histogram.ts`**

The `project` body is the current `renderHistogram` (`panel.ts:1299-1372`) transformed: `this.` references become inputs/outputs, `this.renderer.renderPaths(...)` becomes the returned `ProjectedPlot`, `this.setModeEmpty(...)` becomes `emptyState`:

```ts
import type { SampleResponse } from "../../generated/protocol";
import { histogram } from "../../app/histogram";
import { prepareHistogramPlot } from "../../app/plot-capabilities";
import type { PlotModeModule } from "./contract";
import { colorIndexForHue, yLabel } from "./shared";

export interface HistogramGeometry {
  samples: SampleResponse | null;
}

export const histogramModule: PlotModeModule<HistogramGeometry> = {
  mode: "histogram",
  data: { reduction: "samples", windows: ["visible"] },
  configKey: () => "",
  prepare: ({ samples }) => ({ samples }),
  project(geometry, { state }, frame) {
    const samples = geometry.samples;
    if (samples === null) return { plot: { kind: "empty" }, prepared: null };
    const window = frame.window;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const visible = state.series.filter((series) => series.visible);
    const columns = visible.map((series) => {
      const source = byPath.get(series.path);
      if (source === undefined) return [];
      const values: number[] = [];
      source.time.forEach((time, index) => {
        if (time < window.t0 || time > window.t1) return;
        values.push(source.values[index] ?? Number.NaN);
      });
      return values;
    });
    const binned = histogram(columns);
    if (binned === null) {
      return {
        plot: { kind: "empty" },
        prepared: null,
        emptyState: { empty: true, note: "No values in view." },
      };
    }
    const edges = binned.edges;
    const histogramSeries: {
      path: string;
      colorIndex: number;
      counts: number[];
      sourceValues: number[];
    }[] = [];
    const paths = binned.counts.map((counts, index) => {
      const points: number[] = [];
      // A staircase outline: rise at each edge, run across each bin, and
      // close down to zero at both ends so the shape reads as a
      // distribution rather than a line chart.
      points.push(edges[0] ?? 0, 0);
      counts.forEach((count, bin) => {
        points.push(edges[bin] ?? 0, count, edges[bin + 1] ?? 0, count);
      });
      points.push(edges[edges.length - 1] ?? 0, 0);
      const series = visible[index];
      if (series !== undefined) {
        histogramSeries.push({
          path: series.path,
          colorIndex: colorIndexForHue(series.hue),
          counts,
          sourceValues: columns[index] ?? [],
        });
      }
      return {
        points,
        hue: series?.hue ?? null,
        dash: series?.dash ?? ("solid" as const),
        width: series?.width ?? 1.4,
        alpha: series?.opacity ?? 1,
      };
    });
    const prepared = prepareHistogramPlot({ edges, series: histogramSeries });
    const emptyState = { empty: false, note: "No values in view." };
    const ranges = frame.resolveRanges(prepared);
    if (ranges === null)
      return { plot: { kind: "empty" }, prepared, emptyState };
    const units = visible.map(
      (series) => byPath.get(series.path)?.unit ?? null,
    );
    return {
      plot: {
        kind: "paths",
        paths,
        options: {
          xLabel: state.x_label ?? yLabel(units),
          yLabel: state.y_label ?? "sample count",
          xRange: [ranges.x.min, ranges.x.max],
          yRange: [ranges.y.min, ranges.y.max],
          axisStyle: state.axis_style,
        },
      },
      prepared,
      emptyState,
    };
  },
};
```

Diff this against the old body line by line before proceeding — every filter, `??` fallback, and ordering must match; only the `this.`/return plumbing differs.

- [ ] **Step 4: Run the module test**

Run: `./scripts/test.sh unit -- src/ui/modes/histogram.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the dispatch machinery to `PanelView` and delegate histogram**

In `frontend/src/ui/panel.ts`:

1. Imports: `import { histogramModule } from "./modes/histogram";` and `import type { FrameInput, PlotModeModule, PrepareInput } from "./modes/contract";`

2. Add the cache field next to the other private fields:

```ts
  private prepCache: {
    key: string;
    tiles: ColumnarTileResponse | null;
    samples: SampleResponse | null;
    geometry: unknown;
  } | null = null;
```

3. Add the two methods (place them right after `renderForMode`):

```ts
  /** Stage-2 cache: prepare re-runs only when data or config identity moves. */
  private geometryFor<G>(module: PlotModeModule<G>, input: PrepareInput): G {
    const key = `${module.mode}\u0000${module.configKey(input.state)}`;
    if (
      this.prepCache === null ||
      this.prepCache.key !== key ||
      this.prepCache.tiles !== input.tiles ||
      this.prepCache.samples !== input.samples
    ) {
      this.prepCache = {
        key,
        tiles: input.tiles,
        samples: input.samples,
        geometry: module.prepare(input),
      };
    }
    return this.prepCache.geometry as G;
  }

  private renderViaModule<G>(
    module: PlotModeModule<G>,
    state: RenderPanelState,
    tiles: ColumnarTileResponse | null,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    const input: PrepareInput = {
      state,
      tiles,
      samples,
      callbacks: this.callbacks,
    };
    const geometry = this.geometryFor(module, input);
    const frame: FrameInput = {
      window,
      emphasizePaths: this.emphasizePaths,
      resolveRanges: (prepared, seriesKey) =>
        this.resolvePlotRanges(state, prepared, window, seriesKey),
    };
    const result = module.project(geometry, input, frame);
    this.preparedPlot = result.prepared;
    if (result.xyTraces !== undefined) this.xyTraces = result.xyTraces;
    if (result.domainSeries !== undefined) {
      this.domainSeries = result.domainSeries;
    }
    if (result.hasColorbar !== undefined) this.hasColorbar = result.hasColorbar;
    if (result.emptyState !== undefined) {
      this.setModeEmpty(result.emptyState.empty, result.emptyState.note);
    }
    const plot = result.plot;
    if (plot.kind === "empty") return 0;
    if (plot.kind === "bins") {
      return this.renderer.render(plot.response, plot.xRange, plot.options);
    }
    return this.renderer.renderPaths(plot.paths, plot.options);
  }
```

Check `resolvePlotRanges`'s current signature (`state, plot, window, seriesKey = ""`): the wrapper passes `seriesKey` through as `seriesKey ?? ""` if the optional needs defaulting.

4. In `renderForMode`, replace the histogram branch:

```ts
if (state.mode === "histogram") {
  return this.renderViaModule(histogramModule, state, tiles, samples, window);
}
```

5. Delete the whole `renderHistogram` method.

- [ ] **Step 6: Run the panel suite**

Run: `./scripts/test.sh unit -- src/ui/panel.test.ts src/ui/modes`
Expected: PASS with zero behavioral edits.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/modes/histogram.ts frontend/src/ui/modes/histogram.test.ts frontend/src/ui/panel.ts
git commit -m "refactor(modes): extract the histogram mode onto the module contract"
```

---

### Task 4: FFT module

Same pattern as Task 3, reusing the dispatch machinery. The FFT body is `renderSpectra` (`panel.ts:1241-1297`). Note: `spectrum()` stays in `project` this phase — its output depends on the visible window, and moving it to `prepare` is the phase-4 sample-pipeline change, not this migration.

**Files:**

- Create: `frontend/src/ui/modes/fft.ts`
- Modify: `frontend/src/ui/panel.ts` (dispatch fft; delete `renderSpectra`)
- Test: `frontend/src/ui/modes/fft.test.ts`

**Interfaces:**

- Consumes: contract, shared helpers, `spectrum` (`frontend/src/app/spectrum.ts`), `prepareFftPlot` (`frontend/src/app/plot-capabilities.ts`).
- Produces: `export interface FftGeometry { samples: SampleResponse | null }`, `export const fftModule: PlotModeModule<FftGeometry>`.

- [ ] **Step 1: Write the failing characterization test**

Create `frontend/src/ui/modes/fft.test.ts`, reusing the fixture shapes from `histogram.test.ts` (copy the `series`/`callbacks`/`renderSeries`/`state` helpers, changing `mode` to `"fft"`):

```ts
import { describe, expect, it } from "vitest";
import type { SampleResponse, SampleSeries } from "../../generated/protocol";
import { spectrum } from "../../app/spectrum";
import type { FrameInput, PrepareInput } from "./contract";
import { fftModule } from "./fft";

// ... copy the series/callbacks/renderSeries/state helpers from
// histogram.test.ts here, with mode: "fft" in the state helper ...

const frame: FrameInput = {
  window: { t0: 0, t1: 1 },
  emphasizePaths: null,
  resolveRanges: () => ({ x: { min: 1, max: 100 }, y: { min: -120, max: 0 } }),
};

describe("fftModule", () => {
  it("projects the spectrum path the old renderSpectra produced", () => {
    const n = 128;
    const time = Array.from({ length: n }, (_, index) => index / (n - 1));
    const values = time.map((t) => Math.sin(2 * Math.PI * 8 * t));
    const source: SampleSeries = {
      signal_path: "run_0001/a",
      unit: null,
      time,
      values,
      stride: 1,
    } as SampleSeries;
    const samples = { request_id: "r", series: [source] } as SampleResponse;
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples,
      callbacks,
    };
    const result = fftModule.project(fftModule.prepare(input), input, frame);
    expect(result.plot.kind).toBe("paths");
    if (result.plot.kind !== "paths") return;
    const expected = spectrum(source, 0, 1);
    expect(expected).not.toBeNull();
    if (expected === null) return;
    const points: number[] = [];
    expected.frequency.forEach((frequency, index) => {
      points.push(frequency, expected.amplitudeDb[index] ?? -120);
    });
    expect(result.plot.paths[0]?.points).toEqual(points);
    expect(result.plot.options.xScale).toBe("log");
    expect(result.plot.options.yLabel).toBe("amplitude (dB)");
    expect(result.domainSeries).toHaveLength(1);
    expect(result.domainSeries?.[0]?.x).toEqual(expected.frequency);
    expect(result.emptyState).toEqual({
      empty: false,
      note: "Not enough samples in view.",
    });
  });

  it("reports the empty state when no series has enough samples", () => {
    const samples = {
      request_id: "r",
      series: [
        {
          signal_path: "run_0001/a",
          unit: null,
          time: [0, 0.5, 1],
          values: [1, 2, 3],
          stride: 1,
        } as SampleSeries,
      ],
    } as SampleResponse;
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples,
      callbacks,
    };
    const result = fftModule.project(fftModule.prepare(input), input, frame);
    expect(result.plot.kind).toBe("empty");
    expect(result.emptyState).toEqual({
      empty: true,
      note: "Not enough samples in view.",
    });
    // The old body still built preparedPlot from zero series before bailing.
    expect(result.prepared).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/ui/modes/fft.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `frontend/src/ui/modes/fft.ts`**

Transform of `renderSpectra`, preserving its exact ordering (spectra computed, empty-state set, `prepareFftPlot` built from whatever succeeded, THEN the zero-paths early return):

```ts
import type { SampleResponse } from "../../generated/protocol";
import { spectrum } from "../../app/spectrum";
import { prepareFftPlot } from "../../app/plot-capabilities";
import type { DomainSeriesEntry, PlotModeModule } from "./contract";
import type { PlotPath } from "../../render/canvas-renderer";
import { colorIndexForHue } from "./shared";

export interface FftGeometry {
  samples: SampleResponse | null;
}

export const fftModule: PlotModeModule<FftGeometry> = {
  mode: "fft",
  data: { reduction: "samples", windows: ["visible"] },
  configKey: () => "",
  prepare: ({ samples }) => ({ samples }),
  project(geometry, { state }, frame) {
    const samples = geometry.samples;
    if (samples === null) return { plot: { kind: "empty" }, prepared: null };
    const window = frame.window;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const paths: PlotPath[] = [];
    const domainSeries: DomainSeriesEntry[] = [];
    for (const series of state.series) {
      if (!series.visible) continue;
      const source = byPath.get(series.path);
      if (source === undefined) continue;
      const result = spectrum(source, window.t0, window.t1);
      if (result === null) continue;
      const points: number[] = [];
      result.frequency.forEach((frequency, index) => {
        points.push(frequency, result.amplitudeDb[index] ?? -120);
      });
      domainSeries.push({
        path: series.path,
        colorIndex: colorIndexForHue(series.hue),
        hue: series.hue,
        opacity: series.opacity,
        x: result.frequency,
        y: result.amplitudeDb,
      });
      paths.push({
        points,
        hue: series.hue,
        dash: series.dash,
        width: series.width,
        alpha: series.opacity,
      });
    }
    const emptyState = {
      empty: paths.length === 0,
      note: "Not enough samples in view.",
    };
    const prepared = prepareFftPlot({
      series: domainSeries.map((series) => ({
        path: series.path,
        colorIndex: series.colorIndex,
        frequency: series.x,
        amplitudeDb: series.y,
      })),
    });
    if (paths.length === 0) {
      return { plot: { kind: "empty" }, prepared, domainSeries, emptyState };
    }
    const ranges = frame.resolveRanges(prepared);
    if (ranges === null) {
      return { plot: { kind: "empty" }, prepared, domainSeries, emptyState };
    }
    return {
      plot: {
        kind: "paths",
        paths,
        options: {
          xLabel: state.x_label ?? "frequency (Hz), log",
          yLabel: state.y_label ?? "amplitude (dB)",
          xRange: [ranges.x.min, ranges.x.max],
          yRange: [ranges.y.min, ranges.y.max],
          axisStyle: state.axis_style,
          xScale: "log",
        },
      },
      prepared,
      domainSeries,
      emptyState,
    };
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/test.sh unit -- src/ui/modes/fft.test.ts`
Expected: PASS.

- [ ] **Step 5: Delegate and delete**

In `panel.ts`: import `fftModule`; replace the fft branch of `renderForMode` with `return this.renderViaModule(fftModule, state, tiles, samples, window);`; delete `renderSpectra`. The old body pushed into `this.domainSeries` incrementally — `renderData` already resets `this.domainSeries = []` before dispatch, and `renderViaModule` assigns the module's array, so the net state is identical.

- [ ] **Step 6: Run the suites**

Run: `./scripts/test.sh unit -- src/ui/panel.test.ts src/ui/modes`
Expected: PASS.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/modes/fft.ts frontend/src/ui/modes/fft.test.ts frontend/src/ui/panel.ts
git commit -m "refactor(modes): extract the fft mode onto the module contract"
```

---

### Task 5: Time module

The time branch is the tail of `renderForMode` (`panel.ts:1007-1056`). Its response filtering is response/config-scoped → `prepare`; `prepareTimePlot` takes the visible window and stays in `project` (its extents are lazy since phase 1, so this costs nothing on latched panels).

**Files:**

- Create: `frontend/src/ui/modes/time.ts`
- Modify: `frontend/src/ui/panel.ts` (dispatch time; `renderForMode` shrinks to mode dispatch only)
- Test: `frontend/src/ui/modes/time.test.ts`

**Interfaces:**

- Consumes: contract, shared helpers, `prepareTimePlot` (`frontend/src/app/plot-capabilities.ts`).
- Produces: `export interface TimeGeometry { shown: ColumnarTileResponse | null; bySeries: Map<string, RenderSeries> }`, `export const timeModule: PlotModeModule<TimeGeometry>`.

- [ ] **Step 1: Write the failing characterization test**

Create `frontend/src/ui/modes/time.test.ts`. Build tiles with `binColumnsFromWire` (see `frontend/src/app/bin-columns.test.ts` for the `EnvelopeBin` shape — `finite_count`/`sample_count` are strings):

```ts
import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../../generated/protocol";
import { binColumnsFromWire } from "../../app/bin-columns";
import type { ColumnarTileResponse } from "../../app/bin-columns";
import type { FrameInput, PrepareInput } from "./contract";
import { timeModule } from "./time";

// ... copy the callbacks/renderSeries/state helpers from histogram.test.ts,
// with mode: "time" in the state helper ...

function bin(t0: number, t1: number, v: number): EnvelopeBin {
  return {
    t0,
    t1,
    first: v,
    last: v,
    min: v,
    max: v,
    sum: v,
    sum_sq: v * v,
    finite_count: "1",
    sample_count: "1",
    has_gap: false,
  };
}

function tiles(paths: string[]): ColumnarTileResponse {
  return {
    requestId: "r",
    series: paths.map((path, index) => ({
      signalId: String(index),
      signalPath: path,
      unit: null,
      level: 0,
      bins: binColumnsFromWire([bin(0, 1, index), bin(1, 2, index + 1)]),
    })),
  } as ColumnarTileResponse;
}

const frame: FrameInput = {
  window: { t0: 0, t1: 2 },
  emphasizePaths: null,
  resolveRanges: () => ({ x: { min: 0, max: 2 }, y: { min: 0, max: 3 } }),
};

describe("timeModule", () => {
  it("prepare filters hidden series out of the response", () => {
    const input: PrepareInput = {
      state: {
        ...state(["run_0001/a", "run_0001/b"]),
        series: [
          renderSeries("run_0001/a"),
          { ...renderSeries("run_0001/b"), visible: false },
        ],
      } as PrepareInput["state"],
      tiles: tiles(["run_0001/a", "run_0001/b"]),
      samples: null,
      callbacks,
    };
    const geometry = timeModule.prepare(input);
    expect(geometry.shown?.series.map((tile) => tile.signalPath)).toEqual([
      "run_0001/a",
    ]);
  });

  it("projects bins with per-series styles and emphasis indices", () => {
    const input: PrepareInput = {
      state: state(["run_0001/a", "run_0001/b"]),
      tiles: tiles(["run_0001/a", "run_0001/b"]),
      samples: null,
      callbacks,
    };
    const geometry = timeModule.prepare(input);
    const result = timeModule.project(geometry, input, {
      ...frame,
      emphasizePaths: new Set(["run_0001/b"]),
    });
    expect(result.plot.kind).toBe("bins");
    if (result.plot.kind !== "bins") return;
    expect(result.plot.response.series).toHaveLength(2);
    expect(result.plot.options.styles).toHaveLength(2);
    expect(result.plot.options.styles?.[0]).toEqual({
      hue: 1,
      dash: "solid",
      width: 1.4,
      alpha: 1,
    });
    expect(result.plot.options.emphasisIndices).toEqual([1]);
    expect(result.plot.options.xLabel).toBe("time (s)");
    expect(result.prepared).not.toBeNull();
  });

  it("returns empty with no tiles", () => {
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples: null,
      callbacks,
    };
    const result = timeModule.project(timeModule.prepare(input), input, frame);
    expect(result.plot.kind).toBe("empty");
    expect(result.prepared).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/ui/modes/time.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `frontend/src/ui/modes/time.ts`**

Transform of `panel.ts:1007-1056`. Key details preserved: the emphasis block only attaches `emphasisIndices` when `emphasizePaths` is non-null; `resolveRanges` receives the series key; a null styles entry falls back exactly as before:

```ts
import type { ColumnarTileResponse } from "../../app/bin-columns";
import { prepareTimePlot } from "../../app/plot-capabilities";
import type { RenderOptions } from "../../render/canvas-renderer";
import type { RenderSeries } from "../panel";
import type { PlotModeModule } from "./contract";
import { colorIndexForHue, yLabel } from "./shared";

export interface TimeGeometry {
  shown: ColumnarTileResponse | null;
  bySeries: Map<string, RenderSeries>;
}

export const timeModule: PlotModeModule<TimeGeometry> = {
  mode: "time",
  data: { reduction: "envelope", windows: [] },
  configKey: (state) =>
    state.series
      .map((series) => `${series.path}:${series.visible ? 1 : 0}`)
      .join("\u0000"),
  prepare({ state, tiles }) {
    const bySeries = new Map(
      state.series.map((series) => [series.path, series]),
    );
    if (tiles === null || state.series.length === 0) {
      return { shown: null, bySeries };
    }
    const shown = tiles.series.filter(
      (tile) => bySeries.get(tile.signalPath)?.visible ?? true,
    );
    return { shown: { requestId: tiles.requestId, series: shown }, bySeries };
  },
  project(geometry, { state }, frame) {
    if (geometry.shown === null) {
      return { plot: { kind: "empty" }, prepared: null };
    }
    const { bySeries } = geometry;
    const shown = geometry.shown.series;
    const prepared = prepareTimePlot({
      series: shown.map((tile) => {
        const series = bySeries.get(tile.signalPath);
        return {
          path: tile.signalPath,
          colorIndex: colorIndexForHue(series?.hue ?? 1),
          bins: tile.bins,
        };
      }),
      window: frame.window,
    });
    const seriesKey = state.series.map((series) => series.path).join("\u0000");
    const ranges = frame.resolveRanges(prepared, seriesKey);
    if (ranges === null) return { plot: { kind: "empty" }, prepared };
    const options: RenderOptions = {
      xLabel: state.x_label ?? "time (s)",
      yLabel: state.y_label ?? yLabel(shown.map((tile) => tile.unit)),
      yRange: [ranges.y.min, ranges.y.max],
      axisStyle: state.axis_style,
      styles: shown.map((tile) => {
        const series = bySeries.get(tile.signalPath);
        return {
          hue: series?.hue ?? null,
          dash: series?.dash ?? "solid",
          width: series?.width ?? 1.4,
          alpha: series?.opacity ?? 1,
        };
      }),
      ...(frame.emphasizePaths !== null
        ? {
            emphasisIndices: shown.flatMap((tile, index) =>
              frame.emphasizePaths?.has(tile.signalPath) ? [index] : [],
            ),
          }
        : {}),
    };
    return {
      plot: {
        kind: "bins",
        response: geometry.shown,
        xRange: ranges.x,
        options,
      },
      prepared,
    };
  },
};
```

Note one intentional equivalence: the old code guarded `tiles === null || state.series.length === 0` at project time; the module guards in `prepare` (returning `shown: null`) and `project` checks `shown === null`. An empty `state.series` yields `shown: null` the same way. Verify the old body's exact fallback for `yLabel` — it read `response.series.map((tile) => tile.unit)` where `response` was the filtered response; `shown.map((tile) => tile.unit)` is the same array.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/test.sh unit -- src/ui/modes/time.test.ts`
Expected: PASS.

- [ ] **Step 5: Delegate and delete**

In `panel.ts`, `renderForMode`'s time tail (everything after the histogram/fft/xy branches) becomes:

```ts
return this.renderViaModule(timeModule, state, tiles, samples, window);
```

Delete the moved lines (the `bySeries` map through the `this.renderer.render(...)` call).

- [ ] **Step 6: Run the suites**

Run: `./scripts/test.sh unit -- src/ui/panel.test.ts src/ui/modes src/render/y-axis.test.ts`
Expected: PASS — the sticky-y interplay (Task 1 of phase 1) flows through `frame.resolveRanges` unchanged.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/modes/time.ts frontend/src/ui/modes/time.test.ts frontend/src/ui/panel.ts
git commit -m "refactor(modes): extract the time mode onto the module contract"
```

---

### Task 6: XY module — pairing becomes a real prepare stage

The largest extraction (`renderXy`, `panel.ts:1059-1238`). The phase-1 `XyPrepCache` proved the window-free set: pairing, the series index, dimmed trajectories, colour columns, and the colour domain all move into `prepare`; `project` keeps only the lit windowed flatten, range resolution, and options assembly. The `XyPrepCache` class is then unused and is deleted along with its tests — the framework cache (`geometryFor`) now provides the identical response-scoped invalidation.

**Files:**

- Create: `frontend/src/ui/modes/xy.ts`
- Modify: `frontend/src/ui/panel.ts` (dispatch xy; delete `renderXy`, `resolveXSeries`, `flattenTrace`, the `xyPrep` field, and the `XyPrepCache` import; `markerAt` stays — the cursor overlay uses it)
- Modify: `frontend/src/app/xy.ts` (delete the `XyPrepCache` class)
- Modify: `frontend/src/app/xy.test.ts` (delete the `XyPrepCache` describe block; keep `buildSeriesIndex` tests)
- Test: `frontend/src/ui/modes/xy.test.ts`

**Interfaces:**

- Consumes: contract, shared helpers, `pairSamples` / `lerpSample` / `buildSeriesIndex` / `seriesIndexKey` (`frontend/src/app/xy.ts`), `prepareXyPlot` (`frontend/src/app/plot-capabilities.ts`).
- Produces:
  - `export interface XyGeometry { xSeries: SampleSeries | null; entries: XyTraceEntry[]; dimmed: number[][]; colorColumns: (number[] | null)[]; colorDomain: { min: number; max: number } | null; colorLabelUnit: string | null; }`
  - `export const xyModule: PlotModeModule<XyGeometry>`
  - `export function flattenTrace(trace: XyTrace, window: { t0: number; t1: number } | null): number[]` — moved verbatim from `panel.ts:2779-2793` into `modes/xy.ts` and exported (project uses it per frame; the dimmed variant is precomputed in prepare).

- [ ] **Step 1: Write the failing characterization test**

Create `frontend/src/ui/modes/xy.test.ts`. Shared-timebase pair, one trace, no colour channel; assertions pin the dimmed-under-lit path ordering, widths, and identity reuse across frames:

```ts
import { describe, expect, it } from "vitest";
import type { SampleResponse, SampleSeries } from "../../generated/protocol";
import type { FrameInput, PrepareInput } from "./contract";
import { flattenTrace, xyModule } from "./xy";

// ... copy the callbacks/renderSeries helpers from histogram.test.ts; the
// state helper takes mode "xy" plus x_signal:
function xyState(xSignal: string, paths: string[]) {
  return {
    ...state(paths),
    mode: "xy",
    x_signal: xSignal,
  } as PrepareInput["state"];
}

function series(path: string, time: number[], values: number[]): SampleSeries {
  return {
    signal_path: path,
    unit: "V",
    time,
    values,
    stride: 1,
  } as SampleSeries;
}

const frame: FrameInput = {
  window: { t0: 0, t1: 1 },
  emphasizePaths: null,
  resolveRanges: () => ({ x: { min: 0, max: 4 }, y: { min: 0, max: 4 } }),
};

describe("xyModule", () => {
  const samples = {
    request_id: "r",
    series: [
      series("run_0001/command", [0, 1, 2], [1, 2, 3]),
      series("run_0001/response", [0, 1, 2], [2, 3, 4]),
    ],
  } as SampleResponse;

  function input(): PrepareInput {
    return {
      state: xyState("run_0001/command", ["run_0001/response"]),
      tiles: null,
      samples,
      callbacks,
    };
  }

  it("projects the dimmed full trajectory under the lit windowed one", () => {
    const prep = input();
    const geometry = xyModule.prepare(prep);
    const result = xyModule.project(geometry, prep, frame);
    expect(result.plot.kind).toBe("paths");
    if (result.plot.kind !== "paths") return;
    expect(result.plot.paths).toHaveLength(2);
    const [dimmed, lit] = result.plot.paths;
    expect(dimmed?.dimmed).toBe(true);
    expect(dimmed?.width).toBe(1.2);
    expect(dimmed?.points).toEqual(
      flattenTrace(geometry.entries[0]!.trace, null),
    );
    expect(lit?.markers).toBe(true);
    expect(lit?.width).toBeCloseTo(1.4 + 0.4);
    // Window [0,1] lifts the pen on the sample at t=2.
    expect(lit?.points).toEqual([1, 2, 2, 3, Number.NaN, Number.NaN]);
    expect(result.xyTraces).toHaveLength(1);
    expect(result.hasColorbar).toBe(false);
    // Pins the yUnits preservation: both fixture series carry unit "V".
    // yLabel's exact format lives in modes/shared.ts — assert it saw the
    // unit, and tighten to the exact string once you've read that body.
    expect(result.plot.options.yLabel).toContain("V");
  });

  it("keeps trace and dimmed identity across frames (prepare not re-run)", () => {
    const prep = input();
    const geometry = xyModule.prepare(prep);
    const first = xyModule.project(geometry, prep, frame);
    const second = xyModule.project(geometry, prep, {
      ...frame,
      window: { t0: 1, t1: 2 },
    });
    if (first.plot.kind !== "paths" || second.plot.kind !== "paths") {
      throw new Error("expected paths");
    }
    expect(second.plot.paths[0]?.points).toBe(first.plot.paths[0]?.points);
    expect(second.xyTraces?.[0]?.trace).toBe(first.xyTraces?.[0]?.trace);
  });

  it("returns empty without an x signal or samples", () => {
    const noSamples: PrepareInput = { ...input(), samples: null };
    expect(
      xyModule.project(xyModule.prepare(noSamples), noSamples, frame).plot.kind,
    ).toBe("empty");
    const noX: PrepareInput = {
      ...input(),
      state: { ...input().state, x_signal: null } as PrepareInput["state"],
    };
    const result = xyModule.project(xyModule.prepare(noX), noX, frame);
    expect(result.plot.kind).toBe("empty");
    expect(result.xyTraces).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/ui/modes/xy.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `frontend/src/ui/modes/xy.ts`**

Move `flattenTrace` verbatim from `panel.ts` and export it. Then the module — a careful split of `renderXy`. Everything up to and including the colour domain scan comes from the old body's pre-`paths` section (window-free); the paths/options assembly is the frame section:

```ts
import type { SampleResponse, SampleSeries } from "../../generated/protocol";
import {
  buildSeriesIndex,
  lerpSample,
  pairSamples,
  seriesIndexKey,
  type SeriesPathCallbacks,
  type XyTrace,
} from "../../app/xy";
import { prepareXyPlot } from "../../app/plot-capabilities";
import type { PathRenderOptions, PlotPath } from "../../render/canvas-renderer";
import type { PlotModeModule, XyTraceEntry } from "./contract";
import { axisName, colorIndexForHue, visibleSources, yLabel } from "./shared";

export interface XyGeometry {
  xSeries: SampleSeries | null;
  entries: XyTraceEntry[];
  /** flattenTrace(trace, null) per entry, parallel to `entries`. */
  dimmed: number[][];
  /** Raw colour column per entry, parallel to `entries`. */
  colorColumns: (number[] | null)[];
  /** Padded domain of the colour channel, null when no colour is active. */
  colorDomain: { min: number; max: number } | null;
  colorLabelUnit: string | null;
  /**
   * True when the panel had a resolved colour series (or colour-by-time),
   * even if every colour value was non-finite — the old code passed a
   * non-null `color` to prepareXyPlot in exactly that case.
   */
  hadColorSeries: boolean;
  /** Units of the visible y series in state order — the old yLabel input. */
  yUnits: (string | null)[];
}

/**
 * Flattens a trace to renderer vertices. A `window` restricts output to that
 * time span; vertices outside become NaN so the pen lifts rather than
 * bridging the gap.
 */
export function flattenTrace(
  trace: XyTrace,
  window: { t0: number; t1: number } | null,
): number[] {
  const points: number[] = [];
  for (let index = 0; index < trace.time.length; index += 1) {
    const time = trace.time[index] ?? Number.NaN;
    const inside = window === null || (time >= window.t0 && time <= window.t1);
    points.push(
      inside ? (trace.x[index] ?? Number.NaN) : Number.NaN,
      inside ? (trace.y[index] ?? Number.NaN) : Number.NaN,
    );
  }
  return points;
}

function resolveXSeries(
  index: ReadonlyMap<string, SampleSeries>,
  xSeries: SampleSeries,
  xSignal: string,
  yPath: string,
  callbacks: SeriesPathCallbacks,
): SampleSeries | undefined {
  const xLocal = callbacks.localPathFor(xSignal);
  if (xLocal === null) return xSeries;
  const sourceKey = callbacks.sourceKeyFor(yPath);
  if (sourceKey === null) return xSeries;
  return index.get(seriesIndexKey(sourceKey, xLocal));
}

const EMPTY: XyGeometry = {
  xSeries: null,
  entries: [],
  dimmed: [],
  colorColumns: [],
  colorDomain: null,
  colorLabelUnit: null,
  hadColorSeries: false,
  yUnits: [],
};

export const xyModule: PlotModeModule<XyGeometry> = {
  mode: "xy",
  data: { reduction: "samples", windows: ["context", "visible"] },
  configKey: (state) =>
    [
      state.x_signal ?? "",
      state.color_by_time ? "time" : (state.color_signal ?? ""),
      ...state.series
        .filter((series) => series.visible)
        .map((series) => series.path),
    ].join("\u0000"),
  prepare({ state, samples, callbacks }) {
    if (samples === null || state.x_signal === null) return EMPTY;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const xSeries = byPath.get(state.x_signal);
    if (xSeries === undefined) return EMPTY;
    const index = buildSeriesIndex(samples.series, callbacks);
    const entries: XyTraceEntry[] = [];
    for (const series of state.series) {
      if (!series.visible) continue;
      const ySeries = byPath.get(series.path);
      if (ySeries === undefined) continue;
      const resolved = resolveXSeries(
        index,
        xSeries,
        state.x_signal,
        series.path,
        callbacks,
      );
      if (resolved === undefined) continue;
      entries.push({
        path: series.path,
        colorIndex: colorIndexForHue(series.hue),
        hue: series.hue,
        dash: series.dash,
        width: series.width,
        opacity: series.opacity,
        trace: pairSamples(resolved, ySeries),
      });
    }
    if (entries.length === 0) return { ...EMPTY, xSeries };
    const colorSeries: "time" | SampleSeries | null = state.color_by_time
      ? "time"
      : state.color_signal === null
        ? null
        : (byPath.get(state.color_signal) ?? null);
    const cLocal =
      state.color_signal === null
        ? null
        : callbacks.localPathFor(state.color_signal);
    const resolveColor = (yPath: string): SampleSeries | null => {
      if (colorSeries === null || colorSeries === "time") return null;
      if (cLocal === null) return colorSeries;
      const sourceKey = callbacks.sourceKeyFor(yPath);
      if (sourceKey === null) return colorSeries;
      return index.get(seriesIndexKey(sourceKey, cLocal)) ?? null;
    };
    const colorFor = (yPath: string, trace: XyTrace): number[] | null => {
      if (colorSeries === null) return null;
      if (colorSeries === "time") return [...trace.time];
      const resolved = resolveColor(yPath);
      if (resolved === null) return null;
      return trace.time.map((time) =>
        lerpSample(resolved.time, resolved.values, time),
      );
    };
    const colorColumns = entries.map((entry) =>
      colorFor(entry.path, entry.trace),
    );
    let colorMin = Number.POSITIVE_INFINITY;
    let colorMax = Number.NEGATIVE_INFINITY;
    for (const column of colorColumns) {
      for (const value of column ?? []) {
        if (!Number.isFinite(value)) continue;
        colorMin = Math.min(colorMin, value);
        colorMax = Math.max(colorMax, value);
      }
    }
    const hasColor =
      colorSeries !== null &&
      Number.isFinite(colorMin) &&
      Number.isFinite(colorMax);
    const colorPadding =
      hasColor && colorMin === colorMax
        ? Math.max(1, Math.abs(colorMin) * 0.05)
        : 0;
    return {
      xSeries,
      entries,
      dimmed: entries.map((entry) => flattenTrace(entry.trace, null)),
      colorColumns,
      colorDomain: hasColor
        ? { min: colorMin - colorPadding, max: colorMax + colorPadding }
        : null,
      colorLabelUnit:
        colorSeries !== null && colorSeries !== "time"
          ? colorSeries.unit
          : null,
      hadColorSeries: colorSeries !== null,
      yUnits: state.series
        .filter((series) => series.visible)
        .map((series) => byPath.get(series.path)?.unit ?? null),
    };
  },
  project(geometry, { state, callbacks }, frame) {
    if (geometry.entries.length === 0 || geometry.xSeries === null) {
      return { plot: { kind: "empty" }, prepared: null, xyTraces: [] };
    }
    if (state.x_signal === null) {
      return { plot: { kind: "empty" }, prepared: null, xyTraces: [] };
    }
    const window = frame.window;
    const xLocal = callbacks.localPathFor(state.x_signal);
    const hasColor = geometry.colorDomain !== null;
    const colorDomainMin = geometry.colorDomain?.min ?? 0;
    const colorDomainMax = geometry.colorDomain?.max ?? 1;
    const colorSpan = colorDomainMax - colorDomainMin;
    const prepared = prepareXyPlot({
      x: { path: state.x_signal, values: geometry.xSeries.values },
      series: geometry.entries.map((entry, index) => ({
        ...entry,
        colorValues: geometry.colorColumns[index] ?? null,
      })),
      color: geometry.hadColorSeries
        ? {
            path: state.color_by_time ? "time" : (state.color_signal ?? ""),
          }
        : null,
      window,
    });
    const ranges = frame.resolveRanges(prepared);
    if (ranges === null) {
      return {
        plot: { kind: "empty" },
        prepared,
        xyTraces: geometry.entries,
        hasColorbar: hasColor,
      };
    }
    const paths: PlotPath[] = [];
    geometry.entries.forEach((entry, index) => {
      // Whole trajectory dimmed underneath, the windowed part lit on top.
      paths.push({
        points: geometry.dimmed[index] ?? [],
        hue: entry.hue,
        dash: "solid",
        width: 1.2,
        alpha: entry.opacity,
        dimmed: true,
      });
    });
    geometry.entries.forEach((entry, index) => {
      const colorValues = geometry.colorColumns[index];
      paths.push({
        points: flattenTrace(entry.trace, window),
        hue: entry.hue,
        dash: entry.dash,
        width: entry.width + 0.4,
        alpha: entry.opacity,
        markers: true,
        ...(hasColor && colorValues !== null && colorValues !== undefined
          ? {
              colorValues: colorValues.map(
                (value) => (value - colorDomainMin) / colorSpan,
              ),
            }
          : {}),
      });
    });
    const sources = visibleSources(state.series, callbacks);
    const localLabels = sources.size > 1;
    const cLocal =
      state.color_signal === null
        ? null
        : callbacks.localPathFor(state.color_signal);
    const options: PathRenderOptions = {
      xLabel:
        state.x_label ??
        axisName(
          localLabels && xLocal !== null ? xLocal : state.x_signal,
          geometry.xSeries.unit,
        ),
      yLabel: state.y_label ?? yLabel(geometry.yUnits),
      xRange: [ranges.x.min, ranges.x.max],
      yRange: [ranges.y.min, ranges.y.max],
      axisStyle: state.axis_style,
      ...(state.axis_equal ? { equalAspect: true } : {}),
      ...(hasColor
        ? {
            colorbar: {
              min: colorDomainMin,
              max: colorDomainMax,
              label:
                state.c_label ??
                (state.color_by_time
                  ? "t (s)"
                  : axisName(
                      localLabels && cLocal !== null
                        ? cLocal
                        : (state.color_signal ?? ""),
                      geometry.colorLabelUnit,
                    )),
            },
          }
        : {}),
    };
    return {
      plot: { kind: "paths", paths, options },
      prepared,
      xyTraces: geometry.entries,
      hasColorbar: hasColor,
    };
  },
};
```

Two equivalences worth double-checking against the old body with `git diff` discipline before moving on:

1. **`yUnits`.** The old `yLabel` argument was `state.series.filter((series) => series.visible).map((series) => byPath.get(series.path)?.unit ?? null)` — a lookup into the _samples_ by path. The geometry's `yUnits` field carries exactly that expression, computed in `prepare` where `byPath` exists, and `project` reads `yLabel(geometry.yUnits)`. The first characterization test's `yLabel` containment assertion pins this; tighten it to the exact string after reading `yLabel`'s body in `modes/shared.ts`.

2. **`hadColorSeries`.** The old `color:` argument to `prepareXyPlot` was `colorSeries === null ? null : {...}`, where `colorSeries` was `null` when a configured `color_signal` was absent from the response (`byPath.get(...) ?? null`). The geometry's `hadColorSeries` preserves that exact condition; do NOT substitute `state.color_signal !== null`, which differs precisely in that absent-from-response case. Likewise `colorLabelUnit` preserves the old options-time read of `colorSeries.unit`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/test.sh unit -- src/ui/modes/xy.test.ts`
Expected: PASS, including the yLabel assertion.

- [ ] **Step 5: Delegate and delete**

In `panel.ts`:

1. Import `xyModule`; the xy branch of `renderForMode` becomes `return this.renderViaModule(xyModule, state, tiles, samples, window);`
2. In `renderData`, before the `renderForMode` call, add `this.xyTraces = [];` (the old `renderXy` reset it at its top; the module path resets via the result, but early paths — e.g. mode switches — must not leak stale traces).
3. Delete: the `renderXy` method, the module-level `resolveXSeries` and `flattenTrace` functions, the `xyPrep` field, and the `XyPrepCache`/`seriesIndexKey` imports if now unused. `markerAt` stays (cursor overlay). If other `panel.ts` code calls `flattenTrace` (check with `grep -n "flattenTrace" frontend/src/ui/panel.ts`), import it from `./modes/xy`.
4. In `frontend/src/app/xy.ts`, delete the `XyPrepCache` class (keep `buildSeriesIndex`, `seriesIndexKey`, `SeriesPathCallbacks`, `pairSamples`, `lerpSample`, `traceExtent`, `XyTrace`).
5. In `frontend/src/app/xy.test.ts`, delete the `XyPrepCache` describe block; keep the `buildSeriesIndex` tests.

- [ ] **Step 6: Run the affected suites**

Run: `./scripts/test.sh unit -- src/ui/panel.test.ts src/ui/modes src/app/xy.test.ts src/app/xy-hit.test.ts`
Expected: PASS. The panel suite's XY tests (pairing, colour, cross-source) are the characterization net for this task — no behavioral edits allowed.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/modes/xy.ts frontend/src/ui/modes/xy.test.ts frontend/src/ui/panel.ts frontend/src/app/xy.ts frontend/src/app/xy.test.ts
git commit -m "refactor(modes): extract the xy mode with a real prepare stage"
```

---

### Task 7: The registry, and `renderForMode` collapses

**Files:**

- Create: `frontend/src/ui/modes/index.ts`
- Modify: `frontend/src/ui/panel.ts` (`renderForMode` becomes one dispatch)
- Test: `frontend/src/ui/modes/index.test.ts`

**Interfaces:**

- Consumes: the four modules.
- Produces: `export function plotModeModule(mode: PanelMode): PlotModeModule<unknown>` — Task 8 and any future fifth mode consume this.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/ui/modes/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MODE_DATA } from "./contract";
import { plotModeModule } from "./index";

describe("plotModeModule", () => {
  it("returns the module for every mode with matching declarations", () => {
    for (const mode of ["time", "xy", "fft", "histogram"] as const) {
      const module = plotModeModule(mode);
      expect(module.mode).toBe(mode);
      expect(module.data).toEqual(MODE_DATA[mode]);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/ui/modes/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `frontend/src/ui/modes/index.ts`**

```ts
import type { PanelMode } from "../../generated/session";
import type { PlotModeModule } from "./contract";
import { fftModule } from "./fft";
import { histogramModule } from "./histogram";
import { timeModule } from "./time";
import { xyModule } from "./xy";

const MODULES: Record<PanelMode, PlotModeModule<unknown>> = {
  time: timeModule as PlotModeModule<unknown>,
  xy: xyModule as PlotModeModule<unknown>,
  fft: fftModule as PlotModeModule<unknown>,
  histogram: histogramModule as PlotModeModule<unknown>,
};

/** The registry the panel and shell dispatch through — a fifth mode is one
 * new entry here plus its module file. */
export function plotModeModule(mode: PanelMode): PlotModeModule<unknown> {
  return MODULES[mode];
}
```

- [ ] **Step 4: Collapse `renderForMode`**

In `panel.ts`, replace the whole method body:

```ts
  private renderForMode(
    state: RenderPanelState,
    tiles: ColumnarTileResponse | null,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    return this.renderViaModule(
      plotModeModule(state.mode),
      state,
      tiles,
      samples,
      window,
    );
  }
```

Replace the four per-module imports in `panel.ts` with `import { plotModeModule } from "./modes";`.

- [ ] **Step 5: Run the suites**

Run: `./scripts/test.sh unit -- src/ui/panel.test.ts src/ui/modes`
Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/modes/index.ts frontend/src/ui/modes/index.test.ts frontend/src/ui/panel.ts
git commit -m "refactor(modes): dispatch every mode through the registry"
```

---

### Task 8: The shell acquires by `ModeDataSpec`

Move `refreshTilesPass`'s branching (`app-shell.ts`, `panel.mode === "time"` at ~2656) and `sampleCapForPanel`'s request count (`~:123`, `mode === "xy" ? 2 : 1`) onto the declared specs. The XY context/detail split becomes "declares a context window", so a fifth sample-backed mode inherits the right requests from its declaration.

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`sampleCapForPanel`, `refreshTilesPass`)
- Test: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Consumes: `plotModeModule` / `MODE_DATA` from Task 7.
- Produces: `sampleCapForPanel(mode, seriesCount)` — same signature, now spec-driven; `refreshTilesPass` branches on `reduction`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/ui/app-shell.test.ts`:

```ts
describe("sampleCapForPanel", () => {
  it("derives the request count from the mode's declared windows", () => {
    // xy declares context+visible (2 requests); fft/histogram declare 1.
    expect(sampleCapForPanel("xy", 1000)).toBe(
      Math.floor(500_000 / (1000 * 2)),
    );
    expect(sampleCapForPanel("fft", 1000)).toBe(Math.floor(500_000 / 1000));
    expect(sampleCapForPanel("histogram", 4)).toBe(32_768);
    expect(sampleCapForPanel("time", 4)).toBe(8192);
  });
});
```

Add `sampleCapForPanel` to the test file's import from `./app-shell` if missing. These expected values are today's behavior — the test asserts the refactor changes nothing.

- [ ] **Step 2: Run the test to verify it currently passes, then refactor**

Run: `./scripts/test.sh unit -- src/ui/app-shell.test.ts`
Expected: PASS already (this is a pin-then-refactor task, not test-fail-first — the refactor must keep it green).

- [ ] **Step 3: Refactor `sampleCapForPanel`**

In `app-shell.ts` (import `MODE_DATA` from `./modes/contract`):

```ts
export function sampleCapForPanel(
  mode: PanelMode,
  seriesCount: number,
): number {
  const requests = Math.max(1, MODE_DATA[mode].windows.length);
  const share = Math.floor(
    SAMPLE_POINT_BUDGET / (Math.max(1, seriesCount) * requests),
  );
  return Math.max(1, Math.min(sampleCapFor(mode), share));
}
```

(keep the doc comment, updating its "XY issues two" sentence to "a mode issues one request per declared window").

- [ ] **Step 4: Refactor `refreshTilesPass`**

Replace `if (panel.mode === "time") {` with:

```ts
          const spec = MODE_DATA[panel.mode];
          if (spec.reduction === "envelope") {
```

and in the sample branch, replace the `panel.mode === "xy"` checks:

```ts
const wantsContext = spec.windows.includes("context");
const contextWindow = wantsContext
  ? this.sampleWindow(panel)
  : this.effectiveWindow(panel);
const cap = sampleCapForPanel(panel.mode, ids.length);
const cacheKey = SampleWindowCache.key({
  ids,
  mode: panel.mode,
  window: wantsContext ? window : contextWindow,
  cap,
});
const cached = this.sampleWindowCache.get(panel.id, cacheKey);
if (cached !== null) {
  nextSamples.set(panel.id, cached);
  return;
}
let merged: SampleResponse;
if (wantsContext) {
  merged = await fetchXySamples({
    plane: this.plane,
    panelId: panel.id,
    ids,
    cap,
    contextWindow,
    window,
    contextCache: this.xyContextCache,
  });
} else {
  merged = await this.plane.querySamples({
    request_id: crypto.randomUUID(),
    signal_ids: ids,
    window: contextWindow,
    max_points: cap,
  });
}
```

Check this against the phase-1 state of the block before editing — the shapes must line up exactly (the `sampleWindow(panel)` helper already returns `effectiveWindow` for non-xy modes, so routing non-context modes through `effectiveWindow` directly is behavior-preserving; verify by reading `sampleWindow`, ~line 2886).

- [ ] **Step 5: Run the suites**

Run: `./scripts/test.sh unit -- src/ui/app-shell.test.ts src/app/xy-samples.test.ts`
Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts
git commit -m "refactor(shell): acquire panel data from the declared mode spec"
```

---

### Task 9: Full gate, bench, and silhouette confirmation

**Files:** none (verification only)

- [ ] **Step 1: Broad gate**

Run: `./scripts/test.sh quick`
Expected: PASS.

- [ ] **Step 2: Bench with floors**

Run: `./scripts/test.sh bench`
Expected: PASS — `e2e_mc1000` floors hold. Compare `build/bench/report.json` against the phase-1 numbers: `frame_p95_ms` and `first_plot_ms` must be within noise (this phase moves code; it must not move cost). The `e2e_mc1000_modes` entry re-records — its numbers should match phase 1's within noise as well. Report both tables in the handoff.

- [ ] **Step 3: Visual smoke**

Run the demo (`./scripts/demo.sh` if available, else `./scripts/dev.sh` and load `examples/` data). Flip one panel through all four modes, pan and zoom in each, hover for the cursor, toggle a series. Expected: identical behavior to pre-phase-2; any visual difference whatsoever is a bug in an extraction — bisect the module tasks with `git bisect` if needed.

- [ ] **Step 4: Record the outcome**

Note in the handoff: `panel.ts` line count before/after (`git show <pre-phase-2-commit>:frontend/src/ui/panel.ts | wc -l` vs `wc -l frontend/src/ui/panel.ts`), the bench deltas, and confirmation that adding a fifth mode now touches: one module file + one registry line + the schema/chrome items listed in the spec's §"What a fifth mode costs".

---

## Self-review notes (already applied)

- Spec coverage: this plan implements §"Architecture: the unified mode pipeline" stages 1-3 structure (Tasks 1-8) with stage-4 renderer untouched, per the spec's phasing. The density tier (phase 3) and pyramid XY (phase 4) are intentionally absent. The spec's promise that "prepare never runs during pan/zoom" is delivered by `geometryFor`; FFT/histogram keep window-dependent math in `project` this phase because moving it changes transient visuals — that is the phase-4 sample-pipeline change, and the spec's zero-visual-change rule for this phase wins.
- Task 6's two subtle preservation points (`yUnits` computed in prepare where `byPath` exists; `hadColorSeries` capturing the old absent-from-response colour condition) are baked into the geometry interface and listing directly, with a verification note — the characterization test's yLabel assertion catches a botched port of either.
- Type consistency: `PrepareInput`/`FrameInput`/`ProjectResult` names and shapes match across Tasks 1 and 3-8; `geometryFor`/`renderViaModule` are defined once (Task 3) and only referenced afterward; `plotModeModule` (Task 7) is the only registry symbol Task 8 imports beyond `MODE_DATA`.
- Known drift risk: this plan was written against the tree at phase-1-plan time. If phase 1's execution renamed anything (e.g. `XyPrepCache` methods), re-locate by grep before each task; the contracts here define the target state regardless.

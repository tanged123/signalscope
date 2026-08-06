# Unified Plotting Pipeline — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the verified quick wins, device-pixel correctness, and sample-mode bench coverage from `docs/superpowers/specs/2026-08-06-unified-renderer-design.md` §"Verified quick wins" and §"Device-pixel correctness" — the measured-relief phase that precedes the pipeline rework.

**Architecture:** Every task removes a verified per-frame cost (linear scans, re-fetches, re-pairing, eager extents, `JSON.stringify`) or a resolution loss (CSS-pixel snapping and request density), without changing the pipeline's shape. New logic lands as small exported pure functions/classes in `frontend/src/app/` so it is unit-testable and survives the phase-2 migration.

**Tech Stack:** TypeScript (strict), vitest (jsdom), Playwright bench project, bash script wrappers, no new dependencies.

## Global Constraints

- Run everything through the `./scripts/` wrappers, from the repo root:
  - unit tests: `./scripts/test.sh unit -- <path-or-pattern>`
  - formatting: `./scripts/format.sh` (run before every commit)
  - broad gate: `./scripts/test.sh quick`
  - benchmarks: `./scripts/test.sh bench`
- Never modify anything under `refs/` (third-party reference checkouts) or `frontend/src/generated/` (codegen output).
- These budget constants must NOT change in this phase: `TILE_BIN_BUDGET = 250_000`, `SAMPLE_POINT_BUDGET = 500_000`, `SAMPLE_CAP = 8192`, `SAMPLE_MODE_CAP = 32_768` (all in `frontend/src/ui/app-shell.ts`).
- The renderer must stay a deterministic pure function of response + viewport + palette. No `Date.now()`, no randomness, no ambient state in render paths.
- Stage only the files each task lists. Preserve any unrelated worktree changes.
- Work on the current branch (`unified_fast_renderer`). One commit per task, message format shown in each task.
- If an existing test fails after your change, read it before touching it: update the expectation ONLY when the test encodes the old behavior this plan intentionally changes (each task says which), otherwise your change is wrong.

---

### Task 0: Capture the pre-change bench baseline

No code changes. The spec requires before/after measurement.

**Files:** none (build output only, untracked)

- [ ] **Step 1: Run the benchmark suite on the unmodified tree**

Run: `./scripts/test.sh bench`
Expected: completes; writes `build/bench/report.json`. This takes several minutes (it generates the mc1000 corpus on first run and bakes a snapshot).

- [ ] **Step 2: Preserve the baseline report**

```bash
cp build/bench/report.json build/bench/report-baseline.json
```

`build/` is untracked — do not commit anything. The final task compares against this file.

---

### Task 1: `YAxisPolicy` stops evaluating the autorange thunk once latched

The sticky y-axis policy latches an automatic range once per series set, but `resolve()` calls the `automatic()` thunk on every frame even when the latch is already set (`this.sticky ??= ...` evaluates its right side unconditionally). Short-circuit it so latched panels skip the extent computation entirely — this is what makes Task 2's laziness pay off during pan/zoom.

**Files:**

- Modify: `frontend/src/render/y-axis.ts` (the `resolve` method, ~line 19)
- Test: `frontend/src/render/y-axis.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `YAxisPolicy.resolve(seriesKey: string, automatic: () => readonly [number, number] | null, serialized: readonly [number, number] | null): [number, number] | null` — signature unchanged; new guarantee: `automatic` is not invoked when the latch is already set for `seriesKey`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/render/y-axis.test.ts`, using its existing imports:

```ts
it("stops evaluating the automatic thunk once the latch is set", () => {
  const policy = new YAxisPolicy();
  let calls = 0;
  const automatic = (): readonly [number, number] | null => {
    calls += 1;
    return [0, 10];
  };
  expect(policy.resolve("a", automatic, null)).toEqual([0, 10]);
  expect(policy.resolve("a", automatic, null)).toEqual([0, 10]);
  expect(calls).toBe(1);
  // A series-set change resets the latch and re-evaluates.
  expect(policy.resolve("b", automatic, null)).toEqual([0, 10]);
  expect(calls).toBe(2);
});
```

If the file uses `test(` instead of `it(`, match the local convention.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/render/y-axis.test.ts`
Expected: FAIL — `calls` is 2 after the second resolve (thunk evaluated while latched).

- [ ] **Step 3: Implement the short-circuit**

In `frontend/src/render/y-axis.ts`, replace the body of `resolve` (keep the doc comment):

```ts
  resolve(
    seriesKey: string,
    automatic: () => readonly [number, number] | null,
    serialized: readonly [number, number] | null,
  ): [number, number] | null {
    if (isUsableYRange(serialized)) return [serialized[0], serialized[1]];
    if (seriesKey !== this.key) {
      this.key = seriesKey;
      this.sticky = null;
    }
    if (this.sticky === null) {
      const next = automatic();
      if (isUsableYRange(next)) this.sticky = [next[0], next[1]];
    }
    return this.sticky;
  }
```

- [ ] **Step 4: Run the test to verify it passes, plus the file's other tests**

Run: `./scripts/test.sh unit -- src/render/y-axis.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/y-axis.ts frontend/src/render/y-axis.test.ts
git commit -m "perf(render): skip the autorange thunk once the y latch is set"
```

---

### Task 2: `prepareTimePlot` computes y extents lazily, once

`prepareTimePlot` (`frontend/src/app/plot-capabilities.ts:210-213`) eagerly maps `columnsYExtent` over every series' bins on every construction — and it is constructed every `renderData` call. For a 1000-series panel that is ~157k bin reads per frame, wasted whenever the y latch (Task 1) or a serialized range short-circuits. Make the extent scan lazy and memoized.

**Files:**

- Modify: `frontend/src/app/plot-capabilities.ts` (`prepareTimePlot`, ~line 210)
- Test: `frontend/src/app/plot-capabilities.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks (composes with Task 1 at runtime).
- Produces: `prepareTimePlot(input: TimePlotInput): PreparedPlot` — signature unchanged; new guarantee: bins are not scanned for extents until `autoRanges()` is called, and at most once per prepared plot.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/app/plot-capabilities.test.ts` (it already imports `binColumnsFromWire` and `prepareTimePlot`):

```ts
test("prepareTimePlot scans bins for extents only when autoRanges is called", () => {
  const bins = binColumnsFromWire([
    {
      t0: 0,
      t1: 1,
      first: 1,
      last: 2,
      min: 1,
      max: 2,
      sum: 3,
      sum_sq: 5,
      finite_count: "2",
      sample_count: "2",
      has_gap: false,
    },
  ]);
  let minReads = 0;
  const counted = new Proxy(bins, {
    get(target, property, receiver) {
      if (property === "min") minReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const plot = prepareTimePlot({
    series: [{ path: "run_0001/response", colorIndex: 0, bins: counted }],
    window: { t0: 0, t1: 1 },
  });
  expect(minReads).toBe(0);
  plot.autoRanges();
  const afterFirst = minReads;
  expect(afterFirst).toBeGreaterThan(0);
  plot.autoRanges();
  expect(minReads).toBe(afterFirst);
});
```

If `TimePlotInput.series` entries require more fields than `path`/`colorIndex`/`bins` (check the interface at the top of `plot-capabilities.ts`), add them with neutral values.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/app/plot-capabilities.test.ts`
Expected: FAIL — `minReads` is already > 0 before `autoRanges()`.

- [ ] **Step 3: Make the extent scan lazy**

In `prepareTimePlot`, replace:

```ts
const extents = input.series.map((series) =>
  columnsYExtent(series.bins, input.window),
);
```

with:

```ts
// Scanning every bin of every series is the dominant cost of preparing a
// dense time panel, and the sticky y policy usually never reads it. Memoized
// so a fit command calling autoRanges() twice still scans once.
let extents: readonly ReturnType<typeof columnsYExtent>[] | null = null;
const yExtents = (): readonly ReturnType<typeof columnsYExtent>[] => {
  extents ??= input.series.map((series) =>
    columnsYExtent(series.bins, input.window),
  );
  return extents;
};
```

Then in `autoRanges()` change `for (const extent of extents) {` to `for (const extent of yExtents()) {`.

Verify `extents` has no other reader inside `prepareTimePlot`: run `grep -n "extents" frontend/src/app/plot-capabilities.ts`. If another site reads it, route that site through `yExtents()` the same way.

- [ ] **Step 4: Run the test to verify it passes, plus the file's other tests**

Run: `./scripts/test.sh unit -- src/app/plot-capabilities.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/plot-capabilities.ts frontend/src/app/plot-capabilities.test.ts
git commit -m "perf(app): compute time-plot y extents lazily and once"
```

---

### Task 3: Replace the dirty guard's `JSON.stringify` with a revision counter

`PanelView.renderData` (`frontend/src/ui/panel.ts:948-967`) serializes the entire `PanelState` to JSON on every call just to detect change. The workspace already maintains a monotonic revision counter (`WorkspaceModel.revision()`, bumped on every commit). Pass it down and compare integers. The guard becomes slightly more conservative (any workspace commit re-renders every panel, where stringify only re-rendered the changed one) — that is correct-by-construction and removes the per-panel-per-frame serialization.

**Files:**

- Modify: `frontend/src/ui/panel.ts` (`renderData`, the `lastStateKey` field, new exported predicate)
- Modify: `frontend/src/ui/workspace-view.ts` (`renderData`, ~line 115)
- Modify: `frontend/src/ui/app-shell.ts` (`renderTiles`, ~line 2825)
- Test: `frontend/src/ui/panel.test.ts`

**Interfaces:**

- Consumes: `WorkspaceModel.revision(): number` (exists, `frontend/src/app/workspace.ts:87`).
- Produces:
  - `export interface RenderInputs { revision: number | null; tiles: ColumnarTileResponse | null; samples: SampleResponse | null; window: { t0: number; t1: number } | null; missingEmpty: boolean; }` (in `panel.ts`)
  - `export function sameRenderInputs(last: RenderInputs, next: RenderInputs): boolean` (in `panel.ts`)
  - `PanelView.renderData(state, tiles, samples, window, missing = [], revision: number | null = null): number` — new trailing parameter, default `null` = always render.
  - `WorkspaceView.renderData(tilesByPanel, samplesByPanel, windowFor, missingFor, revision: number | null = null): number` — new trailing parameter, forwarded.

- [ ] **Step 1: Write the failing test for the predicate**

Append to `frontend/src/ui/panel.test.ts` (add `sameRenderInputs` to its existing import from `./panel`):

```ts
describe("sameRenderInputs", () => {
  const tiles = { requestId: "r", series: [] };
  const window = { t0: 0, t1: 1 };
  const base = {
    revision: 3,
    tiles,
    samples: null,
    window,
    missingEmpty: true,
  };

  it("skips only when every identity and the revision match", () => {
    expect(sameRenderInputs(base, { ...base })).toBe(true);
    expect(sameRenderInputs(base, { ...base, window: { t0: 0, t1: 1 } })).toBe(
      true,
    );
  });

  it("re-renders on any changed input", () => {
    expect(sameRenderInputs(base, { ...base, revision: 4 })).toBe(false);
    expect(
      sameRenderInputs(base, {
        ...base,
        tiles: { requestId: "s", series: [] },
      }),
    ).toBe(false);
    expect(sameRenderInputs(base, { ...base, window: { t0: 0, t1: 2 } })).toBe(
      false,
    );
    expect(sameRenderInputs(base, { ...base, missingEmpty: false })).toBe(
      false,
    );
  });

  it("always re-renders when no revision was provided", () => {
    expect(
      sameRenderInputs(
        { ...base, revision: null },
        { ...base, revision: null },
      ),
    ).toBe(false);
  });

  it("never skips before the first render", () => {
    expect(sameRenderInputs({ ...base, window: null }, { ...base })).toBe(
      false,
    );
  });
});
```

If `tiles`' inline literal fails the `ColumnarTileResponse` type, cast it: `const tiles = { requestId: "r", series: [] } as ColumnarTileResponse;` (the predicate only compares identity).

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/ui/panel.test.ts`
Expected: FAIL — `sameRenderInputs` is not exported.

- [ ] **Step 3: Implement the predicate and rewire the guard**

In `frontend/src/ui/panel.ts`:

1. Add near the other module-level helpers (above the `PanelView` class):

```ts
/** Inputs whose identity decides whether `renderData` can be skipped. */
export interface RenderInputs {
  revision: number | null;
  tiles: ColumnarTileResponse | null;
  samples: SampleResponse | null;
  window: { t0: number; t1: number } | null;
  missingEmpty: boolean;
}

/**
 * True when nothing a render depends on changed. The workspace revision
 * stands in for deep state comparison — it bumps on every workspace
 * commit, so this is conservative (an unrelated panel's change re-renders
 * this one) but never stale, and it replaces a per-frame
 * `JSON.stringify(state)`. A null revision always re-renders.
 */
export function sameRenderInputs(
  last: RenderInputs,
  next: RenderInputs,
): boolean {
  return (
    next.revision !== null &&
    next.revision === last.revision &&
    next.tiles === last.tiles &&
    next.samples === last.samples &&
    last.window !== null &&
    next.window !== null &&
    next.window.t0 === last.window.t0 &&
    next.window.t1 === last.window.t1 &&
    next.missingEmpty &&
    last.missingEmpty
  );
}
```

2. In the `PanelView` field declarations (~line 563), replace `private lastStateKey: string | null = null;` with `private lastRevision: number | null = null;`

3. Replace the head of `renderData` (~lines 948-970):

```ts
  renderData(
    state: PanelState,
    tiles: ColumnarTileResponse | null,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
    missing: readonly string[] = [],
    revision: number | null = null,
  ): number {
    if (
      sameRenderInputs(
        {
          revision: this.lastRevision,
          tiles: this.lastTiles,
          samples: this.lastSamples,
          window: this.lastWindow,
          missingEmpty: this.lastMissingEmpty,
        },
        {
          revision,
          tiles,
          samples,
          window,
          missingEmpty: missing.length === 0,
        },
      )
    ) {
      return 0;
    }
    const rendered = renderState(state, this.callbacks);
    this.lastInputState = state;
    this.lastRevision = revision;
```

and delete the old `const stateKey = JSON.stringify(state);` and `this.lastStateKey = stateKey;` lines. The rest of the method is unchanged.

4. In `frontend/src/ui/workspace-view.ts`, add the trailing parameter to `renderData` (~line 115) and forward it:

```ts
  renderData(
    tilesByPanel: ReadonlyMap<string, ColumnarTileResponse>,
    samplesByPanel: ReadonlyMap<string, SampleResponse>,
    windowFor: (panelId: string) => { t0: number; t1: number },
    missingFor: (panelId: string) => readonly string[],
    revision: number | null = null,
  ): number {
```

and in its loop pass `revision` as the sixth argument to the panel's `renderData` (after `missingFor(panel.id)`).

5. In `frontend/src/ui/app-shell.ts` `renderTiles` (~line 2828), pass the revision as the fifth argument:

```ts
this.workspaceView?.renderData(
  this.tilesByPanel,
  this.samplesByPanel,
  (panelId) => {
    /* unchanged */
  },
  (panelId) => this.missingByPanel.get(panelId) ?? [],
  this.workspace.revision(),
) ?? 0;
```

(keep the existing callback bodies exactly as they are).

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh unit -- src/ui/panel.test.ts src/ui/workspace-view src/ui/app-shell.test.ts`
Expected: PASS. If an app-shell or workspace-view test constructs `renderData` calls positionally, the new parameter is trailing-with-default, so existing calls compile unchanged.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/panel.ts frontend/src/ui/workspace-view.ts frontend/src/ui/app-shell.ts frontend/src/ui/panel.test.ts
git commit -m "perf(ui): gate renderData on the workspace revision, not JSON.stringify"
```

---

### Task 4: `isDerivedPath` uses a revision-keyed Set

`AppShell.isDerivedPath` (`frontend/src/ui/app-shell.ts:2811-2813`) linearly scans `workspace.derived()` — and it is called from the `localPathFor`/`sourceKeyFor` callbacks (~lines 369-376), which XY pairing invokes O(series × signals) times per frame. Cache the derived paths as a `Set` keyed on the workspace revision.

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`isDerivedPath` + one new field)
- Test: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Consumes: `WorkspaceModel.revision(): number`.
- Produces: `isDerivedPath` behavior unchanged; new guarantee: `workspace.derived()` is consulted at most once per workspace revision.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/ui/app-shell.test.ts`, following the `Object.create(AppShell.prototype)` probe pattern already used in this file (search for `ArrivalProbe`):

```ts
it("isDerivedPath scans the derived list once per workspace revision", () => {
  const shell = Object.create(AppShell.prototype) as {
    workspace: { revision: () => number; derived: () => { path: string }[] };
    isDerivedPath: (path: string) => boolean;
  };
  let scans = 0;
  shell.workspace = {
    revision: () => 7,
    derived: () => {
      scans += 1;
      return [{ path: "derived/mean" }];
    },
  };
  expect(shell.isDerivedPath("derived/mean")).toBe(true);
  expect(shell.isDerivedPath("run_0001/response")).toBe(false);
  expect(shell.isDerivedPath("derived/mean")).toBe(true);
  expect(scans).toBe(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/ui/app-shell.test.ts`
Expected: FAIL — `scans` is 3.

- [ ] **Step 3: Implement the cache**

In `frontend/src/ui/app-shell.ts`, next to `isDerivedPath`, add the field and replace the method. Use optional chaining on the field read — the test probe object never runs the constructor, so the field may be `undefined` rather than `null`:

```ts
  private derivedPathsCache: { revision: number; paths: Set<string> } | null =
    null;

  private isDerivedPath(path: string): boolean {
    const revision = this.workspace.revision();
    if (this.derivedPathsCache?.revision !== revision) {
      this.derivedPathsCache = {
        revision,
        paths: new Set(this.workspace.derived().map((entry) => entry.path)),
      };
    }
    return this.derivedPathsCache.paths.has(path);
  }
```

Place the field with the other private fields near the top of the class, and keep the method where `isDerivedPath` lives today.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh unit -- src/ui/app-shell.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts
git commit -m "perf(ui): cache derived-path membership per workspace revision"
```

---

### Task 5: XY series index and response-scoped prep cache

Three verified per-frame XY costs, all window-independent and re-paid every pan (`frontend/src/ui/panel.ts` `renderXy`, ~lines 1059-1198):

- `resolveXSeries` does `samples.series.find()` with two callbacks per candidate, per trace — O(series × signals).
- `pairSamples` re-pairs every trace every frame.
- `flattenTrace(trace, null)` (the dimmed full trajectory) and the colour columns rebuild every frame.

Fix all three with one exported cache in `frontend/src/app/xy.ts`, keyed on response identity + panel config, wired into `renderXy`.

**Files:**

- Modify: `frontend/src/app/xy.ts` (new exports: `SeriesPathCallbacks`, `seriesIndexKey`, `buildSeriesIndex`, `XyPrepCache`)
- Modify: `frontend/src/ui/panel.ts` (`resolveXSeries`, `renderXy`, new `xyPrep` field)
- Test: `frontend/src/app/xy.test.ts`

**Interfaces:**

- Consumes: existing `pairSamples`, `XyTrace`, `SampleSeries`, `SampleResponse`.
- Produces (all exported from `frontend/src/app/xy.ts`):
  - `interface SeriesPathCallbacks { localPathFor(path: string): string | null; sourceKeyFor(path: string): string | null; }`
  - `function seriesIndexKey(sourceKey: string, localPath: string): string`
  - `function buildSeriesIndex(series: readonly SampleSeries[], callbacks: SeriesPathCallbacks): Map<string, SampleSeries>`
  - `class XyPrepCache` with methods `sync(samples, key, callbacks): ReadonlyMap<string, SampleSeries>`, `trace(path, pair): XyTrace`, `dimmedPoints(path, trace, flatten): number[]`, `colorColumn(path, compute): number[] | null`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/app/xy.test.ts` (extend its imports from `./xy` with the new names; import `SampleResponse` type if not present):

```ts
function series(path: string, values: number[]): SampleSeries {
  return {
    signal_path: path,
    unit: null,
    time: values.map((_, index) => index),
    values,
    stride: 1,
  } as SampleSeries;
}

const callbacks = {
  sourceKeyFor: (path: string) => path.split("/")[0] ?? null,
  localPathFor: (path: string) => path.split("/").slice(1).join("/") || null,
};

describe("buildSeriesIndex", () => {
  it("indexes by source and local path, first match winning", () => {
    const a = series("run_0001/command", [1]);
    const duplicate = series("run_0001/command", [2]);
    const b = series("run_0002/command", [3]);
    const index = buildSeriesIndex([a, duplicate, b], callbacks);
    expect(index.get(seriesIndexKey("run_0001", "command"))).toBe(a);
    expect(index.get(seriesIndexKey("run_0002", "command"))).toBe(b);
    expect(index.size).toBe(2);
  });
});

describe("XyPrepCache", () => {
  const samples = {
    request_id: "r1",
    series: [
      series("run_0001/command", [1, 2]),
      series("run_0001/response", [3, 4]),
    ],
  } as SampleResponse;

  it("reuses traces and dimmed points while samples and key are unchanged", () => {
    const cache = new XyPrepCache();
    cache.sync(samples, "key", callbacks);
    let pairs = 0;
    const pair = () => {
      pairs += 1;
      return { time: [0, 1], x: [1, 2], y: [3, 4] };
    };
    const first = cache.trace("run_0001/response", pair);
    cache.sync(samples, "key", callbacks);
    const second = cache.trace("run_0001/response", pair);
    expect(second).toBe(first);
    expect(pairs).toBe(1);

    let flattens = 0;
    const flatten = () => {
      flattens += 1;
      return [1, 3, 2, 4];
    };
    const dimmedFirst = cache.dimmedPoints("run_0001/response", first, flatten);
    cache.sync(samples, "key", callbacks);
    expect(cache.dimmedPoints("run_0001/response", first, flatten)).toBe(
      dimmedFirst,
    );
    expect(flattens).toBe(1);
  });

  it("drops everything when the response or the key changes", () => {
    const cache = new XyPrepCache();
    cache.sync(samples, "key", callbacks);
    let pairs = 0;
    const pair = () => {
      pairs += 1;
      return { time: [0], x: [1], y: [3] };
    };
    cache.trace("run_0001/response", pair);
    cache.sync(samples, "other-key", callbacks);
    cache.trace("run_0001/response", pair);
    expect(pairs).toBe(2);
    const other = { ...samples, request_id: "r2" } as SampleResponse;
    cache.sync(other, "other-key", callbacks);
    cache.trace("run_0001/response", pair);
    expect(pairs).toBe(3);
  });

  it("caches null colour columns without recomputing", () => {
    const cache = new XyPrepCache();
    cache.sync(samples, "key", callbacks);
    let computes = 0;
    const compute = () => {
      computes += 1;
      return null;
    };
    expect(cache.colorColumn("run_0001/response", compute)).toBeNull();
    expect(cache.colorColumn("run_0001/response", compute)).toBeNull();
    expect(computes).toBe(1);
  });
});
```

If `xy.test.ts` uses `test(` rather than `describe`/`it`, match the local convention. If `SampleSeries` has extra required fields, extend the `series` helper with neutral values instead of widening casts.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./scripts/test.sh unit -- src/app/xy.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement the index and cache in `frontend/src/app/xy.ts`**

Add `SampleResponse` to the type import from `../generated/protocol`, then append:

```ts
/** The subset of panel callbacks pairing needs. */
export interface SeriesPathCallbacks {
  localPathFor(path: string): string | null;
  sourceKeyFor(path: string): string | null;
}

/** Map key for a series' (source, local channel) pair. */
export function seriesIndexKey(sourceKey: string, localPath: string): string {
  return `${sourceKey}\u0000${localPath}`;
}

/**
 * Index of sample series by (source, local channel). Built once per
 * response so per-trace x and colour resolution is a Map lookup instead of
 * a linear `find` over every series in the response. First match wins,
 * matching the `Array.prototype.find` behaviour it replaces.
 */
export function buildSeriesIndex(
  series: readonly SampleSeries[],
  callbacks: SeriesPathCallbacks,
): Map<string, SampleSeries> {
  const index = new Map<string, SampleSeries>();
  for (const entry of series) {
    const sourceKey = callbacks.sourceKeyFor(entry.signal_path);
    const localPath = callbacks.localPathFor(entry.signal_path);
    if (sourceKey === null || localPath === null) continue;
    const key = seriesIndexKey(sourceKey, localPath);
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

/**
 * Response-scoped XY preparation cache. Pairing, the dimmed full-extent
 * trajectory, and colour columns depend only on the sample response and the
 * panel's series/x/colour configuration — never on the visible window — so
 * they are computed once per (response, config) and reused across every
 * pan/zoom frame.
 */
export class XyPrepCache {
  private samples: SampleResponse | null = null;
  private key = "";
  private index: Map<string, SampleSeries> | null = null;
  private readonly traces = new Map<string, XyTrace>();
  private readonly dimmed = new Map<string, number[]>();
  private readonly colors = new Map<string, number[] | null>();

  /**
   * Rebinds the cache to `(samples, key)`, dropping every entry when either
   * changed, and returns the series index for pairing lookups.
   */
  sync(
    samples: SampleResponse,
    key: string,
    callbacks: SeriesPathCallbacks,
  ): ReadonlyMap<string, SampleSeries> {
    if (this.samples !== samples || this.key !== key) {
      this.samples = samples;
      this.key = key;
      this.index = null;
      this.traces.clear();
      this.dimmed.clear();
      this.colors.clear();
    }
    this.index ??= buildSeriesIndex(samples.series, callbacks);
    return this.index;
  }

  trace(path: string, pair: () => XyTrace): XyTrace {
    let entry = this.traces.get(path);
    if (entry === undefined) {
      entry = pair();
      this.traces.set(path, entry);
    }
    return entry;
  }

  dimmedPoints(
    path: string,
    trace: XyTrace,
    flatten: (trace: XyTrace) => number[],
  ): number[] {
    let entry = this.dimmed.get(path);
    if (entry === undefined) {
      entry = flatten(trace);
      this.dimmed.set(path, entry);
    }
    return entry;
  }

  colorColumn(path: string, compute: () => number[] | null): number[] | null {
    if (this.colors.has(path)) return this.colors.get(path) ?? null;
    const value = compute();
    this.colors.set(path, value);
    return value;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./scripts/test.sh unit -- src/app/xy.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the cache into `renderXy`**

In `frontend/src/ui/panel.ts`:

1. Extend the import from `../app/xy` with `XyPrepCache` and `seriesIndexKey`.

2. Add a field to `PanelView` (near the other private fields): `private readonly xyPrep = new XyPrepCache();`

3. Rewrite `resolveXSeries` (~line 450) to take the index instead of the response:

```ts
function resolveXSeries(
  index: ReadonlyMap<string, SampleSeries>,
  xSeries: SampleSeries,
  xSignal: string,
  yPath: string,
  callbacks: XyPairingCallbacks,
): SampleSeries | undefined {
  const xLocal = callbacks.localPathFor(xSignal);
  if (xLocal === null) return xSeries;
  const sourceKey = callbacks.sourceKeyFor(yPath);
  if (sourceKey === null) return xSeries;
  return index.get(seriesIndexKey(sourceKey, xLocal));
}
```

4. In `renderXy`, after the `if (xSeries === undefined) return 0;` line (~1070), build the key and sync the cache:

```ts
const prepKey = [
  state.x_signal ?? "",
  state.color_by_time ? "time" : (state.color_signal ?? ""),
  ...state.series
    .filter((series) => series.visible)
    .map((series) => series.path),
].join("\u0000");
const index = this.xyPrep.sync(samples, prepKey, this.callbacks);
```

5. In the trace loop, use the index and cache the pairing:

```ts
const resolved = resolveXSeries(
  index,
  xSeries,
  state.x_signal,
  series.path,
  this.callbacks,
);
if (resolved === undefined) continue;
this.xyTraces.push({
  path: series.path,
  colorIndex: colorIndexForHue(series.hue),
  hue: series.hue,
  dash: series.dash,
  width: series.width,
  opacity: series.opacity,
  trace: this.xyPrep.trace(series.path, () => pairSamples(resolved, ySeries)),
});
```

6. Rewrite `resolveColor` (~1105) to use the index:

```ts
const resolveColor = (
  yPath: string,
): SampleResponse["series"][number] | null => {
  if (colorSeries === null || colorSeries === "time") return null;
  if (cLocal === null) return colorSeries;
  const sourceKey = this.callbacks.sourceKeyFor(yPath);
  if (sourceKey === null) return colorSeries;
  return index.get(seriesIndexKey(sourceKey, cLocal)) ?? null;
};
```

7. Cache the colour columns (~1129):

```ts
const colorColumns = this.xyTraces.map((entry) =>
  this.xyPrep.colorColumn(entry.path, () => colorFor(entry.path, entry.trace)),
);
```

8. Cache the dimmed trajectory (~1173):

```ts
paths.push({
  points: this.xyPrep.dimmedPoints(entry.path, entry.trace, (trace) =>
    flattenTrace(trace, null),
  ),
  hue: entry.hue,
  dash: "solid",
  width: 1.2,
  alpha: entry.opacity,
  dimmed: true,
});
```

The lit windowed path (`flattenTrace(entry.trace, window)`) stays per-frame — it genuinely depends on the window.

- [ ] **Step 6: Run the panel and xy suites**

Run: `./scripts/test.sh unit -- src/ui/panel.test.ts src/app/xy.test.ts src/app/xy-hit.test.ts`
Expected: PASS. The panel suite's existing XY pairing tests (`sessionXyState`, cross-source pairing) exercise `resolveXSeries` through `renderXy`'s callers and must pass unmodified — they encode behavior this task must preserve. If one fails, the index construction diverges from the old `find` semantics; fix the code, not the test.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/xy.ts frontend/src/app/xy.test.ts frontend/src/ui/panel.ts
git commit -m "perf(xy): index pairing lookups and cache response-scoped prep"
```

---

### Task 6: Stop re-fetching the XY context request on every pan

The XY sample cache key includes the visible window (`frontend/src/ui/app-shell.ts:2705-2710`), so every pan misses and re-issues **both** requests — including the context request over the full data extent, whose response cannot have changed. Cache the context response under its own window-correct key.

**Files:**

- Create: `frontend/src/app/xy-samples.ts`
- Modify: `frontend/src/ui/app-shell.ts` (XY branch of `refreshTilesPass`, ~lines 2716-2737; one new field; invalidation sites)
- Test: `frontend/src/app/xy-samples.test.ts`

**Interfaces:**

- Consumes: `SampleWindowCache` (`frontend/src/app/sample-window-cache.ts`), `mergeSampleResponses` (`frontend/src/app/samples.ts`), `SampleRequest`/`SampleResponse` (`frontend/src/generated/protocol.ts`).
- Produces (exported from `frontend/src/app/xy-samples.ts`):
  - `interface SampleQueryPlane { querySamples(request: SampleRequest): Promise<SampleResponse>; }`
  - `async function fetchXySamples(options: { plane: SampleQueryPlane; panelId: string; ids: readonly string[]; cap: number; contextWindow: { t0: number; t1: number }; window: { t0: number; t1: number }; contextCache: SampleWindowCache; }): Promise<SampleResponse>`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/xy-samples.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SampleRequest, SampleResponse } from "../generated/protocol";
import { SampleWindowCache } from "./sample-window-cache";
import { fetchXySamples } from "./xy-samples";

function planeStub(): {
  calls: SampleRequest[];
  plane: { querySamples: (request: SampleRequest) => Promise<SampleResponse> };
} {
  const calls: SampleRequest[] = [];
  return {
    calls,
    plane: {
      querySamples: (request: SampleRequest) => {
        calls.push(request);
        return Promise.resolve({
          request_id: request.request_id,
          series: [
            {
              signal_path: "run_0001/response",
              unit: null,
              time: [request.window.t0, request.window.t1],
              values: [1, 2],
              stride: 1,
            },
          ],
        } as SampleResponse);
      },
    },
  };
}

describe("fetchXySamples", () => {
  const contextWindow = { t0: 0, t1: 1000 };

  it("fetches the context window once across pans", async () => {
    const { calls, plane } = planeStub();
    const contextCache = new SampleWindowCache();
    const base = {
      plane,
      panelId: "panel",
      ids: ["sig-1"],
      cap: 124,
      contextWindow,
      contextCache,
    };
    await fetchXySamples({ ...base, window: { t0: 0, t1: 100 } });
    await fetchXySamples({ ...base, window: { t0: 100, t1: 200 } });
    expect(calls).toHaveLength(3);
    const contextCalls = calls.filter(
      (request) =>
        request.window.t0 === contextWindow.t0 &&
        request.window.t1 === contextWindow.t1,
    );
    expect(contextCalls).toHaveLength(1);
  });

  it("re-fetches context when the data extent or cap changes", async () => {
    const { calls, plane } = planeStub();
    const contextCache = new SampleWindowCache();
    const base = {
      plane,
      panelId: "panel",
      ids: ["sig-1"],
      contextCache,
      window: { t0: 0, t1: 100 },
    };
    await fetchXySamples({ ...base, cap: 124, contextWindow });
    await fetchXySamples({
      ...base,
      cap: 124,
      contextWindow: { t0: 0, t1: 2000 },
    });
    await fetchXySamples({ ...base, cap: 200, contextWindow });
    expect(calls).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/app/xy-samples.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `frontend/src/app/xy-samples.ts`**

```ts
import type { SampleRequest, SampleResponse } from "../generated/protocol";
import { mergeSampleResponses } from "./samples";
import { SampleWindowCache } from "./sample-window-cache";

export interface SampleQueryPlane {
  querySamples(request: SampleRequest): Promise<SampleResponse>;
}

/**
 * The XY pair of sample requests. The context response covers the full data
 * extent and depends only on that extent, the ids, and the cap — never the
 * visible window — so it is cached separately and a pan or zoom re-issues
 * only the detail request.
 */
export async function fetchXySamples(options: {
  plane: SampleQueryPlane;
  panelId: string;
  ids: readonly string[];
  cap: number;
  contextWindow: { t0: number; t1: number };
  window: { t0: number; t1: number };
  contextCache: SampleWindowCache;
}): Promise<SampleResponse> {
  const { plane, panelId, ids, cap, contextWindow, window, contextCache } =
    options;
  const contextKey = SampleWindowCache.key({
    ids,
    mode: "xy-context",
    window: contextWindow,
    cap,
  });
  const cachedContext = contextCache.get(panelId, contextKey);
  const contextPromise =
    cachedContext !== null
      ? Promise.resolve(cachedContext)
      : plane.querySamples({
          request_id: crypto.randomUUID(),
          signal_ids: [...ids],
          window: contextWindow,
          max_points: cap,
        });
  const detailPromise = plane.querySamples({
    request_id: crypto.randomUUID(),
    signal_ids: [...ids],
    window,
    max_points: cap,
  });
  const [context, detail] = await Promise.all([contextPromise, detailPromise]);
  contextCache.store(panelId, contextKey, context);
  return mergeSampleResponses(context, detail);
}
```

If `SampleRequest`'s field names differ from `request_id`/`signal_ids`/`window`/`max_points`, check `frontend/src/generated/protocol.ts:166` and match them exactly — do not cast.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/test.sh unit -- src/app/xy-samples.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `refreshTilesPass`**

In `frontend/src/ui/app-shell.ts`:

1. Import `fetchXySamples` from `../app/xy-samples`.
2. Add a field next to the existing `sampleWindowCache` field: `private readonly xyContextCache = new SampleWindowCache();`
3. Replace the XY/else request block (~lines 2716-2737) with:

```ts
let merged: SampleResponse;
if (panel.mode === "xy") {
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

(the `contextRequest` const disappears; the surrounding cache check/store on `sampleWindowCache` stays exactly as it is — the merged response is still cached per panel so unrelated re-renders stay free).

4. Mirror every `this.sampleWindowCache.invalidate(...)` with `this.xyContextCache.invalidate(...)` — find them with `grep -n "sampleWindowCache.invalidate" frontend/src/ui/app-shell.ts` (one site at ~line 2601 at the time of writing) and add the same call with the same argument beside each.

- [ ] **Step 6: Run the app-shell suite and typecheck**

Run: `./scripts/test.sh unit -- src/ui/app-shell.test.ts src/app/xy-samples.test.ts`
Expected: PASS.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/xy-samples.ts frontend/src/app/xy-samples.test.ts frontend/src/ui/app-shell.ts
git commit -m "perf(xy): cache the window-independent context request across pans"
```

---

### Task 7: Batch ghost series by the full style key

`render()`'s batching gate (`frontend/src/render/canvas-renderer.ts:333-339`) requires `alpha === 1 && dash === "solid"`, but ghosts resolve to `alpha = 0.5` — so the 1000-ghost panel the batching was built for strokes 1000 individual `Path2D`s. Include alpha and dash in the group key instead of forbidding them.

Known, accepted visual consequence (locked in the spec): series batched into one `Path2D` composite their overlaps once per group instead of stacking alpha per series. Groups are capped at `MAX_BATCHED_SERIES = 4`, so at most 4 series share coverage; the density tier (phase 3) replaces many-series stroking entirely. The stroke silhouette is unchanged.

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts` (`canBatch` and the group key, ~lines 333-357)
- Test: `frontend/src/render/canvas-renderer.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: no API change; behavioral guarantee: any >128-series panel without emphasis batches, grouped by `color\0width\0alpha\0dash`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/render/canvas-renderer.test.ts`, using its existing `recordingContext`, `fakeCanvas`, `tile`, and `TEST_PALETTE` helpers:

```ts
it("batches translucent ghost series into grouped strokes", () => {
  const { calls, context } = recordingContext();
  const renderer = new CanvasRenderer(fakeCanvas(800, 400, context));
  renderer.setPalette(TEST_PALETTE);
  const series = Array.from({ length: 130 }, (_, index) =>
    tile(`run_${String(index)}/response`, [
      { t0: 0, t1: 1, v: index },
      { t0: 1, t1: 2, v: index + 1 },
    ]),
  );
  const styles: SeriesStroke[] = series.map(() => ({
    hue: null,
    dash: "solid",
    width: 1,
    alpha: 0.5,
  }));
  renderer.render(
    { requestId: "r", series },
    { min: 0, max: 2 },
    { xLabel: "t", yLabel: "v", yRange: [0, 131], styles },
  );
  const clipIndex = calls.findIndex((call) => call.op === "clip");
  const restoreIndex = calls.findIndex(
    (call, index) => index > clipIndex && call.op === "restore",
  );
  const dataStrokes = calls
    .slice(clipIndex, restoreIndex)
    .filter((call) => call.op === "stroke").length;
  expect(dataStrokes).toBe(Math.ceil(130 / 4));
  expect(
    calls.some((call) => call.op === "=globalAlpha" && call.args[0] === 0.5),
  ).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit -- src/render/canvas-renderer.test.ts`
Expected: FAIL — `dataStrokes` is 130 (per-series path).

- [ ] **Step 3: Implement**

In `frontend/src/render/canvas-renderer.ts`:

1. Replace the `canBatch` computation (~333-339) with:

```ts
// Batched series share one Path2D per <=MAX_BATCHED_SERIES group, so
// overlaps inside a group composite once instead of stacking per-series
// alpha. Accepted: groups are capped at 4 and the many-series case is
// slated for the density tier.
const canBatch = response.series.length > 128 && !hasEmphasis;
```

2. Replace the group key (~line 347):

```ts
const key = [
  style.color,
  String(style.width),
  String(style.alpha),
  style.dash,
].join("\u0000");
```

`setStroke` already applies alpha and dash per group; no other change.

- [ ] **Step 4: Run the renderer suite**

Run: `./scripts/test.sh unit -- src/render/canvas-renderer.test.ts`
Expected: PASS. If an existing test asserts that translucent or dashed series are NOT batched, it encodes the old gate this task removes — update that test's expectation to grouped strokes and say so in the commit message. Any other failure means the grouping is wrong; fix the code.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts
git commit -m "perf(render): batch ghost strokes by the full style key"
```

---

### Task 8: Device-pixel request density and column snapping

Verified two-sided defect: the tile request asks for `2 × CSS-width` bins (`app-shell.ts:2657-2658`) and the M4 loop snaps columns to CSS pixels (`canvas-renderer.ts:908-913`), so a 2× display renders at half its horizontal resolution. Fix both sides in one task — either alone is a no-op. Also move the aggregation threshold to device pixels with uPlot's 4× margin so the aggregated/direct crossover is visually invisible.

**Files:**

- Modify: `frontend/src/render/surface.ts` (`prepare` returns the ratio)
- Modify: `frontend/src/render/canvas-renderer.ts` (`beginFrame`, `appendSeriesPath`, `pathKey`)
- Modify: `frontend/src/ui/app-shell.ts` (`refreshTilesPass` pixel width, ~2657-2658)
- Test: `frontend/src/render/canvas-renderer.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `CanvasSurface.prepare(): { context: CanvasRenderingContext2D; width: number; height: number; ratio: number }` — `ratio` added; `width`/`height` stay CSS pixels.
  - Rendering guarantee: envelope columns are snapped to device-pixel columns (quantum `1/ratio` CSS px, centers at `(k + 0.5)/ratio`); client aggregation fires when `count > 4 * plot.width * ratio`.
  - Request guarantee: tile requests carry `pixel_width = round(cssWidth × devicePixelRatio)`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/render/canvas-renderer.test.ts`:

```ts
describe("device-pixel columns", () => {
  it("snaps aggregated columns to device pixels at 2x DPR", () => {
    const saved = globalThis.devicePixelRatio;
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    try {
      const { calls, context } = recordingContext();
      const renderer = new CanvasRenderer(fakeCanvas(40, 40, context));
      renderer.setPalette(TEST_PALETTE);
      // 400 bins > 4 * plot.width(40) * ratio(2) = 320 -> aggregating branch.
      const bins = Array.from({ length: 400 }, (_, index) => ({
        t0: index,
        t1: index + 1,
        v: index % 7,
      }));
      renderer.render(
        { requestId: "r", series: [tile("run_0001/a", bins)] },
        { min: 0, max: 400 },
        { xLabel: "t", yLabel: "v", yRange: [0, 7], axisStyle: "inline" },
      );
      const clipIndex = calls.findIndex((call) => call.op === "clip");
      const restoreIndex = calls.findIndex(
        (call, index) => index > clipIndex && call.op === "restore",
      );
      const xs = calls
        .slice(clipIndex, restoreIndex)
        .filter((call) => call.op === "moveTo" || call.op === "lineTo")
        .map((call) => call.args[0] as number);
      expect(xs.length).toBeGreaterThan(0);
      for (const x of xs) {
        const quantum = x * 2 - Math.floor(x * 2);
        expect(quantum).toBeCloseTo(0.5, 10);
      }
    } finally {
      (globalThis as { devicePixelRatio?: number }).devicePixelRatio = saved;
    }
  });

  it("keeps the direct branch below four bins per device pixel", () => {
    const { calls, context } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(40, 40, context));
    renderer.setPalette(TEST_PALETTE);
    // 100 bins <= 4 * 40 * 1 = 160 -> direct branch, unsnapped x.
    const bins = Array.from({ length: 100 }, (_, index) => ({
      t0: index,
      t1: index + 1,
      v: index % 7,
    }));
    renderer.render(
      { requestId: "r", series: [tile("run_0001/a", bins)] },
      { min: 0, max: 100 },
      { xLabel: "t", yLabel: "v", yRange: [0, 7], axisStyle: "inline" },
    );
    const clipIndex = calls.findIndex((call) => call.op === "clip");
    const restoreIndex = calls.findIndex(
      (call, index) => index > clipIndex && call.op === "restore",
    );
    const xs = calls
      .slice(clipIndex, restoreIndex)
      .filter((call) => call.op === "moveTo" || call.op === "lineTo")
      .map((call) => call.args[0] as number);
    // Direct projection of bin midpoints: 0.5 * 0.4 = 0.2, not half-pixel.
    expect(xs.some((x) => Math.abs(x * 2 - Math.round(x * 2)) > 1e-6)).toBe(
      true,
    );
  });
});
```

Note on the first test's expectation: snapped x is `floor(xCss * 2) / 2 + 0.25`, so `x * 2` is always `k + 0.5` for integer `k` — the assertion checks exactly that.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./scripts/test.sh unit -- src/render/canvas-renderer.test.ts`
Expected: FAIL — at DPR 2 the current code snaps to whole CSS pixels (`x * 2` is `2k + 1`, quantum check yields 0, not 0.5)… verify the failure message matches a snapping mismatch, not a setup error.

- [ ] **Step 3: Implement**

1. `frontend/src/render/surface.ts` — change `prepare`'s return type and statement:

```ts
  prepare(): {
    context: CanvasRenderingContext2D;
    width: number;
    height: number;
    ratio: number;
  } {
```

and the final line: `return { context, width, height, ratio };`

2. `frontend/src/render/canvas-renderer.ts`:

- Add a field: `private pixelRatio = 1;`
- In `beginFrame` (~line 421): `const { context, width, height, ratio } = this.surface.prepare();` then immediately `this.pixelRatio = ratio;`
- In `render()`, extend the `pathKey` array (~lines 288-299) with `this.pixelRatio` as an additional element (before `.map(String)`), so cached paths invalidate when the DPR changes.
- In `appendSeriesPath` (~line 886), replace the branch condition and the snap:

```ts
    const ratio = this.pixelRatio;
    // Aggregate only above ~4 bins per device pixel (uPlot's margin): below
    // it the direct polyline and the merged envelope are visually identical,
    // so the representation switch is invisible.
    if (count > 4 * plot.width * ratio) {
```

and inside the loop replace the x computation:

```ts
// Snap to device-pixel column centers. The backing store is `ratio`
// times the CSS grid this context draws in, so the column quantum is
// 1/ratio CSS px, centered at half a device pixel.
const x =
  plot.x +
  Math.floor(
    (toX(((t0[index] as number) + (t1[index] as number)) * 0.5) - plot.x) *
      ratio,
  ) /
    ratio +
  0.5 / ratio;
```

The direct (else) branch is unchanged.

3. `frontend/src/ui/app-shell.ts` — in `refreshTilesPass` (~2657-2658), scale the request density by the DPR:

```ts
const panelWidth = this.workspaceView?.panelWidth(panel.id) ?? 0;
const dpr = globalThis.devicePixelRatio || 1;
const pixelWidth = Math.max(
  1,
  Math.round((panelWidth > 0 ? panelWidth : width) * dpr),
);
```

No other call sites change: `TileWindowCache` treats `pixelWidth` as an opaque density key, and its `4 * pixelWidth + 2` slice guard scales consistently.

Known, accepted consequence (documented in the spec): at DPR 2 the requested bin count doubles, so the `TILE_BIN_BUDGET / N` clamp binds at roughly half the series count. The density tier (phase 3) is the real fix; do not touch the budget here.

- [ ] **Step 4: Run the renderer, tile-cache, and app-shell suites**

Run: `./scripts/test.sh unit -- src/render/canvas-renderer.test.ts src/app/tile-window-cache.test.ts src/ui/app-shell.test.ts`
Expected: PASS. jsdom leaves `devicePixelRatio` at 1, so existing tests see identical snapping (`floor(x)/1 + 0.5`) — the only intended behavioral difference at DPR 1 is the aggregation threshold moving from `2 × plot.width` to `4 × plot.width`. If an existing test feeds a bin count between those bounds and asserts aggregated output, update its expectation to the direct branch and note it in the commit.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/surface.ts frontend/src/render/canvas-renderer.ts frontend/src/ui/app-shell.ts frontend/src/render/canvas-renderer.test.ts
git commit -m "fix(render): request and snap at device-pixel density"
```

---

### Task 9: Bench coverage for sample-mode panels

`examples/bench/mc1000.workspace.json` contains only time panels, which is why every XY/FFT/histogram regression in this plan's history went unmeasured. Add a modes workspace, bake it in the bench pipeline from a bounded slice of the corpus, and record report-only baselines (no pass/fail floors yet — floors arrive when the later phases land; this phase establishes honest numbers).

**Files:**

- Create: `examples/bench/mc1000-modes.workspace.json`
- Create: `frontend/tests/bench/bench-modes.spec.ts`
- Modify: `scripts/test.sh` (`bench_e2e`)

**Interfaces:**

- Consumes: the bench corpus (`build/bench/corpus/mc1000/run_*.csv`, channels `command`, `response`, `temperature`, `pressure`, `vibration`), `scripts/export.sh`, `frontend/tests/bench/measure.ts` (`startFrameProbe`, `stopFrameProbe`, `interact`), the Playwright `bench` project (testDir `./tests/bench` — new specs are picked up automatically).
- Produces: `build/bench/mc1000-modes.html` artifact, `build/bench/report/bake_modes.json` and `build/bench/report/e2e_mc1000_modes.json` report entries (both without a `pass` field, so `collect-bench-report.mjs` treats them as informational).

- [ ] **Step 1: Create the modes workspace**

Create `examples/bench/mc1000-modes.workspace.json`. It mirrors the field set of `examples/bench/mc1000.workspace.json` exactly (schema_version 20); four panels in a 2×2 grid:

```json
{
  "app": "signalscope",
  "schema_version": 20,
  "theme": "dark",
  "linked_time": {
    "t0": 0,
    "t1": 1000,
    "linked": true,
    "paused": false,
    "cursorT": null,
    "mode": "fixed"
  },
  "active_tab_id": "workspace-1",
  "tabs": [
    {
      "id": "workspace-1",
      "title": "Monte Carlo modes",
      "cursor_mode": "none",
      "focused_panel_id": null,
      "maximized_panel_id": null,
      "panels": [
        {
          "id": "panel-time",
          "title": "response ensemble",
          "mode": "time",
          "axis_style": "gutter",
          "x_ref": null,
          "color_axis": "none",
          "color_ref": null,
          "bindings": [
            {
              "kind": "query",
              "selector": "response @*",
              "refs": [],
              "set_id": null
            }
          ],
          "color_by": "source",
          "overrides": [],
          "focus": [],
          "ghost_mode": "all",
          "split_by": "none",
          "y_range": null,
          "x_range": null,
          "x_label": null,
          "y_label": null,
          "c_label": null,
          "time_window": null,
          "annotations": [],
          "show_stats": false
        },
        {
          "id": "panel-xy",
          "title": "response vs command",
          "mode": "xy",
          "axis_style": "gutter",
          "x_ref": { "source_key": "run_0001", "channel": "command" },
          "color_axis": "none",
          "color_ref": null,
          "bindings": [
            {
              "kind": "query",
              "selector": "response @*",
              "refs": [],
              "set_id": null
            }
          ],
          "color_by": "source",
          "overrides": [],
          "focus": [],
          "ghost_mode": "all",
          "split_by": "none",
          "y_range": null,
          "x_range": null,
          "x_label": null,
          "y_label": null,
          "c_label": null,
          "time_window": null,
          "annotations": [],
          "show_stats": false
        },
        {
          "id": "panel-fft",
          "title": "vibration spectrum",
          "mode": "fft",
          "axis_style": "gutter",
          "x_ref": null,
          "color_axis": "none",
          "color_ref": null,
          "bindings": [
            {
              "kind": "query",
              "selector": "vibration @*",
              "refs": [],
              "set_id": null
            }
          ],
          "color_by": "source",
          "overrides": [],
          "focus": [],
          "ghost_mode": "all",
          "split_by": "none",
          "y_range": null,
          "x_range": null,
          "x_label": null,
          "y_label": null,
          "c_label": null,
          "time_window": null,
          "annotations": [],
          "show_stats": false
        },
        {
          "id": "panel-hist",
          "title": "temperature distribution",
          "mode": "histogram",
          "axis_style": "gutter",
          "x_ref": null,
          "color_axis": "none",
          "color_ref": null,
          "bindings": [
            {
              "kind": "query",
              "selector": "temperature @*",
              "refs": [],
              "set_id": null
            }
          ],
          "color_by": "source",
          "overrides": [],
          "focus": [],
          "ghost_mode": "all",
          "split_by": "none",
          "y_range": null,
          "x_range": null,
          "x_label": null,
          "y_label": null,
          "c_label": null,
          "time_window": null,
          "annotations": [],
          "show_stats": false
        }
      ],
      "layout": [
        {
          "height": 0.5,
          "panels": [
            { "panel_id": "panel-time", "width": 0.5 },
            { "panel_id": "panel-xy", "width": 0.5 }
          ]
        },
        {
          "height": 0.5,
          "panels": [
            { "panel_id": "panel-fft", "width": 0.5 },
            { "panel_id": "panel-hist", "width": 0.5 }
          ]
        }
      ]
    }
  ],
  "named_sets": [],
  "derived": [],
  "derived_bundles": [],
  "sources": []
}
```

If the current `mc1000.workspace.json` has drifted (different `schema_version` or field set), copy its panel skeleton and apply the mode/binding/x_ref differences above rather than trusting this block verbatim.

- [ ] **Step 2: Bake the modes artifact in `bench_e2e`**

In `scripts/test.sh`, inside `bench_e2e()` immediately after the existing bake-report `printf` line (the one writing `bake.json`), insert:

```bash
  # Sample-mode panels force level-0 baking (ADR 0025), so the modes bench
  # bakes a bounded 20-file corpus slice by default rather than all 1000 files.
  local -a modes_args=()
  local modes_files="${SIGNALSCOPE_BENCH_MODES_FILES:-20}"
  selected=0
  for file in "$corpus_dir"/run_*.csv; do
    if [ "$selected" -eq "$modes_files" ]; then
      break
    fi
    modes_args+=(--data "$file")
    selected=$((selected + 1))
  done
  [ "$selected" -eq "$modes_files" ]
  local modes_out="$signalscope_root/build/bench/mc1000-modes.html"
  started=$SECONDS
  "$signalscope_scripts_dir/export.sh" "${modes_args[@]}" \
    --workspace "$signalscope_root/examples/bench/mc1000-modes.workspace.json" \
    --range visible --fidelity "$fidelity" --out "$modes_out"
  elapsed=$((SECONDS - started))
  bytes=$(stat -c %s "$modes_out")
  if [ "$bytes" -gt "$max_bytes" ]; then
    echo "baked modes snapshot is $bytes bytes (limit $max_bytes)" >&2
    exit 1
  fi
  printf '{ "bench": "bake_modes", "seconds": %d, "bytes": %d, "fidelity": "%s", "input_files": %d }\n' \
    "$elapsed" "$bytes" "$fidelity" "$selected" >"$signalscope_root/build/bench/report/bake_modes.json"
```

(the `mkdir -p .../report` line already ran just above; `selected`, `started`, `elapsed`, `bytes`, `fidelity` are already declared locals — reuse them exactly as shown).

- [ ] **Step 3: Create the report-only bench spec**

Create `frontend/tests/bench/bench-modes.spec.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../e2e/fixtures";
import { interact, startFrameProbe, stopFrameProbe } from "./measure";

const artifact = new URL(
  "../../../build/bench/mc1000-modes.html",
  import.meta.url,
);
const reportDir = new URL("../../../build/bench/report/", import.meta.url);

// Report-only: phase 1 of the unified plotting pipeline records sample-mode
// baselines. Floors arrive once the pipeline phases land — an entry without
// a `pass` field is informational to collect-bench-report.mjs.
test("mc1000 modes workspace renders all four modes and records baselines", async ({
  page,
}) => {
  test.setTimeout(240_000);
  expect(
    existsSync(fileURLToPath(artifact)),
    "bake first: ./scripts/test.sh bench",
  ).toBe(true);

  const started = Date.now();
  await page.goto(artifact.href);
  await expect(page.locator(".plot-canvas").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 120_000,
  });
  const firstPlotMs = Date.now() - started;

  // Every panel must actually resolve its signals — an XY panel with a bad
  // x_ref or a mode with too few samples shows its empty state instead.
  await expect(page.locator(".panel-empty:not([hidden])")).toHaveCount(0);

  await startFrameProbe(page);
  await interact(page);
  const stats = await stopFrameProbe(page);

  mkdirSync(fileURLToPath(reportDir), { recursive: true });
  writeFileSync(
    new URL("e2e_mc1000_modes.json", reportDir),
    `${JSON.stringify(
      {
        bench: "e2e_mc1000_modes",
        first_plot_ms: firstPlotMs,
        frame_p95_ms: stats.p95Ms,
        frame_max_ms: stats.maxMs,
        frames: stats.frames,
        long_tasks: stats.longTasks,
        longest_task_ms: stats.longestTaskMs,
        report_only: true,
      },
      null,
      2,
    )}\n`,
  );
});
```

- [ ] **Step 4: Run the bench and verify the artifacts**

Run: `SIGNALSCOPE_BENCH_FILES=2 SIGNALSCOPE_BENCH_MODES_FILES=2 ./scripts/test.sh bench`
Expected: both artifacts bake; both specs pass; `build/bench/report.json` contains `e2e_mc1000`, `e2e_mc1000_modes`, `bake`, and `bake_modes` entries. The tiny file counts keep this verification run fast — the honest baseline run happens in Task 10.

If the modes spec fails on the empty-state assertion, the `x_ref` source key does not match the baked catalog: inspect with `grep -o '"source_key":"[^"]*"' build/bench/mc1000-modes.html | sort -u | head`, fix `x_ref.source_key` in the workspace JSON to a real key, and re-run this step.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add examples/bench/mc1000-modes.workspace.json frontend/tests/bench/bench-modes.spec.ts scripts/test.sh
git commit -m "test(bench): measure sample-mode panels on the mc1000 corpus"
```

---

### Task 10: Full gate and after-baselines

**Files:** none (verification only)

- [ ] **Step 1: Run the broad gates**

Run: `./scripts/test.sh quick`
Expected: PASS (core Rust tests + frontend lint/typecheck/codegen/unit/artifact checks).

- [ ] **Step 2: Run the full benchmark suite**

Run: `./scripts/test.sh bench`
Expected: the command runs both the core and browser benches and writes the
report even if a pre-existing core floor fails. The browser floors
(`e2e_mc1000` frame p95 ≤ 33 ms, stall ≤ 250 ms, first plot ≤ 10 s) must still
hold; the modes entries are report-only. The exit status still reflects any
core or browser failure.

- [ ] **Step 3: Compare against the Task 0 baseline**

```bash
diff <(python3 -m json.tool build/bench/report-baseline.json) <(python3 -m json.tool build/bench/report.json) || true
```

Summarize in the handoff/PR description: the `e2e_mc1000` deltas (first_plot_ms, frame_p95_ms, longest_task_ms) and the new `e2e_mc1000_modes` numbers as the phase-1 baseline. The spec requires re-measuring the mc1000 XY symptom before the phase-4 caching work is scoped — these numbers are that measurement; do not skip recording them.

- [ ] **Step 4: Optional sweep for the record**

The spec's series-count sweep is exercised manually via the corpus slice size:

```bash
SIGNALSCOPE_BENCH_MODES_FILES=1 ./scripts/test.sh bench
SIGNALSCOPE_BENCH_MODES_FILES=10 ./scripts/test.sh bench
SIGNALSCOPE_BENCH_MODES_FILES=1000 ./scripts/test.sh bench
```

Record each `e2e_mc1000_modes` entry (copy `build/bench/report/e2e_mc1000_modes.json` aside between runs — each run overwrites it). Report the 1/10/100/1000 table in the handoff. If the 1000-file bake exceeds the byte cap or times out, record the failure itself as the finding — that is exactly the mc1000 XY data point the spec asks for.

---

## Self-review notes (already applied)

- Spec coverage: every §"Verified quick wins" bullet maps to Tasks 1-7; §"Device-pixel correctness" to Task 8; the bench-coverage bullet and the "re-measure mc1000 XY" requirement to Tasks 9-10. The density tier, pipeline contract, and pyramid XY are phases 2-4 — intentionally absent here.
- The Task 7 alpha-compositing change and the Task 8 threshold change are the only two intended visual/behavioral deltas; both are called out where existing tests may encode the old behavior.
- Type names were verified against the tree at plan time: `SampleRequest` (`generated/protocol.ts:166`), `EnvelopeBin` fields (`finite_count`/`sample_count` are strings), `SampleWindowCache.key` parts, `WorkspaceModel.revision()`, the `Object.create(AppShell.prototype)` probe pattern, and the Playwright `bench` project testDir. Line numbers are as of commit `8c32acd` — re-locate with the quoted code if they drift.

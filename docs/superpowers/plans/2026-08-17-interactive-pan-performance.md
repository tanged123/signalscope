# Interactive pan performance implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an in-pad pan or zoom gesture on a wide, shallow time panel stop rebuilding presentation data and graphics-device residency that is already correct and already resident.

**Architecture:** The renderer consumes the padded tile response and keeps it as a stable identity for every gesture inside the pad; presentation math keeps consuming the visible window, which it is already parameterized by. Removing the sliced intermediate restores every downstream identity cache at once. Three residual per-gesture scans — the time rebase, the vertical extent, and nearest-vertex hit testing — are then bounded individually, and the vertex feed is emitted in the interleaved single-precision layout ChartGPU bulk-copies.

**Tech Stack:** TypeScript, Vitest (jsdom), Playwright, ChartGPU (vendored submodule, pinned revision — do not modify), WebGPU.

**Spec:** [`docs/superpowers/specs/2026-08-17-interactive-pan-performance-design.md`](../specs/2026-08-17-interactive-pan-performance-design.md)

## Task order matters

Tasks 2 and 3 are correctness prerequisites for Task 4, not independent
cleanups. Task 4 makes the renderer's series identity stable across a
gesture, which un-masks two defects that stable identity exposes:

- `nearestVertex` is bounded today only because it receives sliced columns
  (Task 2 gives it its own bound);
- the per-series reuse guard in `ChartHost.render` misses a change in
  whether _any_ series is emphasized, so a cleared hover would leave
  non-emphasized series dimmed (Task 3 closes the guard).

Both are reproducible before Task 4 and both have failing tests below. Do
not reorder them after it.

## Global Constraints

- Use the `./scripts/` wrappers only. Frontend unit tests: `./scripts/test.sh unit <filter>`. Formatting: `./scripts/format.sh`. Never call `pnpm`, `vitest`, `npx`, or `cargo` directly.
- Run `./scripts/format.sh` before every commit. Markdown is formatted like source.
- Do **not** edit anything under `frontend/vendor/chartgpu/`. It is a pinned submodule at revision `671e1c157a6fd9a80df35d5b43795314214569d0`.
- Do **not** change `protocol/schema/scope-protocol.json`, generated protocol/session types, or any Rust crate. This plan is frontend-only apart from its documentation task.
- Live rendering stays full resolution per ADR 0041. No level-of-detail selection, no striding, no sampling mode other than `"none"`.
- Preserve the vertex order `first → min → max → last`, NaN gap vertices, and per-response `tRef` rebasing (ADR 0039).
- Do not run `./scripts/ci.sh e2e` or `./scripts/test.sh bench` until the whole plan is finished (Task 9).
- Do not bump the version. Version bumps happen once, when the pull request is complete.
- Commit after every task with a conventional commit message.

---

### Task 1: Derive the time rebase in O(series)

`ChartHost.render` recomputes `tRef` by scanning every bin of every series on every call. Bin start times are ascending within a series, so the minimum of a series is its first entry.

**Files:**

- Modify: `frontend/src/render/chart-host.ts:299-307`
- Test: `frontend/src/render/chart-host.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: no signature change. `minimumTime(response: ColumnarTileResponse): number` keeps its name, arity, and return value; only its cost changes.

- [ ] **Step 1: Write the characterization test**

Add to `frontend/src/render/chart-host.test.ts`, inside the existing `describe("ChartHost", ...)` block. The second series starts earlier than the first, so a naive "read series[0] only" rewrite would fail it.

```ts
it("rebases time from the earliest first bin without scanning every bin", async () => {
  const host = await hostFixture();
  const series = (signalId: string, starts: number[]) => ({
    signalId,
    signalPath: signalId,
    unit: null,
    level: 0,
    bins: binColumnsFromWire(
      starts.map((t0) => ({
        t0,
        t1: t0,
        first: 1,
        last: 1,
        min: 1,
        max: 1,
        sum: 1,
        sum_sq: 1,
        finite_count: "1",
        sample_count: "1",
        has_gap: false,
      })),
    ),
  });

  host.render({
    ...request(),
    response: {
      requestId: "rebase",
      series: [series("late", [40, 50, 60]), series("early", [25, 35, 45])],
    },
    styles: [stroke(0), stroke(1)],
    xRange: { min: 25, max: 60 },
  });

  const xAxis = (state.charts.at(-1)?.options ?? {}).xAxis as {
    min: number;
    max: number;
  };
  expect(xAxis.min).toBe(0);
  expect(xAxis.max).toBe(35);
});
```

- [ ] **Step 2: Run the test to confirm the baseline**

Run: `./scripts/test.sh unit chart-host`

Expected: PASS. This test characterizes existing correct behavior so Step 3 cannot silently change the rebase value. If it FAILS, stop and report — the baseline is not what this plan assumes.

- [ ] **Step 3: Replace the full scan with a first-entry read**

In `frontend/src/render/chart-host.ts`, replace the whole `minimumTime` function:

```ts
/**
 * Bin start times ascend within a series, so a series minimum is its first
 * entry. Reading only those keeps the rebase O(series) rather than O(bins),
 * which matters because it runs on every render of a wide panel.
 */
function minimumTime(response: ColumnarTileResponse): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const series of response.series) {
    if (series.bins.count === 0) continue;
    minimum = Math.min(minimum, series.bins.t0[0] as number);
  }
  return Number.isFinite(minimum) ? minimum : 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./scripts/test.sh unit chart-host`

Expected: PASS, including the pre-existing "normalizes time to a stable reference" test.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/chart-host.ts frontend/src/render/chart-host.test.ts
git commit -m "perf(frontend): derive the chart time rebase in O(series)"
```

---

### Task 2: Bound nearest-vertex hit testing

`nearestVertex` scans every bin of every series. It is bounded today only because the caller passes sliced columns; Task 4 removes that slice. `nearestLine` in the same file already brackets its scan by binary search, and the helpers are already there.

**Files:**

- Modify: `frontend/src/app/plot-hit.ts:152-187`
- Test: `frontend/src/app/plot-hit.test.ts`

**Interfaces:**

- Consumes: `firstCenterAtOrAfter(bins: BinColumns, time: number): number` and `firstCenterAfter(bins: BinColumns, time: number): number`, both already defined in `plot-hit.ts` (lines 102 and 115). They are module-private and stay that way.
- Produces: no signature change. `nearestVertex(series, layout, px, py, threshold): VertexHit | null` keeps its behavior for every vertex within `threshold` pixels.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/app/plot-hit.test.ts`:

```ts
it("returns the same vertex from padded columns as from trimmed columns", () => {
  const layout: PlotLayout = {
    plot: { x: 0, y: 0, width: 100, height: 100 },
    xRange: { min: 10, max: 20 },
    yRange: { min: 0, max: 10 },
  };
  const bin = (t: number, value: number) => ({
    t0: t,
    t1: t,
    first: value,
    last: value,
    min: value,
    max: value,
    sum: value,
    sum_sq: value * value,
    finite_count: "1",
    sample_count: "1",
    has_gap: false,
  });
  const padded = [];
  for (let t = 0; t <= 30; t += 1) padded.push(bin(t, t % 10));
  const trimmed = padded.filter((entry) => entry.t0 >= 10 && entry.t0 <= 20);

  const at = (bins: typeof padded) =>
    nearestVertex(
      [{ path: "a", bins: binColumnsFromWire(bins) }],
      layout,
      projectX(layout, 15),
      projectY(layout, 5),
      6,
    );

  expect(at(padded)).toEqual(at(trimmed));
  expect(at(padded)?.time).toBe(15);
});
```

Ensure the file imports `projectX`, `projectY`, and the `PlotLayout` type from `./plot-math`, and `binColumnsFromWire` from `./bin-columns`; add any that are missing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit plot-hit`

Expected: FAIL. The padded range contains `t = 5` and `t = 25`, which share the value `5` with `t = 15`; the unbounded scan reaches `t = 5` first and returns it, so `time` is `5` rather than `15`.

- [ ] **Step 3: Bracket the scan**

In `frontend/src/app/plot-hit.ts`, replace `nearestVertex` in full:

```ts
export function nearestVertex(
  series: readonly HitSeries[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): VertexHit | null {
  // Ranked on squared distance — two vertices per bin over the bins the
  // cursor neighborhood can reach — then the winner's true distance is
  // reported once. The bracket keeps the scan independent of how much
  // padded data sits outside the view.
  let best: { path: string; time: number; value: number } | null = null;
  let bestSquared = threshold * threshold;
  const minTime = Math.min(
    invertX(layout, px - threshold),
    invertX(layout, px + threshold),
  );
  const maxTime = Math.max(
    invertX(layout, px - threshold),
    invertX(layout, px + threshold),
  );
  for (const entry of series) {
    const start = firstCenterAtOrAfter(entry.bins, minTime);
    const end = firstCenterAfter(entry.bins, maxTime);
    const firstIndex = Math.max(0, start - 1);
    const lastIndex = Math.min(entry.bins.count, end + 1);
    for (let index = firstIndex; index < lastIndex; index += 1) {
      const flags = entry.bins.flags[index] as number;
      const points = [
        [entry.bins.t0[index] as number, entry.bins.first[index] as number],
        [entry.bins.t1[index] as number, entry.bins.last[index] as number],
      ] as const;
      for (const [time, value, present] of [
        [points[0][0], points[0][1], Boolean(flags & HAS_FIRST)],
        [points[1][0], points[1][1], Boolean(flags & HAS_LAST)],
      ] as const) {
        if (!present || !Number.isFinite(value)) continue;
        const dx = projectX(layout, time) - px;
        const dy = projectY(layout, value) - py;
        const squared = dx * dx + dy * dy;
        if (squared > bestSquared) continue;
        // `<=` on the first candidate keeps a zero-threshold exact hit.
        if (best !== null && squared === bestSquared) continue;
        bestSquared = squared;
        best = { path: entry.path, time, value };
      }
    }
  }
  return best === null ? null : { ...best, distance: Math.sqrt(bestSquared) };
}
```

`invertX` is already imported at the top of the file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./scripts/test.sh unit plot-hit plot-capabilities`

Expected: PASS, including every pre-existing `nearestVertex` test. `prepareTimePlot`'s `annotationAt` is the production caller.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/plot-hit.ts frontend/src/app/plot-hit.test.ts
git commit -m "fix(frontend): bracket nearest-vertex hit testing by cursor time"
```

---

### Task 3: Include emphasis activity in the series reuse guard

`ChartHost.render` computes a series' opacity from whether _any_ series is emphasized (`chart-host.ts:117`), but its reuse guard only compares that series' own emphasis flag (`:106`). Clearing a hover therefore leaves every non-emphasized series at 0.25 opacity, because the guard sees no change and returns the dimmed element.

The defect is masked in production today: slicing hands the renderer a new `bins` object on every refresh pass, so `previous.columns === tile.bins` fails and every element is rebuilt regardless. Task 4 makes that identity stable, which turns this into a visible regression. Close it first.

**Files:**

- Modify: `frontend/src/render/chart-host.ts:30-36`, `:92-147`
- Test: `frontend/src/render/chart-host.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `SeriesElement` gains a field — `emphasisActive: boolean`, true when the render request carried any emphasis index at all. It is module-private to `chart-host.ts`. `ChartHost.render` keeps its signature.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/render/chart-host.test.ts`, inside `describe("ChartHost", ...)`. Both renders pass the **same** response object, so the reuse guard is live.

```ts
it("restores opacity when emphasis clears on an unchanged response", async () => {
  const host = await hostFixture();
  const data = response(["signal-1", "signal-2"]);
  const styles = [stroke(0), stroke(1)];
  const opacityOf = (index: number) =>
    (
      (state.charts.at(-1)?.options ?? {}).series as Array<{
        lineStyle: { opacity: number };
      }>
    )[index]?.lineStyle.opacity;

  host.render(request(data, styles, [0]));
  expect(opacityOf(0)).toBeCloseTo(1);
  expect(opacityOf(1)).toBeCloseTo(0.25);

  host.render(request(data, styles, []));
  expect(opacityOf(1)).toBeCloseTo(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit chart-host`

Expected: FAIL on the last assertion — `opacityOf(1)` is still `0.25`, because the guard reused the dimmed element.

- [ ] **Step 3: Add the field to the cached element**

In `frontend/src/render/chart-host.ts`, extend the `SeriesElement` interface:

```ts
interface SeriesElement {
  columns: object;
  style: SeriesStroke;
  emphasis: boolean;
  /**
   * Whether the request that built this element had any emphasis at all.
   * Opacity depends on it, so reuse must too: clearing a hover changes a
   * non-emphasized series' opacity without changing its own emphasis flag.
   */
  emphasisActive: boolean;
  palette: Palette;
  element: LineSeriesConfig;
}
```

- [ ] **Step 4: Compare and record it**

In `render`, add the binding after the `emphasis` set is built:

```ts
const emphasis = new Set(request.emphasisIndices);
const emphasisActive = request.emphasisIndices.length > 0;
```

add the comparison to the reuse guard:

```ts
if (
  previous !== undefined &&
  previous.columns === tile.bins &&
  sameStyle(previous.style, style) &&
  previous.emphasis === isEmphasized &&
  previous.emphasisActive === emphasisActive &&
  previous.palette === request.palette
) {
  return previous.element;
}
```

use it where opacity is computed:

```ts
const opacity =
  emphasisActive && !isEmphasized && !ghost
    ? 0.25
    : Math.min(1, style.alpha + (isEmphasized ? 0.4 : 0));
```

and record it when the element is cached:

```ts
this.elements[index] = {
  columns: tile.bins,
  style,
  emphasis: isEmphasized,
  emphasisActive,
  palette: request.palette,
  element,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./scripts/test.sh unit chart-host`

Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/chart-host.ts frontend/src/render/chart-host.test.ts
git commit -m "fix(frontend): reuse series elements only when emphasis activity matches"
```

---

### Task 4: Feed the renderer the padded response

The cache slices its padded response into fresh column objects on every refresh pass. The objects are correct but newly identified, and identity is what the renderer's per-series reuse guard, the vertex feed cache, and ChartGPU's own data-reference cache all key on. Return the padded response instead.

This is safe because ChartGPU draws line strokes under a plot scissor rectangle (`renderSeries.ts:1352`, and `:1534` for the dense hairline pass), so bins outside the visible range are clipped by the graphics device. It is correct because every consumer of the response already takes the visible window as an explicit argument: `columnsYExtent` and `columnsStats` filter by it, `nearestLine` and `nearestVertex` bracket by it after Task 2, and `columnsValueAtTime` binary-searches.

**Files:**

- Modify: `frontend/src/app/tile-window-cache.ts:1`, `:49-78`, `:90-110`
- Modify: `frontend/src/ui/app-shell.ts:2657-2696`
- Test: `frontend/src/app/tile-window-cache.test.ts`

**Interfaces:**

- Consumes: `CachedPanelTiles { response: ColumnarTileResponse; window: { t0: number; t1: number }; pixelWidth: number; idsKey: string }`, already exported from `tile-window-cache.ts`. The `nearestVertex` bound from Task 2 and the reuse guard from Task 3.
- Produces: `TileWindowCache.hit(panelId: string, idsKey: string, pixelWidth: number, t0: number, t1: number): ColumnarTileResponse | null` — returns the stored padded response by reference when the entry covers `[t0, t1]` and matches `idsKey` and `pixelWidth`, otherwise `null`. It **replaces** `slice`, which is removed. Repeated calls against one stored entry return the identical object. `sliceColumns` stays exported from `bin-columns.ts`; `data-plane.ts:466` still uses it.

- [ ] **Step 1: Write the failing test**

In `frontend/src/app/tile-window-cache.test.ts`, replace the three tests named `"slice returns a zero-copy padded-window view"`, `"slice rejects mismatched keys and uncovered windows"`, and `"slice reuses dense raw windows without a density rejection"` with:

```ts
test("hit returns the stored padded response by reference", () => {
  const cache = new TileWindowCache();
  const cached = entry();
  cache.store("panel", cached);

  const first = cache.hit("panel", "7", 10, 5, 10);
  const second = cache.hit("panel", "7", 10, 6, 11);

  expect(first).toBe(cached.response);
  expect(second).toBe(first);
  expect(first?.series[0]?.bins.count).toBe(20);
});

test("hit rejects mismatched keys and uncovered windows", () => {
  const cache = new TileWindowCache();
  cache.store("panel", entry());
  expect(cache.hit("panel", "8", 10, 5, 10)).toBeNull();
  expect(cache.hit("panel", "7", 2, 5, 10)).toBeNull();
  expect(cache.hit("panel", "7", 10, -1, 10)).toBeNull();
  expect(cache.hit("panel", "7", 10, 5, 100)).toBeNull();
  expect(cache.get("missing")).toBeNull();
  cache.invalidate("panel");
  expect(cache.get("panel")).toBeNull();
});

test("hit reuses dense raw windows without a density rejection", () => {
  const cache = new TileWindowCache();
  const cached = { ...entry(20, 0), pixelWidth: 2 };
  cache.store("panel", cached);

  expect(cache.hit("panel", "7", 2, 0, 19)).toBe(cached.response);
});
```

Leave `"padWindow aligns equal-span adjacent viewports"`, the `requestPixelWidth` block, and `"sliceColumns preserves typed-array views"` unchanged. Drop `sliceColumns` from the `./bin-columns` import only if the last test no longer uses it — it does, so keep it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit tile-window-cache`

Expected: FAIL with `cache.hit is not a function`.

- [ ] **Step 3: Replace `slice` with `hit`**

In `frontend/src/app/tile-window-cache.ts`, change the import on line 1 to drop `sliceColumns`:

```ts
import type { ColumnarTileResponse } from "./bin-columns";
```

Replace the whole `slice` method with:

```ts
  /**
   * The padded response for a covered viewport, by reference.
   *
   * Returning the stored object rather than a per-gesture slice is what keeps
   * renderer identity stable across an in-pad gesture: the per-series reuse
   * guard, the vertex feed cache, and ChartGPU's data-reference cache all key
   * on it. Presentation math bounds itself by the visible window instead.
   */
  hit(
    panelId: string,
    idsKey: string,
    pixelWidth: number,
    t0: number,
    t1: number,
  ): ColumnarTileResponse | null {
    const entry = this.entries.get(panelId);
    if (
      entry === undefined ||
      entry.idsKey !== idsKey ||
      entry.pixelWidth !== pixelWidth ||
      t0 < entry.window.t0 ||
      t1 > entry.window.t1
    ) {
      return null;
    }
    return entry.response;
  }
```

Then delete the now-unused `firstOverlapping` and `pastLastOverlapping` helpers at the bottom of the file (lines 90-110).

- [ ] **Step 4: Update the caller**

In `frontend/src/ui/app-shell.ts`, inside `refreshTilesPass`, change the cache probe from `slice` to `hit`:

```ts
const cached = this.tileWindowCache.hit(
  panel.id,
  idsKey,
  pixelWidth,
  window.t0,
  window.t1,
);
if (cached !== null) {
  nextTiles.set(panel.id, cached);
  return;
}
```

and replace the post-store re-slice with the response itself:

```ts
this.tileWindowCache.store(panel.id, {
  response,
  window: paddedWindow,
  pixelWidth,
  idsKey,
});
nextTiles.set(panel.id, response);
```

- [ ] **Step 5: Run the cache tests to verify they pass**

Run: `./scripts/test.sh unit tile-window-cache`

Expected: PASS.

- [ ] **Step 6: Run the full unit suite**

Run: `./scripts/test.sh unit`

Expected: PASS, unchanged. No test in `app-shell.test.ts`, `panel.test.ts`, or `plot-capabilities.test.ts` asserts on a bin count today, so this task should need no test edits beyond Step 1.

If something does fail, note that the window-filtered results are unchanged and only the number of bins reaching a consumer grew. Adjust an assertion that checks a _count_; do not weaken one that checks a _value_ — a changed value means the windowing is wrong, which is a defect in this task rather than a stale expectation. Report any such failure rather than working around it.

- [ ] **Step 7: Typecheck and lint**

Run: `./scripts/ci.sh frontend`

Expected: PASS. This catches any remaining reference to the removed `slice` method.

- [ ] **Step 8: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/tile-window-cache.ts frontend/src/app/tile-window-cache.test.ts frontend/src/ui/app-shell.ts
git commit -m "perf(frontend): feed the renderer the padded tile response"
```

---

### Task 5: Compute vertical extents only when they are needed

`prepareTimePlot` computes the vertical extent of every series eagerly when it is constructed, and `resolvePlotRanges` calls `autoRanges()` unconditionally. Together they mean a full scan of every bin of every series on every render, even when the sticky vertical range settled long ago and nothing will consume the result.

Three changes make the scan happen only when its value is used. Keep `PreparedPlot.autoRanges()` as it is — the laziness belongs at the call site that knows whether the value is needed, not hidden behind a property getter that silently costs O(bins) to read.

**Files:**

- Modify: `frontend/src/app/plot-capabilities.ts:210-253`
- Modify: `frontend/src/render/y-axis.ts:19-32`
- Modify: `frontend/src/ui/panel.ts:1465-1484`
- Test: `frontend/src/render/y-axis.test.ts`

**Interfaces:**

- Consumes: `PreparedPlot.autoRanges(): { x: readonly [number, number] | null; y: readonly [number, number] | null }` — unchanged signature, unchanged return values.
- Produces: `YAxisPolicy.resolve(seriesKey: string, automatic: () => readonly [number, number] | null, serialized: readonly [number, number] | null): [number, number] | null` — unchanged signature and unchanged return values, but `automatic` is no longer invoked once a sticky range exists for `seriesKey`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/render/y-axis.test.ts`, inside `describe("YAxisPolicy", ...)`:

```ts
it("does not recompute the automatic range once a sticky range exists", () => {
  const policy = new YAxisPolicy();
  const compute = vi.fn(() => automatic);

  expect(policy.resolve("a", compute, null)).toEqual([-50, 120]);
  expect(compute).toHaveBeenCalledTimes(1);

  expect(policy.resolve("a", compute, null)).toEqual([-50, 120]);
  expect(policy.resolve("a", compute, null)).toEqual([-50, 120]);
  expect(compute).toHaveBeenCalledTimes(1);
});

it("recomputes after the series key changes", () => {
  const policy = new YAxisPolicy();
  const compute = vi.fn(() => automatic);

  policy.resolve("a", compute, null);
  policy.resolve("b", compute, null);

  expect(compute).toHaveBeenCalledTimes(2);
});
```

Add `vi` to the `vitest` import at the top of that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./scripts/test.sh unit y-axis`

Expected: FAIL — `expect(compute).toHaveBeenCalledTimes(1)` receives 3, because `resolve` invokes `automatic()` on every call.

- [ ] **Step 3: Short-circuit the sticky vertical axis**

In `frontend/src/render/y-axis.ts`, replace the `resolve` method:

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
    // A settled sticky range is never replaced, so computing the automatic
    // range again could only be discarded. Skipping the call is what keeps a
    // pan from rescanning every bin of every series.
    if (this.sticky !== null) return this.sticky;
    const next = automatic();
    if (isUsableYRange(next)) this.sticky = [next[0], next[1]];
    return this.sticky;
  }
```

The previous `??=` becomes a plain assignment: it is now only reached when `this.sticky` is `null`.

- [ ] **Step 4: Make the time plot's extents lazy**

In `frontend/src/app/plot-capabilities.ts`, declare a type at module scope, above `prepareTimePlot`:

```ts
type SeriesExtent = { min: number; max: number } | null;
```

Replace the eager `extents` binding at the top of `prepareTimePlot` (lines 211-213) with a memoizing accessor:

```ts
export function prepareTimePlot(input: TimePlotInput): PreparedPlot {
  // Computed on demand: `autoRanges` is the only consumer, and a settled
  // sticky vertical axis never asks for it again.
  let extents: SeriesExtent[] | null = null;
  const seriesExtents = (): SeriesExtent[] =>
    (extents ??= input.series.map((series) =>
      columnsYExtent(series.bins, input.window),
    ));
```

and change `autoRanges` to call it:

```ts
    autoRanges() {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const extent of seriesExtents()) {
        if (extent === null) continue;
        min = Math.min(min, extent.min);
        max = Math.max(max, extent.max);
      }
      const y = paddedExtent(min, max);
      return y === null
        ? { x: null, y: null }
        : { x: [input.window.t0, input.window.t1], y };
    },
```

- [ ] **Step 5: Defer the call site**

In `frontend/src/ui/panel.ts`, replace `resolvePlotRanges`:

```ts
  private resolvePlotRanges(
    state: RenderPanelState,
    plot: PreparedPlot,
    window: { t0: number; t1: number },
    seriesKey = "",
  ): { x: Range; y: Range } | null {
    // Memoized and deferred: a linked-time panel takes its horizontal range
    // from the window, and a settled sticky vertical axis never asks for the
    // automatic range at all, so a pan can resolve without touching bins.
    let cached: ReturnType<PreparedPlot["autoRanges"]> | null = null;
    const automatic = (): ReturnType<PreparedPlot["autoRanges"]> =>
      (cached ??= plot.autoRanges());
    const stickyY = plot.interaction.stickyAutoY
      ? this.yAxis.resolve(seriesKey, () => automatic().y, state.y_range)
      : automatic().y;
    return resolveRanges(
      plot.interaction,
      {
        x: state.x_range,
        y: plot.interaction.stickyAutoY ? null : state.y_range,
      },
      {
        x: plot.interaction.xAxis === "linked-time" ? null : automatic().x,
        y: stickyY,
      },
      window,
    );
  }
```

The `xAxis === "linked-time"` guard is safe: `resolveRanges` (`plot-math.ts:78-81`) takes the horizontal range from `window` and ignores `automatic.x` entirely for that policy.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `./scripts/test.sh unit y-axis plot-capabilities panel`

Expected: PASS.

- [ ] **Step 7: Run the full frontend gate**

Run: `./scripts/ci.sh frontend`

Expected: PASS.

- [ ] **Step 8: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/plot-capabilities.ts frontend/src/render/y-axis.ts frontend/src/render/y-axis.test.ts frontend/src/ui/panel.ts
git commit -m "perf(frontend): resolve vertical extents only when they are consumed"
```

---

### Task 6: Take the range-only path when nothing but the ranges changed

With identity stable, an in-pad pan reaches `ChartHost.render` with every series element reused. The only thing that can differ is the axis bounds, which `setRangesOnly` already applies by spreading the existing options. Rebuilding the whole option object and re-resolving a thousand series configurations for that is waste.

**Files:**

- Modify: `frontend/src/render/chart-host.ts:38-154`
- Test: `frontend/src/render/chart-host.test.ts`

**Interfaces:**

- Consumes: `SeriesElement.emphasisActive` from Task 3; the padded-response identity from Task 4.
- Produces: no signature change. `ChartHost.render(request: ChartRenderRequest): number` still returns elapsed milliseconds and still leaves `layout()` correct.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/render/chart-host.test.ts`. `makeOptions` builds a fresh series array with `.map`, while `setRangesOnly` spreads the existing options and keeps the array — so array identity across two renders is what distinguishes the two paths.

```ts
it("reuses the resolved series array when only the ranges changed", async () => {
  const host = await hostFixture();
  const data = response(["signal-1"]);
  const seriesOf = () => (state.charts.at(-1)?.options ?? {}).series;

  host.render(request(data));
  const first = seriesOf();

  host.render({ ...request(data), xRange: { min: 11, max: 13 } });

  expect(seriesOf()).toBe(first);
  const xAxis = (state.charts.at(-1)?.options ?? {}).xAxis as { min: number };
  expect(xAxis.min).toBe(1);
});

it("rebuilds the options when a label changed", async () => {
  const host = await hostFixture();
  const data = response(["signal-1"]);
  const seriesOf = () => (state.charts.at(-1)?.options ?? {}).series;

  host.render(request(data));
  const first = seriesOf();

  host.render({ ...request(data), yLabel: "amps" });

  expect(seriesOf()).not.toBe(first);
  const yAxis = (state.charts.at(-1)?.options ?? {}).yAxis as { name: string };
  expect(yAxis.name).toBe("amps");
});
```

`request()` builds `xRange: { min: 10, max: 12 }` and the fixture response starts at `t0: 10`, so `tRef` is 10 and a request for `min: 11` resolves to an axis minimum of 1.

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `./scripts/test.sh unit chart-host`

Expected: FAIL on `expect(seriesOf()).toBe(first)` — `makeOptions` maps a new array every render. The label test passes already; it is there to pin the behavior Step 3 must not break.

- [ ] **Step 3: Track rebuilds and the labels, then branch**

In `frontend/src/render/chart-host.ts`, add a field beside `lastLayout`:

```ts
  private lastLabels: { x: string; y: string } | null = null;
```

In `render`, set a flag when the element cache is reset:

```ts
let rebuilt = false;
if (!sameStrings(ids, this.seriesIds) || nextTRef !== this.tRef) {
  this.seriesIds = ids;
  this.tRef = nextTRef;
  this.elements = [];
  rebuilt = true;
}
```

Set it again on the miss path, immediately after the reuse guard's `return previous.element;` block closes — that is, as the first statement after the `if (...) { return previous.element; }`:

```ts
rebuilt = true;
```

Then, after `this.elements.length = series.length;`, branch before building options:

```ts
this.elements.length = series.length;
const labelsChanged =
  this.lastLabels === null ||
  this.lastLabels.x !== request.xLabel ||
  this.lastLabels.y !== request.yLabel;
if (!rebuilt && !labelsChanged && this.options !== null) {
  // Every element was reused and no label moved, so only the axis bounds
  // can differ. The range-only path leaves the resolved series untouched.
  this.setRangesOnly(request.xRange, request.yRange);
  return performance.now() - started;
}
this.lastLabels = { x: request.xLabel, y: request.yLabel };
const options = this.makeOptions(request, series);
this.options = options;
this.chart.setOption(options);
this.lastLayout = this.makeLayout(request.xRange, request.yRange);
return performance.now() - started;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./scripts/test.sh unit chart-host`

Expected: PASS, including the Task 1 and Task 3 tests and the pre-existing capture, resize, and palette tests.

- [ ] **Step 5: Run the full frontend gate**

Run: `./scripts/ci.sh frontend`

Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/chart-host.ts frontend/src/render/chart-host.test.ts
git commit -m "perf(frontend): take the range-only path when only ranges changed"
```

---

### Task 7: Emit the vertex feed as interleaved single-precision

`m4Feed` allocates two double-precision arrays; ChartGPU then packs them element by element into an interleaved single-precision staging buffer. An interleaved `Float32Array` with a zero horizontal offset takes a bulk `TypedArray.set` instead (`cartesianData.ts:750`).

The zero-offset condition holds: `resolveLinePackingXOffset` returns `packingXOffset: 0` unless the horizontal axis type is `"time"`, and `ChartHost.xAxis` sets `type: "value"` (`chart-host.ts:236`). Do not change the axis type.

Precision is unchanged. ChartGPU already truncates to single precision during packing, so this moves an existing conversion earlier rather than introducing one. The `tRef` rebase that makes single precision safe (ADR 0039) is untouched.

**Files:**

- Modify: `frontend/src/render/m4-feed.ts`
- Test: `frontend/src/render/m4-feed.test.ts`, `frontend/src/render/chart-host.test.ts`

**Interfaces:**

- Consumes: `minimumTime` from Task 1 (unchanged signature).
- Produces: `SeriesFeed = Float32Array` — a flat interleaved buffer laid out `[x0, y0, x1, y1, ...]` where `x` is `time - tRef` and `y` is the sample value, `NaN` at a gap. Length is `2 * vertexCount`. `m4Feed(columns: BinColumns, tRef: number): SeriesFeed` and `cachedFeed(columns: BinColumns, tRef: number): SeriesFeed` keep their names and arity. The exported `SeriesFeed` interface with `x` and `y` fields is **removed**; `chart-host.ts:130` is its only consumer and needs no edit, because `LineSeriesConfig.data` accepts `CartesianSeriesData`, which includes `ArrayBufferView`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/render/m4-feed.test.ts`, add a helper after the existing `columns` helper, and one new test:

```ts
function points(feed: Float32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let index = 0; index < feed.length; index += 2) {
    out.push([feed[index] as number, feed[index + 1] as number]);
  }
  return out;
}

describe("interleaved layout", () => {
  it("packs x and y as consecutive pairs with gaps preserved", () => {
    const feed = m4Feed(
      columns([
        { t0: 10, t1: 10, first: 2, min: 2, max: 2, last: 2 },
        { t0: 11, t1: 11, finiteCount: 0, gap: true },
        { t0: 12, t1: 12, first: 3, min: 3, max: 3, last: 3 },
      ]),
      10,
    );

    expect(feed).toBeInstanceOf(Float32Array);
    const pairs = points(feed);
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toEqual([0, 2]);
    expect(pairs[1]?.[0]).toBe(1);
    expect(pairs[1]?.[1]).toBeNaN();
    expect(pairs[2]).toEqual([2, 3]);
  });
});
```

Then update the 17 pre-existing assertions in the file that read `feed.x` or `feed.y` (lines 43-44, 56-58, 66-67, 75-76, 88, 107, 129-132, 147-148). The vertex values, their order, and the gap positions must not change — only how they are addressed. Apply these mappings:

| Existing                         | Replacement                            |
| -------------------------------- | -------------------------------------- |
| `[...feed.x]`                    | `points(feed).map(([x]) => x)`         |
| `[...feed.y]`                    | `points(feed).map(([, y]) => y)`       |
| `feed.y[0]`                      | `points(feed)[0]?.[1]`                 |
| `expect(feed.x).toHaveLength(n)` | `expect(points(feed)).toHaveLength(n)` |

The paired buffer assertions on lines 57-58 and 130-131 collapse to one. They assert that `vertexCount` predicted the length exactly, so no slack remains after `subarray`:

```ts
expect(feed.buffer.byteLength).toBe(feed.byteLength);
```

Keep that assertion — it is the guard that `vertexCount` and the append loop agree, and it would catch a stride mistake in the new interleaved arithmetic.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit m4-feed`

Expected: FAIL — `m4Feed` returns `{ x, y }`, so `expect(feed).toBeInstanceOf(Float32Array)` fails and `points(feed)` yields nothing.

- [ ] **Step 3: Emit the interleaved buffer**

In `frontend/src/render/m4-feed.ts`, replace the `SeriesFeed` interface and the `m4Feed` function. Leave `vertexCount` and `cachedFeed` exactly as they are — `cachedFeed`'s `WeakMap<BinColumns, { tRef: number; feed: SeriesFeed }>` still typechecks against the new alias.

```ts
/**
 * Interleaved `[x0, y0, x1, y1, ...]` in single precision: the layout
 * ChartGPU bulk-copies into its staging buffer instead of packing element by
 * element. `x` is `time - tRef`; `y` is `NaN` at a gap.
 */
export type SeriesFeed = Float32Array;

export function m4Feed(columns: BinColumns, tRef: number): SeriesFeed {
  const feed = new Float32Array(vertexCount(columns) * 2);
  let length = 0;
  const appendGap = (time: number): void => {
    feed[length] = time - tRef;
    feed[length + 1] = Number.NaN;
    length += 2;
  };
  const append = (time: number, value: number): void => {
    if (!Number.isFinite(value)) return;
    feed[length] = time - tRef;
    feed[length + 1] = value;
    length += 2;
  };

  for (let index = 0; index < columns.count; index += 1) {
    const flags = columns.flags[index] as number;
    const midpoint =
      ((columns.t0[index] as number) + (columns.t1[index] as number)) / 2;
    if (columns.finiteCount[index] === 0) {
      appendGap(midpoint);
      continue;
    }
    const hasGap = (flags & HAS_GAP) !== 0;
    if (hasGap) appendGap(midpoint);
    const start = length;
    if (
      columns.sampleCount[index] === 1 &&
      columns.t0[index] === columns.t1[index]
    ) {
      append(columns.t0[index] as number, columns.first[index] as number);
    } else {
      if ((flags & HAS_FIRST) !== 0) {
        append(columns.t0[index] as number, columns.first[index] as number);
      }
      if ((flags & HAS_MIN) !== 0) {
        append(midpoint, columns.min[index] as number);
      }
      if ((flags & HAS_MAX) !== 0) {
        append(midpoint, columns.max[index] as number);
      }
      if ((flags & HAS_LAST) !== 0) {
        append(columns.t1[index] as number, columns.last[index] as number);
      }
    }
    if (length === start) {
      appendGap(midpoint);
    }
    if (hasGap) appendGap(midpoint);
  }
  return feed.subarray(0, length);
}
```

- [ ] **Step 4: Run the feed tests to verify they pass**

Run: `./scripts/test.sh unit m4-feed`

Expected: PASS.

- [ ] **Step 5: Update the renderer's assertions**

In `frontend/src/render/chart-host.test.ts`, four lines read the feed: 140, 143, 162, and 165. On lines 140 and 162 replace the type annotation:

```ts
const series = options.series as Array<{ data: Float32Array }>;
```

On lines 143 and 165 the assertion checks the single vertex's x value, which is now element 0 of the interleaved buffer:

```ts
expect(series[0]?.data[0]).toBe(0);
```

Any other assertion that appears there follows the same indexing: an old `data.x[i]` is `data[i * 2]`, an old `data.y[i]` is `data[i * 2 + 1]`, and an old `data.x.length` is `data.length / 2`.

- [ ] **Step 6: Run the renderer tests to verify they pass**

Run: `./scripts/test.sh unit chart-host`

Expected: PASS.

- [ ] **Step 7: Run the full frontend gate**

Run: `./scripts/ci.sh frontend`

Expected: PASS.

- [ ] **Step 8: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/m4-feed.ts frontend/src/render/m4-feed.test.ts frontend/src/render/chart-host.test.ts
git commit -m "perf(frontend): emit the vertex feed as interleaved single-precision"
```

---

### Task 8: Add an in-pad pan benchmark scenario

The existing `mc1000` scenario mixes wheel zoom, control-drag, and box zoom, so a regression in the in-pad pan path can hide inside it. Add a scenario that drags only within the padded window and reports its own frame statistics against the same floors.

**Files:**

- Modify: `frontend/tests/bench/measure.ts`
- Modify: `frontend/tests/bench/bench.spec.ts`

**Interfaces:**

- Consumes: `startFrameProbe(page: Page): Promise<void>` and `stopFrameProbe(page: Page): Promise<FrameStats>`, both already exported from `measure.ts`. `FrameStats { p95Ms, maxMs, frames, longTasks, longestTaskMs }`.
- Produces: `panInPad(page: Page): Promise<void>` exported from `measure.ts` — a sustained horizontal drag of small steps, each well inside one padded window, with no wheel zoom and no modifier keys.

- [ ] **Step 1: Add the gesture helper**

Append to `frontend/tests/bench/measure.ts`:

```ts
/**
 * A sustained horizontal drag in small steps. Every step stays well inside
 * one padded window, so the gesture exercises the cache-hit render path
 * rather than the fetch a pad exit triggers.
 */
export async function panInPad(page: Page): Promise<void> {
  const canvas = page.locator(".overlay-canvas").first();
  await canvas.hover({ position: { x: 640, y: 200 } });
  await page.mouse.move(640, 200);
  await page.mouse.down();
  // Progressive, not oscillating: 24 steps of 10 css px walk the window
  // 240 px to the left, far enough to be a real pan and comfortably inside
  // a pad that is two to four times the visible span.
  for (let index = 1; index <= 24; index += 1) {
    await page.mouse.move(640 - index * 10, 200, { steps: 4 });
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);
}
```

- [ ] **Step 2: Add the scenario**

Append to `frontend/tests/bench/bench.spec.ts`, after the existing test. Add `panInPad` to the `./measure` import.

```ts
test("mc1000 in-pad pan stays interactive", async ({ page }) => {
  test.setTimeout(240_000);
  expect(
    existsSync(fileURLToPath(artifact)),
    "bake first: ./scripts/test.sh bench e2e",
  ).toBe(true);

  await page.goto(artifact.href);
  await expect(page.locator(".plot-canvas").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 120_000,
  });

  await startFrameProbe(page);
  await panInPad(page);
  const stats = await stopFrameProbe(page);

  mkdirSync(fileURLToPath(reportDir), { recursive: true });
  writeFileSync(
    new URL("e2e_mc1000_pan.json", reportDir),
    JSON.stringify(
      {
        bench: "e2e_mc1000_pan",
        frame_p95_ms: stats.p95Ms,
        frame_max_ms: stats.maxMs,
        frames: stats.frames,
        long_tasks: stats.longTasks,
        longest_task_ms: stats.longestTaskMs,
        floor_frame_p95_ms: 33,
        floor_frames: 100,
        floor_stall_ms: 250,
        pass:
          stats.frames > 100 &&
          stats.p95Ms <= 33 &&
          Math.max(stats.maxMs, stats.longestTaskMs) <= 250,
      },
      null,
      2,
    ),
  );

  expect(stats.frames, "frame probe collected samples").toBeGreaterThan(100);
  expect(stats.p95Ms, "frame interval p95").toBeLessThanOrEqual(33);
  expect(
    Math.max(stats.maxMs, stats.longestTaskMs),
    "longest stall",
  ).toBeLessThanOrEqual(250);
});
```

- [ ] **Step 3: Confirm the report aggregator picks the new file up**

Run: `rg -n "readdir" scripts/collect-bench-report.mjs`

Expected: line 8 reads the report directory with `readdir`, so it globs every scenario file and needs no change for a new scenario. This step is a verification, not an edit — if the aggregator has since changed to an explicit list, add `e2e_mc1000_pan` to it.

- [ ] **Step 4: Lint the new test code**

Run: `./scripts/ci.sh frontend`

Expected: PASS. `eslint` covers `tests` as well as `src`.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/tests/bench/measure.ts frontend/tests/bench/bench.spec.ts
git commit -m "test(bench): measure in-pad pan frame timing separately"
```

---

### Task 9: Record the decision and run the full gate

**Files:**

- Create: `docs/adr/0042-padded-render-feed.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/implementation-roadmap.md:116-125`

**Interfaces:**

- Consumes: the behavior established by Tasks 1-8.
- Produces: documentation only.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0042-padded-render-feed.md`:

```markdown
# ADR 0042: Padded render feed and windowed presentation math

- Status: Accepted
- Date: 2026-08-17

## Context

Panning a wide time panel served from the padded window cache rebuilt every
presentation layer and rewrote the whole vertex residency, roughly twenty
times a second, to move an axis the renderer had already moved. The cause was
identity rather than volume: slicing the cached response per gesture produced
correct but newly identified columns, and the renderer's per-series reuse
guard, the vertex feed cache, and ChartGPU's data-reference cache all key on
that identity.

## Decision

The renderer consumes the padded tile response by reference, and the response
keeps that identity for every gesture inside the pad. `TileWindowCache`
returns the stored response rather than a per-gesture slice.

Presentation math consumes the visible window as an explicit argument.
Vertical extents, visible-region statistics, cursor readings, and hit testing
are bounded by window filtering or binary search rather than by the shape of
the array they are handed. Nearest-vertex hit testing brackets its scan the
way nearest-segment hit testing already did.

Feeding padded data is sound because line strokes draw under a plot scissor
rectangle, so out-of-view bins are clipped by the graphics device.

The time rebase is derived from each series' first bin start rather than a
full scan, and is stable across an in-pad gesture. Vertical extents are
computed only when consumed; a settled sticky vertical axis does not ask for
them. A render in which every series element was reused and no axis label
moved takes the range-only path instead of rebuilding the option object. The
vertex feed is emitted as an interleaved single-precision buffer, the layout
ChartGPU bulk-copies rather than packs element by element.

Series element reuse compares whether any series is emphasized, not only
whether this series is. Opacity depends on the former, so a cleared hover
would otherwise leave non-emphasized series dimmed once identity is stable.

## Consequences

Feeding the pad draws two to four times the visible segments, trading fixed
device fill for the removal of the per-gesture repack and rewrite. A gesture
that leaves the pad still pays a full fetch, and that cost is unchanged.

Live presentation remains full resolution: the same bins produce the same
vertices and the same pixels. This record does not amend ADR 0041. Vertex
order, gap vertices, and `tRef` rebasing from ADR 0039 are unchanged, and
ChartGPU is not forked.

This amends the render-path portion of ADR 0036, which recorded that the
frontend slices cached typed arrays into the render path. Its tile budget,
gap bits, finite extrema, and binary transport decisions remain
authoritative.

Visible-region statistics remain a linear scan over the padded columns while
the statistics strip is shown. A per-response block summary is the expected
remedy if the benchmark shows it matters.
```

- [ ] **Step 2: Add the ADR to the index**

In `docs/adr/README.md`, add after the line for ADR 0041:

```markdown
42. [Padded render feed and windowed presentation math](0042-padded-render-feed.md)
```

- [ ] **Step 3: Update the roadmap**

In `docs/implementation-roadmap.md`, in the full-resolution paragraph at lines 116-125, append:

```markdown
The first measured follow-up landed as
[ADR 0042](adr/0042-padded-render-feed.md): the renderer consumes the padded
tile response so an in-pad pan reuses resident vertices instead of rebuilding
them, and presentation math bounds itself by the visible window. Compact
raw-sample binary transport and eventual pyramid removal remain open.
```

- [ ] **Step 4: Run the complete local gate**

Run: `./scripts/ci.sh all`

Expected: PASS. This runs format, quality, rust, frontend, and e2e.

- [ ] **Step 5: Run the benchmark suite**

Run: `./scripts/test.sh bench`

Expected: both `e2e_mc1000` and `e2e_mc1000_pan` report `pass: true` in `build/bench/report/`. If `frame_p95_ms` exceeds 33 ms, report the number rather than loosening the floor — the floor is the ADR 0035 contract, and a miss is a result to hand back, not a threshold to edit.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add docs/adr/0042-padded-render-feed.md docs/adr/README.md docs/implementation-roadmap.md
git commit -m "docs: record the padded render feed decision"
```

---

## Handoff notes

Report these with the finished work:

- `frame_p95_ms` from `e2e_mc1000_pan` and from `e2e_mc1000`;
- whether any assertion in Task 4 Step 6 had to change, and which;
- whether `collect-bench-report.mjs` needed the change in Task 8 Step 3.

Deliberately **not** in scope, and left for a later measured pass:

- visible-region statistics remain a linear scan over padded columns when the statistics strip is shown;
- compact raw-sample binary transport, which would address the level-zero envelope's byte amplification rather than the per-gesture rebuild this plan targets;
- ChartGPU's compute-shader decimation, which is unreachable while the feed carries NaN gap vertices and would reintroduce level-of-detail against ADR 0041.

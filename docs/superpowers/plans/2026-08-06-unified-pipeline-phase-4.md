# Unified Plotting Pipeline — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pyramid-backed XY from `docs/superpowers/specs/2026-08-06-unified-renderer-design.md` §"Pyramid-backed XY" (baseline only): shared-timebase trace pairs render from envelope tiles through each bucket's `(x_first, y_first) → (x_last, y_last)` in index order — binary transport, out-of-core, and window caching for free — while cross-timebase pairs keep the interpolating sample path. Amends ADR 0037.

**Architecture:** **No Rust or protocol changes.** `Pyramid::query_with_target` (`core/scope-core/src/pyramid.rs:431`) derives level and bin windows purely from the time column, sample count, and target — so two signals sharing one time array (the verified premise across CSV/MCAP/recipe ingest) return index-aligned buckets from the _existing_ tile endpoint when queried together. The client pairs buckets by index, verifies alignment cheaply per pair (level + count + boundary timestamps), converts pairs into the existing `XyTrace` shape so every downstream consumer (prepared plot, hit-testing, markers, flatten, colorbar) is untouched, and falls back to the sample pipeline when verification fails — which also makes baked snapshots work unchanged. The XY mode's `ModeDataSpec` flips to `envelope` with a coarse window-independent context tile query replacing the context sample request.

**Tech Stack:** TypeScript (strict), vitest (jsdom), no new dependencies, no schema changes.

## Global Constraints

- **Prerequisite: phases 1–3 fully landed** (Task 0 verifies). Phase 2's mode modules and phase 3's density files must exist as specced.
- The trajectory _decimation_ is a new representation, so XY visuals on shared-timebase pairs will change (fewer, better-placed vertices; identical at level 0). Cross-timebase pairs and all other modes must render identically. The alignment fallback must be verified working — it is the correctness net.
- Pyramid invariants are law (spec §"Determinism"): `has_gap` on either signal of a pair lifts the pen and never discards data silently; no raw-array scans on pan/zoom; renderer stays deterministic from tiles + viewport.
- Budgets unchanged: `TILE_BIN_BUDGET = 250_000`, sample caps as-is. The XY sample fallback keeps its two-request shape, so `sampleCapForPanel` semantics do not change.
- Run everything through `./scripts/` wrappers; format before every commit; stage only listed files; one commit per task.
- Never modify `refs/`, `frontend/src/generated/`, or anything under `core/`/`shell/` (this phase is frontend-only by design — if you find yourself editing Rust, the design has been misread; stop and re-read the Architecture note).

---

### Task 0: Prerequisites, baseline, and the mandated re-measurement

**Files:** none

- [ ] **Step 1: Verify phases 1–3 landed**

```bash
grep -n "export const xyModule" frontend/src/ui/modes/xy.ts
grep -n "export function densityMode" frontend/src/render/density-policy.ts
grep -n "export async function fetchXySamples" frontend/src/app/xy-samples.ts
grep -n "contextTiles" frontend/src/ui/modes/contract.ts || echo "OK: not yet present"
```

Expected: first three match; fourth prints OK. If any of the first three misses, STOP.

- [ ] **Step 2: Green tree, baseline, and the spec's required XY re-measurement**

Run: `./scripts/test.sh quick` — expected PASS.
Run: `./scripts/test.sh bench`, then `cp build/bench/report.json build/bench/report-phase3-baseline.json`.

The spec requires re-measuring the mc1000 XY symptom before this phase's work is judged: record the `e2e_mc1000_modes` entry's numbers now (its XY panel is `response @*` vs `command` over the corpus slice) — these are the "before". Also record the per-series sample cap in play (`sampleCapForPanel("xy", N)` for the bench's series count) in the handoff notes.

---

### Task 1: Contract evolution for envelope-backed XY

Three additions to the phase-2 contract, all mechanical: XY's `ModeDataSpec` flips to the envelope pipeline with a context window; `PrepareInput` gains the context tile response; `ProjectResult` gains the fallback signal.

**Files:**

- Modify: `frontend/src/ui/modes/contract.ts`
- Modify: `frontend/src/ui/modes/contract.test.ts`

**Interfaces:**

- Produces (changed/added):
  - `MODE_DATA.xy` becomes `{ reduction: "envelope", windows: ["context", "visible"] }` — for envelope modes, `windows` names the _tile_ queries the shell issues; `"context"` is a coarse full-extent query.
  - `PrepareInput` gains `contextTiles: ColumnarTileResponse | null;`
  - `ProjectResult` gains `needsSampleFallback?: boolean;` — set by a mode whose envelope data cannot serve the panel (unverified alignment) and whose sample data has not arrived yet; the shell reacts by refetching that panel through the sample pipeline.

- [ ] **Step 1: Update the contract test (it will fail against current code)**

In `frontend/src/ui/modes/contract.test.ts`, change the xy expectation:

```ts
expect(MODE_DATA.xy).toEqual({
  reduction: "envelope",
  windows: ["context", "visible"],
});
```

Run: `./scripts/test.sh unit -- src/ui/modes/contract.test.ts`
Expected: FAIL — xy still declares samples.

- [ ] **Step 2: Implement the three contract changes**

In `frontend/src/ui/modes/contract.ts`:

1. Update the `ModeDataSpec` doc comment: for `reduction: "envelope"`, `windows` lists tile queries (`"visible"` is implicit for time mode's empty list; `"context"` adds a coarse full-extent query). For `reduction: "samples"` it lists sample requests, unchanged.
2. `MODE_DATA.xy` → `{ reduction: "envelope", windows: ["context", "visible"] }`.
3. Add to `PrepareInput`:

```ts
/** Coarse full-extent tiles for modes declaring a "context" window. */
contextTiles: ColumnarTileResponse | null;
```

4. Add to `ProjectResult`:

```ts
  /**
   * The envelope data cannot serve this panel (pair alignment unverified)
   * and no sample data is present — the shell must refetch this panel
   * through the sample pipeline. Sticky per series set; see app-shell.
   */
  needsSampleFallback?: boolean;
```

- [ ] **Step 3: Fix the compile fallout mechanically**

Every `PrepareInput` literal now needs `contextTiles`. Find them: `grep -rn "callbacks: this.callbacks\|callbacks," frontend/src/ui/panel.ts frontend/src/ui/modes/*.test.ts | grep -v "//"` — in `PanelView.renderViaModule` add `contextTiles: this.lastContextTiles ?? null` — but that field arrives in Task 4; for THIS task pass `contextTiles: null` and leave a one-line `// Task 4 wires the real context tiles.` comment. In the module test files, add `contextTiles: null` to each fixture literal.

- [ ] **Step 4: Run the suites**

Run: `./scripts/test.sh unit -- src/ui/modes src/ui/panel.test.ts`
Expected: PASS (xy module still consumes `samples`; nothing reads the new fields yet).

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/modes/contract.ts frontend/src/ui/modes/contract.test.ts frontend/src/ui/panel.ts frontend/src/ui/modes/histogram.test.ts frontend/src/ui/modes/fft.test.ts frontend/src/ui/modes/time.test.ts frontend/src/ui/modes/xy.test.ts
git commit -m "feat(modes): declare envelope-backed xy in the mode contract"
```

---

### Task 2: The pure pairing core — aligned tiles to `XyTrace`

Two exported pure functions in `frontend/src/app/xy.ts`. This is the heart of the phase and carries the correctness rules from the spec: first/last preserve correspondence (same sample index on a shared timebase), min/max are marginal and must NOT be used as pairs, and a gap on either signal lifts the pen.

**Files:**

- Modify: `frontend/src/app/xy.ts`
- Test: `frontend/src/app/xy.test.ts`

**Interfaces:**

- Consumes: `ColumnarTile`, `BinColumns`, `HAS_FIRST`/`HAS_LAST`/`HAS_GAP` (`frontend/src/app/bin-columns.ts`).
- Produces (exported from `app/xy.ts`):
  - `function tilesAligned(a: ColumnarTile, b: ColumnarTile): boolean` — true when the two tiles' buckets share an index space: same level, same bin count, and identical first/middle/last bucket timestamps. Empty tiles align only with empty tiles.
  - `function pairTileTrace(x: ColumnarTile, y: ColumnarTile, color: ColumnarTile | null): { trace: XyTrace; colors: number[] | null } | null` — null when `tilesAligned` fails for the pair (or the color tile); otherwise the bucket-pair trajectory as an ordinary `XyTrace`, so every existing consumer works unchanged.
  - `function buildTileIndex(tiles: readonly ColumnarTile[], callbacks: SeriesPathCallbacks): Map<string, ColumnarTile>` — the tile analogue of `buildSeriesIndex`, keyed with `seriesIndexKey` on `tile.signalPath` (note the camelCase field, unlike samples' `signal_path`).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/app/xy.test.ts` (add the new names to the `./xy` import; import `binColumnsFromWire` from `./bin-columns` and `EnvelopeBin` from `../generated/protocol` if not present):

```ts
function envelopeBin(
  t0: number,
  t1: number,
  first: number,
  last: number,
  hasGap = false,
): EnvelopeBin {
  return {
    t0,
    t1,
    first,
    last,
    min: Math.min(first, last),
    max: Math.max(first, last),
    sum: first + last,
    sum_sq: first * first + last * last,
    finite_count: "2",
    sample_count: "2",
    has_gap: hasGap,
  };
}

function columnarTile(
  path: string,
  level: number,
  bins: EnvelopeBin[],
): ColumnarTile {
  return {
    signalId: path,
    signalPath: path,
    unit: "V",
    level,
    bins: binColumnsFromWire(bins),
  } as ColumnarTile;
}

describe("tilesAligned", () => {
  const base = [envelopeBin(0, 1, 1, 2), envelopeBin(1, 2, 2, 3)];

  it("accepts same level, count, and bucket timestamps", () => {
    expect(
      tilesAligned(
        columnarTile("run_0001/command", 3, base),
        columnarTile("run_0001/response", 3, base),
      ),
    ).toBe(true);
  });

  it("rejects level, count, or timestamp mismatches", () => {
    expect(
      tilesAligned(columnarTile("a", 3, base), columnarTile("b", 4, base)),
    ).toBe(false);
    expect(
      tilesAligned(
        columnarTile("a", 3, base),
        columnarTile("b", 3, base.slice(0, 1)),
      ),
    ).toBe(false);
    expect(
      tilesAligned(
        columnarTile("a", 3, base),
        columnarTile("b", 3, [
          envelopeBin(0, 1, 1, 2),
          envelopeBin(1, 2.5, 2, 3),
        ]),
      ),
    ).toBe(false);
  });
});

describe("pairTileTrace", () => {
  it("threads the trajectory through first/last pairs in index order", () => {
    const x = columnarTile("run_0001/command", 2, [
      envelopeBin(0, 1, 10, 11),
      envelopeBin(1, 2, 11, 12),
    ]);
    const y = columnarTile("run_0001/response", 2, [
      envelopeBin(0, 1, 20, 21),
      envelopeBin(1, 2, 21, 22),
    ]);
    const paired = pairTileTrace(x, y, null);
    expect(paired).not.toBeNull();
    if (paired === null) return;
    expect(paired.trace.time).toEqual([0, 1, 1, 2]);
    expect(paired.trace.x).toEqual([10, 11, 11, 12]);
    expect(paired.trace.y).toEqual([20, 21, 21, 22]);
    expect(paired.colors).toBeNull();
  });

  it("collapses degenerate level-0 buckets to single points", () => {
    const x = columnarTile("a", 0, [envelopeBin(0, 0, 10, 10)]);
    const y = columnarTile("b", 0, [envelopeBin(0, 0, 20, 20)]);
    const paired = pairTileTrace(x, y, null);
    expect(paired?.trace.time).toEqual([0]);
    expect(paired?.trace.x).toEqual([10]);
    expect(paired?.trace.y).toEqual([20]);
  });

  it("a gap on either signal lifts the pen with a NaN vertex", () => {
    const x = columnarTile("a", 2, [
      envelopeBin(0, 1, 10, 11),
      envelopeBin(1, 2, 11, 12, true),
    ]);
    const y = columnarTile("b", 2, [
      envelopeBin(0, 1, 20, 21),
      envelopeBin(1, 2, 21, 22),
    ]);
    const paired = pairTileTrace(x, y, null);
    expect(paired).not.toBeNull();
    if (paired === null) return;
    // Break inserted before the gap bucket: NaN triple, then its points.
    expect(paired.trace.x).toEqual([10, 11, Number.NaN, 11, 12]);
    expect(paired.trace.y).toEqual([20, 21, Number.NaN, 21, 22]);
  });

  it("returns null for misaligned pairs and misaligned color tiles", () => {
    const x = columnarTile("a", 2, [envelopeBin(0, 1, 10, 11)]);
    const y = columnarTile("b", 3, [envelopeBin(0, 1, 20, 21)]);
    expect(pairTileTrace(x, y, null)).toBeNull();
    const yOk = columnarTile("b", 2, [envelopeBin(0, 1, 20, 21)]);
    const colorBad = columnarTile("c", 5, [envelopeBin(0, 1, 1, 1)]);
    expect(pairTileTrace(x, yOk, colorBad)).toBeNull();
  });

  it("carries aligned color values parallel to the points", () => {
    const bins = [envelopeBin(0, 1, 1, 2)];
    const paired = pairTileTrace(
      columnarTile("a", 1, bins),
      columnarTile("b", 1, [envelopeBin(0, 1, 5, 6)]),
      columnarTile("c", 1, [envelopeBin(0, 1, 7, 8)]),
    );
    expect(paired?.colors).toEqual([7, 8]);
  });
});

describe("buildTileIndex", () => {
  it("indexes tiles by source and local path, first wins", () => {
    const a = columnarTile("run_0001/command", 0, []);
    const b = columnarTile("run_0002/command", 0, []);
    const index = buildTileIndex([a, b], callbacks);
    expect(index.get(seriesIndexKey("run_0001", "command"))).toBe(a);
    expect(index.get(seriesIndexKey("run_0002", "command"))).toBe(b);
  });
});
```

(The `callbacks` helper already exists in this file from phase 1's `buildSeriesIndex` tests.)

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/test.sh unit -- src/app/xy.test.ts`
Expected: FAIL — the three functions do not exist.

- [ ] **Step 3: Implement in `frontend/src/app/xy.ts`**

Add imports: `import { HAS_FIRST, HAS_GAP, HAS_LAST, type ColumnarTile } from "./bin-columns";`

```ts
const PAIR_FLAGS = HAS_FIRST | HAS_LAST;

/**
 * True when two tiles' buckets share one index space. On a shared time
 * array, `query_with_target` derives the level and bin windows from the
 * time column alone, so equal level + count + boundary timestamps means
 * bucket i of one tile covers exactly the samples of bucket i of the
 * other. Timestamps are compared exactly — both sides read the same
 * f64 array, so any drift is a real misalignment, not float noise.
 */
export function tilesAligned(a: ColumnarTile, b: ColumnarTile): boolean {
  if (a.level !== b.level) return false;
  const ab = a.bins;
  const bb = b.bins;
  if (ab.count !== bb.count) return false;
  if (ab.count === 0) return true;
  const last = ab.count - 1;
  const middle = ab.count >> 1;
  return (
    ab.t0[0] === bb.t0[0] &&
    ab.t1[last] === bb.t1[last] &&
    ab.t0[middle] === bb.t0[middle]
  );
}

/**
 * The bucket-pair trajectory for a shared-timebase pair, as an ordinary
 * XyTrace so every downstream consumer (prepared plot, hit-testing,
 * markers, flatten) is unchanged. Per bucket the trajectory passes
 * through (x_first, y_first) then (x_last, y_last) — first/last are the
 * same sample index on both signals, so correspondence is exact. Marginal
 * min/max are deliberately unused: they need not co-occur, and pairing
 * them would draw area the trajectory never visited (spec correction 2).
 * A gap or missing first/last on either signal lifts the pen. Null when
 * the pair (or the colour tile) fails alignment — the caller falls back
 * to the sample pipeline.
 */
export function pairTileTrace(
  x: ColumnarTile,
  y: ColumnarTile,
  color: ColumnarTile | null,
): { trace: XyTrace; colors: number[] | null } | null {
  if (!tilesAligned(x, y)) return null;
  if (color !== null && !tilesAligned(x, color)) return null;
  const time: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const colors: number[] | null = color === null ? null : [];
  const count = x.bins.count;
  let penDown = false;
  const push = (t: number, xv: number, yv: number, cv: number): void => {
    time.push(t);
    xs.push(xv);
    ys.push(yv);
    colors?.push(cv);
  };
  for (let index = 0; index < count; index += 1) {
    const xFlags = x.bins.flags[index] as number;
    const yFlags = y.bins.flags[index] as number;
    if (
      (xFlags & PAIR_FLAGS) !== PAIR_FLAGS ||
      (yFlags & PAIR_FLAGS) !== PAIR_FLAGS
    ) {
      if (penDown) push(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
      penDown = false;
      continue;
    }
    const gap = ((xFlags | yFlags) & HAS_GAP) !== 0;
    if (gap && penDown) {
      push(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    }
    const t0 = x.bins.t0[index] as number;
    const t1 = x.bins.t1[index] as number;
    const cFirst =
      color === null ? Number.NaN : (color.bins.first[index] as number);
    const cLast =
      color === null ? Number.NaN : (color.bins.last[index] as number);
    push(
      t0,
      x.bins.first[index] as number,
      y.bins.first[index] as number,
      cFirst,
    );
    const degenerate =
      t0 === t1 &&
      x.bins.first[index] === x.bins.last[index] &&
      y.bins.first[index] === y.bins.last[index];
    if (!degenerate) {
      push(
        t1,
        x.bins.last[index] as number,
        y.bins.last[index] as number,
        cLast,
      );
    }
    penDown = true;
  }
  return { trace: { time, x: xs, y: ys }, colors };
}

/**
 * Tile analogue of buildSeriesIndex — tiles carry `signalPath`
 * (camelCase) where samples carry `signal_path`. First match wins.
 */
export function buildTileIndex(
  tiles: readonly ColumnarTile[],
  callbacks: SeriesPathCallbacks,
): Map<string, ColumnarTile> {
  const index = new Map<string, ColumnarTile>();
  for (const tile of tiles) {
    const sourceKey = callbacks.sourceKeyFor(tile.signalPath);
    const localPath = callbacks.localPathFor(tile.signalPath);
    if (sourceKey === null || localPath === null) continue;
    const key = seriesIndexKey(sourceKey, localPath);
    if (!index.has(key)) index.set(key, tile);
  }
  return index;
}
```

One deliberate behavior to keep: a gap bucket still draws its own points after the NaN break — the pen lifts _before_ it, matching the time renderer's "`has_gap` breaks a stroke and never discards extrema" invariant. Colour values on a colourless bucket (missing first/last flags on the colour tile only) are `NaN`, which the ramp path already treats as unmapped — do not skip the point for that.

- [ ] **Step 4: Run them to verify they pass**

Run: `./scripts/test.sh unit -- src/app/xy.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/xy.ts frontend/src/app/xy.test.ts
git commit -m "feat(xy): pair aligned pyramid buckets into trajectories"
```

---

### Task 3: The XY module prepares from tiles, falls back to samples

`xyModule.prepare` gains the envelope path: when `tiles` and `contextTiles` are present and every visible pair verifies, geometry comes from `pairTileTrace` (lit) and the context tiles (dimmed); otherwise the existing sample-based prepare runs; if neither can serve, the module reports `needsSampleFallback`. The `project` stage is untouched — geometry keeps the exact same shape, which is the point of `XyTrace` conversion.

**Files:**

- Modify: `frontend/src/ui/modes/xy.ts`
- Test: `frontend/src/ui/modes/xy.test.ts`

**Interfaces:**

- Consumes: `tilesAligned` / `pairTileTrace` / `buildTileIndex` (Task 2), the Task 1 contract fields.
- Produces: unchanged module surface. New behavioral contract:
  - tiles + context, all pairs aligned → envelope geometry, `needsSampleFallback` absent;
  - alignment fails but `samples !== null` → sample geometry (today's path, bit-identical);
  - alignment fails and `samples === null` → `{ plot: { kind: "empty" }, needsSampleFallback: true }`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/ui/modes/xy.test.ts`, reusing its fixtures plus tile builders (copy `envelopeBin`/`columnarTile` from `app/xy.test.ts` into this file — module test files stay self-contained):

```ts
function tileResponse(tiles: ColumnarTile[]): ColumnarTileResponse {
  return { requestId: "t", series: tiles } as ColumnarTileResponse;
}

describe("xyModule envelope path", () => {
  const xTile = columnarTile("run_0001/command", 2, [
    envelopeBin(0, 1, 10, 11),
    envelopeBin(1, 2, 11, 12),
  ]);
  const yTile = columnarTile("run_0001/response", 2, [
    envelopeBin(0, 1, 20, 21),
    envelopeBin(1, 2, 21, 22),
  ]);
  const contextX = columnarTile("run_0001/command", 5, [
    envelopeBin(0, 2, 10, 12),
  ]);
  const contextY = columnarTile("run_0001/response", 5, [
    envelopeBin(0, 2, 20, 22),
  ]);

  function envelopeInput(): PrepareInput {
    return {
      state: xyState("run_0001/command", ["run_0001/response"]),
      tiles: tileResponse([xTile, yTile]),
      contextTiles: tileResponse([contextX, contextY]),
      samples: null,
      callbacks,
    };
  }

  it("builds the lit trajectory from bucket pairs and the dimmed one from context", () => {
    const input = envelopeInput();
    const geometry = xyModule.prepare(input);
    const result = xyModule.project(geometry, input, frame);
    expect(result.needsSampleFallback).toBeUndefined();
    expect(result.plot.kind).toBe("paths");
    if (result.plot.kind !== "paths") return;
    const [dimmed, lit] = result.plot.paths;
    // Dimmed underlay comes from the coarse context pair.
    expect(dimmed?.dimmed).toBe(true);
    expect(dimmed?.points).toEqual([10, 20, 12, 22]);
    // Lit path threads bucket first/last pairs (window covers t 0..1).
    expect(lit?.points).toEqual([10, 20, 11, 21, Number.NaN, Number.NaN]);
    expect(result.xyTraces?.[0]?.trace.x).toEqual([10, 11, 11, 12]);
  });

  it("falls back to the sample path when a pair misaligns and samples exist", () => {
    const misaligned = columnarTile("run_0001/response", 3, [
      envelopeBin(0, 2, 20, 22),
    ]);
    const input: PrepareInput = {
      ...envelopeInput(),
      tiles: tileResponse([xTile, misaligned]),
      samples: {
        request_id: "r",
        series: [
          series("run_0001/command", [0, 1, 2], [1, 2, 3]),
          series("run_0001/response", [0, 1, 2], [2, 3, 4]),
        ],
      } as SampleResponse,
    };
    const result = xyModule.project(xyModule.prepare(input), input, frame);
    expect(result.needsSampleFallback).toBeUndefined();
    expect(result.plot.kind).toBe("paths");
    if (result.plot.kind !== "paths") return;
    // Sample-path geometry: full per-sample vertices, exactly phase 2's.
    expect(result.xyTraces?.[0]?.trace.time).toEqual([0, 1, 2]);
  });

  it("requests the sample fallback when misaligned with no samples", () => {
    const misaligned = columnarTile("run_0001/response", 3, [
      envelopeBin(0, 2, 20, 22),
    ]);
    const input: PrepareInput = {
      ...envelopeInput(),
      tiles: tileResponse([xTile, misaligned]),
    };
    const result = xyModule.project(xyModule.prepare(input), input, frame);
    expect(result.plot.kind).toBe("empty");
    expect(result.needsSampleFallback).toBe(true);
  });

  it("keeps identity across frames on the envelope path", () => {
    const input = envelopeInput();
    const geometry = xyModule.prepare(input);
    const first = xyModule.project(geometry, input, frame);
    const second = xyModule.project(geometry, input, {
      ...frame,
      window: { t0: 1, t1: 2 },
    });
    if (first.plot.kind !== "paths" || second.plot.kind !== "paths") {
      throw new Error("expected paths");
    }
    expect(second.plot.paths[0]?.points).toBe(first.plot.paths[0]?.points);
  });
});
```

Adjust the existing phase-2 xy tests only by adding `contextTiles: null` to their inputs (done in Task 1) — their sample-path expectations must keep passing untouched: with `tiles: null` the module must take the sample path exactly as before.

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/test.sh unit -- src/ui/modes/xy.test.ts`
Expected: the new describe FAILS (envelope path missing); the old tests PASS.

- [ ] **Step 3: Implement in `frontend/src/ui/modes/xy.ts`**

1. Extend imports from `../../app/xy`: `buildTileIndex`, `pairTileTrace`.
2. Extend `XyGeometry`:

```ts
/** True when geometry came from aligned pyramid tiles. */
envelope: boolean;
/** Set when neither tiles nor samples could serve the panel. */
needsSampleFallback: boolean;
```

(`EMPTY` gains `envelope: false, needsSampleFallback: false`.)

3. Restructure `prepare` into three internal functions, keeping the existing body verbatim as `prepareFromSamples`:

```ts
  prepare(input) {
    const fromTiles = prepareFromTiles(input);
    if (fromTiles !== null) return fromTiles;
    if (input.samples !== null) return prepareFromSamples(input);
    if (input.tiles !== null) {
      return { ...EMPTY, needsSampleFallback: true };
    }
    return EMPTY;
  },
```

4. `prepareFromTiles` — null unless every visible pair (and its colour tile) aligns:

```ts
function prepareFromTiles(input: PrepareInput): XyGeometry | null {
  const { state, tiles, contextTiles, callbacks } = input;
  if (tiles === null || contextTiles === null || state.x_signal === null) {
    return null;
  }
  const byPath = new Map(tiles.series.map((tile) => [tile.signalPath, tile]));
  const contextByPath = new Map(
    contextTiles.series.map((tile) => [tile.signalPath, tile]),
  );
  const xTile = byPath.get(state.x_signal);
  if (xTile === undefined) return null;
  const index = buildTileIndex(tiles.series, callbacks);
  const contextIndex = buildTileIndex(contextTiles.series, callbacks);
  const xLocal = callbacks.localPathFor(state.x_signal);
  const cLocal =
    state.color_signal === null
      ? null
      : callbacks.localPathFor(state.color_signal);
  const colorConfigured = state.color_by_time || state.color_signal !== null;
  const entries: XyTraceEntry[] = [];
  const dimmed: number[][] = [];
  const colorColumns: (number[] | null)[] = [];
  for (const series of state.series) {
    if (!series.visible) continue;
    const yTile = byPath.get(series.path);
    const yContext = contextByPath.get(series.path);
    if (yTile === undefined || yContext === undefined) continue;
    const resolveTile = (
      map: ReadonlyMap<string, ColumnarTile>,
      fallback: ColumnarTile,
      local: string | null,
    ): ColumnarTile | undefined => {
      if (local === null) return fallback;
      const sourceKey = callbacks.sourceKeyFor(series.path);
      if (sourceKey === null) return fallback;
      return map.get(seriesIndexKey(sourceKey, local));
    };
    const xPaired = resolveTile(index, xTile, xLocal);
    const xPairedContext = resolveTile(
      contextIndex,
      contextByPath.get(state.x_signal) ?? xTile,
      xLocal,
    );
    if (xPaired === undefined || xPairedContext === undefined) continue;
    const colorTile =
      state.color_signal === null || state.color_by_time
        ? null
        : (resolveTile(
            index,
            byPath.get(state.color_signal) ?? xTile,
            cLocal,
          ) ?? null);
    if (
      state.color_signal !== null &&
      !state.color_by_time &&
      colorTile === null
    ) {
      return null; // colour configured but unresolvable: let samples decide
    }
    const paired = pairTileTrace(xPaired, yTile, colorTile);
    const pairedContext = pairTileTrace(xPairedContext, yContext, null);
    if (paired === null || pairedContext === null) return null;
    entries.push({
      path: series.path,
      colorIndex: colorIndexForHue(series.hue),
      hue: series.hue,
      dash: series.dash,
      width: series.width,
      opacity: series.opacity,
      trace: paired.trace,
    });
    dimmed.push(flattenTrace(pairedContext.trace, null));
    colorColumns.push(
      state.color_by_time ? [...paired.trace.time] : paired.colors,
    );
  }
  if (entries.length === 0) return null;
  // Colour domain scan — identical arithmetic to the sample path.
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
    colorConfigured && Number.isFinite(colorMin) && Number.isFinite(colorMax);
  const colorPadding =
    hasColor && colorMin === colorMax
      ? Math.max(1, Math.abs(colorMin) * 0.05)
      : 0;
  return {
    xSeries: {
      signal_path: state.x_signal,
      unit: xTile.unit,
      time: [],
      values: entries[0]?.trace.x ?? [],
      stride: 1,
    } as SampleSeries,
    entries,
    dimmed,
    colorColumns,
    colorDomain: hasColor
      ? { min: colorMin - colorPadding, max: colorMax + colorPadding }
      : null,
    colorLabelUnit: null,
    hadColorSeries: colorConfigured,
    yUnits: state.series
      .filter((series) => series.visible)
      .map((series) => byPath.get(series.path)?.unit ?? null),
    envelope: true,
    needsSampleFallback: false,
  };
}
```

Three verification points against the phase-2 code before committing:

- `prepareXyPlot`'s `x.values` input: check what `project` passes (`geometry.xSeries.values`) and what `prepareXyPlot` uses it for (`frontend/src/app/plot-capabilities.ts:142-150`, autoRanges/hit). The synthesized `xSeries` above feeds it the lit x vertices — if `prepareXyPlot` needs per-sample x for anything the trace does not carry, route the trace's x column instead and note it.
- `colorLabelUnit`: the envelope path sets null (tile `unit` for the colour signal is available via the colour tile — use `colorTile?.unit ?? null` from the first entry instead if the existing colorbar label test exercises it; check `xy.test.ts`'s colorbar expectations).
- The dimmed underlay's stroke count doubles as before (one dimmed + one lit per entry) — `project` is untouched, so this holds by construction.

5. In `project`, thread the fallback flag: at the top, `if (geometry.needsSampleFallback) return { plot: { kind: "empty" }, prepared: null, xyTraces: [], needsSampleFallback: true };`

- [ ] **Step 4: Run the suites**

Run: `./scripts/test.sh unit -- src/ui/modes/xy.test.ts src/app/xy.test.ts src/ui/panel.test.ts`
Expected: PASS — new envelope tests and every phase-2 sample-path test.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/modes/xy.ts frontend/src/ui/modes/xy.test.ts
git commit -m "feat(xy): prepare trajectories from aligned pyramid tiles"
```

---

### Task 4: Shell acquisition — context tiles, sticky fallback, plumbing

The shell now serves XY through the envelope branch: the visible tile query it already runs for time panels (same `TileWindowCache` machinery, same budget), plus a coarse full-extent context tile query cached window-independently, plus the sticky per-panel sample fallback driven by the module's signal.

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`refreshTilesPass`, new fields, `renderTiles`, fallback callback)
- Modify: `frontend/src/ui/workspace-view.ts` (`renderData` forwards context tiles)
- Modify: `frontend/src/ui/panel.ts` (`renderData` signature, `RenderInputs`, `renderViaModule` passes `contextTiles`, fallback callback on `PanelCallbacks`)
- Test: `frontend/src/ui/panel.test.ts` (guard predicate), `frontend/src/ui/app-shell.test.ts` (fallback stickiness probe)

**Interfaces:**

- Produces:
  - `PanelCallbacks` gains `onSampleFallback(id: string): void`.
  - `PanelView.renderData(state, tiles, samples, window, missing = [], revision = null, contextTiles = null)` — one more trailing parameter; `RenderInputs`/`sameRenderInputs` gain `contextTiles` identity.
  - In `AppShell`: `private readonly contextTileCache = new TileWindowCache();`, `private xySampleFallback = new Map<string, string>();` (panelId → idsKey it was proven on), `private contextTilesByPanel = new Map<string, ColumnarTileResponse>();`, and `const CONTEXT_PIXEL_WIDTH = 512;` (module-level).

- [ ] **Step 1: Extend the dirty-guard predicate test**

In `panel.test.ts`'s `sameRenderInputs` describe (phase 1), add:

```ts
it("re-renders when the context tiles change", () => {
  const other = { requestId: "c", series: [] } as ColumnarTileResponse;
  expect(
    sameRenderInputs(
      { ...base, contextTiles: null },
      { ...base, contextTiles: other },
    ),
  ).toBe(false);
  expect(
    sameRenderInputs(
      { ...base, contextTiles: other },
      { ...base, contextTiles: other },
    ),
  ).toBe(true);
});
```

and add `contextTiles: null` to the `base` fixture. Run `./scripts/test.sh unit -- src/ui/panel.test.ts` — FAIL (field unknown).

- [ ] **Step 2: Implement the panel/workspace plumbing**

1. `RenderInputs` gains `contextTiles: ColumnarTileResponse | null;`; `sameRenderInputs` adds `next.contextTiles === last.contextTiles &&` alongside the tiles comparison.
2. `PanelView` gains `private lastContextTiles: ColumnarTileResponse | null = null;`; `renderData` gains trailing `contextTiles: ColumnarTileResponse | null = null`, includes it in both guard structs, assigns `this.lastContextTiles = contextTiles;`, and passes it into `renderForMode` → `renderViaModule` → the `PrepareInput` literal (replacing Task 1's `contextTiles: null`).
3. `PanelCallbacks` gains `onSampleFallback(id: string): void;` and `renderViaModule` reacts:

```ts
if (result.needsSampleFallback === true) {
  this.callbacks.onSampleFallback(this.id);
}
```

4. `workspace-view.ts` `renderData` gains trailing `contextTilesFor: (panelId: string) => ColumnarTileResponse | null = () => null` and forwards `contextTilesFor(panel.id)` as the seventh argument.

- [ ] **Step 3: Implement the shell acquisition**

In `app-shell.ts`:

1. Module-level: `const CONTEXT_PIXEL_WIDTH = 512;` — coarse enough that a 2001-signal context query costs ~`min(2*512, budget/N)` bins per series, fine enough for a recognizable dimmed silhouette.
2. Fields as listed in Interfaces. Wherever `tileWindowCache.invalidate(...)` is called, mirror `contextTileCache.invalidate(...)` (grep for the sites).
3. The panel callback (where callbacks are constructed, near `localPathFor`):

```ts
        onSampleFallback: (id) => {
          const panel = this.workspace.panel(id);
          if (panel === undefined) return;
          const { ids } = this.panelSignalIds(panel);
          const idsKey = [...ids].sort().join("\u0000");
          if (this.xySampleFallback.get(id) === idsKey) return;
          this.xySampleFallback.set(id, idsKey);
          this.scheduleRefresh(0);
        },
```

4. In `refreshTilesPass`, the envelope branch becomes mode-aware. Replace the branch condition block with:

```ts
          const spec = MODE_DATA[panel.mode];
          const idsKey = [...ids].sort().join("\u0000");
          const fallback =
            spec.reduction === "envelope" &&
            spec.windows.includes("context") &&
            this.xySampleFallback.get(panel.id) === idsKey;
          if (spec.reduction === "envelope" && !fallback) {
```

Inside that branch, after the existing visible-tile fetch, add the context fetch for modes declaring it:

```ts
if (spec.windows.includes("context")) {
  const extent = this.sampleWindow(panel);
  const cachedContext = this.contextTileCache.slice(
    panel.id,
    idsKey,
    CONTEXT_PIXEL_WIDTH,
    extent.t0,
    extent.t1,
  );
  if (cachedContext !== null) {
    nextContextTiles.set(panel.id, cachedContext);
  } else {
    const contextResponse = await this.plane.queryTiles({
      request_id: crypto.randomUUID(),
      signal_ids: ids,
      window: extent,
      pixel_width: CONTEXT_PIXEL_WIDTH,
      max_total_bins: TILE_BIN_BUDGET,
    });
    this.contextTileCache.store(panel.id, {
      response: contextResponse,
      window: extent,
      pixelWidth: CONTEXT_PIXEL_WIDTH,
      idsKey,
    });
    nextContextTiles.set(panel.id, contextResponse);
  }
}
```

(`nextContextTiles` is a new local `Map` alongside `nextTiles`, committed to `this.contextTilesByPanel` next to the others after the token check.)

5. The sample branch's condition becomes `else` (it now also serves envelope panels flagged `fallback` — the `wantsContext` logic from phase 2 keys off `spec.windows.includes("context")`, which is still true for xy, so `fetchXySamples` runs for fallback panels unchanged).
6. `renderTiles` passes `(panelId) => this.contextTilesByPanel.get(panelId) ?? null` as the new argument.
7. `sampleWindow(panel)`'s internal `panel.mode !== "xy"` guard: change to `!MODE_DATA[panel.mode].windows.includes("context")` so it keeps returning the full data extent for xy (it is now called from both branches).

- [ ] **Step 4: Fallback stickiness probe test**

Append to `app-shell.test.ts` (the `Object.create` probe pattern):

```ts
it("the xy sample fallback is sticky per series set and refreshes once", () => {
  const shell = Object.create(AppShell.prototype) as {
    workspace: { panel: (id: string) => unknown };
    panelSignalIds: (panel: unknown) => { ids: string[]; missing: string[] };
    xySampleFallback?: Map<string, string>;
    scheduled: number;
    scheduleRefresh: (delay?: number) => void;
    onSampleFallbackProbe: (id: string) => void;
  };
  shell.xySampleFallback = new Map();
  shell.scheduled = 0;
  shell.scheduleRefresh = () => {
    shell.scheduled += 1;
  };
  shell.workspace = { panel: () => ({ id: "p" }) };
  shell.panelSignalIds = () => ({ ids: ["b", "a"], missing: [] });
  // Bind the real callback body against the probe. Extract the callback
  // body into a private method `markSampleFallback(id: string)` during
  // Step 3 so this test can call it directly:
  AppShell.prototype["markSampleFallback"].call(shell, "p");
  AppShell.prototype["markSampleFallback"].call(shell, "p");
  expect(shell.scheduled).toBe(1);
  expect(shell.xySampleFallback?.get("p")).toBe("a\u0000b");
});
```

This requires Step 3's callback to delegate: `onSampleFallback: (id) => this.markSampleFallback(id)` with the body in `private markSampleFallback(id: string): void`. If the property-access-on-prototype pattern fights the type checker, cast through `as unknown as { markSampleFallback: (id: string) => void }` — match the file's existing probe style.

- [ ] **Step 5: Run the suites**

Run: `./scripts/test.sh unit -- src/ui/app-shell.test.ts src/ui/panel.test.ts src/ui/modes src/app/tile-window-cache.test.ts`
Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/app-shell.ts frontend/src/ui/workspace-view.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts frontend/src/ui/app-shell.test.ts
git commit -m "feat(shell): acquire xy through the tile pipeline with sample fallback"
```

---

### Task 5: Amend ADR 0037

**Files:**

- Modify: `docs/adr/0037-per-mode-sample-budgets.md` (status header + amendment section)

- [ ] **Step 1: Write the amendment**

Read the ADR's current text first. Add an "Amended 2026-08-06" section (house style — check how other amended ADRs in `docs/adr/` mark amendments, e.g. grep for "Amended" or "Superseded"), covering:

- The 2026-08-05 deferral ("extrema-preserving reduction for XY requires a 2D, panel-level reduction over one shared index set") is **superseded**: shared-timebase pairs get index-aligned buckets from the existing per-signal pyramid because `query_with_target` is a pure function of the shared time column and target — no 2D reduction, no bin-layout change, no new endpoint.
- The baseline representation is first/last bucket pairs (exact correspondence — same sample index); marginal min/max stay unused as pairs (bounding-box argument, unchanged from this ADR's original reasoning).
- Cross-timebase pairs remain on stride sampling with interpolation — this ADR's rejection of per-signal min/max on `query_samples` **stands**.
- Client-side alignment verification (level + count + boundary timestamps) with a sticky per-series-set sample fallback; baked snapshots ride the fallback when tiles are unavailable.
- The designed-but-deferred extension: argmin/argmax sample indices in the bin layout for intra-bucket excursion fidelity (spec §"Extension"), gated on the phase-4 bench measurement.

- [ ] **Step 2: Format and commit**

```bash
./scripts/format.sh
git add docs/adr/0037-per-mode-sample-budgets.md
git commit -m "docs(adr): amend 0037 with the pyramid-backed xy baseline"
```

---

### Task 6: Gates, bench, and the mc1000 XY verdict

**Files:** none (verification only)

- [ ] **Step 1: Broad gate**

Run: `./scripts/test.sh quick` — expected PASS.

- [ ] **Step 2: Bench**

Run: `./scripts/test.sh bench` — floors must hold. Compare `e2e_mc1000_modes` against the Task 0 baseline: the XY panel now rides the tile pipeline (binary transport instead of JSON samples, cached context, bucket-pair traces instead of ~124-point strided traces). Record first_plot and frame p95 deltas — this is the number that decides whether the extremum-index extension gets scheduled.

- [ ] **Step 3: Visual and behavioral verification**

In the dev shell with mc1000 corpus data:

1. XY panel `response @*` vs `command`: trajectories render, pan/zoom is smooth, zooming in refines the trajectory (finer pyramid levels), the dimmed full-extent underlay is present and stable across pans, hover markers and the cursor work.
2. Colour channel (`c:` on temperature): colorbar appears, ramp follows the trajectory.
3. Cross-timebase check: build an XY panel pairing signals from two different sources (x from run_0001, y from run_0002 via explicit picks) — it must render via the sample fallback (verify no blank panel; optionally confirm one extra refresh in devtools network/log).
4. Baked snapshot: export a workspace containing the XY panel (`./scripts/export.sh` route from the bench, or the app's export) and open it — the XY panel must render (fallback or tiles, either is acceptable; blank is a failure).
5. Gap behavior: a signal with NaN runs plotted XY must show pen lifts, not bridges.

- [ ] **Step 4: Record the outcome**

Handoff notes: the bench delta table (before/after for the XY panel), which path the baked snapshot took, and the explicit go/no-go recommendation for the extremum-index extension based on whether first/last fidelity visually suffices on the mc1000 trajectories (spec: "gated on whether first/last visually suffices").

---

## Self-review notes (already applied)

- Spec coverage: §"Pyramid-backed XY" baseline maps to Tasks 2 (pairing rules: first/last only, gap-OR pen lifts), 3 (module prepare + fallback), 4 (context query window-independence, cross-source fallback), 5 (ADR amendment), 6 (the mandated re-measurement and the extension gate). The extension itself is documentation-only here (Task 5), per the spec's "designed now, built when fidelity demands".
- The no-Rust-changes claim was verified against `pyramid.rs:431-500` before writing: level selection and bin windows derive from the shared time column and target only, so index alignment is a consequence, not an assumption — and `tilesAligned` still verifies it at runtime because cross-source and mixed-ingest panels exist.
- The fallback doubles as snapshot compatibility: a `BakedPlane` that cannot serve tile queries for level-0-baked XY signals produces misalignment/absence, which routes to the sample path the bake already supports (ADR 0025). Task 6 verifies rather than assumes this.
- Type consistency: `tilesAligned`/`pairTileTrace`/`buildTileIndex` names match between Tasks 2 and 3; `contextTiles`/`needsSampleFallback` between Tasks 1, 3, and 4; `markSampleFallback` is introduced in Task 4 Step 3 and consumed by its Step 4 test.
- Two listings contain explicit verification points instead of certainty (`prepareXyPlot`'s use of `x.values`; `colorLabelUnit` sourcing) because the phase-2 tree this builds on will have evolved — each names the exact file/line to check and the fallback behavior if the check disagrees.

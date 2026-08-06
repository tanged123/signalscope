# Unified Plotting Pipeline — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The density raster tier from `docs/superpowers/specs/2026-08-06-unified-renderer-design.md` §"Density policy and the raster tier" — when the tile budget starves per-series resolution, envelope panels switch from per-series strokes to an aggregate coverage field, fixing the measured 9 px comb artifact on 1000-series ghost panels.

**Architecture:** A pure density policy (`bins-per-device-pixel`, derived from `TILE_BIN_BUDGET / N` vs the device plot width) gates a new render-stage representation inside `CanvasRenderer.render()`. Ghost-styled, non-emphasized series accumulate into a `Float32Array` coverage grid as _connected_ envelope trapezoids (never isolated columns — that is what combs), coverage maps to pixels with the physically-correct alpha law `1 − (1 − a_pt)^k`, and the tile blits under the stroked series via an offscreen canvas so grid and focused lines survive. Everything is pure and deterministic except one injectable canvas factory. The renderer's public API is unchanged; `renderPaths` (XY/FFT/histogram) is untouched this phase.

**Tech Stack:** TypeScript (strict), vitest (jsdom), Canvas2D only, no new dependencies.

## Global Constraints

- **Prerequisite: phases 1 and 2 must be fully landed.** Task 0 verifies. This plan touches `CanvasRenderer.render()`, which phase 1 modified (device-pixel snap, full-style batching) — re-locate code by the quoted snippets.
- This phase intentionally changes what starved panels look like (comb → smooth density field). That is the ONLY permitted visual change: unstarved panels (`densityMode === "strokes"`) must render pixel-identically, and the bench floors must hold.
- Budgets stay at their current values; Task 1 moves `TILE_BIN_BUDGET` to a shared module but must not change it (`250_000`).
- The raster must stay deterministic from response + viewport + palette: fixed alpha law, no randomness, no time. Snapshot (`BakedPlane`) compatibility requires nothing beyond `document.createElement("canvas")`, which the baked frontend already uses for PNG export.
- Run everything through the `./scripts/` wrappers; `./scripts/format.sh` before every commit; stage only listed files; one commit per task.
- Never modify `refs/`, `frontend/src/generated/`.

---

### Task 0: Verify prerequisites and capture the pre-change baseline

**Files:** none

- [ ] **Step 1: Verify phases 1 and 2 landed**

```bash
grep -n "export function plotModeModule" frontend/src/ui/modes/index.ts
grep -n "private pixelRatio" frontend/src/render/canvas-renderer.ts
grep -n "String(style.alpha)" frontend/src/render/canvas-renderer.ts
```

Expected: all three match (registry from phase 2; DPR field and full-style batch key from phase 1). If not, STOP.

- [ ] **Step 2: Green tree and baseline**

Run: `./scripts/test.sh quick` — expected PASS.
Run: `./scripts/test.sh bench`, then `cp build/bench/report.json build/bench/report-phase2-baseline.json`. The `e2e_mc1000` numbers here are the comparison target: its ensemble panel is exactly the 1000-ghost starved case this phase changes.

---

### Task 1: Move `TILE_BIN_BUDGET` to a shared budgets module

The density policy needs the tile budget, and the renderer must not import from `ui/`. Move the constant to `frontend/src/app/budgets.ts`; `app-shell.ts` re-imports it. Pure move.

**Files:**

- Create: `frontend/src/app/budgets.ts`
- Modify: `frontend/src/ui/app-shell.ts` (delete the local `const TILE_BIN_BUDGET`, import instead)
- Test: `frontend/src/app/budgets.test.ts`

**Interfaces:**

- Produces: `export const TILE_BIN_BUDGET = 250_000;` — consumed by `app-shell.ts` (requests) and Task 2 (policy).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/budgets.test.ts`:

```ts
import { expect, test } from "vitest";
import { TILE_BIN_BUDGET } from "./budgets";

test("the tile bin budget is the value ADR 0036 sized transports around", () => {
  expect(TILE_BIN_BUDGET).toBe(250_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit -- src/app/budgets.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `frontend/src/app/budgets.ts`:

```ts
/**
 * Total envelope bins a panel may request per tile query (ADR 0036). Split
 * across series by the host with a 64-bin floor; the density policy
 * (render/density-policy.ts) derives the stroke-vs-raster switch from the
 * same number so the two can never disagree.
 */
export const TILE_BIN_BUDGET = 250_000;
```

In `frontend/src/ui/app-shell.ts`, delete `const TILE_BIN_BUDGET = 250_000;` (~line 129) and add `TILE_BIN_BUDGET` to an import from `../app/budgets`.

- [ ] **Step 4: Run the suites**

Run: `./scripts/test.sh unit -- src/app/budgets.test.ts src/ui/app-shell.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/budgets.ts frontend/src/app/budgets.test.ts frontend/src/ui/app-shell.ts
git commit -m "refactor(app): move the tile bin budget to a shared module"
```

---

### Task 2: The density policy

One pure function deciding strokes vs raster, from series count and device plot width — the spec's rule: raster when the per-series allocation `max(64, TILE_BIN_BUDGET / N)` drops below one bin per two device pixels (`deviceWidth / 2`). Inputs change stepwise (series membership, panel resize), never per frame, which is the hysteresis argument.

**Files:**

- Create: `frontend/src/render/density-policy.ts`
- Test: `frontend/src/render/density-policy.test.ts`

**Interfaces:**

- Consumes: `TILE_BIN_BUDGET` (Task 1).
- Produces: `export function densityMode(seriesCount: number, plotWidthDevice: number): "strokes" | "raster"` — consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/render/density-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { densityMode } from "./density-policy";

describe("densityMode", () => {
  // 250_000 / N vs deviceWidth / 2. At deviceWidth 2956 (1478 CSS × 2 DPR)
  // the boundary sits at N = 250_000 / 1478 ≈ 169.
  it("strokes while the per-series allocation holds a bin per 2 device px", () => {
    expect(densityMode(1, 2956)).toBe("strokes");
    expect(densityMode(100, 2956)).toBe("strokes");
    expect(densityMode(169, 2956)).toBe("strokes");
  });

  it("switches to the raster once the budget starves resolution", () => {
    expect(densityMode(170, 2956)).toBe("raster");
    expect(densityMode(1000, 2956)).toBe("raster");
  });

  it("scales the boundary with panel width", () => {
    // Narrow panel: allocation 250 for N=1000 is >= 400/2, so strokes.
    expect(densityMode(1000, 400)).toBe("strokes");
    expect(densityMode(1000, 600)).toBe("raster");
  });

  it("the 64-bin floor keeps huge panels in raster, and degenerate inputs stroke", () => {
    expect(densityMode(10_000, 2956)).toBe("raster");
    expect(densityMode(0, 2956)).toBe("strokes");
    expect(densityMode(10, 0)).toBe("strokes");
  });
});
```

Before finalizing the boundary numbers, recompute them from the implementation below by hand: `floor(250_000 / 169) = 1479 >= 1478` (strokes), `floor(250_000 / 170) = 1470 < 1478` (raster); for width 400: `max(64, 250) = 250 >= 200` (strokes); width 600: `250 < 300` (raster). If your arithmetic disagrees, fix the test numbers, not the rule.

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit -- src/render/density-policy.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `frontend/src/render/density-policy.ts`**

```ts
import { TILE_BIN_BUDGET } from "../app/budgets";

/**
 * Stroke-vs-raster decision for envelope panels (spec §"Density policy").
 *
 * The tile host splits TILE_BIN_BUDGET across series with a 64-bin floor
 * (shell/src-tauri/src/lib.rs and app/data-plane.ts), so the per-series
 * allocation is what the renderer will actually receive. Below one bin per
 * two device pixels the envelope teeth separate into a comb; at that point
 * per-series strokes stop being a faithful representation and the panel
 * switches to the aggregate coverage raster. Inputs move stepwise (series
 * membership, resize) — never per frame — so the switch cannot flicker
 * during interaction.
 */
export function densityMode(
  seriesCount: number,
  plotWidthDevice: number,
): "strokes" | "raster" {
  if (seriesCount <= 0 || plotWidthDevice <= 0) return "strokes";
  const allocation = Math.max(64, Math.floor(TILE_BIN_BUDGET / seriesCount));
  return allocation >= plotWidthDevice / 2 ? "strokes" : "raster";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `./scripts/test.sh unit -- src/render/density-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/density-policy.ts frontend/src/render/density-policy.test.ts
git commit -m "feat(render): derive the stroke-vs-raster switch from the bin budget"
```

---

### Task 3: The coverage raster core

Two pure functions plus a colour parser, fully unit-testable with no canvas:

- `accumulateEnvelope` — rasterizes one series' envelope bins into a device-pixel coverage grid as **connected trapezoids** between consecutive bins' `[min, max]`, interpolating column by column. Gaps (`HAS_GAP` or missing extrema) break the connection exactly like the stroke path lifts the pen; a bin after a break contributes its own single column.
- `coverageToImage` — maps coverage k to RGBA with the physical compositing law `alpha = 1 − (1 − pointAlpha)^k`: the alpha k overlapping translucent strokes would actually composite to. Straight (non-premultiplied) alpha; the offscreen `drawImage` blend in Task 4 does the compositing, so cells with zero coverage stay fully transparent and the grid shows through.

**Files:**

- Create: `frontend/src/render/density-raster.ts`
- Test: `frontend/src/render/density-raster.test.ts`

**Interfaces:**

- Consumes: `BinColumns`, `HAS_FIRST`/`HAS_LAST`/`HAS_MIN`/`HAS_MAX`/`HAS_GAP` (`frontend/src/app/bin-columns.ts`).
- Produces (all exported):
  - `interface DensityGrid { coverage: Float32Array; width: number; height: number }`
  - `function accumulateEnvelope(grid: DensityGrid, bins: BinColumns, toColumn: (t: number) => number, toRow: (v: number) => number): void` — `toColumn`/`toRow` map data values to _device-pixel_ grid coordinates (the caller bakes plot offset and DPR into them, keeping this function projection-agnostic and testable with identity transforms).
  - `function coverageToImage(grid: DensityGrid, color: string, pointAlpha: number): Uint8ClampedArray` — RGBA, length `width * height * 4`.
  - `function parseHexColor(color: string): { r: number; g: number; b: number }` — `#rgb` and `#rrggbb`; anything else returns neutral grey `{ r: 128, g: 128, b: 128 }`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/render/density-raster.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { binColumnsFromWire } from "../app/bin-columns";
import {
  accumulateEnvelope,
  coverageToImage,
  parseHexColor,
  type DensityGrid,
} from "./density-raster";

function bin(
  t0: number,
  t1: number,
  min: number,
  max: number,
  hasGap = false,
): EnvelopeBin {
  return {
    t0,
    t1,
    first: min,
    last: max,
    min,
    max,
    sum: min + max,
    sum_sq: min * min + max * max,
    finite_count: "2",
    sample_count: "2",
    has_gap: hasGap,
  };
}

function grid(width: number, height: number): DensityGrid {
  return { coverage: new Float32Array(width * height), width, height };
}

function at(g: DensityGrid, x: number, y: number): number {
  return g.coverage[y * g.width + x] ?? Number.NaN;
}

// Identity-ish transforms: bin midpoints land on columns, values on rows.
const toColumn = (t: number) => t;
const toRow = (v: number) => v;

describe("accumulateEnvelope", () => {
  it("fills the vertical span of an isolated bin", () => {
    const g = grid(8, 8);
    accumulateEnvelope(
      g,
      binColumnsFromWire([bin(1.5, 2.5, 2, 5)]),
      toColumn,
      toRow,
    );
    // Midpoint t=2 -> column 2; rows 2..5 covered once.
    expect(at(g, 2, 1)).toBe(0);
    expect(at(g, 2, 2)).toBe(1);
    expect(at(g, 2, 5)).toBe(1);
    expect(at(g, 2, 6)).toBe(0);
    expect(at(g, 1, 3)).toBe(0);
  });

  it("connects consecutive bins as an interpolated band, not teeth", () => {
    const g = grid(8, 8);
    // Midpoints at columns 1 and 5; min/max ramp 2..4 -> 4..6.
    accumulateEnvelope(
      g,
      binColumnsFromWire([bin(0.5, 1.5, 2, 4), bin(4.5, 5.5, 4, 6)]),
      toColumn,
      toRow,
    );
    // Halfway column 3 covers the lerped band rows 3..5.
    expect(at(g, 3, 2)).toBe(0);
    expect(at(g, 3, 3)).toBe(1);
    expect(at(g, 3, 5)).toBe(1);
    expect(at(g, 3, 6)).toBe(0);
    // No cell counted twice within one series.
    for (const value of g.coverage)
      expect(value === 0 || value === 1).toBe(true);
  });

  it("a gap breaks the band exactly like a pen lift", () => {
    const g = grid(10, 8);
    accumulateEnvelope(
      g,
      binColumnsFromWire([bin(0.5, 1.5, 2, 4), bin(6.5, 7.5, 2, 4, true)]),
      toColumn,
      toRow,
    );
    // Columns strictly between the two midpoints stay empty.
    for (let x = 2; x <= 6; x += 1) {
      for (let y = 0; y < 8; y += 1) expect(at(g, x, y)).toBe(0);
    }
    // The gap bin still draws its own column.
    expect(at(g, 7, 3)).toBe(1);
  });

  it("two series accumulate", () => {
    const g = grid(8, 8);
    const columns = binColumnsFromWire([bin(1.5, 2.5, 2, 5)]);
    accumulateEnvelope(g, columns, toColumn, toRow);
    accumulateEnvelope(g, columns, toColumn, toRow);
    expect(at(g, 2, 3)).toBe(2);
  });

  it("clamps out-of-grid geometry instead of writing out of bounds", () => {
    const g = grid(4, 4);
    accumulateEnvelope(
      g,
      binColumnsFromWire([bin(-10, -9, -5, 20), bin(20, 21, -5, 20)]),
      toColumn,
      toRow,
    );
    expect(g.coverage.some((value) => Number.isNaN(value))).toBe(false);
  });
});

describe("coverageToImage", () => {
  it("applies the physical compositing law", () => {
    const g = grid(2, 1);
    g.coverage[0] = 1;
    g.coverage[1] = 2;
    const pixels = coverageToImage(g, "#ffffff", 0.5);
    // k=1 -> alpha 0.5; k=2 -> 1 - 0.25 = 0.75.
    expect(pixels[3]).toBe(Math.round(0.5 * 255));
    expect(pixels[7]).toBe(Math.round(0.75 * 255));
    expect(pixels[0]).toBe(255);
  });

  it("zero coverage stays fully transparent", () => {
    const pixels = coverageToImage(grid(1, 1), "#ffffff", 0.5);
    expect(pixels[3]).toBe(0);
  });
});

describe("parseHexColor", () => {
  it("parses long and short hex, falls back to grey", () => {
    expect(parseHexColor("#4d5563")).toEqual({ r: 0x4d, g: 0x55, b: 0x63 });
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("rgb(1,2,3)")).toEqual({ r: 128, g: 128, b: 128 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/test.sh unit -- src/render/density-raster.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `frontend/src/render/density-raster.ts`**

```ts
import {
  HAS_FIRST,
  HAS_GAP,
  HAS_LAST,
  HAS_MAX,
  HAS_MIN,
  type BinColumns,
} from "../app/bin-columns";

const EXTREMA = HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX;

export interface DensityGrid {
  coverage: Float32Array;
  width: number;
  height: number;
}

/**
 * Rasterizes one series' envelope into the coverage grid as connected
 * trapezoids between consecutive bins' [min, max] spans. Isolated columns
 * are exactly the comb artifact this tier exists to remove, so bins connect
 * whenever the stroke path would connect them, and break where it lifts the
 * pen: a gap flag or missing extrema. Each cell receives at most +1 per
 * series — a bin's own column is filled when it starts a run, and the
 * trapezoid to a successor covers (previous, current], so seams never
 * double-count.
 */
export function accumulateEnvelope(
  grid: DensityGrid,
  bins: BinColumns,
  toColumn: (t: number) => number,
  toRow: (value: number) => number,
): void {
  const { coverage, width, height } = grid;
  const { t0, t1, min, max, flags, count } = bins;
  const fillColumn = (x: number, rowA: number, rowB: number): void => {
    const column = Math.round(x);
    if (column < 0 || column >= width) return;
    const top = Math.max(0, Math.floor(Math.min(rowA, rowB)));
    const bottom = Math.min(height - 1, Math.ceil(Math.max(rowA, rowB)));
    for (let row = top; row <= bottom; row += 1) {
      coverage[row * width + column] += 1;
    }
  };
  let previous: { x: number; lo: number; hi: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const binFlags = flags[index] as number;
    if ((binFlags & EXTREMA) !== EXTREMA) {
      previous = null;
      continue;
    }
    const x = toColumn(((t0[index] as number) + (t1[index] as number)) * 0.5);
    const lo = toRow(min[index] as number);
    const hi = toRow(max[index] as number);
    const gap = (binFlags & HAS_GAP) !== 0;
    if (previous === null || gap || x <= previous.x) {
      fillColumn(x, lo, hi);
    } else {
      // The previous bin's column is already covered; fill (previous, x].
      const from = Math.max(0, Math.round(previous.x) + 1);
      const to = Math.min(width - 1, Math.round(x));
      const span = x - previous.x;
      for (let column = from; column <= to; column += 1) {
        const t = Math.min(1, Math.max(0, (column - previous.x) / span));
        const bandLo = previous.lo + (lo - previous.lo) * t;
        const bandHi = previous.hi + (hi - previous.hi) * t;
        fillColumn(column, bandLo, bandHi);
      }
    }
    previous = gap ? null : { x, lo, hi };
  }
}

/** `#rgb` / `#rrggbb`; anything else falls back to neutral grey. */
export function parseHexColor(color: string): {
  r: number;
  g: number;
  b: number;
} {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex === undefined) return { r: 128, g: 128, b: 128 };
  if (hex.length === 3) {
    return {
      r: parseInt((hex[0] ?? "0") + (hex[0] ?? "0"), 16),
      g: parseInt((hex[1] ?? "0") + (hex[1] ?? "0"), 16),
      b: parseInt((hex[2] ?? "0") + (hex[2] ?? "0"), 16),
    };
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/**
 * Coverage -> straight-alpha RGBA. A cell k series deep composites to the
 * alpha k overlapping translucent strokes would produce:
 * `1 - (1 - pointAlpha)^k`. This is the law xy's field capture validated —
 * a per-window normalized tone curve reads lighter or darker than the very
 * strokes it aggregates. Zero coverage stays transparent so grid lines and
 * background show through the drawImage blend.
 */
export function coverageToImage(
  grid: DensityGrid,
  color: string,
  pointAlpha: number,
): Uint8ClampedArray {
  const { coverage, width, height } = grid;
  const { r, g, b } = parseHexColor(color);
  const keep = 1 - pointAlpha;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < coverage.length; index += 1) {
    const k = coverage[index] ?? 0;
    if (k <= 0) continue;
    const alpha = 1 - Math.pow(keep, k);
    const offset = index * 4;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = Math.round(alpha * 255);
  }
  return pixels;
}
```

One subtlety to verify while porting: in `accumulateEnvelope`, `toRow` inverts (larger values → smaller row numbers, canvas convention) when the real projection is used — `fillColumn` sorts `rowA`/`rowB`, so the function is orientation-agnostic. The tests use identity transforms on purpose; do not "fix" the sort out.

- [ ] **Step 4: Run them to verify they pass**

Run: `./scripts/test.sh unit -- src/render/density-raster.test.ts`
Expected: PASS. If the seam test fails with a 2 at a boundary column, the `from`/`to` bounds diverged from the listing — a bin's own column is filled once when it starts a run, and the trapezoid to its successor covers `[round(prev.x) + 1, round(x)]`, never re-touching the predecessor's column.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/density-raster.ts frontend/src/render/density-raster.test.ts
git commit -m "feat(render): pure coverage raster for starved envelope panels"
```

---

### Task 4: Renderer integration

Wire the policy and raster into `CanvasRenderer.render()`: when `densityMode` says raster, ghost-styled non-emphasized series accumulate into the grid and blit as one tile _under_ the remaining strokes; hued, focused, and emphasized series stroke exactly as today ("the crowd becomes a field; the signals you're looking at stay lines"). Compositing uses an offscreen canvas + `drawImage` because `beginFrame` draws the grid _before_ data (`canvas-renderer.ts:488`) and raw `putImageData` would erase it. The offscreen canvas comes from an injectable factory so jsdom tests can observe the path; when no canvas is available the renderer falls back to stroking — behavior identical to today.

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`
- Test: `frontend/src/render/canvas-renderer.test.ts`

**Interfaces:**

- Consumes: `densityMode` (Task 2), `accumulateEnvelope`/`coverageToImage`/`DensityGrid` (Task 3).
- Produces:
  - `CanvasRenderer.setCanvasFactory(factory: (width: number, height: number) => HTMLCanvasElement | null): void` — test seam; default uses `document.createElement("canvas")`.
  - Behavioral guarantee: `render()` with `densityMode(...) === "strokes"` is byte-identical to before this task.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/render/canvas-renderer.test.ts`. The recording context needs two additions if absent: a `drawImage(...args)` method pushing `{op: "drawImage", args}` and an `imageSmoothingEnabled` property (plain field is fine). Also ensure a global `ImageData` exists for the test environment:

```ts
if (typeof globalThis.ImageData === "undefined") {
  class TestImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  (globalThis as { ImageData?: unknown }).ImageData = TestImageData;
}

function fakeOffscreen(): {
  putCalls: unknown[][];
  factory: (width: number, height: number) => HTMLCanvasElement;
} {
  const putCalls: unknown[][] = [];
  const factory = (width: number, height: number): HTMLCanvasElement =>
    ({
      width,
      height,
      getContext: () => ({
        putImageData: (...args: unknown[]) => {
          putCalls.push(args);
        },
      }),
    }) as unknown as HTMLCanvasElement;
  return { putCalls, factory };
}

describe("density raster tier", () => {
  function ghostResponse(seriesCount: number) {
    const series = Array.from({ length: seriesCount }, (_, index) =>
      tile(`run_${String(index)}/response`, [
        { t0: 0, t1: 1, v: (index % 5) + 1 },
        { t0: 1, t1: 2, v: (index % 5) + 2 },
      ]),
    );
    const styles: SeriesStroke[] = series.map(() => ({
      hue: null,
      dash: "solid",
      width: 1,
      alpha: 0.5,
    }));
    return { response: { requestId: "r", series }, styles };
  }

  it("rasters ghost series when the budget starves resolution", () => {
    const { calls, context } = recordingContext();
    // 2600 CSS px at DPR 1: N=200 -> allocation 1250 < 1300 -> raster.
    const renderer = new CanvasRenderer(fakeCanvas(2600, 400, context));
    renderer.setPalette(TEST_PALETTE);
    const { putCalls, factory } = fakeOffscreen();
    renderer.setCanvasFactory(factory);
    const { response, styles } = ghostResponse(200);
    renderer.render(
      response,
      { min: 0, max: 2 },
      {
        xLabel: "t",
        yLabel: "v",
        yRange: [0, 8],
        axisStyle: "inline",
        styles,
      },
    );
    expect(putCalls.length).toBe(1);
    const drawImages = calls.filter((call) => call.op === "drawImage");
    expect(drawImages.length).toBe(1);
    const clipIndex = calls.findIndex((call) => call.op === "clip");
    const restoreIndex = calls.findIndex(
      (call, index) => index > clipIndex && call.op === "restore",
    );
    const dataStrokes = calls
      .slice(clipIndex, restoreIndex)
      .filter((call) => call.op === "stroke").length;
    expect(dataStrokes).toBe(0);
  });

  it("emphasized and hued series stroke on top of the raster", () => {
    const { calls, context } = recordingContext();
    const renderer = new CanvasRenderer(fakeCanvas(2600, 400, context));
    renderer.setPalette(TEST_PALETTE);
    const { factory } = fakeOffscreen();
    renderer.setCanvasFactory(factory);
    const { response, styles } = ghostResponse(200);
    styles[0] = { hue: 1, dash: "solid", width: 1.4, alpha: 1 };
    renderer.render(
      response,
      { min: 0, max: 2 },
      {
        xLabel: "t",
        yLabel: "v",
        yRange: [0, 8],
        axisStyle: "inline",
        styles,
        emphasisIndices: [5],
      },
    );
    const clipIndex = calls.findIndex((call) => call.op === "clip");
    const restoreIndex = calls.findIndex(
      (call, index) => index > clipIndex && call.op === "restore",
    );
    const slice = calls.slice(clipIndex, restoreIndex);
    const dataStrokes = slice.filter((call) => call.op === "stroke").length;
    expect(dataStrokes).toBe(2); // the hued series and the emphasized ghost
    // The raster tile lands before any stroke: field under lines.
    const drawIndex = slice.findIndex((call) => call.op === "drawImage");
    const firstStroke = slice.findIndex((call) => call.op === "stroke");
    expect(drawIndex).toBeGreaterThan(-1);
    expect(drawIndex).toBeLessThan(firstStroke);
  });

  it("keeps stroking below the threshold and without a canvas factory", () => {
    const belowThreshold = recordingContext();
    const renderer = new CanvasRenderer(
      fakeCanvas(2600, 400, belowThreshold.context),
    );
    renderer.setPalette(TEST_PALETTE);
    const below = ghostResponse(100); // allocation 2500 >= 1300 -> strokes
    renderer.render(
      below.response,
      { min: 0, max: 2 },
      {
        xLabel: "t",
        yLabel: "v",
        yRange: [0, 8],
        axisStyle: "inline",
        styles: below.styles,
      },
    );
    expect(belowThreshold.calls.some((call) => call.op === "drawImage")).toBe(
      false,
    );

    // Above threshold but no factory (default in jsdom): graceful fallback.
    const noFactory = recordingContext();
    const fallback = new CanvasRenderer(
      fakeCanvas(2600, 400, noFactory.context),
    );
    fallback.setPalette(TEST_PALETTE);
    const above = ghostResponse(200);
    fallback.render(
      above.response,
      { min: 0, max: 2 },
      {
        xLabel: "t",
        yLabel: "v",
        yRange: [0, 8],
        axisStyle: "inline",
        styles: above.styles,
      },
    );
    const strokes = noFactory.calls.filter((call) => call.op === "stroke");
    expect(strokes.length).toBeGreaterThan(0);
  });
});
```

Check the emphasized-stroke count assertion against the batching from phase 1: with only 2 stroked series the `> 128` batch gate is not met for the _stroked subset_ — the stroked subset routes through the per-series path, so 2 strokes is right; if the implementation batches on the full series count instead, revisit the implementation (the raster set must be excluded before the batch-count decision, see Step 3).

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/test.sh unit -- src/render/canvas-renderer.test.ts`
Expected: FAIL — `setCanvasFactory` does not exist.

- [ ] **Step 3: Implement in `frontend/src/render/canvas-renderer.ts`**

1. Imports:

```ts
import { densityMode } from "./density-policy";
import {
  accumulateEnvelope,
  coverageToImage,
  type DensityGrid,
} from "./density-raster";
```

2. Fields and the factory seam (near the other private fields):

```ts
  private densityCanvas: HTMLCanvasElement | null = null;
  private canvasFactory: (
    width: number,
    height: number,
  ) => HTMLCanvasElement | null = (width, height) => {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };

  /** Test seam for the offscreen density surface. */
  setCanvasFactory(
    factory: (width: number, height: number) => HTMLCanvasElement | null,
  ): void {
    this.canvasFactory = factory;
    this.densityCanvas = null;
  }
```

3. The blit method (place after `drawSeries`):

```ts
  /**
   * Accumulates the given series into a device-pixel coverage grid and
   * composites it into the plot rect. Returns false when no offscreen
   * canvas is available (headless tests) — the caller then strokes those
   * series instead, which is the pre-density behavior.
   */
  private drawDensity(
    context: CanvasRenderingContext2D,
    plot: PlotRect,
    project: Projection,
    seriesBins: readonly BinColumns[],
    color: string,
    pointAlpha: number,
  ): boolean {
    const ratio = this.pixelRatio;
    const width = Math.max(1, Math.round(plot.width * ratio));
    const height = Math.max(1, Math.round(plot.height * ratio));
    if (
      this.densityCanvas === null ||
      this.densityCanvas.width !== width ||
      this.densityCanvas.height !== height
    ) {
      this.densityCanvas = this.canvasFactory(width, height);
    }
    const offscreen = this.densityCanvas;
    const offContext = offscreen?.getContext("2d") ?? null;
    if (offscreen === null || offContext === null) return false;
    const grid: DensityGrid = {
      coverage: new Float32Array(width * height),
      width,
      height,
    };
    const toColumn = (t: number): number => (project.toX(t) - plot.x) * ratio;
    const toRow = (value: number): number =>
      (project.toY(value) - plot.y) * ratio;
    for (const bins of seriesBins) {
      accumulateEnvelope(grid, bins, toColumn, toRow);
    }
    offContext.putImageData(
      new ImageData(coverageToImage(grid, color, pointAlpha), width, height),
      0,
      0,
    );
    context.save();
    context.imageSmoothingEnabled = false;
    context.drawImage(offscreen, plot.x, plot.y, plot.width, plot.height);
    context.restore();
    return true;
  }
```

4. In `render()`, immediately after the `hasEmphasis` const and BEFORE the `canBatch` computation, insert the raster split:

```ts
const emphasizedIndex = (index: number): boolean =>
  options.emphasisIndex === index ||
  (options.emphasisIndices?.includes(index) ?? false);
const rasterSet = new Set<number>();
if (
  densityMode(response.series.length, plot.width * this.pixelRatio) === "raster"
) {
  response.series.forEach((_, index) => {
    const stroke = options.styles?.[index];
    if (stroke?.hue === null && !emphasizedIndex(index)) {
      rasterSet.add(index);
    }
  });
  if (rasterSet.size > 1) {
    const ghostStyle = styleFor([...rasterSet][0] as number);
    const drawn = this.drawDensity(
      context,
      plot,
      project,
      [...rasterSet].map(
        (index) => (response.series[index] as ColumnarTile).bins,
      ),
      ghostStyle.color,
      ghostStyle.alpha,
    );
    if (!drawn) rasterSet.clear();
  } else {
    rasterSet.clear();
  }
}
```

5. Exclude the raster set from both stroke paths. In the `canBatch` computation, replace `response.series.length > 128` with `response.series.length - rasterSet.size > 128`; in the batched `forEach` and the per-series `forEach`, add as the first line:

```ts
if (rasterSet.has(index)) return;
```

- [ ] **Step 4: Run the full renderer suite**

Run: `./scripts/test.sh unit -- src/render/canvas-renderer.test.ts src/render/density-policy.test.ts src/render/density-raster.test.ts`
Expected: PASS, including every pre-existing render test (they all run below the threshold or without styles, so `densityMode` returns "strokes" or the ghost filter matches nothing — byte-identical output).

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts
git commit -m "feat(render): raster starved ghost panels as a density field"
```

---

### Task 5: ADR 0038

The spec requires the architectural change to carry an ADR: the unified mode pipeline (phase 2) plus the density raster tier (this phase) amend the rendering story of ADR 0036.

**Files:**

- Create: `docs/adr/0038-unified-mode-pipeline-and-density-tier.md`

- [ ] **Step 1: Confirm the number**

Run: `ls docs/adr/ | tail -3` — if a 0038 already exists, use the next free number and adjust the filename/title below.

- [ ] **Step 2: Write the ADR**

Follow the structure of `docs/adr/0037-per-mode-sample-budgets.md` (read it first for the house format: Status/Context/Decision/Consequences). Content requirements — cover each of these, in the house style, citing the spec `docs/superpowers/specs/2026-08-06-unified-renderer-design.md` as the design source:

- **Status:** accepted. **Amends:** ADR 0036's render-path section; does not change the wire format.
- **Decision 1 — mode modules:** every plot mode implements `{ data, configKey, prepare, project }` (`frontend/src/ui/modes/`); the shell acquires from declared `ModeDataSpec`; prepare is response-scoped and framework-cached; project is the only per-frame mode code; the renderer stays mode-blind with its two entry points.
- **Decision 2 — density tier:** envelope panels switch from per-series strokes to an aggregate coverage raster when `max(64, TILE_BIN_BUDGET / N) < deviceWidth / 2`; connected-trapezoid accumulation; `1 − (1 − a_pt)^k` compositing; ghost-styled non-emphasized series only; offscreen-canvas blit under the strokes; deterministic and snapshot-safe.
- **Consequences:** the comb artifact class is closed (cite the 2026-08-06 pixel-level measurement: 157 bins over 1415 px, 9 px pitch); a fifth mode is one module + registry entry; per-series hit-testing is unchanged (raster is display-only); the raster is Canvas2D CPU work bounded by plot area, and a future GPU backend replaces the blit without upstream changes.
- **Rejected:** scaling the budget with N (wire and stroke cost grow linearly, mud persists); marginal bounding-box rendering for starved envelopes (draws area the data never visited — same reasoning ADR 0037 applied to XY).

- [ ] **Step 3: Format and commit**

```bash
./scripts/format.sh
git add docs/adr/0038-unified-mode-pipeline-and-density-tier.md
git commit -m "docs(adr): record the mode pipeline and density tier decisions"
```

---

### Task 6: Gates, bench, and the visual check that closes the comb

**Files:** none (verification only)

- [ ] **Step 1: Broad gate**

Run: `./scripts/test.sh quick`
Expected: PASS.

- [ ] **Step 2: Bench**

Run: `./scripts/test.sh bench`
Expected: PASS with floors held. Compare against `build/bench/report-phase2-baseline.json`:

- `e2e_mc1000` — its ensemble panel (1000 ghost series) now takes the raster path. `frame_p95_ms` and `first_plot_ms` must not regress; they will likely improve (one blit replaces up to 1000 ghost strokes). Record the deltas.
- `e2e_mc1000_modes` — re-record; its time panel crosses the threshold too.

- [ ] **Step 3: Visual verification of the fix**

Load the mc1000 corpus in the dev shell (`./scripts/dev.sh`, open the bench workspace or drop `build/bench/corpus/mc1000` files) and reproduce the original screenshot's panel: `temperature @*`, 1000 sources, ghost mode, window 0→1000 s. Expected:

- The 9 px vertical comb is gone — the ghost crowd reads as a smooth grey density band, denser where more runs overlap.
- The focused (hued) series still draws as a crisp line on top; hovering a ghost emphasizes it as a line.
- Pan/zoom shows no representation flashing; shrinking the panel below the threshold width switches to strokes without artifacts (and back).
- FFT/histogram/XY panels are pixel-identical to phase 2 (this phase never touches `renderPaths`).

Take a screenshot for the PR next to `Screenshot 2026-08-04 222253.png`.

- [ ] **Step 4: Record the outcome**

Handoff notes must include: the bench delta table, the before/after screenshots, and confirmation that the threshold arithmetic observed in the wild matches `densityMode` (series count at which the panel you resized flipped).

---

## Self-review notes (already applied)

- Spec coverage: §"Density policy and the raster tier" maps to Tasks 2 (policy variable + hysteresis argument), 3 (connected trapezoids, physical alpha law, gap rule), 4 (focused/emphasized stroke on top, hit-testing untouched, wire cost untouched), 6 (threshold-crossing behavior verified). The spec's "log-scaled" phrase describes xy's _wire encoding_ of density counts; display compositing uses the physical law directly, which is what xy's own field capture validated — recorded in the ADR wording.
- The grid-erasure hazard was checked against source: `drawGrid` runs in `beginFrame` (`canvas-renderer.ts:488`) before data, so Task 4 composites via offscreen `drawImage` (precedent: `png-export.ts:51-63`) instead of direct `putImageData`.
- Determinism: the only impure seam is the canvas factory; its absence degrades to the exact pre-phase-3 stroke path, never to different geometry.
- Type consistency: `DensityGrid`/`accumulateEnvelope`/`coverageToImage` names match between Tasks 3 and 4; `densityMode` between 2 and 4; `TILE_BIN_BUDGET` between 1 and 2.
- Deferred by design: density for `renderPaths` (XY spaghetti) belongs to the pyramid-XY phase; per-ramp-colored rasters and GPU textures stay deferred per the spec's non-goals.

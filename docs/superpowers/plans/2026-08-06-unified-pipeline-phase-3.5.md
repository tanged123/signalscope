# Unified Plotting Pipeline — Phase 3.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phase-3 density tier actually legible, per the spec amendment `docs/superpowers/specs/2026-08-06-unified-renderer-design.md` §"Amendment (2026-08-06…)": replace the saturating physical alpha law with a log-normalized tone map, give stroked series in raster regime their own full-resolution tile request (kills the remaining comb on focused/hued/hovered lines), and cut the raster accumulation from ~229 ms to low single digits with difference-mark accumulation.

**Architecture:** Three independent corrections. (1) `density-raster.ts` accumulates `+1/−1` span marks and a new `resolveCoverage` prefix-sum resolves them once per frame; `coverageToImage` maps coverage through `alpha(k) = 0.1 + 0.8·ln(1+k)/ln(1+kRef)` with `kRef = 2^ceil(log2(kMax))`. (2) `CanvasRenderer.drawDensity` calls the resolve and drops the point-alpha argument. (3) `app-shell.ts` issues a second tile query for the stroked set (focused + hued + hover-emphasized, ≤ 32 series) when `densityMode` says raster, merging by signal id; a new optional `onEmphasize` panel callback feeds the hover set, debounced through `scheduleRefresh(100)`.

**Tech Stack:** TypeScript (strict), vitest (jsdom), no new dependencies, no protocol changes.

## Global Constraints

- **Prerequisite: phases 1–3 landed** (Task 0 verifies). This plan edits `frontend/src/render/density-raster.ts` and `canvas-renderer.ts` exactly as phase 3 + commit `e9c7954` left them.
- **Permitted visual change:** raster-regime panels only — the density field gains gradation, and stroked series in those panels gain resolution. Panels where `densityMode(...) === "strokes"` must render byte-identically to phase 3.
- Budgets unchanged: the crowd tile request is untouched; the hi-res request adds at most `32 × pixel_width` bins and reuses `TILE_BIN_BUDGET` as its `max_total_bins` (the host caps per-series bins at the pixel width, so a small set gets full resolution without exceeding the budget).
- **The phase-2 configKey rule does not bite here** — the renderer is stateless per frame — but the shell's new merge must be identity-memoized so `renderData`'s tile-identity guard keeps working: same crowd + same hi-res objects must yield the same merged object.
- Run everything through `./scripts/` wrappers; `./scripts/format.sh` before every commit; stage only listed files; one commit per task. Never modify `refs/`, `frontend/src/generated/`.
- Line numbers drift — re-locate by the quoted code.

---

### Task 0: Verify prerequisites and capture the phase-3 baseline

**Files:** none

- [ ] **Step 1: Verify phase 3 (with the review fix) landed**

```bash
grep -n "setCanvasFactory" frontend/src/render/canvas-renderer.ts
grep -n "Uint8ClampedArray<ArrayBuffer>" frontend/src/render/density-raster.ts
grep -n "export function densityMode" frontend/src/render/density-policy.ts
```

Expected: all three match. If the second is missing, STOP — commit `e9c7954` has not landed.

- [ ] **Step 2: Green tree and baseline**

Run: `./scripts/test.sh quick` — expected PASS.
Then: `cp build/bench/report.json build/bench/report-phase3-baseline.json`.

---

### Task 1: Difference-mark accumulation and the log tone map

**Files:**

- Modify: `frontend/src/render/density-raster.ts`
- Test: `frontend/src/render/density-raster.test.ts`

**Interfaces:**

- Produces (consumed by Task 2):
  - `accumulateEnvelope` — same signature, but the grid now holds difference marks until resolved.
  - `export function resolveCoverage(grid: DensityGrid): void` — one prefix-sum pass; call once after all series.
  - `export function coverageToImage(grid: DensityGrid, color: string): Uint8ClampedArray<ArrayBuffer>` — the `pointAlpha` parameter is REMOVED.
  - `export const DENSITY_ALPHA_FLOOR = 0.1;` and `export const DENSITY_ALPHA_MAX = 0.9;`

- [ ] **Step 1: Update the tests to the new contract**

In `frontend/src/render/density-raster.test.ts`:

1. Add `resolveCoverage` to the import from `./density-raster`.
2. In EVERY existing `accumulateEnvelope` test, insert `resolveCoverage(g);` after the last `accumulateEnvelope(...)` call and before the first assertion (the assertions themselves stay unchanged — the resolved grid must hold exactly the coverage the old direct fill produced).
3. Replace the whole `describe("coverageToImage", ...)` block with:

```ts
describe("coverageToImage", () => {
  it("applies the log-normalized tone map", () => {
    const g = grid(3, 1);
    g.coverage[0] = 1;
    g.coverage[1] = 4;
    g.coverage[2] = 0;
    const pixels = coverageToImage(g, "#ffffff");
    // kMax 4 -> kRef 4; alpha(k) = 0.1 + 0.8 * ln(1 + k) / ln(5).
    const alpha = (k: number) => 0.1 + (0.8 * Math.log(1 + k)) / Math.log(5);
    expect(pixels[3]).toBe(Math.round(alpha(1) * 255));
    expect(pixels[7]).toBe(Math.round(alpha(4) * 255));
    expect(pixels[11]).toBe(0);
    expect(pixels[0]).toBe(255);
  });

  it("caps the densest cell at the exposure maximum", () => {
    const g = grid(1, 1);
    g.coverage[0] = 8; // kRef 8: this cell is the reference.
    expect(coverageToImage(g, "#fff")[3]).toBe(Math.round(0.9 * 255));
  });

  it("keeps lone outliers visible under a dense core", () => {
    const g = grid(2, 1);
    g.coverage[0] = 1;
    g.coverage[1] = 1000; // kRef 1024
    const pixels = coverageToImage(g, "#fff");
    const expected = 0.1 + (0.8 * Math.log(2)) / Math.log(1025); // ≈ 0.180
    expect(pixels[3]).toBe(Math.round(expected * 255));
    expect(pixels[3] as number).toBeGreaterThan(25); // never invisible
  });

  it("an empty grid stays fully transparent", () => {
    expect(coverageToImage(grid(1, 1), "#fff")[3]).toBe(0);
  });
});
```

4. Add one new test to the `accumulateEnvelope` describe, pinning the mark representation:

```ts
it("holds difference marks until resolveCoverage runs", () => {
  const g = grid(8, 8);
  accumulateEnvelope(
    g,
    binColumnsFromWire([bin(1.5, 2.5, 2, 5)]),
    toColumn,
    toRow,
  );
  // Unresolved: +1 at the band top, -1 below the band bottom.
  expect(at(g, 2, 2)).toBe(1);
  expect(at(g, 2, 6)).toBe(-1);
  expect(at(g, 2, 4)).toBe(0);
  resolveCoverage(g);
  expect(at(g, 2, 4)).toBe(1);
  expect(at(g, 2, 6)).toBe(0);
});
```

- [ ] **Step 2: Run to verify the new expectations fail**

Run: `./scripts/test.sh unit -- src/render/density-raster.test.ts`
Expected: FAIL — `resolveCoverage` does not exist; `coverageToImage` still takes three arguments.

- [ ] **Step 3: Implement in `frontend/src/render/density-raster.ts`**

1. Replace the `fillColumn` closure inside `accumulateEnvelope` with the mark writer (everything else in the function stays as-is):

```ts
const fillColumn = (x: number, rowA: number, rowB: number): void => {
  const column = Math.round(x);
  if (column < 0 || column >= width) return;
  const top = Math.max(0, Math.floor(Math.min(rowA, rowB)));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(rowA, rowB)));
  if (!(top <= bottom)) return;
  const offset = top * width + column;
  coverage[offset] = (coverage[offset] ?? 0) + 1;
  const below = bottom + 1;
  if (below < height) {
    const belowOffset = below * width + column;
    coverage[belowOffset] = (coverage[belowOffset] ?? 0) - 1;
  }
};
```

2. Update `accumulateEnvelope`'s doc comment: append the sentence
   `The grid holds +1/−1 span marks until resolveCoverage converts them to per-cell coverage — the direct per-row fill measured 229 ms per frame on a 1000-series panel.`

3. Add after `accumulateEnvelope`:

```ts
/**
 * Converts accumulated difference marks into per-cell coverage with one
 * prefix-sum pass down each column. Call exactly once, after every series
 * has been accumulated.
 */
export function resolveCoverage(grid: DensityGrid): void {
  const { coverage, width, height } = grid;
  const running = new Float32Array(width);
  for (let row = 0; row < height; row += 1) {
    const base = row * width;
    for (let column = 0; column < width; column += 1) {
      const sum = (running[column] ?? 0) + (coverage[base + column] ?? 0);
      running[column] = sum;
      coverage[base + column] = sum;
    }
  }
}
```

4. Replace `coverageToImage` (and its doc comment) entirely:

```ts
export const DENSITY_ALPHA_FLOOR = 0.1;
export const DENSITY_ALPHA_MAX = 0.9;

/**
 * Coverage -> straight-alpha RGBA via a log-normalized tone map:
 * `alpha(k) = floor + (max − floor) · ln(1 + k) / ln(1 + kRef)`.
 * The physical law `1 − (1 − a)^k` saturates by k ≈ 7 at ghost alpha 0.5
 * and flattened 1000-run ensembles into a solid slab (field capture
 * 2026-08-06); the log curve is what xy ships for exactly this regime.
 * kRef is the maximum coverage rounded up to a power of two, so exposure
 * holds steady while the densest cell drifts within 2x during pan/zoom.
 * Zero coverage stays transparent so grid lines show through the blend.
 */
export function coverageToImage(
  grid: DensityGrid,
  color: string,
): Uint8ClampedArray<ArrayBuffer> {
  const { coverage, width, height } = grid;
  const { r, g, b } = parseHexColor(color);
  let kMax = 0;
  for (const k of coverage) if (k > kMax) kMax = k;
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (kMax <= 0) return pixels;
  const kRef = 2 ** Math.ceil(Math.log2(kMax));
  const scale = (DENSITY_ALPHA_MAX - DENSITY_ALPHA_FLOOR) / Math.log(1 + kRef);
  for (let index = 0; index < coverage.length; index += 1) {
    const k = coverage[index] ?? 0;
    if (k <= 0) continue;
    const alpha = DENSITY_ALPHA_FLOOR + scale * Math.log(1 + k);
    const offset = index * 4;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = Math.round(alpha * 255);
  }
  return pixels;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `./scripts/test.sh unit -- src/render/density-raster.test.ts`
Expected: PASS. (The renderer suite will fail until Task 2 — that is expected; do not commit a broken tree, so proceed straight to Task 2 and commit both together ONLY if Task 2's Step 1 tests were also written first. Otherwise: commit here is fine because nothing else imports `coverageToImage` with three arguments except `canvas-renderer.ts` — check with `grep -rn "coverageToImage" frontend/src` and if the renderer still passes the old third argument, fold the one-line call-site fix from Task 2 Step 3.1 into this commit to keep the tree green.)

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/density-raster.ts frontend/src/render/density-raster.test.ts
git commit -m "feat(render): log-normalized density tone map on difference marks"
```

---

### Task 2: Renderer integration of the resolve and the new tone map

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`
- Test: `frontend/src/render/canvas-renderer.test.ts` (only if an assertion touches the removed argument — the existing density tests assert call structure, not pixel bytes, and should pass untouched)

**Interfaces:**

- `drawDensity(context, plot, project, seriesBins, color)` — the `pointAlpha` parameter is removed; behavior otherwise identical.

- [ ] **Step 1: Update `drawDensity`**

In `frontend/src/render/canvas-renderer.ts`:

1. Add `resolveCoverage` to the import from `./density-raster`.
2. Remove the `pointAlpha: number,` parameter from `drawDensity`.
3. Replace the accumulate/put block:

```ts
for (const bins of seriesBins) {
  accumulateEnvelope(grid, bins, toColumn, toRow);
}
const pixels = coverageToImage(grid, color, pointAlpha);
```

with:

```ts
for (const bins of seriesBins) {
  accumulateEnvelope(grid, bins, toColumn, toRow);
}
resolveCoverage(grid);
const pixels = coverageToImage(grid, color);
```

4. At the call site in `render()`, drop the last argument:

```ts
const drawn = this.drawDensity(
  context,
  plot,
  project,
  [...rasterSet].map((index) => (response.series[index] as ColumnarTile).bins),
  ghostStyle.color,
);
```

- [ ] **Step 2: Run the renderer suites**

Run: `./scripts/test.sh unit -- src/render/canvas-renderer.test.ts src/render/density-raster.test.ts src/render/density-policy.test.ts`
Expected: PASS with no test edits (the density describe asserts putImageData/drawImage/stroke structure only).

- [ ] **Step 3: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/canvas-renderer.ts
git commit -m "feat(render): resolve coverage marks and tone-map the density blit"
```

---

### Task 3: Hi-res tiles for the stroked set

When `densityMode` says raster, the crowd is rastered from starved bins (fine — the trapezoids interpolate), but focused/hued/hovered series stroke from those same starved bins and comb. The shell now issues a second, small tile query for exactly the stroked set at full pixel width and merges it into the panel response by signal id.

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/panel.ts` (the `onEmphasize` callback)
- Test: `frontend/src/ui/app-shell.test.ts`, `frontend/src/ui/panel.test.ts`

**Interfaces:**

- Produces:
  - `export function mergeTileResponses(crowd: ColumnarTileResponse, hiRes: ColumnarTileResponse): ColumnarTileResponse` (app-shell.ts, exported for tests)
  - `PanelCallbacks.onEmphasize?(id: string, paths: readonly string[]): void` — optional, so existing partial mocks stay valid.
  - Shell internals: `strokedSignalIds`, `hiResTiles`, `mergedTilesFor`, `panelEmphasis` map, `HI_RES_SERIES_CAP = 32`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/ui/app-shell.test.ts` (add `mergeTileResponses` to the import from `./app-shell`, and `binColumnsFromWire` from `../app/bin-columns` if not already imported):

```ts
describe("mergeTileResponses", () => {
  function tileOf(signalId: string, level: number) {
    return {
      signalId,
      signalPath: `p/${signalId}`,
      unit: null,
      level,
      bins: binColumnsFromWire([]),
    };
  }

  it("replaces crowd series with their hi-res twins by signal id", () => {
    const crowd = {
      requestId: "c",
      series: [tileOf("1", 8), tileOf("2", 8)],
    } as unknown as ColumnarTileResponse;
    const hi = {
      requestId: "h",
      series: [tileOf("2", 2)],
    } as unknown as ColumnarTileResponse;
    const merged = mergeTileResponses(crowd, hi);
    expect(merged.series).toHaveLength(2);
    expect(merged.series[0]).toBe(crowd.series[0]);
    expect(merged.series[1]).toBe(hi.series[0]);
    expect(merged.requestId).toBe("c");
  });

  it("ignores hi-res series absent from the crowd", () => {
    const crowd = {
      requestId: "c",
      series: [tileOf("1", 8)],
    } as unknown as ColumnarTileResponse;
    const hi = {
      requestId: "h",
      series: [tileOf("9", 2)],
    } as unknown as ColumnarTileResponse;
    expect(mergeTileResponses(crowd, hi).series[0]).toBe(crowd.series[0]);
  });
});
```

If `ColumnarTileResponse` is not already imported in the test file, import it type-only from `../app/bin-columns`.

Append to `frontend/src/ui/panel.test.ts` (uses the existing probe conventions; `vi` is already imported there):

```ts
describe("hover emphasis notification", () => {
  it("setEmphasis notifies the shell with the panel id and paths", () => {
    const onEmphasize = vi.fn();
    const view = Object.create(PanelView.prototype) as unknown as {
      id: string;
      callbacks: unknown;
      emphasizePaths: ReadonlySet<string> | null;
      lastState: null;
      lastWindow: null;
      setEmphasis(paths: readonly string[] | string | null): void;
    };
    view.id = "panel-1";
    view.callbacks = { onEmphasize };
    view.emphasizePaths = null;
    view.lastState = null;
    view.lastWindow = null;
    view.setEmphasis("run_01/temp");
    expect(onEmphasize).toHaveBeenCalledWith("panel-1", ["run_01/temp"]);
    view.setEmphasis(null);
    expect(onEmphasize).toHaveBeenCalledWith("panel-1", []);
    onEmphasize.mockClear();
    view.setEmphasis(null); // unchanged set: no notification
    expect(onEmphasize).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `./scripts/test.sh unit -- src/ui/app-shell.test.ts src/ui/panel.test.ts`
Expected: FAIL — `mergeTileResponses` is not exported; `onEmphasize` is never called.

- [ ] **Step 3: Implement the panel side**

In `frontend/src/ui/panel.ts`:

1. Add to `PanelCallbacks` (next to `onGesture`):

```ts
  /**
   * Fires whenever the hover/legend emphasis set changes. The shell uses it
   * to fetch full-resolution tiles for emphasized ghosts in raster regime.
   */
  onEmphasize?(id: string, paths: readonly string[]): void;
```

2. In `setEmphasis`, after the `this.emphasizePaths = next;` assignment and the existing re-render block, add as the last line of the method:

```ts
this.callbacks.onEmphasize?.(this.id, next === null ? [] : [...next]);
```

- [ ] **Step 4: Implement the shell side**

In `frontend/src/ui/app-shell.ts`:

1. Imports: add `densityMode` from `../render/density-policy`; `ColumnarTileResponse` (type-only) from `../app/bin-columns` if absent.

2. Module-level, near `const DERIVED_PREFIX`:

```ts
/**
 * Cap on the second, full-resolution tile request in raster regime. Above
 * this the panel is stroking a crowd (e.g. "all" mode at scale) and hi-res
 * for a subset would be arbitrary — the whole set stays at crowd resolution.
 */
const HI_RES_SERIES_CAP = 32;

/**
 * The crowd response with any series present in `hiRes` replaced by its
 * high-resolution twin. Membership and order follow the crowd response, so
 * downstream identity and style mapping are unchanged.
 */
export function mergeTileResponses(
  crowd: ColumnarTileResponse,
  hiRes: ColumnarTileResponse,
): ColumnarTileResponse {
  const byId = new Map(hiRes.series.map((tile) => [tile.signalId, tile]));
  return {
    ...crowd,
    series: crowd.series.map((tile) => byId.get(tile.signalId) ?? tile),
  };
}
```

3. Fields (near the other private caches):

```ts
  private readonly panelEmphasis = new Map<string, readonly string[]>();
  private readonly mergedTiles = new Map<
    string,
    {
      crowd: ColumnarTileResponse;
      hi: ColumnarTileResponse;
      merged: ColumnarTileResponse;
    }
  >();
```

4. Private methods (near `panelSignalIds`):

```ts
  /**
   * Signal ids that stay stroked in raster regime: visible focused/hued
   * series plus the transient hover-emphasis set. Null when the panel is
   * not in raster regime, nothing is stroked, or the stroked set is
   * crowd-sized (cap) — callers then skip the hi-res request entirely.
   */
  private strokedSignalIds(
    panel: PanelState,
    seriesCount: number,
    pixelWidth: number,
  ): string[] | null {
    if (densityMode(seriesCount, pixelWidth) !== "raster") return null;
    const emphasized = new Set(this.panelEmphasis.get(panel.id) ?? []);
    const paths = new Set<string>();
    for (const series of this.resolvedFor(panel)) {
      if (!series.visible) continue;
      if (series.display !== "ghost" || emphasized.has(series.path)) {
        paths.add(series.path);
      }
    }
    const ids: string[] = [];
    for (const path of paths) {
      const id = this.signalsByPath.get(path)?.signal_id;
      if (id !== undefined) ids.push(id);
    }
    if (ids.length === 0 || ids.length > HI_RES_SERIES_CAP) return null;
    if (ids.length >= seriesCount) return null;
    return ids;
  }

  /** The crowd fetch, replayed for the small stroked set at full width,
   * cached under a pseudo panel id so both entries coexist. */
  private async hiResTiles(
    panel: PanelState,
    ids: string[],
    window: { t0: number; t1: number },
    pixelWidth: number,
  ): Promise<ColumnarTileResponse> {
    const cacheId = `${panel.id}\u0000hires`;
    const idsKey = [...ids].sort().join("\u0000");
    const cached = this.tileWindowCache.slice(
      cacheId,
      idsKey,
      pixelWidth,
      window.t0,
      window.t1,
    );
    if (cached !== null) return cached;
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
    this.tileWindowCache.store(cacheId, {
      response,
      window: paddedWindow,
      pixelWidth,
      idsKey,
    });
    return (
      this.tileWindowCache.slice(
        cacheId,
        idsKey,
        pixelWidth,
        window.t0,
        window.t1,
      ) ?? response
    );
  }

  /** Identity-memoized merge: same crowd + same hi-res objects must return
   * the same merged object, or the panel's tile-identity render guard and
   * prepare cache would churn every refresh pass. */
  private mergedTilesFor(
    panelId: string,
    crowd: ColumnarTileResponse,
    hi: ColumnarTileResponse,
  ): ColumnarTileResponse {
    const memo = this.mergedTiles.get(panelId);
    if (memo !== undefined && memo.crowd === crowd && memo.hi === hi) {
      return memo.merged;
    }
    const merged = mergeTileResponses(crowd, hi);
    this.mergedTiles.set(panelId, { crowd, hi, merged });
    return merged;
  }
```

5. In `refreshTilesPass`'s envelope branch, both `nextTiles.set(panel.id, ...)` call sites (the cache-hit path and the post-fetch path) currently set the crowd response directly. Restructure so the resolved crowd response flows through the hi-res split. The cache-hit path:

```ts
if (cached !== null) {
  nextTiles.set(
    panel.id,
    await this.withHiRes(panel, cached, ids, window, pixelWidth),
  );
  return;
}
```

and the post-fetch path (replacing the existing `nextTiles.set(panel.id, this.tileWindowCache.slice(...) ?? response);`):

```ts
const crowd =
  this.tileWindowCache.slice(
    panel.id,
    idsKey,
    pixelWidth,
    window.t0,
    window.t1,
  ) ?? response;
nextTiles.set(
  panel.id,
  await this.withHiRes(panel, crowd, ids, window, pixelWidth),
);
```

with one more private method beside the others:

```ts
  /** The crowd response, upgraded with full-resolution stroked series when
   * the density policy has the panel in raster regime. */
  private async withHiRes(
    panel: PanelState,
    crowd: ColumnarTileResponse,
    ids: string[],
    window: { t0: number; t1: number },
    pixelWidth: number,
  ): Promise<ColumnarTileResponse> {
    const strokedIds = this.strokedSignalIds(panel, ids.length, pixelWidth);
    if (strokedIds === null) return crowd;
    try {
      const hi = await this.hiResTiles(panel, strokedIds, window, pixelWidth);
      return this.mergedTilesFor(panel.id, crowd, hi);
    } catch {
      return crowd;
    }
  }
```

6. In the `PanelCallbacks` object literal (near `onGesture`), add:

```ts
        onEmphasize: (id, paths) => {
          const previous = this.panelEmphasis.get(id) ?? [];
          const next = [...paths].sort();
          if (next.join("\u0000") === previous.join("\u0000")) return;
          if (next.length === 0) this.panelEmphasis.delete(id);
          else this.panelEmphasis.set(id, next);
          const panel = this.workspace.panel(id);
          if (panel === undefined) return;
          if (MODE_DATA[panel.mode].reduction !== "envelope") return;
          this.scheduleRefresh(100);
        },
```

(`panelEmphasis` stores the sorted array, so the join comparison is stable. The 100 ms `scheduleRefresh` is the hover debounce Edward chose; crowd tiles cache-hit during hover, so each dwell costs one small hi-res query.)

- [ ] **Step 5: Run the suites**

Run: `./scripts/test.sh unit -- src/ui/app-shell.test.ts src/ui/panel.test.ts src/ui/modes`
Expected: PASS, including the two new describes.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts
git commit -m "feat(shell): full-resolution tiles for stroked series in raster regime"
```

---

### Task 4: Amend ADR 0038

**Files:**

- Modify: `docs/adr/0038-unified-mode-pipeline-and-density-tier.md`

- [ ] **Step 1: Update the Decision and Rejected sections**

1. In the Decision section, replace the sentence beginning `Coverage maps to straight-alpha pixels using` (and its formula) with:

```text
Coverage maps to straight-alpha pixels through a log-normalized tone map,
`alpha(k) = 0.1 + 0.8 * ln(1 + k) / ln(1 + kRef)`, where `kRef` is the
frame's maximum coverage rounded up to a power of two; an offscreen
Canvas2D surface is blitted below the remaining focused, hued, or
emphasized strokes. In raster regime the shell additionally fetches the
stroked set (focused + hued + hover-emphasized, capped at 32 series) at
full pixel width in a second tile query merged by signal id, so the lines
that remain lines do not inherit the crowd's starved bin allocation.
```

2. Append to the Rejected section:

```text
Fixed physical compositing (`1 - (1 - a)^k`) was shipped first and rejected
after field capture: at ghost alpha 0.5 it saturates by k = 7, rendering a
1000-run ensemble as a structureless slab. Exposure-normalizing the
physical law was rejected because it drives lone outlier runs below
visibility without a floor, and flooring it converges on the log curve.
```

- [ ] **Step 2: Format and commit**

```bash
./scripts/format.sh
git add docs/adr/0038-unified-mode-pipeline-and-density-tier.md
git commit -m "docs(adr): amend 0038 with the tone map and hi-res stroke acquisition"
```

---

### Task 5: Gates, bench, and the visual check

**Files:** none (verification only)

- [ ] **Step 1: Broad gate**

Run: `./scripts/test.sh quick` — expected PASS.
Run: `./scripts/ci.sh quality` — expected PASS.

- [ ] **Step 2: Bench**

Run: `./scripts/test.sh bench`. Compare against `build/bench/report-phase3-baseline.json`: `e2e_mc1000` `frame_p95_ms`/`first_plot_ms` within noise or better (the resolve pass replaces ~50M cell writes with ~3M). Record the delta table in the handoff. Floors that failed at baseline remain environmental.

- [ ] **Step 3: Visual verification**

Reproduce the `Screenshot 2026-08-06 000245.png` panel (mc1000 corpus, `temperature @*`, 1000 sources, ghost mode, full window):

- The grey band now shows **gradation**: dark core where runs concentrate, fading toward the envelope edges; no flat slab.
- The focused blue line is a **continuous crisp trace** — no ~9 px vertical comb.
- Hovering a ghost emphasizes it as a line that sharpens to full resolution after ~100 ms (one-time pop-in per dwell is expected and accepted).
- The status-bar render time on this panel drops from ~229 ms to low double digits.
- A panel below the raster threshold renders identically to phase 3.

Screenshot the result for the PR next to the 2026-08-06 capture.

- [ ] **Step 4: Record the outcome**

Handoff notes: bench delta table, before/after screenshots, observed render-ms, and the hover pop-in behavior.

---

## Self-review notes (already applied)

- Spec coverage: amendment items 1 (tone map — Task 1/2), 2 (hi-res strokes — Task 3), 3 (difference marks — Task 1). ADR amendment required by the spec's ADR rule — Task 4.
- The Task 3 merge is identity-memoized specifically for the phase-1 `sameRenderInputs` tile guard and the phase-2 prepare cache: same crowd + hi objects → same merged object, so hover-clear returns to the pre-hover merged identity via the pseudo-id tile cache.
- `onEmphasize` is optional on `PanelCallbacks` so the existing partial mocks in panel tests stay valid; the shell registers it unconditionally.
- Failure isolation: a failed hi-res query degrades to the crowd response (`withHiRes` catch), never to a blank panel.
- Type consistency: `resolveCoverage` (Tasks 1→2), `mergeTileResponses`/`withHiRes`/`strokedSignalIds`/`hiResTiles` (Task 3 only), `coverageToImage(grid, color)` two-arg form (Tasks 1→2).

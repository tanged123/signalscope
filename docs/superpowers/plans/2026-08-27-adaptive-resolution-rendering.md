# Adaptive-Resolution Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render time-series data above physical-pixel density, refine
asynchronously to level zero on zoom, keep resident workspace tabs instant,
and remain stable with 3,000 resident series.

**Architecture:** Rust and `BakedPlane` select the coarsest pyramid level that
still exceeds one bin per device pixel and contains no bin wider than a device
pixel. The frontend classifies cached responses as current, stale, or missing;
stale plots remain interactive while a generation-safe request and feed
preparation complete, then the whole panel swaps atomically. Inactive tab hosts
remain GPU-resident under a 3,000-series LRU ceiling.

**Tech Stack:** Rust 2024, Axum, TypeScript, Vitest, ChartGPU/WebGPU,
Playwright, treefmt.

**Spec:**
`docs/superpowers/specs/2026-08-27-adaptive-resolution-rendering-design.md`

## Global Constraints

- Resolution is uniform across visible series and measured in physical device
  pixels.
- A nonzero pyramid level is valid only with more visible bins than device
  pixels and no visible bin wider than one device pixel.
- Level zero is the exact zoomed-in endpoint; never silently degrade below the
  visual floor.
- Panel refinement publishes one complete response generation on one frame.
- GPU residency is capped at 3,000 resolved visible series; the active tab has
  priority and inactive panels are evicted least-recently-used.
- Preserve `HttpPlane`/`BakedPlane` parity, the binary protocol, gap semantics,
  exact string identifiers, and explicit export fidelity.
- Add no runtime dependency and do not modify the ChartGPU submodule.
- Use repository scripts for formatting, tests, builds, and version checks.
- The PR already contains its one synchronized version increment to `1.1.9`
  in commit `8b37075`; do not bump it again.
- Defer Playwright, full GUI, and benchmark execution until Task 9.

## File Structure

- `core/scope-core/src/pyramid.rs`: device-pixel-aware native pyramid level
  selection.
- `server/scope-server/src/api.rs`: live adaptive query wiring.
- `frontend/src/app/pyramid-query.ts`: matching baked-host level selection.
- `frontend/src/app/data-plane.ts`: `BakedPlane` adaptive query consumer.
- `frontend/src/app/tile-window-cache.ts`: current/stale/miss cache contract and
  padded physical-width calculation.
- `frontend/src/render/m4-feed.ts`: minimal envelope vertices and feed prewarm.
- `frontend/src/app/render-limits.ts`: shared 3,000-series residency constant.
- `frontend/src/ui/panel-residency.ts`: pure LRU eviction policy.
- `frontend/src/ui/app-shell.ts`: request generations, resource preflight, and
  atomic publication.
- `frontend/src/ui/workspace-view.ts`: retained inactive panel hosts.
- `frontend/src/ui/panel.ts`: reusable GPU release lifecycle.
- `frontend/src/render/gpu-context.ts`: shared-device failure notification and
  render-loop shutdown.
- `docs/adr/0044-adaptive-resolution-presentation.md`: accepted architecture
  amendment.
- Existing neighboring unit and e2e files own verification; create only the
  focused `panel-residency` test and adaptive Playwright spec named below.

---

### Task 1: Native Device-Pixel Pyramid Selection

**Files:**

- Modify: `core/scope-core/src/pyramid.rs:423-530`
- Test: `core/scope-core/src/pyramid.rs:850-990`

**Interfaces:**

- Consumes: `Pyramid::level_window`, `BinLevel::t0_column`, and
  `BinLevel::t1_column`.
- Produces: unchanged
  `Pyramid::query(t0: f64, t1: f64, pixel_width: u32) -> PyramidQuery` with
  the device-pixel floor. `query_with_target(..., Some(_))` retains explicit
  export-budget behavior.

- [ ] **Step 1: Write failing selector tests**

Add tests for the density floor, irregular timestamps, and raw endpoint:

```rust
#[test]
fn adaptive_query_stays_above_one_bin_per_pixel() {
    let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
    let pyramid = Pyramid::from_samples(&time, &time);
    let query = pyramid.query(0.0, 9_999.0, 200);

    assert!(query.level > 0);
    assert!(query.bins.len() > 200);
    assert!(query.bins.len() <= 402);
    let pixel_span = 9_999.0 / 200.0;
    assert!(
        query
            .bins
            .t0_column()
            .iter()
            .zip(query.bins.t1_column())
            .all(|(start, end)| end - start <= pixel_span)
    );
}

#[test]
fn adaptive_query_refines_bins_that_cross_a_device_pixel() {
    let mut time = (0..512).map(f64::from).collect::<Vec<_>>();
    for value in &mut time[256..] {
        *value += 10_000.0;
    }
    let pyramid = Pyramid::from_samples(&time, &time);
    let query = pyramid.query(0.0, 10_511.0, 256);
    let pixel_span = 10_511.0 / 256.0;

    assert!(
        query.level == 0
            || query
                .bins
                .t0_column()
                .iter()
                .zip(query.bins.t1_column())
                .all(|(start, end)| end - start <= pixel_span)
    );
}

#[test]
fn adaptive_query_reaches_level_zero_when_raw_fits() {
    let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
    let pyramid = Pyramid::from_samples(&time, &time);
    let query = pyramid.query(4_900.0, 5_100.0, 400);

    assert_eq!(query.level, 0);
    assert!(query.bins.to_wire_vec().iter().all(|bin| bin.sample_count == 1));
}
```

- [ ] **Step 2: Run the focused core tests and confirm failure**

Run: `./scripts/test.sh core adaptive_query_`

Expected: the regular density test passes under the old count selector; the
irregular projected-width test fails because a selected merged bin spans more
than one device pixel.

- [ ] **Step 3: Add projected-width refinement**

Keep the existing direct count-based level probe, then refine only unbudgeted
live queries:

```rust
fn meets_pixel_floor(bins: &BinLevel, t0: f64, t1: f64, pixel_width: u32) -> bool {
    let pixels = usize::try_from(pixel_width.max(1)).unwrap_or(usize::MAX);
    if bins.len() <= pixels {
        return false;
    }
    let pixel_span = (t1 - t0) / f64::from(pixel_width.max(1));
    pixel_span.is_finite()
        && pixel_span > 0.0
        && bins
            .t0_column()
            .iter()
            .zip(bins.t1_column())
            .all(|(start, end)| end - start <= pixel_span)
}
```

After the existing candidate is found, materialize it once. When
`max_bins.is_none()`, walk toward level zero until `meets_pixel_floor` returns
true; level zero always wins because it is exact. Return the materialized
candidate instead of querying the chosen level a second time. Update the
test-only `query_reference` with the same refinement so its equivalence test
continues to validate the optimized selector.

- [ ] **Step 4: Run the core pyramid suite**

Run: `./scripts/test.sh core pyramid::tests`

Expected: all pyramid tests pass, including explicit
`bin_budget_selects_a_coarser_level`.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add core/scope-core/src/pyramid.rs
git commit -m "feat(core): select visually lossless pyramid levels"
```

### Task 2: Adaptive Live and Baked Hosts

**Files:**

- Modify: `server/scope-server/src/api.rs:613-653`
- Test: `server/scope-server/src/api.rs:1096-1145`
- Modify: `frontend/src/app/pyramid-query.ts`
- Test: `frontend/src/app/pyramid-query.test.ts`
- Modify: `frontend/src/app/data-plane.ts:339-449`
- Test: `frontend/src/app/data-plane.test.ts:196-335`

**Interfaces:**

- Consumes: Task 1's adaptive `Pyramid::query`.
- Produces:
  `queryAdaptivePyramidRange(levels, t0, t1, pixelWidth) -> PyramidQueryRange`
  and host parity without a protocol change.

- [ ] **Step 1: Write failing server behavior tests**

Replace the raw-only assertion with two requests against the 10,000-sample
fixture:

```rust
#[tokio::test]
async fn query_tiles_bin_refines_from_envelope_to_raw() {
    // Reuse the existing query_tiles_bin fixture/router setup.
    let overview = request_tiles(&router, signal_id, 0.0, 9_999.0, 200, Some(1)).await;
    assert!(overview.level > 0);
    assert!(overview.bin_count > 200);
    assert!(overview.bin_count <= 402);

    let detail = request_tiles(&router, signal_id, 4_900.0, 5_100.0, 400, Some(1)).await;
    assert_eq!(detail.level, 0);
    assert!(detail.sample_count.iter().all(|count| *count == 1));
}
```

Extract only the request/response repetition from the current test into its
local `request_tiles` helper. Passing `Some(1)` proves the compatibility field
does not force live presentation below the visual floor.

- [ ] **Step 2: Run the server test and confirm failure**

Run: `./scripts/test.sh server query_tiles_bin_refines_from_envelope_to_raw`

Expected: FAIL because the overview still returns level zero.

- [ ] **Step 3: Activate the native selector**

In `query_tiles_bin`, replace:

```rust
let query = pyramid.query_raw(request.window.t0, request.window.t1);
```

with:

```rust
let query = pyramid.query(
    request.window.t0,
    request.window.t1,
    request.pixel_width,
);
```

Do not divide by signal count and do not consult `max_total_bins`.

- [ ] **Step 4: Write the baked selector tests**

Rename `queryRawPyramidRange` tests for the new API and add level refinement:

```ts
expect(queryAdaptivePyramidRange(levels, 0, 99, 20)).toEqual({
  level: 2,
  start: 0,
  end: 25,
});
expect(queryAdaptivePyramidRange(levels, 40, 50, 20).level).toBe(0);
```

Build every binary level in the fixture, not a single 100-sample aggregate,
so the expected range follows the production pyramid shape. Add an irregular
timestamp case asserting every selected nonzero bin spans at most
`(t1 - t0) / pixelWidth`.

- [ ] **Step 5: Run baked selector tests and confirm failure**

Run: `./scripts/test.sh unit pyramid-query`

Expected: FAIL because `queryAdaptivePyramidRange` is not exported.

- [ ] **Step 6: Implement the baked selector and wire `BakedPlane`**

Replace `queryRawPyramidRange` with:

```ts
export function queryAdaptivePyramidRange(
  levels: readonly EnvelopeBin[][],
  t0: number,
  t1: number,
  pixelWidth: number,
): PyramidQueryRange;
```

Use the existing binary-search range helpers. Choose the first level whose
overlapping range has at most `2 * max(1, floor(pixelWidth))` bins, then walk
toward level zero until the range is exact or it has more than `pixelWidth`
bins and every bin's `t1 - t0` is no greater than one pixel span. Include one
neighbor on each edge after selecting the level.

Call it from `BakedPlane.queryTiles` with `request.pixel_width`. Replace the
raw-only BakedPlane test with overview/detail assertions matching the server
test; continue passing `max_total_bins: 1` to prove it is inert for live
presentation.

- [ ] **Step 7: Run both host suites**

```bash
./scripts/test.sh server query_tiles_bin_
./scripts/test.sh unit pyramid-query data-plane
```

Expected: all selected tests pass and both hosts choose coarse overview data
then level zero for the detail window.

- [ ] **Step 8: Format and commit**

```bash
./scripts/format.sh
git add server/scope-server/src/api.rs frontend/src/app/pyramid-query.ts frontend/src/app/pyramid-query.test.ts frontend/src/app/data-plane.ts frontend/src/app/data-plane.test.ts
git commit -m "feat(data): serve adaptive pyramid windows"
```

### Task 3: Resolution-Aware Padded Cache

**Files:**

- Modify: `frontend/src/app/tile-window-cache.ts`
- Test: `frontend/src/app/tile-window-cache.test.ts`

**Interfaces:**

- Consumes: columnar response levels and time columns.
- Produces:

```ts
export type TileCacheLookup =
  | { kind: "current"; response: ColumnarTileResponse }
  | { kind: "stale"; response: ColumnarTileResponse }
  | { kind: "miss" };

lookup(
  panelId: string,
  idsKey: string,
  visible: { t0: number; t1: number },
  devicePixelWidth: number,
): TileCacheLookup;

static requestPixelWidth(
  cssWidth: number,
  devicePixelRatio: number,
  visible: { t0: number; t1: number },
  padded: { t0: number; t1: number },
): number;
```

- [ ] **Step 1: Replace cache-hit tests with current/stale/miss tests**

Cover these exact outcomes:

```ts
expect(cache.lookup("panel", "7", { t0: 5, t1: 15 }, 8).kind).toBe("current");
expect(cache.lookup("panel", "7", { t0: 8, t1: 12 }, 8)).toMatchObject({
  kind: "stale",
  response: cached.response,
});
expect(cache.lookup("panel", "7", { t0: -1, t1: 10 }, 8)).toEqual({
  kind: "miss",
});
```

Use aggregate bins with nonzero time spans for current/stale cases. Keep the
raw-level test and assert level zero remains `current` at any covered zoom.
Update width tests to assert `800 CSS px × 2 DPR × padding ratio`.

- [ ] **Step 2: Run the cache test and confirm failure**

Run: `./scripts/test.sh unit tile-window-cache`

Expected: FAIL because `lookup` and the DPR argument do not exist.

- [ ] **Step 3: Implement response summaries and lookup classification**

Extend `CachedPanelTiles` with `requestedDevicePixels`. On `store`, compute one
summary per series:

```ts
interface SeriesResolution {
  level: number;
  maxBinSpan: number;
}
```

Keep summaries in the cache entry, not on protocol objects. `lookup` returns
`miss` for identity or coverage failure. Level-zero series always satisfy
density. For nonzero levels, use binary search over `t0`/`t1` columns to count
visible bins and require both `count > devicePixelWidth` and
`maxBinSpan <= visibleSpan / devicePixelWidth`; otherwise return `stale` with
the existing response. The conservative maximum over the padded response is
intentional: it may refine early but can never retain a visibly wide bin.

Implement physical padded width as:

```ts
const physical = Math.max(1, Math.ceil(cssWidth * devicePixelRatio));
return Math.ceil(physical * (paddedSpan / visibleSpan));
```

Fall back to `physical` for invalid spans.

- [ ] **Step 4: Run cache and frontend data tests**

Run: `./scripts/test.sh unit tile-window-cache data-plane`

Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/tile-window-cache.ts frontend/src/app/tile-window-cache.test.ts
git commit -m "feat(frontend): invalidate coarse zoom cache hits"
```

### Task 4: Minimal and Prewarmed ChartGPU Feeds

**Files:**

- Modify: `frontend/src/render/m4-feed.ts`
- Test: `frontend/src/render/m4-feed.test.ts`
- Modify: `frontend/src/render/chart-host.ts:1-160,280-300`
- Test: `frontend/src/render/chart-host.test.ts:127-240`

**Interfaces:**

- Consumes: `ColumnarTileResponse` and `BinColumns`.
- Produces:

```ts
export function responseTimeReference(response: ColumnarTileResponse): number;
export function prepareResponseFeeds(response: ColumnarTileResponse): void;
```

- [ ] **Step 1: Write failing duplicate-extrema tests**

Add cases proving endpoints remain while redundant midpoint extrema disappear:

```ts
it("omits extrema already represented by endpoints", () => {
  const feed = m4Feed(
    columns([{ t0: 10, t1: 12, first: 1, min: 1, max: 5, last: 5 }]),
    10,
  );
  expect(points(feed)).toEqual([
    [0, 1],
    [2, 5],
  ]);
});

it("emits equal midpoint extrema once", () => {
  const feed = m4Feed(
    columns([{ t0: 0, t1: 2, first: 1, min: 0, max: 0, last: 1 }]),
    0,
  );
  expect(points(feed)).toEqual([
    [0, 1],
    [1, 0],
    [2, 1],
  ]);
});
```

Retain the existing distinct `first → min → max → last` and gap assertions.

- [ ] **Step 2: Run the feed tests and confirm failure**

Run: `./scripts/test.sh unit m4-feed`

Expected: both new tests fail with four emitted vertices.

- [ ] **Step 3: Implement exact vertex planning**

For aggregate bins, always emit finite first and last endpoints. Emit minimum
only when it differs from both endpoints. Emit maximum only when it differs
from both endpoints and from the emitted minimum. Mirror the same predicates
in `vertexCount` so `feed.buffer.byteLength === feed.byteLength` remains true.
Do not deduplicate NaN gap sentinels across bin boundaries.

Move `minimumTime` from `chart-host.ts` into `m4-feed.ts` as
`responseTimeReference`. Implement `prepareResponseFeeds` by computing that
reference once and calling `cachedFeed` for every series. Make `ChartHost`
consume the shared function.

The aggregate emission body should have this shape; keep the existing flag and
finiteness checks around each value:

```ts
append(columns.t0[index] as number, first);
let emittedExtremum: number | null = null;
if (min !== first && min !== last) {
  append(midpoint, min);
  emittedExtremum = min;
}
if (max !== first && max !== last && max !== emittedExtremum) {
  append(midpoint, max);
}
append(columns.t1[index] as number, last);
```

- [ ] **Step 4: Add and run prewarm identity coverage**

Add:

```ts
it("prewarms the same feed ChartHost consumes", () => {
  const response = tileResponse();
  prepareResponseFeeds(response);
  const reference = responseTimeReference(response);
  expect(cachedFeed(response.series[0]!.bins, reference)).toBe(
    cachedFeed(response.series[0]!.bins, reference),
  );
});
```

Run: `./scripts/test.sh unit m4-feed chart-host`

Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/m4-feed.ts frontend/src/render/m4-feed.test.ts frontend/src/render/chart-host.ts frontend/src/render/chart-host.test.ts
git commit -m "perf(render): compact and prewarm envelope feeds"
```

### Task 5: Generation-Safe Atomic Refinement and Active Limit

**Files:**

- Create: `frontend/src/app/render-limits.ts`
- Modify: `frontend/src/ui/app-shell.ts:90-190,2480-2615`
- Test: `frontend/src/ui/app-shell.test.ts:16-180`

**Interfaces:**

- Consumes: Task 3's `TileCacheLookup`, Task 4's
  `prepareResponseFeeds`, and `window.devicePixelRatio`.
- Produces: `MAX_RESIDENT_SERIES = 3_000`, request generations that never
  publish superseded data, and one `renderTiles()` call per complete refresh.

- [ ] **Step 1: Write failing refresh tests**

Add tests with deferred `queryTiles` promises proving:

1. a stale cache response remains `tilesByPanel` while refinement is pending;
2. a refresh requested during that pending query prevents the older response
   from entering the cache or rendering;
3. publication occurs only after `prepareResponseFeeds` ran for every response;
4. 3,001 visible resolved series report
   `series limit exceeded: 3001 visible; maximum 3000` before `queryTiles`.

Use `vi.mock("../render/m4-feed", ...)` to observe prewarming. The generation
assertion should resolve the first deferred response after calling
`refreshTiles()` a second time and expect no intermediate `renderTiles` call.

- [ ] **Step 2: Run the AppShell tests and confirm failure**

Run: `./scripts/test.sh unit app-shell`

Expected: stale lookup is unsupported, the first response still stores before
the queued refresh, and no 3,000-series preflight exists.

- [ ] **Step 3: Implement physical-width requests and fallbacks**

Create:

```ts
export const MAX_RESIDENT_SERIES = 3_000;
```

Before querying, count `this.resolvedFor(panel).filter((series) =>
series.visible).length` across active panels. On overflow, call `reportError`
with the exact message above and preserve the current drawable maps.

For each panel, compute CSS width, physical width, and padded request width via
Task 3. Send `max_total_bins: null`. Handle lookup outcomes as follows:

- `current`: put the cached response in `nextTiles`, no query;
- `stale`: retain it as the failure fallback and query a replacement;
- `miss`: query with no fallback.

Prewarm successful replacements before staging them for publication.

- [ ] **Step 4: Make generation ownership begin at request time**

Increment `refreshToken` in `refreshTiles()`, not when a pass begins. Pass the
captured token into `refreshTilesPass(token)`. Query results remain local until
all active panels finish. If `token !== this.refreshToken`, discard the entire
candidate map without storing or rendering it. Otherwise store every
replacement, assign both panel maps once, and call `renderTiles()` once.

```ts
private refreshTiles(): Promise<void> {
  this.refreshQueued = true;
  this.refreshToken += 1;
  if (this.refreshPromise !== null) return this.refreshPromise;
  this.refreshPromise = (async () => {
    try {
      while (this.refreshQueued) {
        this.refreshQueued = false;
        await this.refreshTilesPass(this.refreshToken);
      }
    } finally {
      this.refreshPromise = null;
    }
  })();
  return this.refreshPromise;
}
```

Keep the existing loop so a queued newest generation starts immediately after
the obsolete pass settles. On a current-generation query failure, report the
error and publish its stale fallback when present.

- [ ] **Step 5: Run focused frontend tests**

Run: `./scripts/test.sh unit app-shell tile-window-cache m4-feed chart-host`

Expected: PASS; no test observes a partially published panel generation.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/app/render-limits.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts
git commit -m "feat(frontend): refine plot resolution atomically"
```

### Task 6: Bounded Workspace-Tab GPU Residency

**Files:**

- Create: `frontend/src/ui/panel-residency.ts`
- Create: `frontend/src/ui/panel-residency.test.ts`
- Modify: `frontend/src/ui/workspace-view.ts:32-155`
- Modify: `frontend/src/ui/app-shell.ts:235-270,1825-1845,2145-2170`
- Test: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Consumes: `MAX_RESIDENT_SERIES` and per-panel resolved visible counts.
- Produces:

```ts
export interface ResidentPanel {
  id: string;
  seriesCount: number;
  lastUsed: number;
  active: boolean;
}

export function panelsToEvict(
  panels: readonly ResidentPanel[],
  limit: number,
): string[];

WorkspaceView.sync(
  hasSignals: boolean,
  seriesCounts: ReadonlyMap<string, number>,
): void;
```

- [ ] **Step 1: Write failing pure residency tests**

```ts
it("keeps three resident thousand-series panels", () => {
  expect(
    panelsToEvict(
      [
        { id: "a", seriesCount: 1000, lastUsed: 1, active: false },
        { id: "b", seriesCount: 1000, lastUsed: 2, active: false },
        { id: "c", seriesCount: 1000, lastUsed: 3, active: true },
      ],
      3000,
    ),
  ).toEqual([]);
});

it("evicts least-recent inactive panels and never the active panel", () => {
  expect(
    panelsToEvict(
      [
        { id: "old", seriesCount: 1000, lastUsed: 1, active: false },
        { id: "new", seriesCount: 1000, lastUsed: 3, active: false },
        { id: "active", seriesCount: 2000, lastUsed: 4, active: true },
      ],
      3000,
    ),
  ).toEqual(["old"]);
});
```

- [ ] **Step 2: Run the policy test and confirm failure**

Run: `./scripts/test.sh unit panel-residency`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure LRU policy**

Sum every resident cost. Sort inactive panels by `lastUsed`, then append IDs
until the remaining sum is at most the limit. If active panels alone exceed
the limit, return every inactive ID; Task 5 owns the visible error.

```ts
export function panelsToEvict(
  panels: readonly ResidentPanel[],
  limit: number,
): string[] {
  let resident = panels.reduce((sum, panel) => sum + panel.seriesCount, 0);
  const evicted: string[] = [];
  for (const panel of panels
    .filter(({ active }) => !active)
    .sort((left, right) => left.lastUsed - right.lastUsed)) {
    if (resident <= limit) break;
    resident -= panel.seriesCount;
    evicted.push(panel.id);
  }
  return evicted;
}
```

- [ ] **Step 4: Retain inactive `PanelView` instances**

In `WorkspaceView.sync`, compute `alive` from
`this.model.tabs().flatMap((tab) => tab.panels)`, not only active panels. Dispose
only IDs absent from all tabs. Track a monotonic use counter for mounted active
panels and their supplied series costs. After mounting the active layout, call
`panelsToEvict`; dispose, remove, and delete only returned inactive views.

Store the latest count map on `WorkspaceView` so `setGpu` can resync without
inventing zero costs:

```ts
private seriesCounts: ReadonlyMap<string, number> = new Map();

sync(hasSignals: boolean, seriesCounts: ReadonlyMap<string, number>): void {
  this.seriesCounts = seriesCounts;
  const allPanels = this.model.tabs().flatMap((tab) => tab.panels);
  const alive = new Set(allPanels.map((panel) => panel.id));
  // Dispose closed IDs, mount the active layout, then apply LRU evictions.
}
```

The existing `root.replaceChildren()` detaches inactive DOM while leaving its
`PanelView` and `ChartHost` alive. Returning to a resident tab therefore calls
`view(id)` on the existing object and reattaches the same canvases.

In `AppShell`, build the series-count map across every workspace tab from
`resolvedFor(panel).filter(({ visible }) => visible).length` and pass it to all
`WorkspaceView.sync` calls. Before closing a tab or panel, capture its panel
IDs and call `tileWindowCache.invalidate(id)` after the model change so closed
responses are released. An LRU-evicted view keeps its tile-cache entry, letting
it rebuild without a new query.

- [ ] **Step 5: Run unit suites**

Run: `./scripts/test.sh unit panel-residency workspace app-shell`

Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/ui/panel-residency.ts frontend/src/ui/panel-residency.test.ts frontend/src/ui/workspace-view.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts
git commit -m "perf(ui): retain bounded workspace tab charts"
```

### Task 7: Shared WebGPU Failure Lifecycle

**Files:**

- Modify: `frontend/src/render/gpu-context.ts`
- Test: `frontend/src/render/gpu-context.test.ts`
- Modify: `frontend/src/ui/panel.ts:480-620,1010-1025`
- Test: `frontend/src/ui/panel.test.ts`
- Modify: `frontend/src/ui/workspace-view.ts`
- Modify: `frontend/src/ui/app-shell.ts:210-235,3035-3045,3195-3202`
- Test: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/styles/app.css:1109-1130`

**Interfaces:**

- Produces:

```ts
export interface GpuFailure {
  kind: "device-lost" | "uncaptured-error";
  message: string;
}

GpuContext.onFailure(callback: (failure: GpuFailure) => void): () => void;
PanelView.releaseGpu(): void;
WorkspaceView.releaseGpu(): void;
```

- [ ] **Step 1: Write failing GPU-context tests**

Mock `device.lost` with a deferred promise and `device.addEventListener`.
Assert that resolving loss:

- notifies one registered failure listener with `kind: "device-lost"`;
- cancels the shared animation frame;
- makes later `register` calls return a no-op unregister without scheduling;
- reports an `uncapturederror` listener event without stopping a healthy loop.

- [ ] **Step 2: Run the GPU test and confirm failure**

Run: `./scripts/test.sh unit gpu-context`

Expected: FAIL because `onFailure` is absent and loss does not stop the loop.

- [ ] **Step 3: Implement failure notification and shutdown**

Maintain a listener set and `lost` boolean inside `acquireGpuContext`. On
`device.lost`, cancel the frame, clear registered render hosts, and notify once
unless the reason is `destroyed`. On `uncapturederror`, call `preventDefault`
and notify without marking the device lost. Return an unregister closure from
`onFailure`.

```ts
const failures = new Set<(failure: GpuFailure) => void>();
const notify = (failure: GpuFailure): void => {
  for (const listener of failures) listener(failure);
};
void device.lost.then((info) => {
  if (info.reason === "destroyed") return;
  lost = true;
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  hosts.clear();
  notify({
    kind: "device-lost",
    message: info.message || "WebGPU device lost",
  });
});
device.addEventListener("uncapturederror", (event) => {
  event.preventDefault();
  notify({ kind: "uncaptured-error", message: event.error.message });
});
```

- [ ] **Step 4: Add reusable host release**

Add `PanelView.releaseGpu()` that disposes the current host, invalidates any
pending create generation, sets `chartHost`, `chartHostReady`, and `gpu` to
null, retains `pendingChartRender`, and hides the chart surface. Make
`dispose()` call `releaseGpu()` before disposing interactions. Add a creation
generation guard so a host resolving after release is immediately disposed.

Add `WorkspaceView.releaseGpu()` to call every view's method and clear its GPU
reference without deleting panel views.

- [ ] **Step 5: Surface loss with a reload action**

Subscribe in `AppShell.setGpu`. For `uncaptured-error`, call `reportError` only.
For `device-lost`, call `workspaceView.releaseGpu()`, show `.gpu-warning` with
`WebGPU device lost — reload SignalScope`, and expose a
`.gpu-warning-reload` button whose click calls `window.location.reload()`.
Keep the dismiss button for initial unavailability only.

Test AppShell with a fake `onFailure` callback and assert the warning text,
release call, reported error, and reload-button presence.

- [ ] **Step 6: Run focused frontend tests**

Run: `./scripts/test.sh unit gpu-context panel app-shell`

Expected: PASS.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add frontend/src/render/gpu-context.ts frontend/src/render/gpu-context.test.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts frontend/src/ui/workspace-view.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/styles/app.css
git commit -m "fix(render): contain shared WebGPU device loss"
```

### Task 8: Record the Architecture Amendment

**Files:**

- Create: `docs/adr/0044-adaptive-resolution-presentation.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/implementation-roadmap.md:108-180`
- Modify: `README.md`

**Interfaces:**

- Consumes: implemented behavior from Tasks 1-7.
- Produces: accepted ADR 0044 and user-facing architecture summary.

- [ ] **Step 1: Write ADR 0044**

Record these decisions concisely:

- physical-device-pixel density and projected-width floor;
- asynchronous panel-wide atomic refinement;
- full resolution as the zoom endpoint, amending ADR 0041;
- no fixed total-bin split for live presentation, amending ADR 0036;
- retained tabs under a 3,000-visible-series LRU ceiling;
- clear failure rather than unequal or invisible degradation;
- unchanged protocol, session, export fidelity, and host parity.

Add entry 44 to `docs/adr/README.md`. Update the roadmap's ChartGPU paragraph
to replace “full-resolution presentation baseline” as the final live behavior
with the adaptive endpoint. Update README performance language to say live
time panels refine from pixel-dense envelopes to exact samples.

- [ ] **Step 2: Format and validate documentation**

```bash
./scripts/format.sh
./scripts/format.sh --check
git diff --check
```

Expected: all commands pass.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0044-adaptive-resolution-presentation.md docs/adr/README.md docs/implementation-roadmap.md README.md
git commit -m "docs: adopt adaptive time presentation"
```

### Task 9: End-to-End Fidelity, Tab Reuse, and Final Gates

**Files:**

- Create: `frontend/tests/e2e/adaptive-resolution.spec.ts`
- Modify: `frontend/tests/e2e/workbench.spec.ts:77-117`

**Interfaces:**

- Consumes: all implementation tasks.
- Produces: real-WebGPU proof of refinement, visual parity, resident canvas
  identity. The unchanged benchmark suite supplies the existing mc1000
  performance reports.

- [ ] **Step 1: Add a real-response level probe**

Before navigation, install a test-only `fetch` wrapper with
`page.addInitScript`. Clone `/api/query_tiles_bin` responses and parse only the
binary headers to append each response's series levels to
`window.__signalscopeTestLevels`. Advance offsets using the documented
`24-byte series header + aligned names + aligned 73 * bin_count` layout.

Use this parser inside the init script:

```ts
const align8 = (value: number): number => (value + 7) & ~7;
const levels = (buffer: ArrayBuffer): number[] => {
  const view = new DataView(buffer);
  const count = view.getUint32(8, true);
  const out: number[] = [];
  let offset = 16;
  for (let index = 0; index < count; index += 1) {
    const level = view.getUint32(offset + 8, true);
    const bins = view.getUint32(offset + 12, true);
    const pathBytes = view.getUint16(offset + 16, true);
    const unitBytes = view.getUint16(offset + 18, true);
    out.push(level);
    offset = align8(
      offset + 24 + pathBytes + (unitBytes === 0xffff ? 0 : unitBytes),
    );
    offset = align8(offset + bins * 73);
  }
  return out;
};
```

The first test loads the ordinary app, records the overview level, zooms in
until the visible raw slice fits, and asserts the observed levels are
monotonically nonincreasing and end at zero. Also assert the canvas remains
visible while a finer response is pending.

- [ ] **Step 2: Add deterministic adaptive/full visual comparison**

Open two pages at the same viewport. On the second page, the init-script fetch
wrapper rewrites tile-request JSON to set `pixel_width: 1_000_000`, forcing
level zero without changing production code. After both charts settle, copy
their ChartGPU canvases into same-sized 2D canvases with `drawImage` and return
`ImageData.data` arrays.

In the test, mark a pixel different when any RGB channel delta exceeds 16.
Assert differing pixels are at most 0.5% of the plot and run a four-neighbor
flood fill asserting every connected differing component has both width and
height at most one physical pixel. Ignore alpha because both canvases are
composited onto the same opaque token background.

Capture pixels in each page without a new dependency:

```ts
const pixels = await page.evaluate(() => {
  const sources = [
    ...document.querySelectorAll<HTMLCanvasElement>(".chart-host canvas"),
  ];
  const target = document.createElement("canvas");
  target.width = sources[0]?.width ?? 1;
  target.height = sources[0]?.height ?? 1;
  const context = target.getContext("2d");
  if (context === null) throw new Error("2D capture unavailable");
  for (const source of sources) context.drawImage(source, 0, 0);
  return {
    width: target.width,
    height: target.height,
    data: [...context.getImageData(0, 0, target.width, target.height).data],
  };
});
```

- [ ] **Step 3: Prove tab canvas identity reuse**

Extend the existing workspace-tab test. Store the first tab's canvas on
`window.__signalscopeFirstCanvas`, create/select a second populated tab, then
return and assert:

```ts
expect(
  await page.evaluate(
    () =>
      (window as unknown as { __signalscopeFirstCanvas: HTMLCanvasElement })
        .__signalscopeFirstCanvas ===
      document.querySelector(".workspace .chart-host canvas"),
  ),
).toBe(true);
```

This proves the tab switch did not dispose/recreate ChartGPU.

- [ ] **Step 4: Run the complete test sequence**

Run in this order:

```bash
./scripts/format.sh
./scripts/test.sh core
./scripts/test.sh server
./scripts/test.sh frontend
./scripts/ci.sh all
./scripts/test.sh bench all
./scripts/version.sh check
```

Expected: formatting, core, server, frontend, full CI, existing mc1000 bench,
and version synchronization pass. If a pre-existing benchmark floor still
fails, preserve its report and record the measured values; do not loosen the
floor or create a larger corpus in this PR.

- [ ] **Step 5: Perform the approved manual acceptance**

Run `./scripts/run.sh`, load the existing generated `mc1000` corpus, and check:

1. one 1,000-series panel plots without visible overview striation;
2. zooming keeps the old plot responsive, swaps without a visible jump, and
   eventually shows exact level-zero detail;
3. three 1,000-series panels remain responsive;
4. switching among their tabs returns immediately without a first-render
   delay; and
5. a 3,001st visible series is rejected clearly without device instability.

The implementing agent cannot claim this manual GUI result unless it actually
performed it. Otherwise hand these five checks to the maintainer and report
automated results only.

- [ ] **Step 6: Review diffs and commit tests**

```bash
git diff --check
git status --short
git add frontend/tests/e2e/adaptive-resolution.spec.ts frontend/tests/e2e/workbench.spec.ts
git commit -m "test: cover adaptive rendering acceptance"
```

Do not stage unrelated work and do not change version manifests.

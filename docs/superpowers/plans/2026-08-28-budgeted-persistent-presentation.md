# Budgeted Persistent Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed 3,000-series rejection with byte-budgeted uniform resolution and keep prepared CPU plus GPU overview banks resident so fit-to-all is immediate.

**Architecture:** A presentation planner assigns one bins-per-physical-pixel density to the active layout from separate CPU and GPU byte ledgers. Each panel caches prepared overview/detail responses on the CPU and lazily owns matching ChartGPU hosts; fit selects the resident overview host synchronously, while missing banks refine and publish panel-wide by generation.

**Tech Stack:** Rust pyramid/server, TypeScript, typed arrays, vendored ChartGPU/WebGPU, Vitest, Playwright, repository shell wrappers

**Spec:** `docs/superpowers/specs/2026-08-28-budgeted-persistent-presentation-design.md`

## Global Constraints

- Preferred density is exactly `2.0` envelope bins per physical device pixel per visible series.
- Density is uniform across the active layout; different source rates may use different pyramid levels only to satisfy that shared density.
- Auto CPU budget is `deviceMemory * 128 MiB`, clamped to 512 MiB through 2 GiB, with a 512 MiB fallback.
- Auto GPU budget is twice `adapter.limits.maxBufferSize`, clamped to 256 MiB through 1 GiB.
- The active overview and selected bank remain resident; eviction follows the order fixed in the spec.
- No incremental line publication or mixed response generation is permitted.
- Presentation budgets do not change snapshot/export fidelity.
- Do not add runtime dependencies or change the tile protocol.
- Preserve the PR's existing synchronized version `1.1.9`; do not perform a second version bump.
- Use repository scripts for codegen, formatting, tests, builds, E2E, and benchmarks.

---

### Task 1: Record the architecture and add budget preferences

**Files:**

- Create: `docs/adr/0045-budgeted-persistent-presentation.md`
- Modify: `docs/adr/README.md`
- Modify: `protocol/schema/scope-preferences.json`
- Modify: `core/scope-core/src/preferences.rs`
- Modify: `frontend/src/app/preferences.ts`
- Modify: `protocol/testdata/preferences-conformance.json`
- Regenerate: `core/scope-core/src/preferences/generated.rs`
- Regenerate: `frontend/src/generated/preferences.ts`
- Test: `core/scope-core/src/preferences.rs`
- Test: `frontend/src/app/preferences-conformance.test.ts`

**Interfaces:**

- Consumes: preferences schema v6 and ADR 0044.
- Produces: preferences schema v7 with `presentation_cpu_bytes: string | null` and `presentation_gpu_bytes: string | null` in TypeScript, plus the accepted ADR that supersedes ADR 0044's count ceiling.

- [ ] **Step 1: Write failing Rust migration and TypeScript parsing tests**

Add a Rust test proving v6 gains nullable budgets:

```rust
#[test]
fn v6_preferences_gain_auto_presentation_budgets() {
    let stored = serde_json::json!({
        "schema_version": 6,
        "theme": "dark",
        "ui_font_family": "inter",
        "plot_font_family": "jetbrains",
        "ui_font_size": 13.0,
        "plot_font_size": 9.0,
        "plot_line_width_scale": 1.0,
        "cache_max_bytes": DEFAULT_CACHE_MAX_BYTES.to_string()
    });
    let restored = from_json(&stored.to_string()).unwrap();
    assert_eq!(restored.presentation_cpu_bytes, None);
    assert_eq!(restored.presentation_gpu_bytes, None);
}
```

In `preferences-conformance.test.ts`, assert malformed and zero overrides repair to `null`, while positive decimal strings survive.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
./scripts/test.sh core v6_preferences_gain_auto_presentation_budgets
./scripts/test.sh unit preferences-conformance
```

Expected: FAIL because the generated preference fields do not exist.

- [ ] **Step 3: Advance and regenerate the additive preference schema**

Set `schema_version` to `7` and add:

```json
"presentation_cpu_bytes": "u64?",
"presentation_gpu_bytes": "u64?"
```

Add `None` defaults, include version 6 in the migration ladder, repair only positive values, and update `defaultPreferences()` plus `parsePreferences()` using the existing decimal-string helper. Regenerate committed outputs:

```bash
./scripts/codegen.sh
REGENERATE_FIXTURES=1 ./scripts/test.sh core preferences_conformance_fixture_matches_rust
```

- [ ] **Step 4: Write ADR 0045 and index it**

Record these decisions without repeating deliberation: separate tracked CPU/GPU soft budgets, uniform density, persistent overview/detail banks, exact managed-byte accounting, fixed eviction order, no count ceiling, and no claim about total VRAM. State that ADR 0045 supersedes only ADR 0044's cache/residency policy; level-zero and export decisions remain accepted.

- [ ] **Step 5: Run schema and focused preference verification**

Run:

```bash
./scripts/test.sh core preferences
./scripts/test.sh unit preferences
./scripts/format.sh
```

Expected: PASS; generated files and fixture are synchronized.

- [ ] **Step 6: Commit the architecture and schema**

```bash
git add docs/adr/0045-budgeted-persistent-presentation.md docs/adr/README.md protocol/schema/scope-preferences.json protocol/testdata/preferences-conformance.json core/scope-core/src/preferences.rs core/scope-core/src/preferences/generated.rs frontend/src/app/preferences.ts frontend/src/generated/preferences.ts frontend/src/app/preferences-conformance.test.ts
git commit -m "feat(config): add presentation memory budgets"
```

### Task 2: Make ChartGPU report resident series-buffer capacity

**Files:**

- Modify: `frontend/vendor/chartgpu/src/data/createDataStore.ts`
- Modify: `frontend/vendor/chartgpu/src/data/__tests__/createDataStore.test.ts`
- Modify: `frontend/vendor/chartgpu/src/ChartGPU.ts`
- Create: `frontend/vendor/chartgpu/src/__tests__/ChartGPU.performanceMetrics.test.ts`
- Modify: `frontend/vendor/chartgpu` submodule pointer

**Interfaces:**

- Consumes: `SeriesEntry.capacityBytes` and `PerformanceMetrics.memory`.
- Produces: `DataStore.getResidentBytes(): number`; `getPerformanceMetrics().memory.used` and `.allocated` equal current series-buffer capacity, while `.peak` is the high-water mark.

- [ ] **Step 1: Add failing data-store capacity tests**

Create assertions around existing mocked GPU buffers:

```ts
store.setSeries(0, new Float32Array([0, 1, 1, 2]));
const first = store.getSeriesBuffer(0).size;
expect(store.getResidentBytes()).toBe(first);
store.setSeries(1, new Float32Array([0, 3, 1, 4]));
expect(store.getResidentBytes()).toBe(first + store.getSeriesBuffer(1).size);
store.removeSeries(0);
expect(store.getResidentBytes()).toBe(store.getSeriesBuffer(1).size);
```

Add an instance-level test asserting `memory.used > 0` after a line is uploaded and returns to zero after series removal.

- [ ] **Step 2: Run ChartGPU tests and verify they fail**

Run:

```bash
./scripts/test.sh unit createDataStore ChartGPU
```

Expected: FAIL because `getResidentBytes` is absent and memory metrics remain zero.

- [ ] **Step 3: Implement exact current and peak accounting**

Add this data-store method:

```ts
const getResidentBytes = (): number =>
  [...series.values()].reduce((total, entry) => total + entry.capacityBytes, 0);
```

Expose it on `DataStore`. In `ChartGPU.ts`, keep `let peakResidentBytes = 0`, sample `dataStore.getResidentBytes()` in `calculatePerformanceMetrics()`, update the high-water mark, and return current bytes for `used` and `allocated`.

- [ ] **Step 4: Run ChartGPU unit and submodule integrity checks**

Run:

```bash
./scripts/test.sh unit createDataStore ChartGPU
./scripts/chartgpu-submodule.test.sh
```

Expected: PASS.

- [ ] **Step 5: Commit the submodule and parent pointer**

```bash
git -C frontend/vendor/chartgpu add src/data/createDataStore.ts src/data/__tests__/createDataStore.test.ts src/ChartGPU.ts src/__tests__/ChartGPU.performanceMetrics.test.ts
git -C frontend/vendor/chartgpu commit -m "feat(metrics): report resident data buffers"
git add frontend/vendor/chartgpu
git commit -m "chore(chartgpu): track resident presentation bytes"
```

### Task 3: Implement the uniform-density budget planner

**Files:**

- Create: `frontend/src/app/presentation-budget.ts`
- Create: `frontend/src/app/presentation-budget.test.ts`

**Interfaces:**

- Consumes: adapter `maxBufferSize`, optional `navigator.deviceMemory`, explicit preference overrides, retained CPU/GPU bytes, and active panel demand.
- Produces:

```ts
export interface PresentationBudgets {
  cpuBytes: number;
  gpuBytes: number;
}

export interface PanelDemand {
  panelId: string;
  physicalPixels: number;
  paddingRatio: number;
  visibleSeries: number;
}

export interface DensityPlan {
  density: number;
  targetDensity: 2;
  limited: boolean;
  fits: boolean;
  requests: ReadonlyMap<string, number>;
  estimatedCpuBytes: number;
  estimatedGpuBytes: number;
}

export function autoPresentationBudgets(
  adapterMaxBufferSize: number,
  deviceMemoryGiB?: number,
): PresentationBudgets;

export function planPresentationDensity(input: {
  demands: readonly PanelDemand[];
  budgets: PresentationBudgets;
  retainedCpuBytes: number;
  retainedGpuBytes: number;
  maxDensity?: number;
}): DensityPlan;
```

- [ ] **Step 1: Write failing budget and 5,000-series tests**

Cover exact Auto bounds and a deterministic constrained plan:

```ts
expect(autoPresentationBudgets(256 * MIB, 8)).toEqual({
  cpuBytes: 1024 * MIB,
  gpuBytes: 512 * MIB,
});

const plan = planPresentationDensity({
  demands: [
    {
      panelId: "panel-1",
      physicalPixels: 1000,
      paddingRatio: 2,
      visibleSeries: 5000,
    },
  ],
  budgets: { cpuBytes: 512 * MIB, gpuBytes: 256 * MIB },
  retainedCpuBytes: 0,
  retainedGpuBytes: 0,
});
expect(plan.fits).toBe(true);
expect(plan.limited).toBe(true);
expect(plan.density).toBeGreaterThan(0);
expect(plan.density).toBeLessThan(2);
expect(plan.requests.get("panel-1")).toBeGreaterThanOrEqual(1);
```

Also prove two unequal panel widths receive one density, empty layouts consume no budget, explicit retained bytes reduce density, and an impossible minimum returns `fits: false`.

- [ ] **Step 2: Run the planner tests and verify they fail**

Run:

```bash
./scripts/test.sh unit presentation-budget
```

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement Auto budgets and binary-search density planning**

Use exact constants:

```ts
export const TARGET_BINS_PER_PIXEL = 2 as const;
export const CPU_BYTES_PER_BIN = 121;
export const GPU_BYTES_PER_BIN = 96;
export const MIB = 1024 * 1024;
```

For a density candidate, compute each request as
`max(1, ceil(physicalPixels * paddingRatio * density / 2))` and estimate at
most `2 * request * visibleSeries` bins. Test `min(2, maxDensity ?? 2)` first,
then binary search 32 iterations between the largest per-panel minimum density,
`2 / (physicalPixels * paddingRatio)`, and that ceiling. Return `fits: false`
only when the minimum request exceeds a remaining budget.

- [ ] **Step 4: Run focused tests and format**

Run:

```bash
./scripts/test.sh unit presentation-budget
./scripts/format.sh
```

Expected: PASS.

- [ ] **Step 5: Commit the planner**

```bash
git add frontend/src/app/presentation-budget.ts frontend/src/app/presentation-budget.test.ts
git commit -m "feat(frontend): plan uniform presentation density"
```

### Task 4: Represent and account prepared CPU banks

**Files:**

- Modify: `frontend/src/render/m4-feed.ts`
- Modify: `frontend/src/render/m4-feed.test.ts`
- Create: `frontend/src/app/prepared-tile-bank.ts`
- Create: `frontend/src/app/prepared-tile-bank.test.ts`
- Modify: `frontend/src/render/chart-host.ts`
- Modify: `frontend/src/render/chart-host.test.ts`

**Interfaces:**

- Consumes: `ColumnarTileResponse`, M4 feed preparation, and ChartGPU memory metrics.
- Produces:

```ts
export type TileBankRole = "overview" | "detail";

export interface PreparedTileBank {
  id: string;
  role: TileBankRole;
  response: ColumnarTileResponse;
  window: { t0: number; t1: number };
  visibleWindow: { t0: number; t1: number };
  idsKey: string;
  density: number;
  requestedPixelWidth: number;
  feeds: readonly Float32Array[];
  cpuBytes: number;
}

export function prepareTileBank(
  input: Omit<PreparedTileBank, "feeds" | "cpuBytes">,
): PreparedTileBank;
```

`ChartRenderRequest` gains `bank: PreparedTileBank`; `ChartHost.residentGpuBytes()` returns `getPerformanceMetrics().memory.used`.

- [ ] **Step 1: Write failing unique-buffer and prepared-feed tests**

Decode or construct two series whose column views share one `ArrayBuffer`, then assert the backing buffer is counted once and feeds are added once:

```ts
const bank = prepareTileBank(input);
expect(bank.feeds).toHaveLength(2);
expect(bank.cpuBytes).toBe(
  sharedBuffer.byteLength +
    bank.feeds.reduce((sum, feed) => sum + feed.byteLength, 0),
);
```

Add a ChartHost test whose mocked `getPerformanceMetrics()` reports 4096 bytes and assert `residentGpuBytes()` returns 4096.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
./scripts/test.sh unit prepared-tile-bank m4-feed chart-host
```

Expected: FAIL because prepared banks and GPU accounting are absent.

- [ ] **Step 3: Make feed preparation explicit and strongly retained**

Change `prepareResponseFeeds` to return feeds in response series order. Count
unique `ArrayBufferLike` identities from every typed column with a `Set`, add
the feed byte lengths, and freeze the resulting bank metadata. Change
`ChartHost.render()` to read the bank's precomputed feed by series index rather
than calling the weak cache during publication.

- [ ] **Step 4: Run focused tests**

Run:

```bash
./scripts/test.sh unit prepared-tile-bank m4-feed chart-host
```

Expected: PASS; existing extrema and gap tests remain green.

- [ ] **Step 5: Commit prepared-bank accounting**

```bash
git add frontend/src/app/prepared-tile-bank.ts frontend/src/app/prepared-tile-bank.test.ts frontend/src/render/m4-feed.ts frontend/src/render/m4-feed.test.ts frontend/src/render/chart-host.ts frontend/src/render/chart-host.test.ts
git commit -m "feat(render): retain accounted prepared tile banks"
```

### Task 5: Replace the single-entry tile cache with a byte-bounded bank cache

**Files:**

- Replace: `frontend/src/app/tile-window-cache.ts`
- Replace: `frontend/src/app/tile-window-cache.test.ts`

**Interfaces:**

- Consumes: `PreparedTileBank`, panel id, role, signal identity, visible window, and planned density.
- Produces:

```ts
export type BankLookup =
  | { kind: "current"; bank: PreparedTileBank }
  | { kind: "stale"; bank: PreparedTileBank }
  | { kind: "miss" };

export class TileWindowCache {
  lookup(
    panelId: string,
    role: TileBankRole,
    idsKey: string,
    visible: { t0: number; t1: number },
    density: number,
  ): BankLookup;
  overview(panelId: string, idsKey: string): PreparedTileBank | null;
  store(panelId: string, bank: PreparedTileBank, pinned: boolean): void;
  setSelected(panelId: string, bankId: string): void;
  cpuBytes(): number;
  evictCpu(
    bytesNeeded: number,
    activePanelIds: ReadonlySet<string>,
  ): PreparedTileBank[];
  invalidate(panelId?: string): void;
}
```

- [ ] **Step 1: Rewrite tests around multiple bank roles and byte pressure**

Prove one panel retains overview plus detail, lookup checks the requested
density rather than a hardcoded device width, and LRU eviction follows:
superseded active detail, inactive detail, inactive overview. Assert selected
and active overview bank ids never appear in the eviction result.

- [ ] **Step 2: Run cache tests and verify they fail**

Run:

```bash
./scripts/test.sh unit tile-window-cache
```

Expected: FAIL because the existing map stores one response per panel.

- [ ] **Step 3: Implement role-keyed LRU entries and density-aware lookup**

Store entries by bank id and index them by panel. Update a monotonic `lastUsed`
counter on lookup and selection. A response is current when its coverage,
identity, and maximum projected bin span satisfy its chosen density; level zero
is always current for covered raw data. `cpuBytes()` sums each bank once.

- [ ] **Step 4: Run cache and adaptive-query unit tests**

Run:

```bash
./scripts/test.sh unit tile-window-cache pyramid-query
```

Expected: PASS.

- [ ] **Step 5: Commit the CPU bank cache**

```bash
git add frontend/src/app/tile-window-cache.ts frontend/src/app/tile-window-cache.test.ts
git commit -m "feat(frontend): retain overview and detail tile banks"
```

### Task 6: Add persistent overview/detail GPU hosts per panel

**Files:**

- Create: `frontend/src/render/panel-render-banks.ts`
- Create: `frontend/src/render/panel-render-banks.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/panel.test.ts`
- Modify: `frontend/src/styles/app.css`

**Interfaces:**

- Consumes: shared `GpuContext`, `ChartHost`, `TileBankRole`, and complete `ChartRenderRequest` values.
- Produces:

```ts
export class PanelRenderBanks {
  constructor(container: HTMLElement, gpu: GpuContext);
  publish(role: TileBankRole, request: ChartRenderRequest): number;
  select(role: TileBankRole): boolean;
  selectedRole(): TileBankRole | null;
  layout(): PlotLayout | null;
  residentGpuBytes(role?: TileBankRole): number;
  evict(role: TileBankRole): void;
  resize(): void;
  capture(): Promise<HTMLCanvasElement>;
  dispose(): void;
}
```

- [ ] **Step 1: Write failing two-host lifecycle tests**

Mock `ChartHost.create` and assert:

```ts
banks.publish("overview", overviewRequest);
banks.publish("detail", detailRequest);
expect(banks.select("overview")).toBe(true);
expect(overviewElement.hidden).toBe(false);
expect(detailElement.hidden).toBe(true);
expect(overviewHost.render).toHaveBeenCalledTimes(1);
banks.select("detail");
expect(detailHost.render).toHaveBeenCalledTimes(1);
```

Also prove capture/layout use the selected host, resize reaches both, a stable
hidden host is retained, role eviction disposes only that host, and panel
disposal releases both.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
./scripts/test.sh unit panel-render-banks panel
```

Expected: FAIL because PanelView owns one ChartHost.

- [ ] **Step 3: Implement lazy bank hosts and switch PanelView to the manager**

Create two absolutely stacked `.chart-bank` containers inside the existing
`.chart-host`, identified by `data-bank-role="overview|detail"`; only the
selected bank is visible. Do not cross-fade. Replace `chartHost`,
`chartHostReady`, and `pendingChartRender` with the manager and a pending
request per role. Keep the overlay above both hosts. Route hit testing, layout,
capture, resize, theme updates, and release through the selected bank.

- [ ] **Step 4: Run panel and renderer tests**

Run:

```bash
./scripts/test.sh unit panel-render-banks panel chart-host gpu-context
```

Expected: PASS.

- [ ] **Step 5: Commit persistent GPU banks**

```bash
git add frontend/src/render/panel-render-banks.ts frontend/src/render/panel-render-banks.test.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts frontend/src/styles/app.css
git commit -m "feat(render): retain persistent overview GPU banks"
```

### Task 7: Coordinate budgeted refresh, atomic publication, and immediate fit

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/ui/workspace-view.ts`
- Modify: `frontend/src/ui/panel.ts`
- Delete: `frontend/src/app/render-limits.ts`

**Interfaces:**

- Consumes: budget planner, prepared bank cache, panel GPU bank manager,
  existing generation tokens, panel signal extents, and `DataPlane.queryTiles`.
- Produces: one density-planned refresh pass; `WorkspaceView.publishBank(panelId,
role, request)` and `WorkspaceView.selectBank(panelId, role)`; no fixed series
  admission check.

- [ ] **Step 1: Replace the count-cap test with failing budgeted-flow tests**

Delete the expectation for `series limit exceeded`. Add tests proving:

```ts
shell.resolvedFor = vi.fn(() =>
  Array.from({ length: 5000 }, () => ({ visible: true })),
);
await shell.refreshTiles();
expect(queryTiles).toHaveBeenCalled();
expect(new Set(requests.map((request) => request.pixel_width)).size).toBe(1);
expect(shell.reportError).not.toHaveBeenCalled();
```

Add a deep-window setup with a stored overview bank, invoke `fitPanelView`, and
assert `selectBank(panelId, "overview")` occurs synchronously while
`queryTiles`, `prepareTileBank`, and `publishBank` do not run before selection.
Add generation and preparation-failure tests proving current selections remain
unchanged.

- [ ] **Step 2: Run AppShell tests and verify they fail**

Run:

```bash
./scripts/test.sh unit app-shell
```

Expected: FAIL on the fixed cap and missing bank APIs.

- [ ] **Step 3: Implement overview identity and shared-density refresh**

For each panel, derive its full signal extent and classify a full-extent query
as `overview`; classify a narrower effective window as `detail`. Before issuing
requests:

1. select a current resident role if present;
2. collect active panel demands;
3. compute one `DensityPlan` from current retained usage;
4. query missing/stale roles with the plan's per-panel `pixel_width`;
5. call `prepareTileBank` for every replacement;
6. store and publish complete banks only if the generation remains current.

When a fit gesture has a resident overview, call `selectBank` before updating
the linked window and scheduling refinement. Keep range-only gestures on the
selected host.

- [ ] **Step 4: Add the one-retry allocation path**

On a current-generation preparation or GPU publication allocation error,
preserve the selected role, request eviction, call `planPresentationDensity`
with `maxDensity` set to half the failed plan's density, and retry the complete
active layout once. Mark the generation failed after the second failure and
report requested versus available managed bytes. Do not retry uncaptured errors
or device loss here.

- [ ] **Step 5: Run AppShell, cache, and panel tests**

Run:

```bash
./scripts/test.sh unit app-shell tile-window-cache panel
```

Expected: PASS, including 5,000-series admission and immediate overview
selection.

- [ ] **Step 6: Commit the refresh coordinator**

```bash
git add frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/ui/workspace-view.ts frontend/src/ui/panel.ts frontend/src/app/render-limits.ts
git commit -m "feat(frontend): publish budgeted panel banks atomically"
```

### Task 8: Replace count-based tab residency and expose presentation status

**Files:**

- Create: `frontend/src/app/presentation-residency.ts`
- Create: `frontend/src/app/presentation-residency.test.ts`
- Delete: `frontend/src/ui/panel-residency.ts`
- Delete: `frontend/src/ui/panel-residency.test.ts`
- Modify: `frontend/src/ui/workspace-view.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/app/preferences.ts`
- Modify: `frontend/src/styles/app.css`

**Interfaces:**

- Consumes: CPU cache entries, per-role GPU bytes from every PanelView, active
  panel ids, budget overrides, planner output, and existing settings commands.
- Produces:

```ts
export type EvictionAction = {
  panelId: string;
  role: TileBankRole;
  medium: "gpu" | "cpu";
};

export interface ResidentBank {
  panelId: string;
  role: TileBankRole;
  cpuBytes: number;
  gpuBytes: number;
  selected: boolean;
  superseded: boolean;
  active: boolean;
  lastUsed: number;
}

export function planPresentationEvictions(input: {
  cpuBytes: number;
  gpuBytes: number;
  budgets: PresentationBudgets;
  banks: readonly ResidentBank[];
  activePanelIds: ReadonlySet<string>;
}): readonly EvictionAction[];
```

`WorkspaceView.presentationUsage()` returns current per-role GPU residency and
`WorkspaceView.evictGpu(panelId, role)` executes a GPU action.

- [ ] **Step 1: Write failing deterministic eviction tests**

Create a fixture containing inactive detail/overview, superseded active detail,
inactive CPU detail/overview, selected active detail, and active overview.
Assert the first five categories match the spec order and neither active pin is
returned. Replace the old three-thousand-series test with byte totals.

- [ ] **Step 2: Write failing status and settings tests**

Assert 79% target usage renders no presentation text, 82% renders
`presentation 82%`, and a limited plan renders exactly:

```text
resolution limited · 0.8/2.0 bins/px · 5,000 series
```

Assert CPU/GPU settings cycle Auto, 256 MiB, 512 MiB, 1 GiB, and 2 GiB, save
decimal-byte preferences, and retain the configured total ceiling while each
ChartGPU series buffer remains separately bounded by device hard limits.

- [ ] **Step 3: Run residency and AppShell tests and verify they fail**

Run:

```bash
./scripts/test.sh unit presentation-residency app-shell preferences
```

Expected: FAIL because count-based residency and status remain.

- [ ] **Step 4: Implement byte eviction and status rendering**

Apply eviction actions before lowering active density. Update LRU timestamps on
tab activation and bank selection. Add a `.presentation-stat` beside render
time, achromatic under the design tokens, with a tooltip naming managed CPU/GPU
budgets and recovery actions. Hide it below 80% at target density.

Wire the completed eviction planner into `refreshTilesPass` before its density
calculation so inactive residency creates headroom before the active layout is
degraded.

- [ ] **Step 5: Implement advanced budget settings**

Add two settings entries that cycle the fixed choices, format labels as `Auto`,
`256 MiB`, `512 MiB`, `1 GiB`, or `2 GiB`, persist through the existing delayed
preference save, invalidate only budget planning, and schedule a 250 ms upgrade
refresh. Do not clear resident banks merely because a ceiling increases.

- [ ] **Step 6: Run focused frontend tests**

Run:

```bash
./scripts/test.sh unit presentation-residency app-shell preferences workspace-view
./scripts/format.sh
```

Expected: PASS.

- [ ] **Step 7: Commit residency and status behavior**

```bash
git add frontend/src/app/presentation-residency.ts frontend/src/app/presentation-residency.test.ts frontend/src/ui/panel-residency.ts frontend/src/ui/panel-residency.test.ts frontend/src/ui/workspace-view.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/app/preferences.ts frontend/src/styles/app.css
git commit -m "feat(ui): surface budgeted presentation residency"
```

### Task 9: Add browser acceptance and benchmark evidence

**Files:**

- Modify: `frontend/tests/e2e/adaptive-resolution.spec.ts`
- Modify: `frontend/tests/e2e/workbench.spec.ts`
- Modify: `frontend/tests/bench/bench.spec.ts`
- Modify: `frontend/tests/bench/measure.ts`
- Modify: `scripts/collect-bench-report.mjs` only if the new report shape needs aggregation support

**Interfaces:**

- Consumes: public browser behavior, test probes, `mc1000` artifact, and status text.
- Produces: E2E proof of persistent overview switching and uniform 5,000-series planning; benchmark fields `fit_overview_ms`, `presentation_density`, `visible_series`, and `query_count_during_fit`.

- [ ] **Step 1: Add a failing persistent-overview E2E probe**

Extend the init probe to count tile requests and prepared bank publications.
Load the app, zoom until the selected detail reaches level zero, record counts,
double-click the overlay, and assert within one animation frame:

```ts
interface BudgetResolutionProbe extends ResolutionProbe {
  __signalscopeTileQueryCount: number;
  __signalscopePreparedBankCount: number;
}

const selectedBankRole = (target: Page): Promise<string | null> =>
  target.evaluate(
    () =>
      (
        document.querySelector(
          ".panel .chart-bank:not([hidden])",
        ) as HTMLElement | null
      )?.dataset.bankRole ?? null,
  );
const tileQueryCount = (target: Page): Promise<number> =>
  target.evaluate(
    () =>
      (window as unknown as BudgetResolutionProbe).__signalscopeTileQueryCount,
  );
const preparedBankCount = (target: Page): Promise<number> =>
  target.evaluate(
    () =>
      (window as unknown as BudgetResolutionProbe)
        .__signalscopePreparedBankCount,
  );
expect(await selectedBankRole(page)).toBe("overview");
expect(await tileQueryCount(page)).toBe(beforeQueries);
expect(await preparedBankCount(page)).toBe(beforePrepared);
```

Then wait for stability and assert no partial canvas clearing occurred.

- [ ] **Step 2: Add a failing 5,000-series E2E scenario**

Use route fixtures to expose 1,000 sources with five visible channels and
return bounded synthetic binary tiles at the requested width. Assert the app
becomes ready, no `series limit exceeded` text appears, every request uses the
same planned density, the status names 5,000 series when limited, zoom increases
or preserves density, and fit selects overview.

- [ ] **Step 3: Run the completed browser acceptance scenarios**

Run:

```bash
CI=1 ./scripts/test.sh e2e
```

Expected: PASS. If a user-run server occupies port 8317, stop that manual server
before rerunning; do not change test auth to mask the conflict.

- [ ] **Step 4: Add fit and density measurements to the browser benchmark**

After the existing interaction probe, zoom deeply, wait for detail stability,
measure double-click through the first overview frame, and write:

```ts
{
  fit_overview_ms: fitOverviewMs,
  floor_fit_overview_ms: 33,
  presentation_density: density,
  visible_series: visibleSeries,
  query_count_during_fit: queryCountAfter - queryCountBefore
}
```

Include `fitOverviewMs <= 33` and `query_count_during_fit === 0` in the report's
`pass` expression. Do not weaken existing frame or stall floors.

- [ ] **Step 5: Run E2E and bounded browser benchmarks**

Run:

```bash
CI=1 ./scripts/test.sh e2e
SIGNALSCOPE_BENCH_FILES=2 ./scripts/test.sh bench e2e
```

Expected: all 50-plus desktop tests pass; the bounded benchmark emits the new
fields and passes its existing and new floors.

- [ ] **Step 6: Commit acceptance coverage**

```bash
git add frontend/tests/e2e/adaptive-resolution.spec.ts frontend/tests/e2e/workbench.spec.ts frontend/tests/bench/bench.spec.ts frontend/tests/bench/measure.ts scripts/collect-bench-report.mjs
git commit -m "test: cover persistent budgeted presentation"
```

### Task 10: Synchronize documentation and run the complete handoff gate

**Files:**

- Modify: `README.md`
- Modify: `docs/implementation-roadmap.md`
- Modify: `docs/adr/0044-adaptive-resolution-presentation.md` only to add a superseded-policy pointer to ADR 0045
- Review: all files changed by Tasks 1-9

**Interfaces:**

- Consumes: completed behavior and benchmark output.
- Produces: user-facing documentation, clean formatting, synchronized generated files, full CI evidence, preserved benchmark diagnostics, and manual acceptance instructions.

- [ ] **Step 1: Update behavior documentation**

Replace the 3,000-series ceiling language with: uniform budgeted density,
persistent prepared CPU/GPU overview banks, inactive-bank byte eviction, exact
level-zero zoom endpoint, and honest managed-budget status. State that WebGPU
does not expose total/free VRAM and exports remain explicit and unchanged.

- [ ] **Step 2: Run formatting and focused cross-layer suites**

Run:

```bash
./scripts/format.sh
./scripts/test.sh core pyramid
./scripts/test.sh server query_tiles_bin
./scripts/test.sh frontend
```

Expected: PASS.

- [ ] **Step 3: Run the complete CI-equivalent gate**

Ensure no manual `scope-server` is occupying port 8317, then run:

```bash
CI=1 ./scripts/ci.sh all
```

Expected: PASS, including the complete serial WebGPU E2E suite.

- [ ] **Step 4: Run and preserve the full benchmark report**

Run:

```bash
CI=1 ./scripts/test.sh bench all
```

Expected: the new browser fit fields are present. Record every result from
`build/bench/report.json`; do not describe legacy `query_raw` floor failures as
adaptive-path regressions.

- [ ] **Step 5: Verify release metadata without another bump**

Run:

```bash
./scripts/version.sh check
```

Expected: manifests remain synchronized at `1.1.9`. Do not run
`./scripts/version.sh bump` because this PR already contains its single version
increment.

- [ ] **Step 6: Review repository state and commit documentation**

```bash
git status --short
git diff --check
git add README.md docs/implementation-roadmap.md docs/adr/0044-adaptive-resolution-presentation.md
git commit -m "docs: describe budgeted presentation residency"
```

- [ ] **Step 7: Hand off manual GPU acceptance**

Ask the maintainer to launch through `./scripts/run.sh app`, load all five
channels from the 1,000-source corpus, and verify: 5,000 lines render without a
count error; the status reports any density reduction; zoom reaches exact raw
samples; repeated double-click fit shows the overview immediately; tab returns
reuse GPU or CPU residency according to pressure; and no mixed-generation
lines, blank frame, device loss, or forced exit occurs.

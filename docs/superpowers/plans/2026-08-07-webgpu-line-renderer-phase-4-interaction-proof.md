# WebGPU Line Renderer Phase 4: Interaction and Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete nonblocking pan/zoom/refinement and GPU picking, then prove fidelity and performance at 1,000 and 10,000 visible series.

**Architecture:** A generation-based acquisition controller delivers coarse tiles for every visible series before any refinement, reuses padded resident windows for transform-only pan, and swaps detail atomically by panel generation. A GPU compute picker searches the selected point range once per visible series, reduces to one deterministic nearest result, and returns through a mapped-buffer ring without blocking frames. Structural counters, software-adapter image tests, and full-scale benchmark reports enforce the no-drop/no-merge contract.

**Tech Stack:** WebGPU compute, asynchronous map-read buffers, Playwright Chromium/SwiftShader, Rust deterministic corpus generation, browser PerformanceObserver, repository benchmark/report scripts.

## Global Constraints

- Coarse tiles for all visible series arrive before fine tiles for any series.
- Pan inside resident padded windows performs zero point upload and zero descriptor rebuild.
- Stale request generations never alter residency, selected LOD, axes, or warnings.
- Memory pressure coarsens the panel as a whole; it never removes a subset of visible series.
- Pointer movement never performs a CPU vertex scan, synchronous render, tile query, or mapped-buffer wait.
- Hover uses the latest completed pick and updates Canvas overlay/tooltip only; it does not restyle series or request a WebGPU plot frame.
- Click may await one explicit pick in its event task, but rendering continues independently.
- Every visible series contributes descriptors whenever it contains at least one valid segment. Counters must equal this cardinality; aggregate substitution is a test failure.
- Interaction floor: frame p95 at most 33 ms and longest frame/long task at most 250 ms for mc1000 and dense10k.
- Interaction target: frame p95 at most one display interval and longest stall at most 100 ms.
- Final validation includes GUI, GPU integration, end-to-end, native bundle, snapshot artifacts, and the complete quality gate.
- The final change is one major application version bump because session/protocol compatibility was intentionally broken.
- Start only from a committed Phase 3 completion gate. Before Task 1, run `git status --short`, inspect target files and nearby tests, and preserve unrelated changes.

---

## Resulting File Structure

- `frontend/src/app/tile-refinement.ts` — coarse-first, chunked, generation-safe acquisition.
- `frontend/src/render/gpu/picker.ts` — dispatch, reduction, readback ring, and request sequencing.
- `frontend/src/render/gpu/shaders/pick-series.wgsl` — one invocation per visible series.
- `frontend/src/render/gpu/shaders/pick-reduce.wgsl` — deterministic nearest reduction.
- `frontend/src/render/gpu/metrics.ts` — production counters with a bench-only read API.
- `frontend/tests/gpu/line-renderer.spec.ts` — software-adapter fidelity images and structural assertions.
- `frontend/tests/bench/bench.spec.ts` — mc1000 and dense10k performance matrix.
- `core/scope-core/src/benchmarks/corpus.rs` — deterministic 10,000-series/100M-sample tier.

### Task 1: Add Coarse-First Generation-Safe Tile Refinement

**Files:**

- Create: `frontend/src/app/tile-refinement.ts`
- Create: `frontend/src/app/tile-refinement.test.ts`
- Modify: `frontend/src/app/tile-window-cache.ts`
- Modify: `frontend/src/app/tile-window-cache.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/render/gpu/residency.ts`

**Interfaces:**

```ts
export const COARSE_POINT_TARGET = 64;
export const SERIES_CHUNK_SIZE = 128;

export interface RefinementRequest {
  readonly panelId: string;
  readonly generation: number;
  readonly signalIds: readonly string[];
  readonly window: { t0: number; t1: number };
  readonly target: number;
}

export interface RefinementSink {
  acceptCoarse(generation: number, response: ColumnarTileResponse): void;
  acceptFine(generation: number, response: ColumnarTileResponse): void;
  fail(generation: number, signalIds: readonly string[], error: unknown): void;
}
```

- [ ] **Step 1: Add scheduling-order tests**

With 300 IDs, deferred query promises, and chunk size 128, assert request order is:

```text
coarse ids[0..128]
coarse ids[128..256]
coarse ids[256..300]
fine ids[0..128]
fine ids[128..256]
fine ids[256..300]
```

Assert fine requests do not begin until all coarse chunks resolve, while each coarse response is delivered immediately. Assert a new generation causes every old response/error to be ignored.

- [ ] **Step 2: Add resident-pan and common-coarsening tests**

Prime a padded cache/residency window, pan within it, and assert query count, upload bytes, and descriptor rebuild count stay zero. Force the second fine allocation to fail and assert the selected set reverts all series to the complete coarse generation rather than keeping a fine subset.

- [ ] **Step 3: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/app/tile-refinement.test.ts frontend/src/app/tile-window-cache.test.ts frontend/src/ui/app-shell.test.ts`

Expected: FAIL because acquisition currently performs one undifferentiated target request.

- [ ] **Step 4: Implement generation and chunking**

Sort IDs by exact panel series-slot order, not numeric/string ID. Pad the window once. Coarse requests use `pixel_width: COARSE_POINT_TARGET`; fine requests use `TileWindowCache.requestPixelWidth(target, visible, padded)`. Query chunks sequentially within each phase to cap transient IPC/ArrayBuffer pressure.

- [ ] **Step 5: Publish coarse and fine selections safely**

`acceptCoarse` uploads and pins each chunk, merges it into the generation's coarse map, and lets the panel render partial coarse availability with an explicit missing-data state for not-yet-arrived series. Fine chunks upload as superseding candidates, but the panel swaps from coarse to fine only after all visible series have a resident fine candidate. If budget cannot hold the complete fine set, discard/supersede all fine candidates and keep coarse.

- [ ] **Step 6: Make resident pan transform-only**

Before scheduling a request, ask residency/cache whether every visible series has a selected tile covering the new window at the selected target. If yes, update only viewport/axes and schedule a GPU frame. Crossing the padded boundary starts a new coarse/fine generation while the prior selected tiles remain visible.

- [ ] **Step 7: Verify scheduler tests**

Run: `./scripts/test.sh unit frontend/src/app/tile-refinement.test.ts frontend/src/app/tile-window-cache.test.ts frontend/src/ui/app-shell.test.ts frontend/src/render/gpu/residency.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/tile-refinement.ts frontend/src/app/tile-refinement.test.ts frontend/src/app/tile-window-cache.ts frontend/src/app/tile-window-cache.test.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/ui/panel.ts frontend/src/render/gpu/residency.ts
git commit -m "feat(plot): refine every visible series coarse-first"
```

### Task 2: Implement GPU Time-Series Picking and Async Readback

**Files:**

- Create: `frontend/src/render/gpu/picker.ts`
- Create: `frontend/src/render/gpu/picker.test.ts`
- Create: `frontend/src/render/gpu/shaders/pick-series.wgsl`
- Create: `frontend/src/render/gpu/shaders/pick-reduce.wgsl`
- Modify: `frontend/src/render/gpu/line-renderer.ts`
- Modify: `frontend/src/render/gpu/runtime.ts`

**Interfaces:**

```ts
export interface PickRequest {
  readonly sequence: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly radius: number;
  readonly explicit: boolean;
}

export interface PickResult {
  readonly sequence: number;
  readonly seriesSlot: number;
  readonly time: number;
  readonly value: number;
  readonly distance: number;
}

export class GpuPicker {
  request(request: PickRequest): Promise<PickResult | null>;
  latest(): PickResult | null;
  encode(encoder: GPUCommandEncoder): void;
}
```

- [ ] **Step 1: Add picker scheduling/readback tests**

Mock three readback buffers and assert hover requests above 30 Hz replace the pending hover instead of allocating/dispatching. Assert sequence 8 completing before sequence 7 remains latest. Assert no `mapAsync` promise is awaited by `encode` or pointer callbacks. Assert explicit requests are queued behind an in-flight slot and resolve their own promise.

- [ ] **Step 2: Add CPU-reference nearest tests**

Build fixtures for exact point, interpolation between adjacent points, a gap, same-distance series tie, hidden series, epoch timestamps, and values outside radius. Tie-break by lower stable series slot. The GPU result layout is:

```text
u32 sequence
u32 series_slot
f32 distance
f32 time_offset
f32 value
u32 valid
u32 reserved0
u32 reserved1
```

- [ ] **Step 3: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/picker.test.ts`

Expected: FAIL because the picker does not exist.

- [ ] **Step 4: Implement one invocation per visible series**

Dispatch once per arena page over that page's selected tile directories. Each invocation:

1. exits for hidden/empty series;
2. converts cursor time to the tile's relative origin;
3. binary-searches ordered points for the adjacent pair;
4. refuses interpolation when the right point has `BREAK_BEFORE`;
5. projects the nearest point/segment in device pixels;
6. writes one candidate indexed by stable series slot.

No invocation scans an entire line.

- [ ] **Step 5: Reduce candidates deterministically**

Use 256-thread hierarchical workgroup reduction over candidate distance. Invalid candidates behave as positive infinity. Compare `(distance, seriesSlot)` lexicographically. Reuse high-water buffers. Write the final 32-byte result to a storage/copy buffer.

- [ ] **Step 6: Copy through a three-buffer readback ring**

During `encode`, copy one result into the next free `MAP_READ | COPY_DST`
buffer and record that slot. Start `mapAsync` from `afterSubmit`, then resolve
asynchronously and immediately unmap after copying eight scalar fields. If all
three slots are busy, drop replaceable hover work; explicit work waits for the
next free slot without stalling render submission.

- [ ] **Step 7: Integrate picker encode with the shared frame**

`GpuLineRenderer` marks picker compute dirty separately from plot render dirty. A pick-only frame encodes compute/copy but no render pass. Runtime still makes one queue submission for all dirty panel render and pick work.

- [ ] **Step 8: Verify tests and build**

Run: `./scripts/test.sh unit frontend/src/render/gpu/picker.test.ts frontend/src/render/gpu/line-renderer.test.ts frontend/src/render/gpu/runtime.test.ts`

Run: `./scripts/build.sh web`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/render/gpu/picker.ts frontend/src/render/gpu/picker.test.ts frontend/src/render/gpu/shaders/pick-series.wgsl frontend/src/render/gpu/shaders/pick-reduce.wgsl frontend/src/render/gpu/line-renderer.ts frontend/src/render/gpu/runtime.ts
git commit -m "feat(gpu): pick nearest time series asynchronously"
```

### Task 3: Replace CPU Hover/Click Paths with Completed GPU Picks

**Files:**

- Modify: `frontend/src/app/time-plot.ts`
- Modify: `frontend/src/app/time-plot.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/panel.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/render/overlay-renderer.ts`
- Modify: `frontend/src/render/overlay-renderer.test.ts`

**Interfaces:**

- `PreparedTimePlot` no longer exposes CPU `seriesAt`, `cursorAt`, or `annotationAt` scans.
- Panel maps `seriesSlot` back to exact series ref/path/style through `SeriesSlots`.

- [ ] **Step 1: Add pointer-path negative tests**

In panel tests, dispatch 100 pointer moves over a 10,000-series fixture and assert: zero calls to tile acquisition; zero calls to `GpuLineRenderer.setTiles`; zero plot frame requests; at most the throttled number of `picker.request` calls; overlay/tooltip uses only completed results.

Add a click test whose explicit pick promise is unresolved while a pan frame is requested and encoded successfully.

- [ ] **Step 2: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/ui/panel.test.ts frontend/src/ui/app-shell.test.ts frontend/src/app/time-plot.test.ts`

Expected: FAIL while temporary CPU hit behavior or disabled hover remains.

- [ ] **Step 3: Wire hover to latest completed picks**

Pointer move submits a replaceable pick request and immediately reads `picker.latest()`. If the result is within radius, map slot to path and show one bounded tooltip row plus one Canvas overlay marker. A later completion schedules an overlay-only draw if pointer coordinates still match its sequence. Do not call `setStyles` for hover.

- [ ] **Step 4: Wire click and keyboard behavior**

Shift-click and Alt-click await one explicit pick, then call existing focus/mute callbacks. Plain click pins an annotation with exact picked time/value. Enter on a keyboard-selected legend item remains unchanged; right-click remains nonessential.

- [ ] **Step 5: Remove CPU scan code**

Delete `nearestLine`, `nearestVertex`, temporary point reconstruction for hit testing, and any pointer loop over `series` or `bins`. Keep compact CPU statistics and annotation resolution; annotations resolve from their pinned values until a later pick updates them.

- [ ] **Step 6: Verify interaction unit tests**

Run: `./scripts/test.sh unit frontend/src/ui/panel.test.ts frontend/src/ui/app-shell.test.ts frontend/src/app/time-plot.test.ts frontend/src/render/overlay-renderer.test.ts`

Expected: PASS.

- [ ] **Step 7: Run CPU-scan gate**

```bash
! rg -n 'nearestLine|nearestVertex|for .*series.*pointer|pointermove[\s\S]{0,400}queryTiles' frontend/src
```

Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/time-plot.ts frontend/src/app/time-plot.test.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/render/overlay-renderer.ts frontend/src/render/overlay-renderer.test.ts
git commit -m "feat(plot): drive hover and clicks from GPU picks"
```

### Task 4: Expose Structural and Timing Metrics Without Polluting Production

**Files:**

- Create: `frontend/src/render/gpu/metrics.ts`
- Create: `frontend/src/render/gpu/metrics.test.ts`
- Modify: `frontend/src/render/gpu/runtime.ts`
- Modify: `frontend/src/render/gpu/arena.ts`
- Modify: `frontend/src/render/gpu/residency.ts`
- Modify: `frontend/src/render/gpu/descriptor-builder.ts`
- Modify: `frontend/src/render/gpu/line-renderer.ts`
- Modify: `frontend/src/render/gpu/picker.ts`
- Modify: `frontend/src/ui/app-shell.ts`

**Interfaces:**

```ts
export interface GpuMetricsSnapshot {
  frameCount: number;
  frameCpuMs: number[];
  uploadBytes: number;
  residentBytes: number;
  residentPages: number;
  drawCalls: number;
  submittedSegments: number;
  visibleSeries: number;
  seriesWithSegments: number;
  descriptorRebuilds: number;
  pickLatencyMs: number[];
  deviceRecoveryMs: number[];
}
```

- [ ] **Step 1: Add counter-reset and cardinality tests**

Assert counters accumulate monotonically, `snapshot()` returns copies, and `reset()` clears interval counters but keeps current resident bytes. Given 1,000 directories where 17 contain no valid edge, assert `visibleSeries=1000` and `seriesWithSegments=983`; no counter may substitute descriptor pages for series cardinality.

- [ ] **Step 2: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/metrics.test.ts`

Expected: FAIL because metrics do not exist.

- [ ] **Step 3: Instrument ownership boundaries**

Count bytes only in arena writes, resident bytes only in allocator
allocate/free, descriptor rebuilds only in rebuild calls, and draw calls at
render-pass encoding. Compute `submittedSegments` structurally from adjacent
selected-tile point pairs whose second point lacks `BREAK_BEFORE`, and assert
that the descriptor scan's total matches it in tests; do not add a per-frame
GPU count readback. Measure frame CPU around the entire shared RAF callback,
pick latency from request timestamp to readback completion, and recovery from
loss observation to first successful restored frame.

- [ ] **Step 4: Publish a bench-only read API**

When `import.meta.env.MODE === "test"` or URL query contains `signalscope-bench=1`, expose:

```ts
window.__signalscopeBench = {
  snapshot: () => runtime.metrics.snapshot(),
  reset: () => runtime.metrics.reset(),
  loseDeviceForTest: () => runtime.destroyDeviceForTest(),
};
```

Do not expose tile data, point arrays, or mutating production state. Production without the query flag has no global.
`destroyDeviceForTest()` calls `device.destroy()` and exists solely for this
gated benchmark hook; ordinary application code must not call it.

- [ ] **Step 5: Replace the misleading renderer-only status**

Update `.render-ms` from the old synchronous Canvas time to the latest whole-workspace frame CPU duration, labeled `frame X.X ms`. Update at most twice per second. Acquisition/refinement timings remain benchmark metrics, not falsely included in one render number.

- [ ] **Step 6: Verify tests**

Run: `./scripts/test.sh unit frontend/src/render/gpu/metrics.test.ts frontend/src/render/gpu/runtime.test.ts frontend/src/ui/app-shell.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/render/gpu frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts
git commit -m "perf(gpu): expose complete frame and fidelity counters"
```

### Task 5: Add Software-Adapter Fidelity and Precision Tests

**Files:**

- Modify: `frontend/playwright.config.ts`
- Modify: `scripts/test.sh`
- Create: `frontend/tests/gpu/fixtures.ts`
- Create: `frontend/tests/gpu/line-renderer.spec.ts`
- Create: `frontend/tests/gpu/line-renderer.spec.ts-snapshots/` generated PNG baselines
- Modify: `frontend/src/node-builtins.d.ts` if Playwright snapshot helpers require missing declarations

**Interfaces:**

- Adds canonical command `./scripts/test.sh gpu [--update-snapshots]`.
- GPU project runs Chromium with WebGPU enabled and SwiftShader software rendering.

- [ ] **Step 1: Add the GPU Playwright project and script route**

Configure:

```ts
{
  name: "gpu",
  testDir: "./tests/gpu",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1000, height: 600 },
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader"],
    },
  },
}
```

`./scripts/test.sh gpu` invokes this project; optional `--update-snapshots` is forwarded only by this route. Default e2e includes the GPU project only at the final `full` gate, not ordinary desktop smoke.

- [ ] **Step 2: Create deterministic baked fixtures**

Create in-memory manifests for: ordered min-before-max and max-before-min, repeated extrema indexes, leading/middle/trailing NaN gaps, 50 overlapping series, quad/hairline threshold on either side, focused/dashed/wide exceptions, light/dark tokens, and epoch timestamp deep zoom.

- [ ] **Step 3: Add structural assertions before screenshots**

For every fixture, await a metrics frame and assert expected `visibleSeries`, `seriesWithSegments`, `submittedSegments`, descriptor rebuild count, and draw-call upper bound:

```ts
expect(metrics.drawCalls).toBeLessThanOrEqual(metrics.residentPages * 2 + 1);
expect(metrics.seriesWithSegments).toBe(expectedDrawableSeries);
```

Pan inside the fixture's padded window and assert upload bytes/descriptors remain zero after metrics reset.

- [ ] **Step 4: Add bounded image comparisons**

Capture `.plot-stack` with animations disabled. Use `toHaveScreenshot` with `maxDiffPixelRatio: 0.02` and `threshold: 0.2`. Assert gap rectangles remain background-colored and each known outlier trajectory touches its expected pixel mask, so a globally similar aggregate image cannot pass.

- [ ] **Step 5: Add epoch precision proof**

Expose projected test points from the fixture only as expected CSS coordinates, not internal GPU data. Read nontransparent pixel bounds around each and assert center differs from the f64 CPU reference by less than 0.25 device pixel.

- [ ] **Step 6: Generate baselines and rerun cleanly**

Run: `./scripts/test.sh gpu --update-snapshots`

Review every generated image, then run: `./scripts/test.sh gpu`

Expected: PASS on the software adapter without updating files on the second run.

- [ ] **Step 7: Commit**

```bash
git add frontend/playwright.config.ts scripts/test.sh frontend/tests/gpu frontend/src/node-builtins.d.ts
git commit -m "test(gpu): prove line fidelity on a software adapter"
```

### Task 6: Add the 10,000-Series/100M-Sample Corpus and Bench Matrix

**Files:**

- Modify: `core/scope-core/src/benchmarks/corpus.rs`
- Modify: `core/scope-core/src/benchmarks/mod.rs`
- Modify: `scripts/test.sh`
- Modify: `scripts/collect-bench-report.mjs`
- Modify: `frontend/tests/bench/measure.ts`
- Modify: `frontend/tests/bench/bench.spec.ts`
- Create: `examples/bench/dense10k.workspace.json`
- Modify: `.github/workflows/bench.yml`

**Interfaces:**

- Corpus tier `dense10k`: 10,000 files, 10,000 intervals plus row zero, one plotted channel, 100,010,000 plotted samples.
- Reports: `e2e_mc1000.json`, `e2e_dense10k.json`, and one aggregate `report.json`.

- [ ] **Step 1: Add deterministic corpus tests**

Define:

```rust
pub fn dense10k() -> TierSpec {
    TierSpec {
        name: "dense10k",
        files: 10_000,
        rows: 10_000,
        hz: 10.0,
        channels: &["response"],
        nan_every: 100,
        nan_rows: 4_000..4_200,
    }
}
```

Increment `GENERATOR_VERSION`. Test total plotted sample count from the spec arithmetic and byte stability on a three-file slice.

- [ ] **Step 2: Run corpus tests to verify expected behavior**

Run: `./scripts/test.sh core corpus`

Expected: PASS after adding the tier; this test does not generate all 10,000 files.

- [ ] **Step 3: Add ignored full-tier generation and bake routes**

Add `bench_corpus_dense10k` and script selection `SIGNALSCOPE_BENCH_TIER=mc1000|dense10k|all`. Full scheduled bench generates/reuses both under `build/bench/corpus/`, bakes one time-only snapshot per tier, and writes bake seconds/bytes/input files.

- [ ] **Step 4: Expand frame measurement**

`measure.ts` returns p50/p95/max frame interval, long-task max, interaction elapsed, and `window.__signalscopeBench.snapshot()`. Add helpers for ten wheel zooms, six ctrl-drags, one box zoom, a resident-window pan, 30 hover picks, and one device-loss recovery.

- [ ] **Step 5: Write one parameterized browser bench**

For each tier record:

```json
{
  "cold_first_plot_ms": 0,
  "coarse_first_ms": 0,
  "refinement_ms": 0,
  "upload_bytes": 0,
  "resident_gpu_bytes": 0,
  "draw_calls": 0,
  "submitted_segments": 0,
  "visible_series": 0,
  "series_with_segments": 0,
  "frame_p50_ms": 0,
  "frame_p95_ms": 0,
  "frame_max_ms": 0,
  "longest_task_ms": 0,
  "pick_p95_ms": 0,
  "device_recovery_ms": 0,
  "resident_pan_upload_bytes": 0,
  "resident_pan_descriptor_rebuilds": 0
}
```

The zeros above define required keys, not accepted results. Set `pass` only when visible/expected drawable cardinalities match, resident pan counters are zero, frame p95 is `<= 33`, and `max(frame_max,longest_task) <= 250`.

- [ ] **Step 6: Enforce no-drop cardinality**

mc1000 workspace binds one channel across 1,000 sources; dense10k binds one channel across 10,000. Assert `visible_series` equals exactly 1,000/10,000. Derive expected drawable count from gap-only fixtures; for these corpora it equals visible count. A lower count fails even if timing passes.

- [ ] **Step 7: Update scheduled benchmark and aggregation**

Scheduled workflow runs both tiers non-blocking as before and uploads corpus-independent reports. Collector rejects duplicate bench names, missing required keys, nonfinite numbers, or any `pass: false`.

- [ ] **Step 8: Run smoke and full acceptance separately**

Run bounded local smoke:

`SIGNALSCOPE_BENCH_FILES=20 SIGNALSCOPE_BENCH_DENSE10K_FILES=100 ./scripts/test.sh bench e2e`

Expected: harness completes and reports cardinality for the bounded inputs.

Run full hardware acceptance on the designated benchmark host:

`SIGNALSCOPE_BENCH_TIER=all ./scripts/test.sh bench`

Expected: both full reports pass the 33 ms/250 ms floors. Record target misses (`> one display interval` or `> 100 ms`) in the report without weakening the hard floor.

- [ ] **Step 9: Commit**

```bash
git add core/scope-core/src/benchmarks scripts/test.sh scripts/collect-bench-report.mjs frontend/tests/bench examples/bench/dense10k.workspace.json .github/workflows/bench.yml
git commit -m "perf(bench): enforce 1000 and 10000 series floors"
```

### Task 7: Close Documentation, Remove Obsolete Artifacts, and Version the PR

**Files:**

- Modify: `docs/implementation-roadmap.md`
- Modify: `docs/adr/0039-time-series-webgpu-renderer.md`
- Modify: `README.md`
- Delete: obsolete Canvas/density/mode benchmark reports or checked fixtures found by the gates below
- Modify via script: synchronized version manifests

**Interfaces:**

- Final repository describes WebGPU requirements, measured floors, unsupported-host behavior, and current commands.

- [ ] **Step 1: Run implementation-completeness searches**

```bash
! rg -n 'density-raster|density-policy|TILE_BIN_BUDGET|max_total_bins|renderPaths|CanvasRenderer|PlotModeModule|MODE_DATA|sampleCapForPanel|xySampleFallback|HI_RES_SERIES_CAP' frontend core shell protocol scripts examples
! rg -n 'PanelMode|x_ref|color_ref|color_axis|c_label|axis_equal' frontend core shell protocol examples
! rg -n 'LTTB|largest.triangle|drawStride|index.stride' frontend/src core/scope-core/src
```

Expected: all exit 0. References in historical ADRs/specs/plans are outside these production-path gates and remain intact.

- [ ] **Step 2: Document the shipped behavior and actual report fields**

Update ADR 0039 consequences and roadmap with:

- WebGPU-only series rendering and unsupported-host behavior;
- cache v5, protocol v20, session v22;
- per-series ordered representative LOD and exact gap runs;
- mc1000/dense10k hard floors and the latest report file paths;
- known hardware/software-adapter limitations observed during the full run.

README lists `./scripts/test.sh gpu` and the full benchmark command. Do not claim target timing if only the hard floor passed.

- [ ] **Step 3: Run the complete final validation**

Run in order:

```bash
./scripts/format.sh
./scripts/format.sh --check
./scripts/test.sh full
./scripts/test.sh gpu
./scripts/ci.sh all
./scripts/build.sh native
git diff --check
```

Expected: every command passes. This is the final GUI/end-to-end gate for the complete implementation plan.

- [ ] **Step 4: Review staged and unstaged scope before versioning**

Run:

```bash
git status --short
git diff --stat
git diff --cached --stat
```

Expected: no unrelated user files are staged or modified. Stage only files belonging to this implementation.

- [ ] **Step 5: Commit final documentation before the version bump**

```bash
git add docs/implementation-roadmap.md docs/adr/0039-time-series-webgpu-renderer.md README.md
git commit -m "docs(plot): record WebGPU renderer limits"
```

- [ ] **Step 6: Apply the one final major version bump**

Run:

```bash
./scripts/version.sh bump major
./scripts/version.sh check
./scripts/format.sh
```

Review generated manifest changes, stage only those files, then commit:

```bash
git add Cargo.toml Cargo.lock frontend/package.json shell/src-tauri/tauri.conf.json frontend/src/ui/app-shell.ts README.md
git commit -m "chore(release): bump version for WebGPU-only plotting"
```

The pre-commit hook may format files without staging them; rerun `git status --short`, stage any formatter-produced version-file changes explicitly, and amend only if necessary.

- [ ] **Step 7: Re-run version and formatting checks after the commit**

Run:

```bash
./scripts/version.sh check
./scripts/format.sh --check
git status --short --branch
```

Expected: synchronized version, clean formatting, and no uncommitted implementation files.

## Final Acceptance Gate

The implementation is complete only when all of these are true:

- mc1000 and dense10k draw every visible series and pass cardinality counters.
- Zoom increases representative resolution through level zero without density/band/merge substitution.
- Resident-window pan uploads zero bytes and rebuilds zero descriptors.
- Pointer movement remains asynchronous and performs no CPU line scan.
- Draw calls are bounded by arena pages/passes, not visible series.
- Epoch projection error is below 0.25 device pixel.
- Device loss restores visible plots or produces an explicit terminal capability error.
- Native and baked hosts use the same packed tile and WebGPU renderer path.
- `./scripts/ci.sh all`, GPU integration, desktop e2e, web/native builds, schema/codegen checks, and version checks pass.
- The worktree contains no unrelated staged changes.

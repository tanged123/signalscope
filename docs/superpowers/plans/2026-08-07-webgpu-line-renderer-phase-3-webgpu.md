# WebGPU Line Renderer Phase 3: GPU Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Canvas2D series stroking with one shared WebGPU runtime, paged GPU residency, stable segment descriptors, anti-aliased quads, and dense one-pixel hairlines.

**Architecture:** The workspace owns one adapter/device/queue, one dirty `requestAnimationFrame` loop, and shared pipeline caches. Panels own surfaces, transforms, styles, tile selections, and descriptor buffers. Ordered point tiles upload once into limit-sized arena pages; descriptors build only when residency or selected LOD changes; pan/zoom writes a transform uniform and style changes write metadata only.

**Tech Stack:** WebGPU/WGSL, TypeScript 5.9, `@webgpu/types` as a development-only type package, Canvas2D axes/labels/overlays, Vitest mocks, Vite raw WGSL imports.

## Global Constraints

- WebGPU is the only production series renderer after this phase; no Canvas2D series fallback remains.
- One adapter/device/queue and one queue submission serve all dirty panels in a workspace frame.
- Draw calls scale with resident arena pages and passes, never with series count.
- Every segment delivered by the selected LOD is submitted. LTTB, index stride, series merging, and cardinality cutoffs are absent.
- Descriptor order is deterministic by panel series slot, tile source start, then point order.
- Pan/zoom does not rebuild geometry. Restyle, mute, and emphasis do not rebuild geometry or fetch data.
- GPU points are not retained in a second CPU staging copy after upload. Compact statistical summaries may remain on CPU.
- Runtime limits determine page size; never assume one storage buffer can hold the workspace.
- Epoch-scale projection error must remain below 0.25 device pixel.
- Focused, dashed, or explicitly widened lines use anti-aliased quads. Dense eligible solid ordinary lines use the sample-count-1 hairline pass without skipping segments.
- Do not implement picking or progressive acquisition in this phase; those land in Phase 4.
- ChartGPU remains reference material only. Any copied source or shader fragment must retain its MIT notice.
- Live streaming and ring-buffer ingest remain outside this implementation.
- Start only from a committed Phase 2 completion gate. Before Task 1, run `git status --short`, inspect target files and nearby tests, and preserve unrelated changes.
- Do not bump the application version in this phase.

---

## Resulting File Structure

- `frontend/src/render/axis-renderer.ts` — Canvas2D layout, background, axes, labels, and grid geometry.
- `frontend/src/render/gpu/capabilities.ts` — adapter/device negotiation and clear unsupported reasons.
- `frontend/src/render/gpu/runtime.ts` — shared device, caches, error/loss state, and frame loop.
- `frontend/src/render/gpu/frame-loop.ts` — dirty panel coalescing and one command submission.
- `frontend/src/render/gpu/arena.ts` — limit-aware storage-buffer pages and suballocation.
- `frontend/src/render/gpu/residency.ts` — tile-keyed GPU LRU and pinned coarse residency.
- `frontend/src/render/gpu/series-slots.ts` — stable panel series identities and metadata packing.
- `frontend/src/render/gpu/prefix-scan.ts` — reusable stable GPU exclusive scan.
- `frontend/src/render/gpu/line-renderer.ts` — panel surface, descriptor build, and frame graph.
- `frontend/src/render/gpu/shaders/*.wgsl` — scan, descriptor, grid, quad, and hairline pipelines.
- Deleted: `frontend/src/render/canvas-renderer.ts` and `frontend/src/app/canvas-point-adapter.ts` after the switch.

### Task 1: Add WebGPU Types and Capability Negotiation

**Files:**

- Modify: `frontend/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `frontend/tsconfig.json`
- Modify: `scripts/setup.sh`
- Modify: `README.md`
- Create: `frontend/src/render/gpu/capabilities.ts`
- Create: `frontend/src/render/gpu/capabilities.test.ts`

**Interfaces:**

- Produces `requestGpuDevice(gpu: GPU | undefined): Promise<GpuDeviceResult>`.
- `GpuDeviceResult` is either `{ supported: true, adapter, device, format, limits }` or `{ supported: false, reason, capability }`.

- [ ] **Step 1: Add failing capability tests with a mock GPU**

Test these exact outcomes:

```ts
expect(await requestGpuDevice(undefined)).toEqual({
  supported: false,
  capability: "navigator.gpu",
  reason: "WebGPU is unavailable",
});
```

Also cover no adapter, `maxStorageBuffersPerShaderStage < 4`, compute workgroup size/invocations below 256, storage binding below 16 MiB, device request failure, and successful preferred-format negotiation.

- [ ] **Step 2: Run the test to verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/capabilities.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add the development-only type package reproducibly**

Add exact dev dependency `"@webgpu/types": "0.1.69"` and add it to `tsconfig.json`'s `types`. Extend `scripts/setup.sh` with one documented option:

```bash
case "${1:-}" in
--update-lock) pnpm install --lockfile-only ;;
"") pnpm install --frozen-lockfile ;;
*) echo "usage: ./scripts/setup.sh [--update-lock]" >&2; exit 2 ;;
esac
```

Document `./scripts/setup.sh --update-lock` in README as the lockfile-refresh command after an intentional manifest edit. Run it once; do not invoke bare `pnpm install`.

- [ ] **Step 4: Implement conservative capability floors**

Use:

```ts
export const MIN_STORAGE_BINDING_BYTES = 16 * 1024 * 1024;
export const SCAN_WORKGROUP_SIZE = 256;
```

Request `powerPreference: "high-performance"`. Validate adapter limits before `requestDevice`. Request only the selected storage-buffer and max-buffer limits, not every adapter maximum. Return errors as data; do not log or render from this module.

- [ ] **Step 5: Verify types and tests**

Run: `./scripts/setup.sh`

Run: `./scripts/test.sh unit frontend/src/render/gpu/capabilities.test.ts`

Run: `./scripts/build.sh web`

Expected: PASS with no runtime dependency added to the snapshot bundle.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json pnpm-lock.yaml frontend/tsconfig.json scripts/setup.sh README.md frontend/src/render/gpu/capabilities.ts frontend/src/render/gpu/capabilities.test.ts
git commit -m "feat(gpu): negotiate required WebGPU capabilities"
```

### Task 2: Build the Shared Runtime and Dirty Workspace Frame Loop

**Files:**

- Create: `frontend/src/render/gpu/frame-loop.ts`
- Create: `frontend/src/render/gpu/frame-loop.test.ts`
- Create: `frontend/src/render/gpu/runtime.ts`
- Create: `frontend/src/render/gpu/runtime.test.ts`

**Interfaces:**

```ts
export interface GpuPanelEncoder {
  readonly id: string;
  encode(encoder: GPUCommandEncoder): void;
  afterSubmit?(): void;
  deviceLost(): void;
  deviceRestored(device: GPUDevice, format: GPUTextureFormat): void;
}

export type GpuRuntimeResult =
  | { supported: true; runtime: GpuRuntime }
  | { supported: false; reason: string; capability: string };

export class GpuRuntime {
  static create(gpu?: GPU): Promise<GpuRuntimeResult>;
  register(panel: GpuPanelEncoder): () => void;
  requestFrame(panel: GpuPanelEncoder): void;
  shader(label: string, code: string): GPUShaderModule;
  renderPipeline(
    key: string,
    create: () => GPURenderPipeline,
  ): GPURenderPipeline;
  computePipeline(
    key: string,
    create: () => GPUComputePipeline,
  ): GPUComputePipeline;
}
```

- [ ] **Step 1: Add frame-coalescing tests**

With injected `requestAnimationFrame`, command-encoder, and queue mocks, assert:

```ts
loop.request(panelA);
loop.request(panelA);
loop.request(panelB);
raf.flush();
expect(panelA.encode).toHaveBeenCalledTimes(1);
expect(panelB.encode).toHaveBeenCalledTimes(1);
expect(device.createCommandEncoder).toHaveBeenCalledTimes(1);
expect(queue.submit).toHaveBeenCalledTimes(1);
```

Also assert unregistering before the frame prevents encode and an encode exception marks only that panel failed while the runtime reports the error once.

- [ ] **Step 2: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/frame-loop.test.ts frontend/src/render/gpu/runtime.test.ts`

Expected: FAIL because neither class exists.

- [ ] **Step 3: Implement one external render loop**

`GpuFrameLoop` owns a `Set<GpuPanelEncoder>`, one RAF handle, and the queue.
`request` adds the panel and schedules only if no RAF is pending. The callback
snapshots and clears the dirty set, creates one encoder, calls every
still-registered dirty panel in registration order, submits exactly one
finished command buffer, then calls `afterSubmit` on each successfully encoded
panel. Readback mapping must begin in `afterSubmit`, never before submission.

- [ ] **Step 4: Implement stable caches**

`GpuRuntime` caches shader modules and pipelines by explicit immutable string keys. Repeated calls return object identity. Bind groups remain panel-owned because their buffers differ. Runtime installs `device.addEventListener("uncapturederror", ...)` and exposes one error subscriber instead of printing.

- [ ] **Step 5: Install loss handling without recovery yet**

When `device.lost` resolves, stop scheduling/submission, call `deviceLost` on registered panels, clear device-owned caches, and publish `{kind: "lost", message}`. Task 7 adds reacquisition.

- [ ] **Step 6: Verify runtime tests**

Run: `./scripts/test.sh unit frontend/src/render/gpu/frame-loop.test.ts frontend/src/render/gpu/runtime.test.ts`

Expected: PASS, including one submission for multiple panels.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/render/gpu/frame-loop.ts frontend/src/render/gpu/frame-loop.test.ts frontend/src/render/gpu/runtime.ts frontend/src/render/gpu/runtime.test.ts
git commit -m "feat(gpu): add shared dirty workspace runtime"
```

### Task 3: Allocate Limit-Aware Point Arenas and GPU Residency

**Files:**

- Create: `frontend/src/render/gpu/arena.ts`
- Create: `frontend/src/render/gpu/arena.test.ts`
- Create: `frontend/src/render/gpu/residency.ts`
- Create: `frontend/src/render/gpu/residency.test.ts`
- Create: `frontend/src/render/gpu/series-slots.ts`
- Create: `frontend/src/render/gpu/series-slots.test.ts`

**Interfaces:**

```ts
export interface ArenaSlice {
  readonly page: number;
  readonly offset: number;
  readonly size: number;
}

export interface TileKey {
  readonly signalId: string;
  readonly level: number;
  readonly sourceStart: string;
  readonly generation: number;
}

export interface ResidentTile {
  readonly key: string;
  readonly points: ArenaSlice;
  readonly pointCount: number;
  readonly origin: number;
  readonly seriesSlot: number;
  readonly sourceStart: string;
  readonly sourceEnd: string;
  readonly coarse: boolean;
}
```

- [ ] **Step 1: Add page sizing and allocation tests**

Assert:

```ts
expect(
  arenaPageBytes({
    maxStorageBufferBindingSize: 128 * MiB,
    maxBufferSize: 256 * MiB,
  }),
).toBe(64 * MiB);
```

Also cover a 32 MiB adapter selecting 16 MiB pages, 256-byte alignment, first-fit reuse, coalescing adjacent free blocks, allocation larger than one page failing clearly, and every buffer usage containing `STORAGE | COPY_DST`.

- [ ] **Step 2: Add LRU and stable-slot tests**

Use four tiles to prove eviction order: non-visible, superseded visible fine,
visible fine, while visible coarse is pinned. Assert style changes preserve
`seriesSlot`, removed series slots are reused only after a later generation,
and 10,000 registrations do not allocate 10,000 buffers.

- [ ] **Step 3: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/arena.test.ts frontend/src/render/gpu/residency.test.ts frontend/src/render/gpu/series-slots.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement paged suballocation**

Choose page bytes as:

```ts
alignDown(
  Math.min(64 * MiB, limits.maxStorageBufferBindingSize, limits.maxBufferSize),
  256,
);
```

Require at least 16 MiB. Create pages lazily. Each page owns one GPU buffer and a sorted free-list. `write(slice, bytes)` checks exact bounds and calls `queue.writeBuffer` once; it never retains `bytes`.

- [ ] **Step 5: Implement tile residency and byte budget**

Default budget is `min(512 MiB, pageBytes * 8)`, never below two pages. Key
strings concatenate exact signal ID, level, source start, and generation.
Upload copies `PackedPointStream.bytes`, records metadata, and releases the
caller reference after return. Visibility/pin state is separate from key
identity.

- [ ] **Step 6: Implement stable panel series slots**

Map exact signal IDs to u32 slots. Pack one 32-byte metadata record:

```text
f32 rgba[4]
f32 width_device_px
u32 dash (0 solid, 1 dash, 2 dot)
u32 flags (bit0 visible, bit1 emphasized)
u32 reserved
```

Metadata lives in one growable panel buffer, not one buffer per series. Diff records and coalesce adjacent dirty slots into the fewest `queue.writeBuffer` calls.

- [ ] **Step 7: Verify unit tests**

Run: `./scripts/test.sh unit frontend/src/render/gpu/arena.test.ts frontend/src/render/gpu/residency.test.ts frontend/src/render/gpu/series-slots.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/render/gpu/arena.ts frontend/src/render/gpu/arena.test.ts frontend/src/render/gpu/residency.ts frontend/src/render/gpu/residency.test.ts frontend/src/render/gpu/series-slots.ts frontend/src/render/gpu/series-slots.test.ts
git commit -m "feat(gpu): add paged tile residency"
```

### Task 4: Build Stable Segment Descriptors with a GPU Prefix Scan

**Files:**

- Create: `frontend/src/render/gpu/prefix-scan.ts`
- Create: `frontend/src/render/gpu/prefix-scan.test.ts`
- Create: `frontend/src/render/gpu/descriptor-builder.ts`
- Create: `frontend/src/render/gpu/descriptor-builder.test.ts`
- Create: `frontend/src/render/gpu/shaders/scan-blocks.wgsl`
- Create: `frontend/src/render/gpu/shaders/scan-add.wgsl`
- Create: `frontend/src/render/gpu/shaders/segment-flags.wgsl`
- Create: `frontend/src/render/gpu/shaders/segment-scatter.wgsl`
- Create: `frontend/src/render/gpu/shaders/indirect-args.wgsl`

**Interfaces:**

- A `SegmentDescriptor` is 16 bytes: `u32 firstPoint`, `u32 secondPoint`, `u32 seriesSlot`, `u32 sourceOrder`.
- One descriptor/indirect set exists per selected arena page.
- `DescriptorBuilder.rebuild(encoder, page, directories)` is called only after residency or selected LOD changes.

- [ ] **Step 1: Add CPU-reference scan tests**

Test the scheduling and buffer sizing for lengths `0, 1, 255, 256, 257, 65_535, 65_536`. The exclusive scan reference must satisfy:

```ts
expect(exclusiveScan([1, 0, 1, 1])).toEqual({ values: [0, 1, 1, 2], total: 3 });
```

Mock command encoding and assert recursive block scans and add passes are dispatched in the correct order without exceeding device workgroup limits.

- [ ] **Step 2: Add descriptor directory tests**

Given directories in scrambled response order, assert CPU directory preparation
sorts by `seriesSlot`, exact `BigInt(sourceStart)`, and point offset; candidate
ranges are contiguous; and indirect draw counts are one per valid non-break
edge.

- [ ] **Step 3: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/prefix-scan.test.ts frontend/src/render/gpu/descriptor-builder.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement hierarchical exclusive scan**

Each 256-thread workgroup scans 512 u32 values in shared memory using Blelloch up-sweep/down-sweep, writes scanned values and one block sum. Recursively scan block sums, then add block offsets. Zero-length input performs no dispatch. Buffers use `STORAGE | COPY_SRC | COPY_DST` and are reused at their high-water capacity.

- [ ] **Step 5: Implement deterministic descriptor compaction**

For each page, create one sorted tile-directory buffer. `segment-flags.wgsl` emits one candidate bit for each adjacent point pair; bit is 1 only when the second point lacks `BREAK_BEFORE`. Scan flags. `segment-scatter.wgsl` writes valid descriptors at scanned offsets. `sourceOrder` is the candidate's stable global order, not an atomic counter.

- [ ] **Step 6: Generate indirect arguments on GPU**

Write two 16-byte argument records from the scan total:

```text
quad:     vertexCount=6, instanceCount=segmentCount, firstVertex=0, firstInstance=0
hairline: vertexCount=segmentCount*2, instanceCount=1, firstVertex=0, firstInstance=0
```

Both passes share the same descriptor stream; style eligibility is decided in shaders so restyling never rebuilds descriptors.

- [ ] **Step 7: Verify unit tests and shader compilation through a mocked device**

Run: `./scripts/test.sh unit frontend/src/render/gpu/prefix-scan.test.ts frontend/src/render/gpu/descriptor-builder.test.ts`

Run: `./scripts/build.sh web`

Expected: PASS; WGSL files are bundled as raw strings.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/render/gpu/prefix-scan.ts frontend/src/render/gpu/prefix-scan.test.ts frontend/src/render/gpu/descriptor-builder.ts frontend/src/render/gpu/descriptor-builder.test.ts frontend/src/render/gpu/shaders
git commit -m "feat(gpu): compact stable segment descriptors"
```

### Task 5: Render Precise Quads and Dense Hairlines

**Files:**

- Create: `frontend/src/render/gpu/precision.ts`
- Create: `frontend/src/render/gpu/precision.test.ts`
- Create: `frontend/src/render/gpu/line-renderer.ts`
- Create: `frontend/src/render/gpu/line-renderer.test.ts`
- Create: `frontend/src/render/gpu/shaders/grid.wgsl`
- Create: `frontend/src/render/gpu/shaders/line-common.wgsl`
- Create: `frontend/src/render/gpu/shaders/line-quad.wgsl`
- Create: `frontend/src/render/gpu/shaders/line-hairline.wgsl`

**Interfaces:**

```ts
export interface LineViewport {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly plotX: number;
  readonly plotY: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly devicePixelRatio: number;
}

export class GpuLineRenderer implements GpuPanelEncoder {
  setViewport(viewport: LineViewport): void;
  setTiles(tiles: readonly ResidentTile[]): void;
  setStyles(styles: readonly SeriesStyle[]): void;
  resize(width: number, height: number): void;
  encode(encoder: GPUCommandEncoder): void;
}
```

- [ ] **Step 1: Add high/low precision tests**

Define:

```ts
export function splitF64(value: number): readonly [high: number, low: number] {
  const high = Math.fround(value);
  return [high, Math.fround(value - high)];
}
```

Compare the shader-equivalent projection with f64 CPU projection for timestamps around `1_700_000_000`, `1_700_000_000_000`, spans down to `1e-6`, DPR 1–4, and widths to 7680. Assert finite representable cases are below 0.25 device pixel.

- [ ] **Step 2: Add frame-graph and write-diff tests**

Mock the device and assert unchanged scene encodes no uniform/style writes; pan writes one transform range and performs no descriptor rebuild/upload; style changes write metadata only; tile identity changes rebuild descriptors; one page emits at most one quad and one hairline indirect draw.

- [ ] **Step 3: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/precision.test.ts frontend/src/render/gpu/line-renderer.test.ts`

Expected: FAIL because the renderer does not exist.

- [ ] **Step 4: Define transform and shader precision**

The uniform stores tile/view origins as high/low f32 pairs. WGSL computes:

```wgsl
let relativeTime = (tileOriginHigh - viewOriginHigh)
                 + (tileOriginLow - viewOriginLow)
                 + point.timeOffset;
```

Then apply f32 scale to device pixels and clip space. Y uses f32 values and f32 affine. Scissor every series pass to the device-pixel plot rectangle.

- [ ] **Step 5: Implement anti-aliased segment quads**

Vertex shader fetches descriptor/endpoints/style by instance, projects both endpoints, computes a screen-space normal, and emits six vertices covering `width/2 + 1` device pixels. Fragment shader uses interpolated cross-line distance and `fwidth` for straight-alpha edge coverage. Invisible or dense-hairline-eligible styles emit clip position outside the viewport.

Dash phase uses projected time x in device pixels, so adjacent monotonic segments share phase without viewport-dependent geometry rebuild. Dash and dot periods are fixed multiples of style width.

- [ ] **Step 6: Implement the dense hairline pass**

Set `dense = segmentCount > plotWidth * plotHeight * 8`. In dense mode, visible solid non-emphasized styles with width `<= 1.4` are emitted by `line-list` at `sampleCount: 1`; quad shader discards them. Hairline shader discards every other style. Both shaders fetch the identical descriptor stream, so switching paths cannot change geometry membership.

- [ ] **Step 7: Encode the frame graph**

For each dirty panel:

```text
descriptor compute when dirty
4x MSAA render pass: grid + quad descriptors
resolve to current surface texture
sampleCount 1 load pass: hairline descriptors
```

Create MSAA color texture lazily and recreate only on size/format change. Use premultiplied alpha canvas configuration. Count encoded draw calls and submitted descriptors for Phase 4 metrics.

- [ ] **Step 8: Verify tests and web build**

Run: `./scripts/test.sh unit frontend/src/render/gpu/precision.test.ts frontend/src/render/gpu/line-renderer.test.ts`

Run: `./scripts/build.sh web`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/render/gpu/precision.ts frontend/src/render/gpu/precision.test.ts frontend/src/render/gpu/line-renderer.ts frontend/src/render/gpu/line-renderer.test.ts frontend/src/render/gpu/shaders
git commit -m "feat(gpu): render precise quads and dense hairlines"
```

### Task 6: Split Canvas Furniture from Series and Switch Panels to WebGPU

**Files:**

- Create: `frontend/src/render/axis-renderer.ts`
- Create: `frontend/src/render/axis-renderer.test.ts`
- Modify: `frontend/src/render/overlay-renderer.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/panel.test.ts`
- Modify: `frontend/src/ui/workspace-view.ts`
- Create: `frontend/src/ui/workspace-view.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/main.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/src/app/png-export.ts`
- Modify: `frontend/src/app/png-export.test.ts`
- Delete: `frontend/src/render/canvas-renderer.ts`
- Delete: `frontend/src/render/canvas-renderer.test.ts`
- Delete: `frontend/src/app/canvas-point-adapter.ts`
- Delete: `frontend/src/app/canvas-point-adapter.test.ts`

**Interfaces:**

- Layer order: `.axes-canvas`, `.series-canvas`, `.overlay-canvas`.
- `PanelView` receives the shared `GpuRuntime` in its constructor.
- PNG composition receives axes, series, and overlay canvases in that order.

- [ ] **Step 1: Add axis-layout parity tests**

Move Canvas renderer layout/tick/gutter/inline-axis tests into `axis-renderer.test.ts`. Assert the same `PlotLayout` for fixed canvas/font/ranges and assert returned grid line geometry stays inside the plot rectangle.

- [ ] **Step 2: Add panel layer and PNG tests**

Assert panel markup contains exactly three canvases in axes/series/overlay
order. Resize from zero to a DPR-2 size and assert all three backing stores use
the same nonzero device dimensions while CSS dimensions stay in logical
pixels. In PNG tests, mock `drawImage` and assert calls occur in the same order
below the title header.

- [ ] **Step 3: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/render/axis-renderer.test.ts frontend/src/ui/panel.test.ts frontend/src/ui/workspace-view.test.ts frontend/src/app/png-export.test.ts`

Expected: FAIL because the split does not exist.

- [ ] **Step 4: Extract `AxisRenderer`**

Move surface sizing, palette, layout, ticks, labels, background, gutter, and inline furniture from `CanvasRenderer`. Return device-pixel grid segments to `GpuLineRenderer`; do not stroke series. `lastLayout()` remains the interaction source of truth.

- [ ] **Step 5: Initialize the shared runtime before workspace views**

`AppShell.mount` awaits `GpuRuntime.create(navigator.gpu)`. On success pass the
runtime into `WorkspaceView`, then every `PanelView`. `main.ts` keeps one
`AppShell`. No panel may call `requestAdapter` or `requestDevice`. Configure
each `GPUCanvasContext` only after its backing size is at least 1×1; a shared
`ResizeObserver` path clamps invalid DPR to 1 and resizes all three layers
atomically.

- [ ] **Step 6: Upload transient tile points and retain compact summaries**

When `PanelView.renderData` receives a new tile response:

1. Resolve stable series slots and style metadata.
2. Upload each point byte stream to `GpuResidency`.
3. Copy only statistical columns required by `time-plot.ts` into compact summary arrays.
4. Drop response/point references after upload.
5. Select resident tiles and request one runtime frame.

Pan/zoom updates axis layout and renderer uniform, then requests a frame. It does not invoke encode synchronously.

- [ ] **Step 7: Update styles and overlays without geometry work**

Focus/mute/override/theme changes call `setStyles`. Cursor, annotations, box zoom, and gesture feedback remain Canvas2D overlay draws. Until Phase 4, suppress pointer hover hit tests instead of scanning GPU-discarded CPU points; keyboard legend focus remains functional.

- [ ] **Step 8: Delete the temporary Canvas series path**

Remove `CanvasRenderer`, adapter, Path2D caches, and imports. CSS assigns z-index 0/1/2 to axes/series/overlay, identical absolute sizing, and pointer events only to overlay.

- [ ] **Step 9: Verify unit, frontend, and native compilation**

Run: `./scripts/format.sh`

Run: `./scripts/test.sh unit frontend/src/render/axis-renderer.test.ts frontend/src/ui/panel.test.ts frontend/src/ui/workspace-view.test.ts frontend/src/app/png-export.test.ts`

Run: `./scripts/test.sh frontend`

Run: `./scripts/test.sh shell`

Expected: PASS. GUI and Playwright verification remains deferred until Phase 4 completes the interaction path.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/render frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts frontend/src/ui/workspace-view.ts frontend/src/ui/workspace-view.test.ts frontend/src/ui/app-shell.ts frontend/src/main.ts frontend/src/styles/app.css frontend/src/app/png-export.ts frontend/src/app/png-export.test.ts frontend/src/app/canvas-point-adapter.ts frontend/src/app/canvas-point-adapter.test.ts
git commit -m "feat(plot): switch time-series strokes to WebGPU"
```

### Task 7: Recover from Device Loss and Surface Unsupported Hosts

**Files:**

- Modify: `frontend/src/render/gpu/runtime.ts`
- Modify: `frontend/src/render/gpu/runtime.test.ts`
- Modify: `frontend/src/render/gpu/residency.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/src/main.ts`

**Interfaces:**

- Runtime reacquires one adapter/device, rebuilds caches, and calls `deviceRestored` on registered panels.
- AppShell callback invalidates tile windows and re-requests visible tiles after restore.

- [ ] **Step 1: Add loss/recovery tests**

Use two sequential mock devices. Resolve the first device's loss promise and assert: submissions stop; panels receive `deviceLost`; buffers are dropped; second negotiation occurs once; panels receive the second device; visible tile refresh callback runs once; frame submission resumes.

Add AppShell tests for unsupported capability text and a tile upload failure that leaves other panels alive.

- [ ] **Step 2: Run tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/runtime.test.ts frontend/src/ui/app-shell.test.ts`

Expected: FAIL because loss currently stops permanently.

- [ ] **Step 3: Implement one-at-a-time reacquisition**

Guard recovery with a single promise. Clear every device-owned module/pipeline/buffer/bind-group reference. Re-run capability negotiation. On success call panel restore handlers in registration order, then invoke the app tile-refresh subscriber. Ignore completion from superseded recovery attempts.

- [ ] **Step 4: Render explicit unsupported/recovery states**

Unsupported startup replaces the workspace with:

```html
<section class="unsupported-host" role="alert">
  <h1>WebGPU required</h1>
  <p class="unsupported-capability"></p>
  <p class="unsupported-reason"></p>
</section>
```

During device recovery, keep axes/overlays visible and show `Recovering GPU…` in each panel empty-state layer. On terminal reacquisition failure show the failed capability/reason; never leave a blank plot.

- [ ] **Step 5: Handle tile and memory failures locally**

If fine upload/allocation fails, retain the previous resident level and report one panel warning. If no tile is resident, show `series data unavailable` while other series/panels render. Ask residency to evict by policy before treating allocation as failed.

- [ ] **Step 6: Run Phase 3 validation**

Run: `./scripts/format.sh`

Run: `./scripts/test.sh quick`

Run: `./scripts/test.sh shell`

Expected: PASS. Do not claim GUI behavior, a platform build, or GPU output is verified yet; Phase 4 owns those final checks.

- [ ] **Step 7: Run structural gates**

```bash
! rg -n 'new CanvasRenderer|renderPaths|Path2D|canvas-point-adapter|requestAdapter\(' frontend/src --glob '!render/gpu/capabilities.ts'
! rg -n 'for .*series.*createBuffer|series.*drawIndirect|series.*draw\(' frontend/src/render/gpu
```

Expected: both exit 0. The only `requestAdapter` call is capability negotiation; no series loop creates resources or draw calls.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/render/gpu frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/ui/panel.ts frontend/src/styles/app.css frontend/src/main.ts
git commit -m "feat(gpu): recover devices and report unsupported hosts"
```

## Phase 3 Completion Gate

Run:

```bash
./scripts/format.sh --check
./scripts/test.sh quick
./scripts/test.sh shell
./scripts/build.sh web
git diff --check
git status --short
```

Expected: all listed non-GUI checks and the web bundle pass. The production tree contains no Canvas2D series renderer and no per-series GPU resource/draw loop. Continue directly to Phase 4 before treating the branch as user-ready.

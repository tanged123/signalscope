# WebGPU Line Renderer Corrective Reimplementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the incomplete WebGPU scaffolding with a compiling, identity-preserving renderer whose transport, residency, interaction, recovery, fidelity, and performance claims are enforced by tests that cannot pass on blank output.

**Architecture:** Keep ADR 0039's time-series-only, WebGPU-only product direction. Rust streams ordered extrema-preserving points from bounded out-of-core storage; the frontend uploads each selected tile once, compacts valid segments on the GPU, and renders page-bounded quad and hairline passes. Chromium with SwiftShader is the deterministic GPU test authority; Tauri verifies capability handling and native shell integration but is not required to expose WebGPU on WSL or unsupported Linux WebKitGTK builds.

**Tech Stack:** Rust, Tauri, TypeScript, WebGPU/WGSL, Playwright Chromium/SwiftShader, Vitest, repository scripts, binary protocol framing, self-contained baked snapshots.

## Global Constraints

- No XY, FFT, histogram, Canvas2D series-stroke fallback, density field, envelope band, merged geometry, or visible-series cutoff.
- Every visible series with one valid edge contributes at least one compact descriptor at every selected LOD.
- No compatibility layer: make protocol/cache changes directly, bump their versions, and reject obsolete versions clearly.
- `protocol/schema/scope-protocol.json` remains the generated JSON contract; native bulk tiles use the versioned binary codec and both hosts return the same `ColumnarTileResponse` shape.
- Rust never materializes a complete paged time/value column to build a pyramid or answer an indexed gather.
- Pan within a padded resident window writes viewport state only: zero point uploads and zero descriptor rebuilds.
- Restyle, visibility, and emphasis changes write series metadata only.
- Production rendering allocates no JavaScript object per segment and performs no CPU loop over points during pointer movement.
- GPU work is page-bounded. Draw calls scale with pages and passes, never series count.
- Timestamps stay f64 on the wire. GPU code compares high/low origins and relative f32 offsets; it never reconstructs epoch time into one f32.
- All production WGSL modules must compile without error before the renderer is reported ready.
- A GPU test must fail on shader errors, uncaptured validation errors, zero submitted descriptors, incorrect series cardinality, or a blank trajectory mask.
- Automated GPU correctness uses Playwright Chromium with SwiftShader. Native Tauri GPU smoke tests are conditional; unsupported WSL/WebKitGTK hosts must show the capability screen and pass without pretending to render.
- Do not update a golden image merely to make a test pass. First prove shader compilation, exact structural counts, and fixture-specific pixel masks.
- Run narrow unit/core checks per task. Defer GUI, full GPU, native bundle, benchmark, and full end-to-end gates until Task 12.
- Use repository scripts for setup, formatting, codegen, tests, builds, and CI.
- Preserve unrelated work. Stage explicit files only; never use `git add -A`.
- Do not bump the application version until every final gate in Task 12 passes. The completed corrective PR uses a patch bump from the then-current target version.

---

## Resulting File Structure

- `core/scope-core/src/gaps.rs` — streaming gap-run builder.
- `core/scope-core/src/paging.rs` — one-page-at-a-time indexed gathering.
- `core/scope-core/src/pyramid.rs` — fallible streaming pyramid construction and ordered query errors.
- `core/scope-core/src/cache.rs` — cache-v6 representative-index and gap-run validation.
- `protocol/src/tile_binary.rs` — fallible binary tile encoder.
- `frontend/src/app/tile-binary.ts` — strict binary decoder.
- `frontend/src/app/baked-tile.ts` — native-equivalent baked window slicing and repacking.
- `frontend/src/render/gpu/shader-sources.ts` — one registry of every production WGSL module.
- `frontend/src/render/gpu/descriptor-pipeline.ts` — GPU flag, scan, scatter, and indirect-argument encoding.
- `frontend/src/render/gpu/render-targets.ts` — per-panel MSAA texture, resolve, and surface lifecycle.
- `frontend/src/render/gpu/line-renderer.ts` — command encoding and stable page resources.
- `frontend/src/render/gpu/residency.ts` — atomic selected sets, supersession, pinning, and eviction.
- `frontend/src/render/gpu/picker.ts` — high/low precision compute picking and readback scheduling.
- `frontend/tests/gpu/` — compilation, structural, precision, and bounded pixel-mask tests.
- `frontend/tests/bench/` — measured acquisition, render-frame, pan, pick, and recovery reports.

## Test Authority

| Layer               | Required authority                                 | What it proves                                                                   |
| ------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Rust/frontend unit  | `./scripts/test.sh core`, `unit`, `frontend`       | transport, paging, state, allocation, deterministic CPU references               |
| GPU correctness     | `./scripts/test.sh gpu` using Chromium SwiftShader | WGSL compilation, validation-free execution, descriptors, pixels, precision      |
| Browser interaction | `./scripts/test.sh e2e`                            | gestures, overlays, unsupported-host behavior, snapshot host                     |
| Tauri shell         | `./scripts/test.sh shell` and native build         | IPC, capability/error routing, bundle integration; not hardware GPU output       |
| Optional native GPU | manual run on a supported host                     | driver/webview smoke evidence only                                               |
| Performance         | `./scripts/test.sh bench e2e`                      | real renderer milestones and metric deltas, never an independent RAF proxy alone |

WSL and Linux WebKitGTK installations without `navigator.gpu` are expected to take the unsupported-host path. They are not allowed to skip the Chromium/SwiftShader GPU gate.

### Task 1: Make Shader Compilation and Capability Failure Honest

**Files:**

- Create: `frontend/src/render/gpu/shader-sources.ts`
- Create: `frontend/src/render/gpu/shader-sources.test.ts`
- Modify: `frontend/src/render/gpu/capabilities.ts`
- Modify: `frontend/src/render/gpu/capabilities.test.ts`
- Modify: `frontend/src/render/gpu/runtime.ts`
- Modify: `frontend/src/render/gpu/runtime.test.ts`
- Modify: `frontend/src/render/gpu/shaders/line-quad.wgsl`
- Modify: `frontend/src/render/gpu/shaders/line-hairline.wgsl`
- Modify: `frontend/src/render/gpu/shaders/pick-series.wgsl`
- Modify: `frontend/tests/gpu/fixtures.ts`
- Modify: `frontend/tests/gpu/line-renderer.spec.ts`

**Interfaces:**

```ts
export interface ProductionShader {
  readonly label: string;
  readonly code: string;
}

export const PRODUCTION_SHADERS: readonly ProductionShader[];

export async function compileProductionShaders(
  device: GPUDevice,
): Promise<readonly string[]>;
```

- [ ] **Step 1: Add failing capability and compilation tests**

Require at least five storage buffers because the picker binds points, ranges, tile metadata, styles, and candidates. In the GPU fixture, compile every registered shader and collect every `GPUCompilationMessage` whose type is `error`.

```ts
expect(validateLimits(limits({ maxStorageBuffersPerShaderStage: 4 }))).toBe(
  "WebGPU requires five storage buffers per shader stage",
);

const errors = await compileProductionShaders(device);
expect(errors).toEqual([]);
```

- [ ] **Step 2: Run the tests and preserve the failure evidence**

Run: `./scripts/test.sh unit frontend/src/render/gpu/capabilities.test.ts frontend/src/render/gpu/shader-sources.test.ts frontend/src/render/gpu/runtime.test.ts`

Run: `./scripts/test.sh gpu --grep "compiles production shaders"`

Expected: FAIL on the four-buffer floor and current WGSL validation errors.

- [ ] **Step 3: Register all shaders once and fix WGSL syntax**

`shader-sources.ts` imports every `.wgsl?raw` file and exports a frozen array. Integer vertex outputs use `@interpolate(flat)`. Fragment entry points receive one `@builtin(position)` value. All `if` statements use braces, and NaN checks use `value != value` consistently.

```wgsl
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) series_slot: u32,
  @location(1) edge_distance: f32,
};
```

- [ ] **Step 4: Fail startup instead of showing a blank surface**

After requesting the device, `GpuRuntime.create` awaits shader compilation. On any error it destroys the device and returns:

```ts
{
  supported: false,
  capability: `shader.${label}`,
  reason: message,
}
```

Keep uncaptured-error listeners active after startup; route errors to the terminal GPU state rather than merely recording metrics.

- [ ] **Step 5: Verify and commit**

Run: `./scripts/test.sh unit frontend/src/render/gpu/capabilities.test.ts frontend/src/render/gpu/shader-sources.test.ts frontend/src/render/gpu/runtime.test.ts`

Run: `./scripts/test.sh gpu --grep "compiles production shaders"`

Expected: PASS with zero compilation or uncaptured validation errors.

```bash
git add frontend/src/render/gpu/shader-sources.ts frontend/src/render/gpu/shader-sources.test.ts frontend/src/render/gpu/capabilities.ts frontend/src/render/gpu/capabilities.test.ts frontend/src/render/gpu/runtime.ts frontend/src/render/gpu/runtime.test.ts frontend/src/render/gpu/shaders/line-quad.wgsl frontend/src/render/gpu/shaders/line-hairline.wgsl frontend/src/render/gpu/shaders/pick-series.wgsl frontend/tests/gpu/fixtures.ts frontend/tests/gpu/line-renderer.spec.ts
git commit -m "fix(plot): reject invalid WebGPU pipelines"
```

### Task 2: Gather Paged Values and Build Gap Runs with Bounded Memory

**Files:**

- Modify: `core/scope-core/src/gaps.rs`
- Modify: `core/scope-core/src/paging.rs`
- Modify: `core/scope-core/src/columns.rs`
- Modify: `core/scope-core/src/ingest/decoded.rs`
- Modify: `core/scope-core/src/ingest/csv.rs`
- Modify: `core/scope-core/src/ingest/mcap.rs`
- Modify: `core/scope-core/src/ingest/container/hdf5.rs`
- Modify: `core/scope-core/src/ingest/container/parquet.rs`
- Modify: `core/scope-core/src/ingest/recipe/decode.rs`

**Interfaces:**

```rust
#[derive(Default)]
pub struct GapRunBuilder {
    open_start: Option<u64>,
    next_index: u64,
    ranges: Vec<(u64, u64)>,
}

impl GapRunBuilder {
    pub fn push(&mut self, value: f64);
    pub fn extend(&mut self, values: &[f64]);
    pub fn finish(self) -> GapRuns;
}

pub struct DecodedSignal {
    pub local_path: String,
    pub unit: Option<String>,
    pub time: Column,
    pub values: Column,
    pub gap_runs: GapRuns,
}
```

- [ ] **Step 1: Add failing gap-builder and sparse-gather tests**

Test chunk boundaries, a run beginning in one chunk and ending in another, trailing NaNs, and all-finite data. Add a paged gather over indexes spanning at least 16 pages in shuffled order with duplicates; assert output order and duplicate values exactly match the request.

```rust
let mut builder = GapRunBuilder::default();
builder.extend(&[1.0, f64::NAN]);
builder.extend(&[f64::NAN, 2.0, f64::NAN]);
assert_eq!(builder.finish().as_slice(), &[(1, 3), (4, 5)]);
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `./scripts/test.sh core gaps`

Run: `./scripts/test.sh core paging`

Expected: FAIL because streaming construction and bounded sparse gathering are absent.

- [ ] **Step 3: Implement one-page-at-a-time gathering**

Sort `(page_index, request_position, value_index)` metadata, not page buffers. Read one page, fill every output position belonging to it, and drop its lease before reading the next page. Do not store `Arc<[u8]>` by page.

```rust
for group in grouped_requests {
    let lease = cache.read(handle, group.byte_range())?;
    for request in group.requests() {
        output[request.output_index] = decode_f64(lease.bytes(), request.offset);
    }
}
```

- [ ] **Step 4: Populate gap runs at decode/spill time**

Every decoder builds `GapRunBuilder` while appending values and stores the finished runs in `DecodedSignal`. Derived spill conversion carries the same metadata. Delete production calls that reconstruct gaps by rescanning a paged value column.

- [ ] **Step 5: Verify and commit**

Run: `./scripts/test.sh core gaps`

Run: `./scripts/test.sh core paging`

Run: `./scripts/test.sh core ingest`

Expected: PASS; gather retains at most one active page lease.

```bash
git add core/scope-core/src/gaps.rs core/scope-core/src/paging.rs core/scope-core/src/columns.rs core/scope-core/src/ingest/decoded.rs core/scope-core/src/ingest/csv.rs core/scope-core/src/ingest/mcap.rs core/scope-core/src/ingest/container/hdf5.rs core/scope-core/src/ingest/container/parquet.rs core/scope-core/src/ingest/recipe/decode.rs
git commit -m "fix(core): bound indexed column gathering"
```

### Task 3: Stream Pyramid Construction and Reject Invalid Cache Representatives

**Files:**

- Modify: `core/scope-core/src/pyramid.rs`
- Modify: `core/scope-core/src/bins.rs`
- Modify: `core/scope-core/src/store.rs`
- Modify: `core/scope-core/src/cache.rs`
- Modify: `shell/src-tauri/src/lib.rs`
- Modify: `core/scope-core/src/benchmarks/mod.rs`

**Interfaces:**

```rust
pub enum PyramidError {
    Column(PageError),
    LengthMismatch { time: usize, values: usize },
    InvalidRepresentative { level: u32, bin: usize, index: u64 },
}

pub fn from_columns(
    time: &Column,
    values: &Column,
    gap_runs: GapRuns,
) -> Result<Pyramid, PyramidError>;
```

- [ ] **Step 1: Add failing streaming and cache-corruption tests**

Build the same synthetic signal as owned and page-backed columns and assert every level's bins, representative indexes, ordered points, and gaps are equal. Mutate each cached first/min/max/last index to be out of row bounds and outside its bin; assert cache load becomes a miss/error rather than a blank query.

```rust
let owned = Pyramid::from_columns(&owned_t, &owned_v, gaps.clone())?;
let paged = Pyramid::from_columns(&paged_t, &paged_v, gaps)?;
assert_eq!(owned.query_at_level(4, None), paged.query_at_level(4, None));
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `./scripts/test.sh core pyramid`

Run: `./scripts/test.sh core cache`

Expected: FAIL because `from_signal` materializes full columns and cache v5 accepts invalid indexes.

- [ ] **Step 3: Implement a carry-based streaming pyramid builder**

Read matching time/value chunks through `Column::range`. Feed each raw sample into level 1; whenever a level has two children, merge them and carry one parent upward. Keep only unfinished carry bins plus completed compact levels. Preserve exact first/min/max/last indexes and use the supplied `GapRuns`.

```rust
for base in (0..values.len()).step_by(CHUNK_VALUES) {
    let end = (base + CHUNK_VALUES).min(values.len());
    let time_chunk = time.range(base..end)?;
    let value_chunk = values.range(base..end)?;
    builder.extend(base as u64, &time_chunk, &value_chunk);
}
let pyramid = builder.finish(time.downgrade(), values.downgrade(), gap_runs);
```

Change production call sites to propagate `PyramidError`; no `unwrap_or_default()` or empty-point substitution is allowed after a gather failure.

- [ ] **Step 4: Bump cache ABI to v6 and validate on load**

For each representative flag/index pair, require:

```text
index < sample_count
bin_source_start <= index < bin_source_end
first <= min/max/last in source-order terms only where their flags are present
absent flag => sentinel index
stored gap runs are sorted, disjoint, half-open, and within sample_count
```

Any violation is a cache miss with a diagnostic naming signal, level, bin, and field.

- [ ] **Step 5: Repair the stale fixture assertion**

The time-only `mc1000` workspace has one panel. Update the benchmark fixture test to encode per-fixture expected panel counts rather than one global value.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh core pyramid`

Run: `./scripts/test.sh core cache`

Run: `./scripts/test.sh core benchmarks::workspace_fixtures_load_at_current_schema`

Run: `./scripts/test.sh shell query_tiles`

Expected: PASS with no full-column load in pyramid production paths.

```bash
git add core/scope-core/src/pyramid.rs core/scope-core/src/bins.rs core/scope-core/src/store.rs core/scope-core/src/cache.rs core/scope-core/src/benchmarks/mod.rs shell/src-tauri/src/lib.rs
git commit -m "fix(core): stream ordered pyramid construction"
```

### Task 4: Make Native and Baked Tile Transport Strictly Equivalent

**Files:**

- Modify: `protocol/schema/scope-protocol.json`
- Modify: `protocol/src/tile_binary.rs`
- Modify: `protocol/src/lib.rs`
- Regenerate: `protocol/src/generated.rs`
- Regenerate: `frontend/src/generated/protocol.ts`
- Create: `frontend/src/app/baked-tile.ts`
- Create: `frontend/src/app/baked-tile.test.ts`
- Modify: `frontend/src/app/tile-binary.ts`
- Modify: `frontend/src/app/tile-binary.test.ts`
- Modify: `frontend/src/app/tile-points.ts`
- Modify: `frontend/src/app/tile-points.test.ts`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `core/scope-core/src/snapshot.rs`
- Modify: `shell/src-tauri/src/lib.rs`

**Interfaces:**

```rust
pub enum TileBinaryError {
    NonFiniteOrigin { signal_id: u64, signal_path: String },
    UnrepresentableTimeOffset { signal_id: u64, source_index: u64 },
    UnrepresentableValue { signal_id: u64, source_index: u64 },
}

pub fn encode_tile_response(
    series: &[BinaryTileSeries<'_>],
) -> Result<Vec<u8>, TileBinaryError>;
```

```ts
export interface SlicedBakedTile {
  readonly sourceStart: string;
  readonly sourceEnd: string;
  readonly origin: number;
  readonly points: PackedPointStream;
}

export function sliceBakedTile(
  level: BakedLevel,
  startBin: number,
  endBin: number,
  t0: number,
  t1: number,
): SlicedBakedTile;
```

- [ ] **Step 1: Add failing encoder, decoder, and host-conformance tests**

Rust tests require large finite values to return typed errors without panicking. TypeScript mutation tests reject nonfinite origins/points, reversed source ranges, unknown flags, invalid UTF-8, nonzero reserved fields, and nonzero alignment padding. A native/baked fixture compares level, source range, origin-relative decoded points, breaks, and bins for full and partial windows.

- [ ] **Step 2: Run tests and verify failure**

Run: `./scripts/test.sh core tile_binary`

Run: `./scripts/test.sh unit frontend/src/app/tile-binary.test.ts frontend/src/app/tile-points.test.ts frontend/src/app/baked-tile.test.ts frontend/src/app/data-plane.test.ts`

Expected: FAIL on encoder assertions, decoder omissions, and baked source metadata.

- [ ] **Step 3: Remove the stale JSON tile response and bump protocol v21**

Delete generated `SignalTile`/`TileResponse` definitions because production bulk responses are binary and snapshots use `BakedLevel`. Keep `TileRequest`, `BakedLevel`, and `TilePoint` in the schema. Run `./scripts/codegen.sh`; do not hand-edit generated files.

- [ ] **Step 4: Make binary encoding fallible and decoding strict**

Replace every representability `assert!` with `Result` propagation. The shell maps `TileBinaryError` into a command error naming the signal and offending source index. TypeScript uses `new TextDecoder("utf-8", { fatal: true })` and validates every reserved/flag/padding byte before exposing typed views.

- [ ] **Step 5: Repack partial baked windows**

Select points by the queried bin/source range, retain one edge neighbor where required for clipping, choose the first selected absolute time as the new origin, and write a compact 16-byte stream. `sourceStart` and `sourceEnd` come from selected point source indexes, not the full baked level.

```ts
const origin = selected[0]?.time ?? 0;
const sourceStart = selected[0]?.source_index ?? "0";
const sourceEnd =
  selected.length === 0
    ? sourceStart
    : (BigInt(selected.at(-1)!.source_index) + 1n).toString();
```

- [ ] **Step 6: Verify and commit**

Run: `./scripts/codegen.sh`

Run: `./scripts/test.sh core tile_binary`

Run: `./scripts/test.sh core snapshot`

Run: `./scripts/test.sh unit frontend/src/app/tile-binary.test.ts frontend/src/app/tile-points.test.ts frontend/src/app/baked-tile.test.ts frontend/src/app/data-plane.test.ts`

Run: `./scripts/test.sh shell query_tiles`

Expected: PASS; native and baked partial windows decode to equivalent tile metadata and ordered points.

```bash
git add protocol/schema/scope-protocol.json protocol/src/tile_binary.rs protocol/src/lib.rs protocol/src/generated.rs core/scope-core/src/snapshot.rs shell/src-tauri/src/lib.rs frontend/src/app/baked-tile.ts frontend/src/app/baked-tile.test.ts frontend/src/app/tile-binary.ts frontend/src/app/tile-binary.test.ts frontend/src/app/tile-points.ts frontend/src/app/tile-points.test.ts frontend/src/app/data-plane.ts frontend/src/app/data-plane.test.ts frontend/src/generated/protocol.ts
git commit -m "fix(protocol): align ordered tiles across hosts"
```

### Task 5: Implement GPU Segment Flagging, Scan, Scatter, and Indirect Arguments

**Files:**

- Create: `frontend/src/render/gpu/descriptor-pipeline.ts`
- Create: `frontend/src/render/gpu/descriptor-pipeline.test.ts`
- Modify: `frontend/src/render/gpu/descriptor-builder.ts`
- Modify: `frontend/src/render/gpu/descriptor-builder.test.ts`
- Modify: `frontend/src/render/gpu/prefix-scan.ts`
- Modify: `frontend/src/render/gpu/prefix-scan.test.ts`
- Modify: `frontend/src/render/gpu/line-renderer.ts`
- Modify: `frontend/src/render/gpu/line-renderer.test.ts`
- Modify: `frontend/src/render/gpu/shaders/segment-flags.wgsl`
- Modify: `frontend/src/render/gpu/shaders/scan-blocks.wgsl`
- Modify: `frontend/src/render/gpu/shaders/scan-add.wgsl`
- Modify: `frontend/src/render/gpu/shaders/segment-scatter.wgsl`
- Modify: `frontend/src/render/gpu/shaders/indirect-args.wgsl`
- Modify: `frontend/tests/gpu/fixtures.ts`
- Modify: `frontend/tests/gpu/line-renderer.spec.ts`

**Interfaces:**

```ts
export interface TileDirectory {
  readonly pointStart: number;
  readonly pointCount: number;
  readonly seriesSlot: number;
  readonly tileMetaIndex: number;
}

export interface DescriptorBuildBuffers {
  readonly descriptors: GPUBuffer;
  readonly descriptorCount: GPUBuffer;
  readonly quadArgs: GPUBuffer;
  readonly hairlineArgs: GPUBuffer;
}

export class GpuDescriptorPipeline {
  ensureCapacity(candidateCount: number, tileCount: number): void;
  encode(
    encoder: GPUCommandEncoder,
    directories: GPUBuffer,
    candidateCount: number,
  ): DescriptorBuildBuffers;
  destroy(): void;
}
```

```wgsl
struct SegmentDescriptor {
  first_point: u32,
  second_point: u32,
  series_slot: u32,
  tile_meta_index: u32,
};
```

- [ ] **Step 1: Add failing structural compute tests**

Create a software-adapter fixture with duplicate extrema, three gaps, two tiles, and two series. Compare GPU descriptor bytes against the CPU reference exactly, including stable order and `tile_meta_index`. Assert compact count excludes every broken edge and indirect counts equal the compact result.

- [ ] **Step 2: Run tests and verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/descriptor-pipeline.test.ts frontend/src/render/gpu/prefix-scan.test.ts frontend/src/render/gpu/descriptor-builder.test.ts`

Run: `./scripts/test.sh gpu --grep "compacts ordered segments"`

Expected: FAIL because the five compute shaders are no-ops and production allocates descriptors on the CPU.

- [ ] **Step 3: Implement the hierarchical scan**

Use 256 invocations per workgroup. `segment-flags` writes one `u32` per conceptual adjacent edge. `scan-blocks` performs an exclusive Blelloch scan and emits block sums. Recursively scan block sums, then `scan-add` adds block prefixes. `segment-scatter` writes valid descriptors at scanned offsets. `indirect-args` writes compact count into both draw argument buffers.

```wgsl
let candidate = global_id.x;
if (candidate < params.candidate_count && flags[candidate] != 0u) {
  descriptors[prefix[candidate]] = descriptor_for(candidate);
}
```

- [ ] **Step 4: Keep only compact directories on the CPU**

CPU code sorts one `TileDirectory` per selected tile by `(seriesSlot, sourceStart, pointStart)` and uploads that fixed-size table. Delete `PreparedDirectory.candidates`, `flatMap`, and every production allocation of `SegmentDescriptor`. Retain the CPU builder only as a test oracle.

- [ ] **Step 5: Make metadata lookup O(1)**

Both line shaders and picker index `tile_meta[descriptor.tile_meta_index]` or `tile_meta[range.tile_meta_index]`. Delete every loop that searches metadata by point range.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh unit frontend/src/render/gpu/descriptor-pipeline.test.ts frontend/src/render/gpu/prefix-scan.test.ts frontend/src/render/gpu/descriptor-builder.test.ts frontend/src/render/gpu/line-renderer.test.ts`

Run: `./scripts/test.sh gpu --grep "compacts ordered segments"`

Expected: PASS; production searches show no per-segment JS descriptor construction and no shader metadata scan.

```bash
git add frontend/src/render/gpu/descriptor-pipeline.ts frontend/src/render/gpu/descriptor-pipeline.test.ts frontend/src/render/gpu/descriptor-builder.ts frontend/src/render/gpu/descriptor-builder.test.ts frontend/src/render/gpu/prefix-scan.ts frontend/src/render/gpu/prefix-scan.test.ts frontend/src/render/gpu/line-renderer.ts frontend/src/render/gpu/line-renderer.test.ts frontend/src/render/gpu/shaders/segment-flags.wgsl frontend/src/render/gpu/shaders/scan-blocks.wgsl frontend/src/render/gpu/shaders/scan-add.wgsl frontend/src/render/gpu/shaders/segment-scatter.wgsl frontend/src/render/gpu/shaders/indirect-args.wgsl frontend/tests/gpu/fixtures.ts frontend/tests/gpu/line-renderer.spec.ts
git commit -m "feat(plot): compact line descriptors on GPU"
```

### Task 6: Build the Required Blended MSAA/Hairline Frame Graph

**Files:**

- Create: `frontend/src/render/gpu/render-targets.ts`
- Create: `frontend/src/render/gpu/render-targets.test.ts`
- Modify: `frontend/src/render/gpu/line-renderer.ts`
- Modify: `frontend/src/render/gpu/line-renderer.test.ts`
- Modify: `frontend/src/render/gpu/shaders/line-quad.wgsl`
- Modify: `frontend/src/render/gpu/shaders/line-hairline.wgsl`
- Modify: `frontend/src/render/gpu/shaders/grid.wgsl`

**Interfaces:**

```ts
export class PanelRenderTargets {
  configure(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
  ): void;
  resize(width: number, height: number): void;
  frame(): { swapchain: GPUTextureView; msaa: GPUTextureView };
  destroy(): void;
}
```

- [ ] **Step 1: Add failing render-pass tests**

Using the mock encoder, assert one optional compute sequence, one 4x MSAA pass resolving to the swapchain, then one sample-count-1 hairline load pass. Assert every render pass sets the same device-pixel scissor and that pipeline targets use premultiplied-alpha blending.

- [ ] **Step 2: Run unit tests and verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/render-targets.test.ts frontend/src/render/gpu/line-renderer.test.ts`

Expected: FAIL because rendering is direct single-sample with no blend or scissor.

- [ ] **Step 3: Implement stable render targets and pipelines**

Create one per-panel 4x texture, recreate it only when device, format, width, or height changes, and destroy the old texture. Configure quad/grid pipelines with `sampleCount: 4`; hairlines remain `sampleCount: 1` after resolve.

```ts
const premultiplied: GPUBlendState = {
  color: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
};
```

- [ ] **Step 4: Partition quad and hairline membership**

Dense, ordinary, solid, one-device-pixel series draw only in the hairline pass. Focused, dashed, widened, or otherwise ineligible series draw only as quads. Every valid descriptor belongs to exactly one pass; no segment is silently removed or double-drawn.

- [ ] **Step 5: Apply plot scissoring**

Round/clamp the device-pixel plot rectangle to the canvas and call `setScissorRect` before every page draw in both passes. A zero-area plot encodes no draw.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh unit frontend/src/render/gpu/render-targets.test.ts frontend/src/render/gpu/line-renderer.test.ts`

Run: `./scripts/build.sh web`

Expected: PASS with stable targets/bind groups and no line pixels outside the plot scissor.

```bash
git add frontend/src/render/gpu/render-targets.ts frontend/src/render/gpu/render-targets.test.ts frontend/src/render/gpu/line-renderer.ts frontend/src/render/gpu/line-renderer.test.ts frontend/src/render/gpu/shaders/line-quad.wgsl frontend/src/render/gpu/shaders/line-hairline.wgsl frontend/src/render/gpu/shaders/grid.wgsl
git commit -m "feat(plot): render blended WebGPU line passes"
```

### Task 7: Make Residency Atomic and Resident Pan Transform-Only

**Files:**

- Modify: `frontend/src/render/gpu/residency.ts`
- Modify: `frontend/src/render/gpu/residency.test.ts`
- Modify: `frontend/src/render/gpu/series-slots.ts`
- Modify: `frontend/src/render/gpu/series-slots.test.ts`
- Modify: `frontend/src/render/gpu/line-renderer.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/panel.test.ts`

**Interfaces:**

```ts
export interface TileIdentity {
  readonly signalId: string;
  readonly level: number;
  readonly sourceStart: string;
  readonly sourceEnd: string;
}

export class GpuResidency {
  stage(
    generation: number,
    tiles: readonly ResidencyTile[],
  ): readonly ResidentTile[];
  select(generation: number, keys: readonly string[]): readonly ResidentTile[];
  discardGeneration(generation: number): void;
  covers(keys: readonly string[], t0: number, t1: number): boolean;
  clear(): void;
}
```

`TileIdentity` excludes workspace revision. Generation changes only when acquisition crosses a padded boundary or requests a new LOD.

- [ ] **Step 1: Add failing resident-pan, supersession, and eviction tests**

Prime complete coarse and fine selections, pan inside their source/time coverage, restyle, and change unrelated workspace state. Assert upload bytes and descriptor rebuild count remain unchanged. Stage an incomplete fine generation and assert selection remains all-coarse. Force pressure and assert nonvisible/superseded fine tiles evict before current coarse tiles.

- [ ] **Step 2: Run tests and verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/residency.test.ts frontend/src/render/gpu/series-slots.test.ts frontend/src/ui/panel.test.ts`

Expected: FAIL because workspace revision is in tile keys and old coarse entries remain visible/pinned.

- [ ] **Step 3: Separate acquisition generation from workspace revision**

`PanelView.renderData` accepts an explicit acquisition selection containing generation and resident keys. Window/style revision never enters `tileKey`. If selected resident tiles cover the requested window, update axes and `LineViewport` only.

- [ ] **Step 4: Implement atomic batch admission**

Before writing any bytes, compute missing allocation size and an eviction plan using this order:

```text
nonvisible superseded fine
nonvisible coarse
visible superseded fine
current visible fine
never current visible coarse
```

Apply eviction and uploads transactionally. If the complete fine selection cannot fit, discard its staged entries and retain the complete coarse selection.

- [ ] **Step 5: Make style preparation O(series)**

Build `Map<string, RenderSeries>` once, then iterate tiles once. Release `SeriesSlots` for signals no longer selected. Cache bind groups per page and recreate them only when a referenced GPU buffer changes.

```ts
const seriesByPath = new Map(
  rendered.series.map((series) => [series.path, series]),
);
for (const tile of tiles.series) {
  const series = seriesByPath.get(tile.signalPath);
  if (series !== undefined) writeStyle(tile, series);
}
```

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh unit frontend/src/render/gpu/residency.test.ts frontend/src/render/gpu/series-slots.test.ts frontend/src/render/gpu/line-renderer.test.ts frontend/src/ui/panel.test.ts`

Expected: PASS; resident pan and style-only updates report zero geometry work.

```bash
git add frontend/src/render/gpu/residency.ts frontend/src/render/gpu/residency.test.ts frontend/src/render/gpu/series-slots.ts frontend/src/render/gpu/series-slots.test.ts frontend/src/render/gpu/line-renderer.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts
git commit -m "fix(plot): preserve atomic GPU residency"
```

### Task 8: Cancel Obsolete Acquisition and Publish Only the Latest Generation

**Files:**

- Modify: `frontend/src/app/tile-refinement.ts`
- Modify: `frontend/src/app/tile-refinement.test.ts`
- Modify: `frontend/src/app/tile-window-cache.ts`
- Modify: `frontend/src/app/tile-window-cache.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/ui/panel.ts`

**Interfaces:**

```ts
export interface RefinementGeneration {
  readonly id: number;
  readonly controller: AbortController;
  readonly paddedWindow: { t0: number; t1: number };
}

export class TileRefinementController {
  start(request: RefinementRequest): number;
  cancelActive(): void;
}
```

- [ ] **Step 1: Add failing cancellation and publication tests**

Start a 10,000-series generation, leave its first coarse chunk unresolved, then start a new viewport generation. Assert the old signal is aborted immediately, no old coarse/fine response reaches residency, and the new coarse chunk starts without waiting for old fine chunks.

- [ ] **Step 2: Run tests and verify failure**

Run: `./scripts/test.sh unit frontend/src/app/tile-refinement.test.ts frontend/src/app/tile-window-cache.test.ts frontend/src/ui/app-shell.test.ts`

Expected: FAIL because a new refresh currently queues behind the active generation.

- [ ] **Step 3: Implement immediate supersession**

On every request that is not covered by current residency, abort the active controller, increment the acquisition generation, and begin coarse chunks for the new padded window. Guard every completion and error:

```ts
if (generation.id !== this.active?.id || generation.controller.signal.aborted) {
  return;
}
```

Publish coarse chunks immediately. Stage fine chunks, but call `residency.select` only after all visible signals have a fine resident.

- [ ] **Step 4: Verify and commit**

Run: `./scripts/test.sh unit frontend/src/app/tile-refinement.test.ts frontend/src/app/tile-window-cache.test.ts frontend/src/ui/app-shell.test.ts frontend/src/render/gpu/residency.test.ts`

Expected: PASS; old 10,000-series work never blocks or mutates a newer viewport.

```bash
git add frontend/src/app/tile-refinement.ts frontend/src/app/tile-refinement.test.ts frontend/src/app/tile-window-cache.ts frontend/src/app/tile-window-cache.test.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/src/ui/panel.ts
git commit -m "fix(plot): supersede stale tile refinement"
```

### Task 9: Implement Precise Hierarchical GPU Picking and Remove CPU Pointer Scans

**Files:**

- Modify: `frontend/src/render/gpu/picker.ts`
- Modify: `frontend/src/render/gpu/picker.test.ts`
- Modify: `frontend/src/render/gpu/shaders/pick-series.wgsl`
- Modify: `frontend/src/render/gpu/shaders/pick-reduce.wgsl`
- Modify: `frontend/src/app/time-plot.ts`
- Modify: `frontend/src/app/time-plot.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/panel.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/tests/gpu/fixtures.ts`
- Modify: `frontend/tests/gpu/line-renderer.spec.ts`

**Interfaces:**

```ts
export interface PickResult {
  readonly sequence: number;
  readonly seriesSlot: number;
  readonly tileMetaIndex: number;
  readonly relativeTime: number;
  readonly value: number;
  readonly distance: number;
}

export interface GpuPickerScheduler {
  requestFrame(): void;
}
```

- [ ] **Step 1: Add failing precision, reduction, and saturation tests**

Use epoch timestamps with adjacent points separated below one f32 ULP at epoch scale; require projected/picked error below 0.25 device pixel. Dispatch more explicit picks than readback slots and assert every promise resolves in sequence. Compare 1, 255, 256, 257, and 10,000 candidate reductions against `(distance, seriesSlot)` ordering.

- [ ] **Step 2: Run tests and verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/picker.test.ts frontend/src/app/time-plot.test.ts frontend/src/ui/panel.test.ts frontend/src/ui/app-shell.test.ts`

Run: `./scripts/test.sh gpu --grep "picks epoch-scale lines"`

Expected: FAIL on absolute-f32 time and serial reduction.

- [ ] **Step 3: Keep picker time relative**

Convert cursor high/low time to each tile origin without forming an absolute f32. Return `relativeTime` plus `tileMetaIndex`; TypeScript reconstructs the final f64 annotation time from the CPU tile origin after readback.

```ts
const time = page.tileOrigins[result.tileMetaIndex] + result.relativeTime;
```

- [ ] **Step 4: Implement hierarchical reduction and slot wakeup**

Use 256-thread workgroups to reduce candidate blocks into a high-water scratch buffer, repeating until one candidate remains. When `mapAsync` completes, free the slot and call `requestFrame()` if explicit or hover work remains. Hover coalesces to the newest sequence; explicit requests remain FIFO.

- [ ] **Step 5: Delete CPU pointer scans**

Derive cursor time directly from viewport x. `PreparedTimePlot` no longer maps/binary-searches every series for cursor or hit testing. Tooltip rows use the latest completed GPU pick and bounded selected/legend state. Pointer movement never calls a function that loops `series`, `bins`, or `points`.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh unit frontend/src/render/gpu/picker.test.ts frontend/src/app/time-plot.test.ts frontend/src/ui/panel.test.ts frontend/src/ui/app-shell.test.ts`

Run: `./scripts/test.sh gpu --grep "picks epoch-scale lines"`

Run: `rg -n "cursorAt|seriesAt|nearest(Line|Vertex)" frontend/src`

Expected: tests PASS and the search finds no production CPU scan path.

```bash
git add frontend/src/render/gpu/picker.ts frontend/src/render/gpu/picker.test.ts frontend/src/render/gpu/shaders/pick-series.wgsl frontend/src/render/gpu/shaders/pick-reduce.wgsl frontend/src/app/time-plot.ts frontend/src/app/time-plot.test.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts frontend/tests/gpu/fixtures.ts frontend/tests/gpu/line-renderer.spec.ts
git commit -m "feat(plot): complete asynchronous GPU picking"
```

### Task 10: Recover Surfaces and Dispose Every Panel Resource

**Files:**

- Modify: `frontend/src/render/gpu/frame-loop.ts`
- Modify: `frontend/src/render/gpu/runtime.ts`
- Modify: `frontend/src/render/gpu/runtime.test.ts`
- Modify: `frontend/src/render/gpu/line-renderer.ts`
- Modify: `frontend/src/render/gpu/line-renderer.test.ts`
- Modify: `frontend/src/render/gpu/picker.ts`
- Modify: `frontend/src/render/gpu/arena.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/panel.test.ts`
- Modify: `frontend/src/ui/workspace-view.ts`
- Modify: `frontend/src/ui/workspace-view.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

```ts
export interface GpuPanelEncoder {
  readonly id: string;
  encode(encoder: GPUCommandEncoder): void;
  afterSubmit(): void;
  deviceLost(): void;
  deviceRestored(device: GPUDevice, format: GPUTextureFormat): void;
  dispose(): void;
}

export type GpuRuntimeState =
  | { kind: "ready" }
  | { kind: "recovering"; message: string }
  | { kind: "unsupported"; capability: string; reason: string };
```

- [ ] **Step 1: Add failing loss, restore, and removal tests**

Assert device loss stops submission, reports `recovering`, reacquires once, reconfigures every context with the new device, re-requests selected tiles, and records recovery only after a successful nonblank frame. Make reacquisition fail and assert a visible terminal unsupported state. Remove a panel and assert runtime registration, observers, buffers, textures, picker slots, arena pages, and bind groups are released.

- [ ] **Step 2: Run tests and verify failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/runtime.test.ts frontend/src/render/gpu/line-renderer.test.ts frontend/src/ui/panel.test.ts frontend/src/ui/workspace-view.test.ts frontend/src/ui/app-shell.test.ts`

Expected: FAIL because contexts are not reconfigured and panel removal has no disposal path.

- [ ] **Step 3: Make registration ownership explicit**

`GpuRuntime.register` returns one disposer that unregisters from both `panels` and the current frame loop. `PanelView.dispose` invokes it exactly once, disconnects `ResizeObserver`, and destroys renderer/residency/arena resources. `WorkspaceView.sync` calls `dispose` before removing a panel element.

- [ ] **Step 4: Reconfigure on every device generation**

`deviceRestored` calls:

```ts
context.configure({
  device,
  format,
  alphaMode: "premultiplied",
});
```

Then recreate render targets, pipelines, buffers, bind groups, and picker slots once. Re-request visible tiles from the active data plane; do not attempt to reuse destroyed GPU allocations.

- [ ] **Step 5: Surface recovery state**

Canvas overlays remain visible while a factual `Recovering GPU…` state blocks new submissions. A failed restore becomes `WebGPU unavailable: <capability> — <reason>` and never leaves a blank interactive panel.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh unit frontend/src/render/gpu/runtime.test.ts frontend/src/render/gpu/line-renderer.test.ts frontend/src/ui/panel.test.ts frontend/src/ui/workspace-view.test.ts frontend/src/ui/app-shell.test.ts`

Expected: PASS with exact destroy/unregister counts.

```bash
git add frontend/src/render/gpu/frame-loop.ts frontend/src/render/gpu/runtime.ts frontend/src/render/gpu/runtime.test.ts frontend/src/render/gpu/line-renderer.ts frontend/src/render/gpu/line-renderer.test.ts frontend/src/render/gpu/picker.ts frontend/src/render/gpu/arena.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts frontend/src/ui/workspace-view.ts frontend/src/ui/workspace-view.test.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts
git commit -m "fix(plot): restore and dispose WebGPU surfaces"
```

### Task 11: Replace the Blank Golden with Structural and Pixel-Mask Proof

**Files:**

- Modify: `frontend/src/render/gpu/metrics.ts`
- Modify: `frontend/src/render/gpu/metrics.test.ts`
- Modify: `frontend/src/render/gpu/line-renderer.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/tests/gpu/fixtures.ts`
- Modify: `frontend/tests/gpu/line-renderer.spec.ts`
- Replace: `frontend/tests/gpu/line-renderer.spec.ts-snapshots/line-renderer-gpu-linux.png`
- Modify: `frontend/playwright.config.ts`
- Modify: `core/scope-core/src/benchmarks/corpus.rs`
- Modify: `core/scope-core/src/benchmarks/mod.rs`

**Interfaces:**

```ts
export interface GpuMetricsSnapshot {
  readonly selectedSeries: number;
  readonly seriesWithSegments: number;
  readonly compactSegments: number;
  readonly descriptorRebuilds: number;
  readonly uploadBytes: number;
  readonly residentBytes: number;
  readonly drawCalls: number;
  readonly successfulFrames: number;
  readonly validationErrors: readonly string[];
}
```

- [ ] **Step 1: Add deterministic GPU fixtures**

Use separate cases for ordered extrema, duplicate extrema, exact gaps, two overlapping translucent lines, quad/hairline membership, focused emphasis, light/dark tokens, epoch deep zoom, 1,000 visible series, and a small 10,000-series structural fixture. Fix `dense10k` gap generation so the generated response signal actually contains NaNs.

- [ ] **Step 2: Make metrics describe submitted GPU work**

Read compact descriptor counts from the compute result, not `pointCount - 1`. Aggregate metrics across panels in `GpuRuntime`; panel removal subtracts its state. Increment successful frames only after a pass with a configured context and submitted nonzero geometry completes without validation error.

- [ ] **Step 3: Assert bounded pixel masks before screenshots**

For every fixture, read canvas pixels and assert:

```text
trajectory pixel count > 0
pixels outside plot scissor == 0
gap corridor trajectory pixels == 0
expected extrema neighborhoods contain trajectory pixels
overlap neighborhood differs from either single-line color
selectedSeries == seriesWithSegments for drawable fixtures
compactSegments == CPU reference segment count
validationErrors is empty
```

Only after these assertions pass may the task regenerate the representative screenshot.

- [ ] **Step 4: Pin the software adapter launch contract**

The `gpu` Playwright project uses repository Chromium with `--enable-unsafe-webgpu --use-angle=swiftshader`. Its setup test requires `navigator.gpu`, a successful adapter/device, all production shader modules compiled, and a nonblank probe triangle. If SwiftShader is unavailable, fail with installation diagnostics; do not skip.

- [ ] **Step 5: Run the GPU proof twice**

Run: `./scripts/test.sh gpu --update-snapshots`

Run: `./scripts/test.sh gpu`

Expected: both PASS; the second run changes no files and the golden contains trajectory pixels.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh core corpus`

Run: `git diff --check`

```bash
git add frontend/src/render/gpu/metrics.ts frontend/src/render/gpu/metrics.test.ts frontend/src/render/gpu/line-renderer.ts frontend/src/ui/panel.ts frontend/tests/gpu/fixtures.ts frontend/tests/gpu/line-renderer.spec.ts frontend/tests/gpu/line-renderer.spec.ts-snapshots/line-renderer-gpu-linux.png frontend/playwright.config.ts core/scope-core/src/benchmarks/corpus.rs core/scope-core/src/benchmarks/mod.rs
git commit -m "test(plot): prove nonblank WebGPU fidelity"
```

### Task 12: Measure Real Work, Wire Final Gates, and Complete the PR

**Files:**

- Modify: `frontend/tests/bench/measure.ts`
- Modify: `frontend/tests/bench/bench.spec.ts`
- Modify: `scripts/test.sh`
- Modify: `scripts/ci.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/bench.yml`
- Modify: `docs/implementation-roadmap.md`
- Modify: version manifests produced by `./scripts/version.sh bump patch`

**Interfaces:**

```ts
export interface BenchMilestones {
  readonly navigationStart: number;
  readonly coarseComplete: number;
  readonly firstSuccessfulGpuFrame: number;
  readonly fineComplete: number;
}

export interface MetricDelta {
  readonly uploadBytes: number;
  readonly descriptorRebuilds: number;
  readonly successfulFrames: number;
}
```

- [ ] **Step 1: Replace fabricated benchmark fields with observed milestones**

The app emits bench-only events for coarse completion, first successful nonblank GPU frame, fine selection, completed picks, and restored frame. Remove every hardcoded refinement/pan/recovery zero. Compute durations from event timestamps and deltas from snapshots taken immediately before and after each operation.

- [ ] **Step 2: Drive renderer work, not an unrelated RAF loop**

Keep RAF and `PerformanceObserver` for responsiveness, but pair them with renderer counters. The interaction script performs:

```text
10 resident-window pans
10 padded-boundary pans
10 wheel zooms in and out
30 hover picks
10 explicit click picks
one test-only device loss and restored nonblank frame
```

For resident pans, assert `uploadBytes == 0` and `descriptorRebuilds == 0`. Require every pick promise and recovery event; empty arrays fail rather than becoming zero milliseconds.

- [ ] **Step 3: Enforce all acceptance fields**

Both `mc1000` and `dense10k` reports fail unless:

```text
selected series == expected input files
series with segments == drawable input files
compact segments > 0
successful GPU frames > 0
validation errors == 0
frame p95 <= 33 ms
longest frame or long task <= 250 ms
resident pan upload bytes == 0
resident pan descriptor rebuilds == 0
pick p95 is measured from 40 completed picks
device recovery is measured from one restored nonblank frame
```

- [ ] **Step 4: Put the GPU proof in public test and CI scripts**

Extend `./scripts/test.sh full` and `./scripts/ci.sh e2e` to run the GPU project after ordinary e2e. Add a dedicated Linux CI step using the same script so PRs cannot pass with invalid WGSL or a blank golden. Native shell tests continue to accept either `ready` or the explicit unsupported state according to the host capability probe.

- [ ] **Step 5: Run the complete final gate**

Run: `./scripts/format.sh`

Run: `./scripts/format.sh --check`

Run: `./scripts/test.sh quick`

Run: `./scripts/test.sh shell`

Run: `./scripts/test.sh frontend`

Run: `./scripts/test.sh gpu`

Run: `./scripts/test.sh e2e`

Run: `./scripts/test.sh bench e2e`

Run: `./scripts/build.sh web`

Run: `./scripts/build.sh native`

Run: `./scripts/ci.sh all`

Expected: every command PASS. The native build proves bundling, not native WebGPU availability. Record the host's capability result without claiming hardware rendering when it took the unsupported path.

- [ ] **Step 6: Perform the supported-host manual smoke when available**

On a non-WSL host where Tauri exposes `navigator.gpu`, run `./scripts/run.sh native`, load `mc1000`, and record adapter limits, first successful frame, pan behavior, and absence of validation errors. If no such host is available, state that limitation in the handoff; do not block the deterministic SwiftShader proof and do not claim native GPU execution was tested.

- [ ] **Step 7: Update completion documentation**

Correct the roadmap's prior completion claim with measured report fields and the exact native platform limitation. Do not rewrite historical plans or ADR 0039; this plan repairs its implementation without changing the accepted architecture.

- [ ] **Step 8: Bump the version only after all gates pass**

Run: `./scripts/version.sh bump patch`

Run: `./scripts/version.sh check`

Run: `./scripts/format.sh`

Run: `./scripts/format.sh --check`

Review staged and unstaged diffs separately, then stage only implementation files and synchronized manifests.

```bash
git commit -m "chore(release): bump version for verified WebGPU plotting"
```

## Final Acceptance Gate

The implementation is complete only when all of the following are true:

- Every production WGSL module compiles under the software adapter with no validation error.
- The GPU golden and every focused fixture contain verified trajectory pixels.
- Descriptor compaction runs on GPU; production allocates no JS descriptor per segment.
- Shader metadata lookup is O(1).
- Quad output is premultiplied-alpha blended, 4x MSAA resolved, and plot-scissored.
- Hairline and quad membership are disjoint and collectively preserve every valid segment.
- Resident pan performs zero point upload and zero descriptor rebuild.
- Coarse/fine selection is atomic across all visible series.
- Obsolete viewport work is aborted immediately.
- Pointer movement performs no CPU series/vertex scan.
- Epoch-scale picking stays below 0.25 device-pixel error and every explicit request resolves.
- Device restoration reconfigures surfaces and terminal failure is visible.
- Removed panels release runtime registration, observers, and all GPU resources.
- Paged pyramid construction and indexed gathering remain bounded.
- Native and baked partial-window tile metadata/points are equivalent.
- Large finite values return typed tile errors rather than panicking.
- `mc1000` and `dense10k` reports contain measured refinement, pan, pick, and recovery values and pass the 33 ms/250 ms floors.
- `./scripts/ci.sh all` passes after the GPU project is part of the gate.
- The final patch version is synchronized only after every preceding condition passes.

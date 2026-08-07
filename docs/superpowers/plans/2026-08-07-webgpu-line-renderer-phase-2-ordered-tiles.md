# WebGPU Line Renderer Phase 2: Ordered Tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every pyramid query return an ordered stream of real sample representatives, exact gap breaks, and compact statistics suitable for direct GPU upload.

**Architecture:** Pyramid bins retain representative source indices and signals retain exact NaN gap runs. A query orders and deduplicates first/min/max/last indices, gathers only those raw samples, marks breaks by searching gap runs, and emits a packed 16-byte GPU point stream beside the existing statistical columns. Native and baked hosts produce the same frontend tile shape; a temporary adapter renders the new points through Canvas2D until Phase 3.

**Tech Stack:** Rust 2024, binary little-endian tile framing, JSON snapshot manifests, typed-array views, Canvas2D compatibility adapter, protocol code generation.

## Global Constraints

- Every representative is a raw `(time, value)` sample and remains in source-index order.
- First, last, finite extrema, and gaps survive every level; equal representative indices are emitted once.
- Min/max ties select the earliest source index so output is deterministic.
- Level zero emits each raw sample once and never manufactures a value.
- Keep bin sums, squared sums, finite/sample counts, extrema, and gap metadata for statistics.
- `query_with_target` remains the LOD selector; its target is per series and independent of panel cardinality.
- Native point payloads are packed for direct `queue.writeBuffer`; no per-point JavaScript objects are created on native queries.
- Sidecar cache ABI becomes v5 and protocol becomes v20. Old sidecars are misses and rebuild; old wire payloads fail before partial decode.
- The Canvas adapter is explicitly temporary and is deleted in Phase 3.
- Start only from a committed Phase 1 completion gate. Before Task 1, run `git status --short`, inspect target files and nearby tests, and preserve unrelated changes.
- Do not bump the application version in this phase.

---

## Resulting File Structure

- `core/scope-core/src/bins.rs` — compact bin columns plus four representative source-index columns.
- `core/scope-core/src/gaps.rs` — exact sorted, disjoint half-open NaN runs and intersection queries.
- `core/scope-core/src/points.rs` — ordered representative generation and point packing inputs.
- `core/scope-core/src/columns.rs` — page-aware indexed gather.
- `core/scope-core/src/cache.rs` — cache v5 bin/index and gap-run sections.
- `protocol/src/tile_binary.rs` — v20 series header, statistical columns, and packed point stream.
- `frontend/src/app/tile-points.ts` — zero-copy point-stream access and baked-host packing.
- `frontend/src/app/canvas-point-adapter.ts` — temporary point-to-level-zero columns.

### Task 1: Preserve Representative Source Indices in Every Pyramid Bin

**Files:**

- Modify: `core/scope-core/src/bins.rs`
- Modify: `core/scope-core/src/pyramid.rs`
- Modify: `core/scope-core/src/ingest/batch.rs`

**Interfaces:**

- Produces columns `first_index`, `last_index`, `min_index`, `max_index: &[u64]` on `BinLevel`.
- Uses `MISSING_INDEX = u64::MAX` when the corresponding finite-value flag is absent.

- [ ] **Step 1: Write failing representative-index tests**

Add these cases to `pyramid.rs`:

```rust
#[test]
fn merged_bin_keeps_orderable_representative_indices() {
    let pyramid = Pyramid::from_samples(
        &[10.0, 11.0, 12.0, 13.0],
        &[5.0, -3.0, 9.0, 7.0],
    );
    let bin = pyramid.level(2).unwrap().get(0).unwrap();
    assert_eq!(bin.first_index(), Some(0));
    assert_eq!(bin.min_index(), Some(1));
    assert_eq!(bin.max_index(), Some(2));
    assert_eq!(bin.last_index(), Some(3));
}

#[test]
fn extrema_ties_choose_the_earliest_sample() {
    let pyramid = Pyramid::from_samples(
        &[0.0, 1.0, 2.0, 3.0],
        &[2.0, -1.0, -1.0, 2.0],
    );
    let bin = pyramid.level(2).unwrap().get(0).unwrap();
    assert_eq!(bin.min_index(), Some(1));
    assert_eq!(bin.max_index(), Some(0));
}

#[test]
fn all_nan_bin_has_no_representative_indices() {
    let pyramid = Pyramid::from_samples(&[0.0, 1.0], &[f64::NAN, f64::NAN]);
    let bin = pyramid.level(1).unwrap().get(0).unwrap();
    assert_eq!(bin.first_index(), None);
    assert_eq!(bin.last_index(), None);
    assert_eq!(bin.min_index(), None);
    assert_eq!(bin.max_index(), None);
}
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `./scripts/test.sh core merged_bin_keeps_orderable_representative_indices`

Expected: FAIL because `BinRef` has no index accessors.

- [ ] **Step 3: Add the four index columns**

Add four `Vec<u64>` fields to `BinLevel` and `SharedBinLevel`, include them in equality, capacity, slices, shared conversion, and accessors. Task 4 updates cache encoding/decoding after the in-memory behavior passes. Define:

```rust
pub const MISSING_INDEX: u64 = u64::MAX;

impl BinRef<'_> {
    pub fn first_index(self) -> Option<u64> { self.index_for(HAS_FIRST, self.level.first_index_column()) }
    pub fn last_index(self) -> Option<u64> { self.index_for(HAS_LAST, self.level.last_index_column()) }
    pub fn min_index(self) -> Option<u64> { self.index_for(HAS_MIN, self.level.min_index_column()) }
    pub fn max_index(self) -> Option<u64> { self.index_for(HAS_MAX, self.level.max_index_column()) }
}
```

Indexes are absolute source-row indexes, not offsets within a level. Level-zero finite samples set all four indexes to the row index.

Do not build production levels through `EnvelopeBin`: it cannot carry source
indexes. Add a private indexed construction value:

```rust
struct IndexedBin {
    summary: EnvelopeBin,
    first_index: u64,
    last_index: u64,
    min_index: u64,
    max_index: u64,
}
```

Refactor `sample_bin`, `merge_bins`, `from_parts`, `fold_bin`, and
`merge_level` to operate on `IndexedBin`, then append it with
`BinLevel::push_indexed`. Keep `EnvelopeBin` as the statistical wire/session
value. `BinLevel::from_wire` may fill `MISSING_INDEX` only for isolated
statistical codec fixtures; no production pyramid constructor, query, cache
reopen path, or ordered-point test may call it.

- [ ] **Step 4: Merge indexes with values**

Replace independent `min_option`/`max_option` selection with value/index pairs. For equal values choose the lower index. First comes from the left finite child, last from the right finite child. All index flags must agree with the corresponding value flags.

- [ ] **Step 5: Update compact byte accounting**

Set:

```rust
pub const BYTES_PER_BIN: usize =
    8 * size_of::<f64>() + 4 * size_of::<u64>() + 2 * size_of::<u32>() + size_of::<u8>();
```

Update the storage-budget test to assert `BYTES_PER_BIN <= 112`, and let ingest admission use the new constant automatically.

- [ ] **Step 6: Run pyramid tests**

Run: `./scripts/test.sh core pyramid`

Expected: PASS for extrema, NaN, synthesized-level, retained/paged, and query-reference cases.

- [ ] **Step 7: Commit**

```bash
git add core/scope-core/src/bins.rs core/scope-core/src/pyramid.rs core/scope-core/src/ingest/batch.rs
git commit -m "feat(pyramid): retain representative sample indices"
```

### Task 2: Store Exact Gap Runs and Gather Indexed Samples Efficiently

**Files:**

- Create: `core/scope-core/src/gaps.rs`
- Modify: `core/scope-core/src/lib.rs`
- Modify: `core/scope-core/src/columns.rs`
- Modify: `core/scope-core/src/paging.rs`
- Modify: `core/scope-core/src/pyramid.rs`

**Interfaces:**

- Produces: `GapRuns::from_values`, `GapRuns::breaks_between`, and `Column::gather`.
- `Pyramid` owns `Arc<GapRuns>` beside its columns and merged levels.

- [ ] **Step 1: Write gap-run and gather tests**

```rust
#[test]
fn gap_runs_are_sorted_disjoint_and_half_open() {
    let runs = GapRuns::from_values(&[1.0, f64::NAN, f64::NAN, 2.0, f64::NAN, 3.0]);
    assert_eq!(runs.as_slice(), &[(1, 3), (4, 5)]);
    assert!(runs.breaks_between(0, 3));
    assert!(!runs.breaks_between(3, 3));
    assert!(runs.breaks_between(3, 5));
}

#[test]
fn gather_preserves_request_order_and_duplicates() {
    let column = Column::from(vec![10.0, 20.0, 30.0, 40.0]);
    assert_eq!(column.gather(&[3, 1, 1]).unwrap(), vec![40.0, 20.0, 20.0]);
}
```

Add a paged gather test with indexes crossing a 64 KiB page boundary.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `./scripts/test.sh core gap_runs_are_sorted_disjoint_and_half_open`

Run: `./scripts/test.sh core gather_preserves_request_order_and_duplicates`

Expected: both FAIL because the types do not exist.

- [ ] **Step 3: Implement `GapRuns`**

Use exact half-open row ranges:

```rust
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GapRuns(Arc<[(u64, u64)]>);

impl GapRuns {
    pub fn from_values(values: &[f64]) -> Self;
    pub fn from_ranges(ranges: Vec<(u64, u64)>) -> Option<Self>;
    pub fn as_slice(&self) -> &[(u64, u64)];
    pub fn breaks_between(&self, left: u64, right: u64) -> bool;
}
```

`breaks_between(left, right)` is only called for finite representative rows and
returns true when a NaN row lies strictly between them. Return false when
`right <= left`; otherwise binary-search the first run whose end exceeds
`left + 1` and test whether its start is less than `right`.

- [ ] **Step 4: Implement page-aware gather**

Add `PageHandle::values_at(&[usize]) -> Result<Vec<f64>, PageError>`. Validate all indexes first, group requested positions by page, lease each page once, decode requested values, and restore original request order. `Column::gather` delegates to direct indexing for owned columns and `values_at` for paged columns.

- [ ] **Step 5: Attach gap runs to `Pyramid`**

In-memory constructors compute runs while raw values are already resident.
Streaming ingest extends a run builder while decoding chunks and passes the
finished runs into the pyramid. Cached reopen accepts only validated v5 runs.
Never materialize or rescan a paged multi-GB value column to discover gaps.
Clones share the `Arc`. Add:

```rust
pub fn gap_runs(&self) -> &GapRuns;
```

Do not derive gaps from coarse `has_gap`; the raw runs are authoritative.

- [ ] **Step 6: Run focused and full core tests**

Run: `./scripts/test.sh core gaps`

Run: `./scripts/test.sh core paging`

Run: `./scripts/test.sh core pyramid`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add core/scope-core/src/gaps.rs core/scope-core/src/lib.rs core/scope-core/src/columns.rs core/scope-core/src/paging.rs core/scope-core/src/pyramid.rs
git commit -m "feat(pyramid): preserve exact gap boundaries"
```

### Task 3: Emit Ordered Real-Sample Point Streams

**Files:**

- Create: `core/scope-core/src/points.rs`
- Modify: `core/scope-core/src/lib.rs`
- Modify: `core/scope-core/src/pyramid.rs`
- Modify: `core/scope-core/src/tile_wire.rs`

**Interfaces:**

- Produces:

```rust
pub struct RenderPoint {
    pub time: f64,
    pub value: f64,
    pub source_index: u64,
    pub break_before: bool,
}

pub struct PyramidQuery {
    pub level: u32,
    pub source_start: u64,
    pub source_end: u64,
    pub bins: BinLevel,
    pub points: Vec<RenderPoint>,
}
```

- [ ] **Step 1: Add ordered-emission tests**

Cover all required cases in `points.rs`:

```rust
#[test]
fn extrema_are_sorted_and_duplicate_indices_are_removed() {
    let query = Pyramid::from_samples(
        &[0.0, 1.0, 2.0, 3.0],
        &[4.0, -2.0, 9.0, 7.0],
    ).query_with_target(0.0, 3.0, 1, Some(1));
    assert_eq!(
        query.points.iter().map(|point| point.source_index).collect::<Vec<_>>(),
        vec![0, 1, 2, 3],
    );
}

#[test]
fn level_zero_is_raw_passthrough_with_gap_breaks() {
    let query = Pyramid::from_samples(
        &[10.0, 11.0, 12.0, 13.0],
        &[1.0, f64::NAN, 3.0, 4.0],
    ).query_with_target(10.0, 13.0, 100, None);
    assert_eq!(query.points.len(), 3);
    assert_eq!(query.points[1].source_index, 2);
    assert!(query.points[1].break_before);
}
```

Also test all-NaN bins, leading/trailing gaps, several gaps in one coarse bin, epoch-scale nonuniform timestamps, and each emitted value/time against the raw arrays at `source_index`.

- [ ] **Step 2: Run tests to verify failure**

Run: `./scripts/test.sh core extrema_are_sorted_and_duplicate_indices_are_removed`

Expected: FAIL because `PyramidQuery` has no points.

- [ ] **Step 3: Implement candidate ordering**

For every selected bin, collect present `[first_index, min_index, max_index, last_index]`, sort ascending, and deduplicate. Append across bins while deduplicating the shared boundary index. Use `Column::gather` once for all point indexes for time and once for values.

- [ ] **Step 4: Mark exact breaks**

The first emitted point has `break_before = true`. Every later point sets it from `gap_runs.breaks_between(previous.source_index, current.source_index)`. Skipped finite samples introduced by LOD do not break a stroke.

- [ ] **Step 5: Return source metadata**

Set `source_start..source_end` to the exclusive raw row range covered by the
selected neighboring bins, or `0..0` for an empty query. Preserve the existing
neighboring-bin window behavior. A failed paged gather returns an empty query
through the existing fallible path rather than panicking.

- [ ] **Step 6: Verify all query semantics**

Run: `./scripts/test.sh core points`

Run: `./scripts/test.sh core pyramid`

Expected: PASS; query-reference level selection is unchanged.

- [ ] **Step 7: Commit**

```bash
git add core/scope-core/src/points.rs core/scope-core/src/lib.rs core/scope-core/src/pyramid.rs core/scope-core/src/tile_wire.rs
git commit -m "feat(pyramid): emit ordered real-sample points"
```

### Task 4: Bump and Validate the Sidecar Cache ABI

**Files:**

- Modify: `core/scope-core/src/cache.rs`
- Modify: `core/scope-core/src/bins.rs`
- Modify: `core/scope-core/src/pyramid.rs`

**Interfaces:**

- Produces: sidecar `CACHE_VERSION = 5` with representative-index columns and one gap-run section per signal.

- [ ] **Step 1: Add v5 round-trip and v4-miss tests**

Extend the cache tests to compare all four index columns and `gap_runs()` after reopen. Rename the prior-version test to `a_v4_sidecar_is_a_miss_not_an_error` and write `4` into the version bytes.

- [ ] **Step 2: Run the cache round-trip test to verify failure**

Run: `./scripts/test.sh core sidecar_round_trips_store_and_pyramid_queries`

Expected: FAIL because the current cache omits indexes and runs.

- [ ] **Step 3: Define the v5 binary sections**

Set `CACHE_VERSION` to `5`. Extend each bin payload after the eight f64 columns with four u64 index columns, then sample count, finite count, and flags. Add `gap_section: CacheSection` to `CacheSignal`; encode as:

```text
u64 run_count
run_count × { u64 start, u64 end }
8-byte padding
```

Reject unsorted, overlapping, empty, reversed, or out-of-row-count runs as a cache miss.

- [ ] **Step 4: Update paged range decoding**

`BinLevel::decode_cache_range` reads the four u64 columns by range without materializing full levels. `PagedBinLevel::value` remains for f64 fields; add an index accessor that reads u64 fields with the same page-aware bounds checks.

- [ ] **Step 5: Verify cache invalidation and paging**

Run: `./scripts/test.sh core cache`

Expected: PASS, including changed ABI, checksums, large paged levels, and app-owned cache roots.

- [ ] **Step 6: Commit**

```bash
git add core/scope-core/src/cache.rs core/scope-core/src/bins.rs core/scope-core/src/pyramid.rs
git commit -m "feat(cache): persist representative indices and gaps"
```

### Task 5: Define Protocol v20 and the Packed Tile Framing

**Files:**

- Modify: `protocol/schema/scope-protocol.json`
- Modify: `protocol/src/tile_binary.rs`
- Modify: `protocol/testdata/tile-binary-conformance.bin`
- Modify: `protocol/testdata/tile-binary-conformance.json`
- Modify: `protocol/testdata/pyramid-conformance.json`
- Modify: `core/scope-core/src/tile_wire.rs`
- Modify: `core/scope-core/src/benchmarks/mod.rs`
- Modify: `shell/src-tauri/src/lib.rs`
- Regenerate: `protocol/src/generated.rs`
- Regenerate: `frontend/src/generated/protocol.ts`

**Interfaces:**

- Binary point stride is exactly 16 bytes: `f32 time_offset`, `f32 value`, `u32 flags`, `u32 reserved`.
- Point flag bit 0 is `BREAK_BEFORE`; all other bits and the reserved word must be zero.
- Series origin is f64 and `time_offset = point.time - origin`.
- `RenderPoint.source_index` proves raw-sample identity in core and baked fixtures. It is deliberately omitted from the upload record because shaders never consume it; packing may occur only after identity/order tests pass.

- [ ] **Step 1: Add codec tests for the exact layout**

Create a two-series fixture containing epoch timestamps, a gap, an all-NaN bin, and Unicode names. Assert decoded points, origin, source start, statistics, padding, and rejection of an unknown point flag/reserved word.

- [ ] **Step 2: Run the protocol test to verify failure**

Run: `./scripts/test.sh core tile_binary`

Expected: FAIL against the v19 framing.

- [ ] **Step 3: Add generated snapshot types**

Set protocol version to `20` and add:

```json
"TilePoint": {
  "kind": "object",
  "fields": {
    "time": "f64",
    "value": "f64",
    "source_index": "u64",
    "break_before": "bool"
  }
},
"BakedLevel": {
  "kind": "object",
    "fields": {
      "level": "u32",
      "source_start": "u64",
      "source_end": "u64",
      "origin": "f64",
    "bins": "EnvelopeBin[]",
    "points": "TilePoint[]"
  }
}
```

Change `BakedSignal.levels` to `BakedLevel[]`. Extend `SignalTile` with
`source_start`, `source_end`, `origin`, and `points`. Native transport uses the packed binary
framing; baked transport serializes `TilePoint.source_index` for fidelity
validation and drops it only when building the identical runtime upload bytes.

- [ ] **Step 4: Implement the v20 series framing**

Use this fixed 48-byte series header:

```text
u64 signal_id
u32 level
u32 bin_count
u32 point_count
u16 path_bytes
u16 unit_bytes (0xffff = null)
u64 source_start
u64 source_end
f64 origin
```

After names and 8-byte alignment, keep the existing 73-byte-per-bin statistical columns, align to 8, append `point_count × 16` interleaved point bytes, then align to 8. The four representative indexes remain a core/cache detail and are not duplicated on the wire.

- [ ] **Step 5: Pack only representable finite points**

Choose `origin` as the first point time or zero for an empty stream. Before encoding, require finite time/value and finite f32 offset/value. Encode `BREAK_BEFORE` from `RenderPoint`. A packing failure returns a clear tile-query error naming the signal rather than emitting infinities.

- [ ] **Step 6: Regenerate and refresh conformance fixtures**

Run: `./scripts/codegen.sh`

Regenerate deterministic fixtures through their existing guarded tests:

`REGENERATE_FIXTURES=1 ./scripts/test.sh core tile_binary_conformance_fixture`

`REGENERATE_FIXTURES=1 ./scripts/test.sh core conformance_fixture_matches_rust_query`

Do not hand-edit the binary or JSON fixtures.

Update every `SignalTile` constructor in protocol/core/shell tests for the new
generated fields. Change `bench_tile_wire_cost` to encode `query.points`
through `binary_series`; it must never reconstruct an ordered stream from
statistical bins.

- [ ] **Step 7: Verify protocol and shell**

Run: `./scripts/test.sh core tile_binary`

Run: `./scripts/test.sh core tile_wire`

Run: `./scripts/test.sh core pyramid_conformance`

Run: `./scripts/test.sh shell query_tiles`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add protocol/schema/scope-protocol.json protocol/src/generated.rs protocol/src/tile_binary.rs protocol/testdata/tile-binary-conformance.bin protocol/testdata/tile-binary-conformance.json protocol/testdata/pyramid-conformance.json core/scope-core/src/tile_wire.rs core/scope-core/src/benchmarks/mod.rs shell/src-tauri/src/lib.rs frontend/src/generated/protocol.ts
git commit -m "feat(protocol): stream GPU-shaped ordered tiles"
```

### Task 6: Decode Native Points Without Per-Point Allocation

**Files:**

- Create: `frontend/src/app/tile-points.ts`
- Create: `frontend/src/app/tile-points.test.ts`
- Modify: `frontend/src/app/bin-columns.ts`
- Modify: `frontend/src/app/tile-binary.ts`
- Modify: `frontend/src/app/tile-binary.test.ts`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `frontend/src/app/tile-window-cache.ts`
- Modify: `frontend/src/app/tile-window-cache.test.ts`

**Interfaces:**

- Produces:

```ts
export interface PackedPointStream {
  readonly count: number;
  readonly bytes: Uint8Array;
  readonly forceBreakFirst: boolean;
}

export interface ColumnarTile {
  signalId: string;
  signalPath: string;
  unit: string | null;
  level: number;
  sourceStart: string;
  sourceEnd: string;
  origin: number;
  bins: BinColumns;
  points: PackedPointStream;
}
```

- [ ] **Step 1: Add packed-stream access tests**

Test `pointTime`, `pointValue`, `pointBreakBefore`, and `slicePointStream` against an epoch-origin fixture. Assert `decoded.points.bytes.buffer === inputBuffer` for the native full response.

- [ ] **Step 2: Run the decoder tests to verify failure**

Run: `./scripts/test.sh unit frontend/src/app/tile-points.test.ts frontend/src/app/tile-binary.test.ts`

Expected: FAIL because v20 fields are absent.

- [ ] **Step 3: Implement zero-copy native decoding**

`tile-points.ts` exports constants and readers:

```ts
export const POINT_STRIDE = 16;
export const BREAK_BEFORE = 1;
export function pointTime(
  stream: PackedPointStream,
  origin: number,
  index: number,
): number;
export function pointValue(stream: PackedPointStream, index: number): number;
export function pointBreakBefore(
  stream: PackedPointStream,
  index: number,
): boolean;
```

Readers use `DataView` over `bytes.buffer` and account for `bytes.byteOffset`. Decoder validates lengths, flags, reserved words, and trailing bytes before returning.

- [ ] **Step 4: Slice points with padded tile windows**

`TileWindowCache.slice` binary-searches point times, retains one neighbor on
each side, returns a `bytes.subarray(...)`, and sets `forceBreakFirst` when the
slice begins mid-stream. `pointBreakBefore` returns true for index zero when
that metadata is set. Do not copy or mutate the backing response buffer. Bin
statistics keep their current zero-copy subarray slicing.

- [ ] **Step 5: Verify native and cache behavior**

Run: `./scripts/test.sh unit frontend/src/app/tile-binary.test.ts frontend/src/app/tile-points.test.ts frontend/src/app/tile-window-cache.test.ts frontend/src/app/data-plane.test.ts`

Expected: PASS with no array of JavaScript point objects in `TauriPlane`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/tile-points.ts frontend/src/app/tile-points.test.ts frontend/src/app/bin-columns.ts frontend/src/app/tile-binary.ts frontend/src/app/tile-binary.test.ts frontend/src/app/data-plane.ts frontend/src/app/data-plane.test.ts frontend/src/app/tile-window-cache.ts frontend/src/app/tile-window-cache.test.ts
git commit -m "feat(frontend): decode ordered tile points zero-copy"
```

### Task 7: Bake Explicit Levels and Match the Native Tile Shape

**Files:**

- Modify: `core/scope-core/src/snapshot.rs`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `frontend/src/app/pyramid-query.ts`
- Modify: `frontend/src/app/pyramid-query.test.ts`
- Modify: `frontend/src/app/baked-session.test.ts`
- Modify: `frontend/scripts/check-snapshot.mjs`

**Interfaces:**

- `BakedLevel.level` is the real pyramid level; array position is never interpreted as level number.
- `BakedLevel.source_start..source_end` is the same exclusive raw range as native framing.
- `BakedPlane.queryTiles` returns the same `ColumnarTile` shape as native.

- [ ] **Step 1: Add a decimated-level identity test**

Bake a signal whose finest retained level is greater than zero and assert `manifest.signals[0].levels[0].level` equals the plan's actual level. Query it through `BakedPlane` and assert the returned level, origin, source start, points, and bins match the Rust query reference.

- [ ] **Step 2: Run snapshot and BakedPlane tests to verify failure**

Run: `./scripts/test.sh core baked_levels_are_positional_from_the_finest_planned_level`

Run: `./scripts/test.sh unit frontend/src/app/data-plane.test.ts`

Expected: FAIL because baked levels currently lose their true index and contain bins only.

- [ ] **Step 3: Bake bins and points together**

For each `LevelPlan`, call the same ordered-query helper used by native tiles
for the planned level/window and serialize one
`BakedLevel { level, source_start, source_end, origin, bins, points }`.
Preserve deterministic signal and level order.

- [ ] **Step 4: Pack BakedPlane points once per cached level**

Convert `TilePoint[]` into the identical 16-byte stream, rejecting non-finite/f32-unrepresentable data with the same message as native. Cache packed levels by `(signal_id, level)`; slice cached bytes and bins for requests. Do not keep a second expanded point-object cache.

- [ ] **Step 5: Keep CSV sample behavior explicit**

For baked `querySamples`, use the finest baked level's ordered points. This is an export-fidelity approximation when level zero was not baked; retain and test that existing snapshot contract rather than inventing raw data.

- [ ] **Step 6: Verify snapshot artifacts**

Run: `./scripts/test.sh core snapshot`

Run: `./scripts/test.sh frontend`

Expected: PASS, including no-network, injection escaping, and artifact size checks.

- [ ] **Step 7: Commit**

```bash
git add core/scope-core/src/snapshot.rs frontend/src/app/data-plane.ts frontend/src/app/data-plane.test.ts frontend/src/app/pyramid-query.ts frontend/src/app/pyramid-query.test.ts frontend/src/app/baked-session.test.ts frontend/scripts/check-snapshot.mjs
git commit -m "feat(snapshot): bake explicit ordered tile levels"
```

### Task 8: Keep Time Plots Working Through the Temporary Canvas Adapter

**Files:**

- Create: `frontend/src/app/canvas-point-adapter.ts`
- Create: `frontend/src/app/canvas-point-adapter.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/panel.test.ts`
- Modify: `frontend/src/render/canvas-renderer.test.ts`

**Interfaces:**

- Produces: `canvasBinsFromPoints(tile: ColumnarTile): BinColumns`.
- Statistics and auto-range continue to consume `tile.bins`; only Canvas stroke geometry consumes adapter output.

- [ ] **Step 1: Add adapter fidelity tests**

Given a packed stream with a repeated source representative and a break, assert one level-zero-style bin per packed point, `t0 === t1 === pointTime`, all finite value fields equal `pointValue`, and `HAS_GAP` is set exactly when `break_before` is true.

- [ ] **Step 2: Run the adapter test to verify failure**

Run: `./scripts/test.sh unit frontend/src/app/canvas-point-adapter.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the temporary adapter**

Allocate exactly the `BinColumns` needed by the Canvas renderer. Set sum/value counts for a single finite sample. The first point starts a stroke. Do not cache by panel; cache by `PackedPointStream.bytes` identity in a `WeakMap<ArrayBuffer, BinColumns>` so style-only redraws reuse it.

- [ ] **Step 4: Wire panel geometry and statistics separately**

The panel passes adapted columns to `CanvasRenderer.render`, but `prepareTimePlot` receives statistical bins for y extent and stats. Cursor/annotation temporary CPU behavior may read adapted points so displayed values are real representatives.

- [ ] **Step 5: Run Phase 2 validation**

Run: `./scripts/format.sh`

Run: `./scripts/test.sh core`

Run: `./scripts/test.sh frontend`

Run: `./scripts/test.sh quick`

Run: `./scripts/test.sh shell`

Expected: all non-GUI checks PASS; native and baked visual verification remains deferred until Phase 4.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/canvas-point-adapter.ts frontend/src/app/canvas-point-adapter.test.ts frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts frontend/src/render/canvas-renderer.test.ts
git commit -m "refactor(plot): adapt ordered points to Canvas temporarily"
```

## Phase 2 Completion Gate

Run:

```bash
./scripts/format.sh --check
./scripts/test.sh quick
./scripts/test.sh shell
git diff --check
git status --short
```

The native/baked conformance fixtures must cover NaN gaps and epoch-scale
timestamps. Every serialized baked point and every pre-packed native point
must trace to its raw source index, and a level-zero query must equal the raw
finite samples. Do not proceed if the Canvas adapter remains wired to envelope
first/min/max synthesis instead of the ordered point stream. GUI inspection is
deferred to the completed Phase 4 gate.

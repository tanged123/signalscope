# Plotting Performance Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make zoom/pan on the mc1000 corpus (1000 sources × 5 channels × 10,001 samples) interactive — tile refresh p95 ≤ 20 ms in core, frame p95 ≤ 33 ms in the browser — by fixing the six root causes found in the 2026-08-04 performance investigation.

**Architecture:** Seven phases, each an independently landable PR. Phase 0 adds honest benchmarks over the paths that are actually slow (warm-reopen paged queries, wire serialization, 1000-source browser artifact). Phase 1 fixes the core query engine (page-granular I/O, columnar query path, iterative synthesis, O(1) level selection). Phase 2 replaces JSON tile transport with a versioned binary columnar format consumed zero-copy as typed arrays. Phase 3 adds client-side window padding, caching, and request elision. Phase 4 fixes the interaction loop (rAF coalescing, gesture-end history, dirty checks, cached resolution). Phase 5 rewrites the Canvas2D stroke geometry. Phase 6 records the ADR and closes out.

**Tech Stack:** Rust (scope-core, scope-protocol, signalscope-shell), TypeScript (frontend), Tauri 2 raw IPC responses, Playwright bench project. No new workspace dependencies.

## Root causes this plan fixes (from the investigation)

1. JSON tile transport: ~239 B/bin × up to 2×width bins × 1000 series ≈ hundreds of MB serialized by `serde_json`, `JSON.parse`d into millions of objects per refresh (`shell/src-tauri/src/lib.rs:866`, `protocol/src/generated.rs` `EnvelopeBin`).
2. Paged I/O: `PageCache::read` does a fresh `File::open` + exact-range read per probe (`core/scope-core/src/paging.rs:318`); binary searches issue ~116 probes/signal → ~116k opens per refresh after warm reopen; `make_room`/`resident_bytes` is O(entries) per insert (`paging.rs:407-434`).
3. No client-side tile cache: `tilesByPanel` holds one response, replaced wholesale (`frontend/src/ui/app-shell.ts:184`, `:2602`); a one-pixel pan refetches everything.
4. Levels 0–2 are synthesized recursively from raw columns per query (`FINEST_STORED_LEVEL = 3`, `core/scope-core/src/pyramid.rs:13`, `:481-560`), the resident query path triple-materializes wire↔columnar (`pyramid.rs:126-128`), and level selection is a linear probe walk (`pyramid.rs:466-468`). This is the failing `tile_latency` floor (existing task #2).
5. Interaction loop: every pointer event runs `commitHistory` (two `structuredClone` + two `JSON.stringify` of the session, `frontend/src/app/history.ts:60-62`) plus a synchronous full redraw of every panel with no dirty check (`app-shell.ts:2688-2701`, `workspace-view.ts:122`), plus per-frame `resolvePanel`/autoscale/stats recompute.
6. Canvas2D geometry: 4 same-x vertices per bin with default miter joins under an active clip (`frontend/src/render/canvas-renderer.ts:628-676`).

## Global Constraints

- All commands go through `./scripts/` wrappers; run `./scripts/format.sh` before staging every commit (AGENTS.md).
- No new workspace dependencies. `unsafe_code = "forbid"`; clippy `all` + `pedantic` at warn; CI runs `-D warnings`.
- `protocol/schema/scope-protocol.json` is the single JSON schema source; regenerate with `node protocol/scripts/generate-types.mjs`; never hand-edit `protocol/src/generated.rs` or `frontend/src/generated/protocol.ts`.
- Wire-level `u64` identifiers stay exact (string at the TS boundary; `BigInt` for binary decode).
- Pyramid invariants are law: parent bins preserve first/last/finite min-max/counts/gap OR; `has_gap` breaks a stroke, never discards extrema; query density bounded by viewport width; the renderer never scans raw arrays for ordinary pan/zoom.
- The renderer stays deterministic from tiles + viewport + tokens; `TauriPlane` and `BakedPlane` implement the same `DataPlane` contract; UI code never branches on host identity.
- Snapshots stay self-contained, no-network, JSON-manifest based — the baked manifest format does **not** change in this plan.
- Benches print one JSON line each via `report::write_report`; no banners.
- Bench floors (existing): tile refresh p95 ≤ 20 ms / p99 ≤ 50 ms; e2e first plot ≤ 10 s, frame p95 ≤ 33 ms, stall ≤ 250 ms.
- Each phase is a PR; each PR ends with `./scripts/version.sh bump <level>` + `./scripts/version.sh check` as its final commit (Phase 2 is `minor` — additive protocol capability; all others `patch`).

## File Structure (new files)

- `core/scope-core/src/benchmarks/mod.rs` — three new benches (Phase 0)
- `core/scope-core/src/tile_wire.rs` — `BinLevel` → binary series bridge (Phase 2)
- `protocol/src/tile_binary.rs` — binary tile response codec (Phase 2)
- `protocol/testdata/tile-binary-conformance.bin` / `.json` — cross-host fixture (Phase 2)
- `frontend/src/app/bin-columns.ts` — `BinColumns` typed-array bin model + helpers (Phase 2)
- `frontend/src/app/tile-binary.ts` — binary decoder (Phase 2)
- `frontend/src/app/tile-window-cache.ts` — padded-window client cache (Phase 3)
- `docs/adr/0036-binary-tile-transport-and-render-path.md` — ADR (Phase 6)

Existing tasks closed by this plan: task #2 (tile_latency floor — Phase 1), task #3 (1000-source browser proof — Phase 0).

Explicitly deferred (do not build in this plan): WebGL2/GPU renderer, xy-style density/aggregate textures for 1000-series spaghetti panels beyond the bin budget in Task 11, binary snapshot manifests, HTTP/WebSocket data plane.

---

## Phase 0 — Honest benchmarks

The current benches measure the resident, no-IPC path. Add benches for what is actually slow so every later phase is measurable. New benches are **report-only** (no assert) until Phase 1/2 tighten them.

### Task 1: Warm-reopen tile latency bench

**Files:**

- Modify: `core/scope-core/src/benchmarks/mod.rs` (after `bench_tile_latency`, ~line 428)

**Interfaces:**

- Consumes: `corpus::ensure`, `corpus::mc1000`, `StoreSink`, `batch_options`, `corpus_paths`, `latency_windows`, `report::{write_report, percentile}` — all already in `mod.rs`.
- Produces: bench `warm_tile_latency` reporting `{p50_ms, p95_ms, p99_ms, paged_levels}`.

- [ ] **Step 1: Write the bench.** Mirrors `bench_mc_warm_reopen`'s two-pass shape (warm up the sidecar cache, reopen, then query the paged pyramids with `bench_tile_latency`'s window schedule):

```rust
#[test]
#[ignore = "release benchmark"]
fn bench_warm_tile_latency() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let cache_dir = corpus::bench_root().join("cache/mc1000");
    std::fs::create_dir_all(&cache_dir).unwrap();

    let warmup = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir.clone())));
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&warmup) as Arc<dyn CommitSink>,
    );
    assert_eq!(jobs.join(id).unwrap().state, BatchState::Done);
    drop(warmup);

    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir)));
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&sink) as Arc<dyn CommitSink>,
    );
    assert_eq!(jobs.join(id).unwrap().state, BatchState::Done);

    let pyramids = sink.pyramids.lock().unwrap();
    let ensemble: Vec<&Pyramid> = pyramids
        .iter()
        .filter_map(|((_, local_path), pyramid)| (local_path == "response").then_some(pyramid))
        .collect();
    assert_eq!(ensemble.len(), 1000);
    let paged_levels: usize = ensemble.iter().map(|p| p.paged_level_count()).sum();
    assert!(paged_levels > 0, "warm reopen produced no paged levels");

    let windows = latency_windows(1000.0, &[1000.0, 300.0, 100.0, 30.0, 10.0, 3.0, 1.0]);
    let mut refresh_ms: Vec<f64> = windows
        .iter()
        .map(|&(t0, t1)| {
            let started = Instant::now();
            for pyramid in &ensemble {
                std::hint::black_box(pyramid.query(t0, t1, 1920).bins.len());
            }
            started.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    refresh_ms.sort_by(f64::total_cmp);
    report::write_report(
        "warm_tile_latency",
        serde_json::json!({
            "bench": "warm_tile_latency",
            "refreshes": refresh_ms.len(),
            "series_per_refresh": 1000,
            "paged_levels": paged_levels,
            "p50_ms": report::percentile(&refresh_ms, 0.50),
            "p95_ms": report::percentile(&refresh_ms, 0.95),
            "p99_ms": report::percentile(&refresh_ms, 0.99),
            "target_p95_ms": 10.0,
            "floor_p95_ms": null,
            "pass": true,
        }),
    );
}
```

`floor_p95_ms: null` + `pass: true` marks report-only; Task 8 installs the floor.

- [ ] **Step 2: Run it.** `./scripts/test.sh bench core` (or narrower: `cargo` is wrapped, so use `./scripts/test.sh bench core` and let the suite run; the new bench prints one JSON line). Expect a large p95 (hundreds of ms to seconds) — that is the point. Record the number in the PR description.

- [ ] **Step 3: Format and commit.**

```bash
./scripts/format.sh
git add core/scope-core/src/benchmarks/mod.rs
git commit -m "feat(bench): measure warm-reopen paged tile latency"
```

### Task 2: Tile wire-cost bench

**Files:**

- Modify: `core/scope-core/src/benchmarks/mod.rs`

**Interfaces:**

- Consumes: `scope_protocol::{TileResponse, SignalTile}` (scope-core already depends on scope-protocol).
- Produces: bench `tile_wire_cost` reporting `{json_bytes, json_encode_ms}`; Phase 2 Task 12 adds the binary arm.

- [ ] **Step 1: Write the bench.** Build the full-window 1000-series response exactly as `query_tiles` would, then measure serialization:

```rust
#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_tile_wire_cost() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(None));
    let id = jobs.submit(
        corpus_paths(&corpus),
        Arc::clone(&sink) as Arc<dyn CommitSink>,
    );
    assert_eq!(jobs.join(id).unwrap().state, BatchState::Done);

    let pyramids = sink.pyramids.lock().unwrap();
    let series: Vec<scope_protocol::SignalTile> = pyramids
        .iter()
        .filter(|((_, local_path), _)| local_path == "response")
        .enumerate()
        .map(|(index, (_, pyramid))| {
            let query = pyramid.query(0.0, 1000.0, 1920);
            scope_protocol::SignalTile {
                signal_id: index as u64,
                signal_path: format!("run_{index:04}/response"),
                unit: None,
                level: query.level,
                bins: query.bins,
            }
        })
        .collect();
    assert_eq!(series.len(), 1000);
    let response = scope_protocol::TileResponse {
        request_id: "bench".into(),
        series,
    };

    let started = Instant::now();
    let json = serde_json::to_string(&response).unwrap();
    let json_encode_ms = started.elapsed().as_secs_f64() * 1000.0;
    report::write_report(
        "tile_wire_cost",
        serde_json::json!({
            "bench": "tile_wire_cost",
            "series": 1000,
            "bins": response.series.iter().map(|s| s.bins.len()).sum::<usize>(),
            "json_bytes": json.len(),
            "json_encode_ms": json_encode_ms,
            "pass": true,
        }),
    );
    std::hint::black_box(json.len());
}
```

Note for Phase 1: Task 5 changes `PyramidQuery::bins` to `BinLevel`; this bench then inserts `.to_wire_vec()` after `query(...)` — Task 5 owns that edit.

- [ ] **Step 2: Run `./scripts/test.sh bench core`, record `json_bytes` and `json_encode_ms`.** Expect hundreds of MB / hundreds of ms.

- [ ] **Step 3: Format and commit.**

```bash
./scripts/format.sh
git add core/scope-core/src/benchmarks/mod.rs
git commit -m "feat(bench): measure tile response JSON wire cost"
```

### Task 3: 1000-source browser bench artifact (closes task #3)

The e2e bench currently bakes 2 of 1000 files (`scripts/test.sh:50`), so no browser bench sees 1000 series. Parameterize the count; the bench workflow runs the full corpus, PR smoke keeps 2.

**Files:**

- Modify: `scripts/test.sh:41-76` (`bench_e2e`)
- Modify: `frontend/tests/bench/bench.spec.ts` (report `input_files`)

- [ ] **Step 1: Parameterize `bench_e2e`.** Replace the hardcoded `browser_files=2` block:

```bash
bench_e2e() {
  local corpus_dir="$signalscope_root/build/bench/corpus/mc1000"
  if [ ! -f "$corpus_dir/manifest.json" ]; then
    cargo test --release -p scope-core -- --ignored --test-threads=1 bench_corpus_mc1000
  fi
  local -a data_args=()
  local file selected=0
  # Full corpus by default so the browser bench proves 1000 sources; PR smoke
  # jobs pass SIGNALSCOPE_BENCH_FILES=2 to stay bounded.
  local browser_files="${SIGNALSCOPE_BENCH_FILES:-1000}"
  for file in "$corpus_dir"/run_*.csv; do
    if [ "$selected" -eq "$browser_files" ]; then
      break
    fi
    data_args+=(--data "$file")
    selected=$((selected + 1))
  done
  [ "$selected" -eq "$browser_files" ]
  local out="$signalscope_root/build/bench/mc1000.html"
  local max_bytes="${SIGNALSCOPE_BENCH_MAX_BYTES:-1073741824}"
  ...
```

(The rest of the function is unchanged; only `browser_files` and `max_bytes` lines move to env-overridable defaults.)

- [ ] **Step 2: Check the workflow.** In `.github/workflows/bench.yml`, the bench job runs `./scripts/test.sh bench` — it now gets 1000 files by default. If any PR-CI job calls `bench e2e`, set `SIGNALSCOPE_BENCH_FILES=2 SIGNALSCOPE_BENCH_MAX_BYTES=268435456` in that job's env (grep the workflows for `test.sh bench`).

- [ ] **Step 3: Add `input_files` to the e2e report** so regressions in coverage are visible. In `frontend/tests/bench/bench.spec.ts`, read the bake report and include it:

```ts
import { readFileSync } from "node:fs";
// after stopFrameProbe:
const bake = JSON.parse(
  readFileSync(fileURLToPath(new URL("bake.json", reportDir)), "utf8"),
) as { input_files: number };
// add to the written JSON object:
input_files: bake.input_files,
```

- [ ] **Step 4: Run `./scripts/test.sh bench e2e` once locally.** Expected: the 1000-file bake is slow and the bench likely **fails its floors** (first plot > 10 s and/or frame p95 > 33 ms). That is the honest baseline; do not loosen the floors. If the bake itself exceeds 1 GiB or the page OOMs, record the failure mode in the PR description — it is a Phase 2/5 target, not a reason to shrink the corpus. Baseline `SIGNALSCOPE_BENCH_FILES=2` must still pass.

- [ ] **Step 5: Format and commit.**

```bash
./scripts/format.sh
git add scripts/test.sh frontend/tests/bench/bench.spec.ts
git commit -m "feat(bench): bake the full mc1000 corpus for the browser bench"
```

- [ ] **Step 6: Phase 0 handoff.** Run `./scripts/ci.sh rust` and `./scripts/test.sh frontend`. Bump: `./scripts/version.sh bump patch && ./scripts/version.sh check`, commit manifests.

---

## Phase 1 — Core query engine (closes task #2)

Order matters: Task 4 (paging) first — it is pure I/O and independent; then Task 5 (columnar path) which changes `PyramidQuery`; then Task 6 (synthesis + selection) which builds on 5.

### Task 4: Page-granular `PageCache`

Replace exact-range cache entries with fixed-size pages so a binary search costs at most 2 file reads instead of ~14 opens, and track resident bytes incrementally.

**Files:**

- Modify: `core/scope-core/src/paging.rs`
- Tests: extend `paging.rs` `mod tests`

**Interfaces:**

- Public API of `PageHandle`/`PageCache`/`Lease` is **unchanged** (`read`, `values`, `values_range`, `value`, `bytes`, `bytes_range`, `evict_unleased`, `leased_bytes`, `resident_bytes`, `delete`). Only internals change, so `bins.rs`, `columns.rs`, `cache.rs` compile untouched.

- [ ] **Step 1: Write failing tests** in `paging.rs`:

```rust
#[test]
fn repeated_probes_hit_one_page() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("column");
    let values: Vec<u8> = (0..PAGE_BYTES_TEST * 2).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &values).unwrap();
    let cache = PageCache::new(directory.path(), 1024 * 1024);
    let handle = PageHandle::cached(cache.clone(), &path, 0, values.len());
    // Two probes into the same page: second must not grow residency.
    drop(cache.read(&handle, 0..8).unwrap());
    let resident = cache.resident_bytes();
    drop(cache.read(&handle, 16..24).unwrap());
    assert_eq!(cache.resident_bytes(), resident);
    // A probe into the second page loads exactly one more page.
    drop(cache.read(&handle, PAGE_BYTES_TEST..PAGE_BYTES_TEST + 8).unwrap());
    assert_eq!(cache.resident_bytes(), resident * 2);
}

#[test]
fn cross_page_reads_assemble_correct_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("column");
    let values: Vec<u8> = (0..PAGE_BYTES_TEST * 3).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &values).unwrap();
    let cache = PageCache::new(directory.path(), 1024 * 1024);
    let handle = PageHandle::cached(cache.clone(), &path, 0, values.len());
    let range = PAGE_BYTES_TEST - 5..PAGE_BYTES_TEST * 2 + 7;
    let lease = cache.read(&handle, range.clone()).unwrap();
    assert_eq!(lease.bytes(), &values[range]);
}
```

Use a test-visible page size: `pub(crate) const PAGE_BYTES: usize = 64 * 1024;` in cfg(not(test)) and `pub(crate) const PAGE_BYTES: usize = 64;` under `#[cfg(test)]` is a determinism trap — instead make it a field: `State.page_bytes`, defaulting to `64 * 1024` in `PageCache::new`, with a `#[cfg(test)] pub(crate) fn with_page_bytes(root, capacity, page_bytes)` constructor. `PAGE_BYTES_TEST` in tests is `64`. Update the four existing tests to construct via `with_page_bytes(directory.path(), .., 64)` where they depend on page-sized accounting.

- [ ] **Step 2: Run to verify failure.** `./scripts/test.sh core paging` — new tests fail (resident bytes grow per exact range today).

- [ ] **Step 3: Implement.** In `paging.rs`:

- `Key` becomes `{ path: PathBuf, page: u64 }` where `page = absolute_offset / page_bytes` **of the handle's region start** — pages are aligned to `handle.offset`, so all probes into one section share pages: `page_index = range.start / page_bytes` relative to region, and the cache key is `(path, handle.offset, page_index)` → `struct Key { path: PathBuf, region: u64, page: u64 }`.
- `State` gains `page_bytes: usize` and `resident: usize` (incremented on insert, decremented on remove — delete the `resident_bytes(state)` fold; `make_room` loops on `state.resident + requested > capacity`).
- `PageCache::read(handle, range)`:
  1. Compute `first = range.start / page_bytes`, `last = (range.end - 1) / page_bytes` (empty range: return empty lease with `bytes: Arc::from([])` and no keys).
  2. Under one lock, collect which of `first..=last` are missing.
  3. If any missing: **open the file once**, read each missing page with the existing `read_at` (page byte range clipped to the region length; short reads at the region tail are legal — only error if a page comes back shorter than the region demands), then re-lock and insert (re-check for races as today).
  4. Assemble the requested bytes: single-page ranges within one page return `Arc<[u8]>` sliced via copy (`bytes[start_in_page..end_in_page].into()`); multi-page ranges concatenate. (A copy of the requested range is at most what the old code allocated; the win is eliminating opens and duplicate page bytes.)
  5. `Lease` holds `keys: Vec<Key>` (all pages it pinned); `Drop` decrements each.
- `leased_bytes`/`resident_bytes`/`evict_unleased`/`delete` update to page entries (`delete` retains by `key.path != handle.path` as today).
- `PageError::ShortRead` keeps its meaning: raised when the file cannot supply bytes the region claims to have.

- [ ] **Step 4: Run.** `./scripts/test.sh core paging` — all paging tests pass. Then the whole core suite: `./scripts/test.sh core` (cache round-trip tests exercise the paged path heavily).

- [ ] **Step 5: Measure.** `./scripts/test.sh bench core` — record `warm_tile_latency` p95 before/after in the commit message. Expect an order-of-magnitude drop.

- [ ] **Step 6: Format and commit.**

```bash
./scripts/format.sh
git add core/scope-core/src/paging.rs
git commit -m "perf(core): page-granular PageCache with O(1) residency accounting"
```

### Task 5: Columnar query path — no wire round-trips inside core

**Files:**

- Modify: `core/scope-core/src/bins.rs` (add `slice`), `core/scope-core/src/columns.rs` (view-based `range`), `core/scope-core/src/pyramid.rs` (`PyramidQuery.bins: BinLevel`, `level_window` returns `BinLevel`), `shell/src-tauri/src/lib.rs:885-892` (convert at boundary), `core/scope-core/src/benchmarks/mod.rs` (append `.to_wire_vec()` where benches touch `query(..).bins` as wire), `core/scope-core/src/snapshot.rs` + `core/scope-core/src/compute.rs` + any other `query(...)` caller (`grep -rn "\.query(" core/ shell/`).

**Interfaces:**

- Produces: `impl BinLevel { pub fn slice(&self, range: Range<usize>) -> BinLevel }`; `PyramidQuery { pub level: u32, pub bins: BinLevel }`; `Pyramid::level_window(..) -> Option<BinLevel>`; `Pyramid::level(..)` **keeps** returning `Option<Vec<EnvelopeBin>>` (bake/fixture callers).
- Produces: `ColumnGuard` that can be a view: `Column::range` on `Owned` returns a guard sharing the Arc with a stored sub-range instead of copying.

- [ ] **Step 1: Write failing tests** in `bins.rs` and `pyramid.rs`:

```rust
// bins.rs
#[test]
fn slice_matches_wire_roundtrip() {
    let level = BinLevel::from_wire(&[bin(), bin(), bin()]);
    let sliced = level.slice(1..3);
    assert_eq!(sliced.len(), 2);
    assert_eq!(sliced.to_wire(0), level.to_wire(1));
}

// pyramid.rs
#[test]
fn query_returns_columnar_bins_identical_to_wire() {
    let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
    let values = time.iter().map(|v| v.sin()).collect::<Vec<_>>();
    let pyramid = Pyramid::from_samples(&time, &values);
    let query = pyramid.query(0.0, 9_999.0, 200);
    assert!(query.bins.len() <= 402);
    assert_eq!(query.bins.to_wire_vec().len(), query.bins.len());
}
```

- [ ] **Step 2: Implement `BinLevel::slice`** (plain Vec slicing of all 11 field vectors), make `ColumnGuard` hold `(Arc<[f64]>, Range<usize>)` with `Deref` to `&values[range]` so `Column::range` on `Owned` stops copying, change `CachedBinLevel::range` Resident arm from the `to_wire`/`from_wire` round-trip to `level.slice(range)`, change `level_window` to return `BinLevel` (callers append `.to_wire_vec()` where they need wire), and change `PyramidQuery.bins` to `BinLevel`.

  Caution: `ColumnGuard::shared()` returns the backing `Arc<[f64]>` and is called from `store.rs:136,141` on full-column guards only. Keep it correct for views anyway: when the stored range is not the whole column, `shared()` must return `Arc::from(&values[range])` (copy), never the oversized backing Arc.

- [ ] **Step 3: Mechanical caller fixes.** `grep -rn "query(" core/scope-core/src shell/src-tauri/src | grep -v test` — at each site that consumed `Vec<EnvelopeBin>`, either keep columnar (preferred: `.len()`, iteration via `to_wire(i)`) or add `.to_wire_vec()`. `query_tiles` in `shell/src-tauri/src/lib.rs` uses `bins: query.bins.to_wire_vec()` (until Phase 2 removes it). Pyramid unit tests comparing `query.bins` to wire vectors add `.to_wire_vec()`.

- [ ] **Step 4: Run.** `./scripts/test.sh core` and `./scripts/test.sh shell` — conformance fixture (`conformance_fixture_matches_rust_query`) must pass **unchanged**: this task must not alter any query result, only its in-memory representation.

- [ ] **Step 5: Format and commit.**

```bash
./scripts/format.sh
git add core/scope-core/src shell/src-tauri/src/lib.rs
git commit -m "perf(core): columnar query path without wire round-trips"
```

### Task 6: Iterative synthesis and O(1) level selection

**Files:**

- Modify: `core/scope-core/src/pyramid.rs`

**Interfaces:**

- `synthesize_level` signature unchanged; results must be **bit-identical** to the recursive version (the recursion is a left-complete binary tree over `2^index` samples — reproduce that exact merge order with a binary-counter fold so float sums match).
- `query` level selection replaced by arithmetic on `raw_start`/`raw_end`; results must match the probe walk exactly (property-tested).

- [ ] **Step 1: Write failing property tests** (deterministic seeds, no new deps — a tiny LCG inline):

```rust
#[test]
fn iterative_synthesis_is_bit_identical_to_reference() {
    let mut state = 0x2545_F491_4F6C_DD1D_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1_u64 << 53) as f64
    };
    for len in [1_usize, 2, 3, 7, 8, 1000, 10_001] {
        let time: Vec<f64> = (0..len).map(|i| i as f64).collect();
        let values: Vec<f64> = (0..len)
            .map(|i| if i % 97 == 0 { f64::NAN } else { next() * 100.0 - 50.0 })
            .collect();
        let pyramid = Pyramid::from_samples(&time, &values);
        let reference = Pyramid::from_samples_storing_every_level(&time, &values);
        for index in 0..pyramid.level_count() {
            assert_eq!(pyramid.level(index), reference.level(index), "level {index} len {len}");
        }
    }
}

#[test]
fn direct_level_selection_matches_probe_walk() {
    for len in [5_usize, 100, 1000, 10_001, 100_000] {
        let time: Vec<f64> = (0..len).map(|i| i as f64).collect();
        let values = time.clone();
        let pyramid = Pyramid::from_samples(&time, &values);
        for &(t0, t1) in &[(0.0, len as f64), (0.3 * len as f64, 0.31 * len as f64),
                           (0.0, 1.0), (len as f64 * 0.9, len as f64 * 2.0)] {
            for width in [64_u32, 200, 800, 1920] {
                let expected = pyramid.query_reference(t0, t1, width);
                let actual = pyramid.query(t0, t1, width);
                assert_eq!(expected.level, actual.level, "len {len} w {width} [{t0},{t1}]");
                assert_eq!(expected.bins, actual.bins);
            }
        }
    }
}
```

Keep the old probe-walk implementation as `#[cfg(test)] fn query_reference` (verbatim copy of today's `query`).

- [ ] **Step 2: Implement iterative synthesis.** Replace `synthesize_bin` recursion with a binary-counter fold that reproduces the recursion's merge tree exactly (merge two partials of equal rank before absorbing the next sample):

```rust
fn fold_bin(time: &[f64], values: &[f64], start: usize, width: usize) -> EnvelopeBin {
    // stack[k] holds a partial covering 2^k samples; identical tree to the
    // old recursion, so float sums stay bit-identical.
    let end = (start + width).min(time.len());
    let mut stack: Vec<(u32, EnvelopeBin)> = Vec::with_capacity(width.trailing_zeros() as usize + 2);
    for i in start..end {
        let mut rank = 0_u32;
        let mut bin = sample_bin(time[i], values[i]);
        while stack.last().is_some_and(|(r, _)| *r == rank) {
            let (_, left) = stack.pop().expect("checked");
            bin = merge_bins(&left, &bin);
            rank += 1;
        }
        stack.push((rank, bin));
    }
    let (_, mut bin) = stack.pop().expect("non-empty bin");
    while let Some((_, left)) = stack.pop() {
        bin = merge_bins(&left, &bin);
    }
    bin
}
```

`synthesize_level` calls `fold_bin(&time, &values, bin * width, width)` per bin over the (now view-based, uncopied) window slices.

Careful: verify against the reference test — if the recursion's tail-partial shape differs (a last bin narrower than `2^index`), the reference test's odd lengths (3, 7, 10_001) catch it; adjust the final drain order until bit-identical.

- [ ] **Step 3: Implement direct level selection.** In `query`, after computing `raw_start`/`raw_end` (already present at `pyramid.rs:457-458`), replace the `(1..level_count()).find(...)` walk. For monotone time, `overlap_count` is pure index arithmetic:
  - synthesized level `k` (`k < first_stored_level`): `count_k = raw_end.div_ceil(1 << k) - raw_start / (1 << k)` (matches the existing synthesized arm verbatim);
  - stored level `k`: today's count is `window_range` length, i.e. `(min(raw_end.div_ceil(1 << k) + 1, len_k)) - (raw_start >> k).saturating_sub(1)` — the ±1 neighbor padding included.
    Loop `k` from 1 upward computing these two integers per level (no I/O, no partition points, ~17 iterations max) and pick the first `≤ target`, else coarsest. Keep `level_window` untouched (it still does exact windowed materialization).

- [ ] **Step 4: Run.** `./scripts/test.sh core pyramid` — both new tests plus `conformance_fixture_matches_rust_query` pass. If the conformance fixture fails, the arithmetic diverged from the probe semantics — fix the arithmetic; do **not** regenerate the fixture.

- [ ] **Step 5: Measure.** `./scripts/test.sh bench core`; record `tile_latency` and `warm_tile_latency` p95 in the commit message.

- [ ] **Step 6: Format and commit.**

```bash
./scripts/format.sh
git add core/scope-core/src/pyramid.rs
git commit -m "perf(core): iterative bin synthesis and arithmetic level selection"
```

### Task 7: Windowed reads for `query_samples`

**Files:**

- Modify: `shell/src-tauri/src/lib.rs:903-938` (`query_samples`)
- Test: `shell/src-tauri/src/lib.rs` `#[cfg(test)]` (a windowed-read test beside existing shell tests)

- [ ] **Step 1: Write the failing test** (shell tests construct `DataState` directly — follow the existing pattern near the bottom of `lib.rs`): ingest a small CSV via the existing test helpers, call the `query_samples` internals with a narrow window, and assert the response only contains in-window samples. If shell tests lack a direct harness for commands, test the new helper instead:

```rust
#[test]
fn sample_slice_reads_only_the_window() {
    // helper under test: windowed_slice(signal, t0, t1) -> (Vec<f64>, Vec<f64>)
    let signal = test_signal_with_times(0.0..1000.0); // reuse existing fixture helper
    let (time, values) = windowed_slice(&signal, 10.0, 20.0).unwrap();
    assert!(time.first().is_some_and(|t| *t >= 9.0));
    assert!(time.last().is_some_and(|t| *t <= 21.0));
}
```

- [ ] **Step 2: Implement.** In `query_samples`, replace the full-column loads:

```rust
let time_column = signal.time_column();
let start = time_column
    .partition_point(|t| t < request.window.t0)
    .map_err(|error| error.to_string())?
    .saturating_sub(1);
let end = time_column
    .partition_point(|t| t <= request.window.t1)
    .map_err(|error| error.to_string())?
    .saturating_add(1)
    .min(time_column.len());
let time = time_column.range(start..end).map_err(|error| error.to_string())?;
let values = signal
    .values_column()
    .range(start..end)
    .map_err(|error| error.to_string())?;
let slice = compute::sample_window(
    &time,
    &values,
    request.window.t0,
    request.window.t1,
    request.max_points,
);
```

(`Signal::time_column`/`values_column` already exist — `Pyramid::from_signal` uses them. `sample_window` re-partitions inside the subslice; feeding it the pre-cut window yields identical output because the cut is one sample wider than the window on each side, matching its own edge handling — verify with the existing compute tests.)

- [ ] **Step 3: Run.** `./scripts/test.sh shell` and `./scripts/test.sh core compute`.

- [ ] **Step 4: Format and commit.**

```bash
./scripts/format.sh
git add shell/src-tauri/src/lib.rs
git commit -m "perf(shell): window sample queries instead of full-column reads"
```

### Task 8: Install the warm floor, close task #2

- [ ] **Step 1:** In `bench_warm_tile_latency` (Task 1), replace `"floor_p95_ms": null, "pass": true` with `"floor_p95_ms": 20.0, "floor_p99_ms": 50.0, "pass": p95 <= 20.0 && p99 <= 50.0` and add the asserts (same shape as `bench_tile_latency`).
- [ ] **Step 2:** Run `./scripts/test.sh bench core`. Both `tile_latency` and `warm_tile_latency` must now pass their 20/50 ms floors. If not, profile before proceeding — Phases 2+ assume the core is fast.
- [ ] **Step 3:** Format, commit, close task #2:

```bash
./scripts/format.sh
git add core/scope-core/src/benchmarks/mod.rs
git commit -m "test(bench): enforce warm tile latency floors"
```

- [ ] **Step 4: Phase 1 handoff.** `./scripts/ci.sh rust`, then `./scripts/version.sh bump patch && ./scripts/version.sh check`, commit manifests.

---

## Phase 2 — Binary tile transport

JSON tiles become a versioned little-endian columnar payload, decoded in the webview as zero-copy typed-array views. The JSON `query_tiles` command and the `TileResponse`/`SignalTile`/`EnvelopeBin` JSON types **remain** — snapshots and the conformance fixture still use them; only the native tile path switches.

Binary layout (all little-endian; document verbatim in the ADR):

```
header  (16 B): magic "SSTB" (0x42545353 LE) u32 | protocol_version u32 |
                series_count u32 | reserved u32 = 0
per series:
  fixed   (24 B): signal_id u64 | level u32 | bin_count u32 |
                  path_len u16 | unit_len u16 (0xFFFF = null unit) | pad u32 = 0
  strings        : path utf8, unit utf8, zero-padded to a multiple of 8
  columns        : t0 f64[n] | t1 f64[n] | first f64[n] | last f64[n] |
                   min f64[n] | max f64[n] | sum f64[n] | sum_sq f64[n] |
                   sample_count u32[n] | finite_count u32[n] | flags u8[n],
                   zero-padded to a multiple of 8
flags bits: 1=HAS_FIRST 2=HAS_LAST 4=HAS_MIN 8=HAS_MAX 16=HAS_GAP
```

Every series block starts 8-aligned, f64 columns first, so `Float64Array`/`Uint32Array` views need no copies. Absent optional values are encoded as NaN with the flag bit clear (same convention as `BinLevel`). `request_id` is not in the payload — the caller correlates by invoke promise.

### Task 9: Rust codec + conformance fixture

**Files:**

- Create: `protocol/src/tile_binary.rs`; register `pub mod tile_binary;` + re-exports in `protocol/src/lib.rs`
- Create: `core/scope-core/src/tile_wire.rs`; register in `core/scope-core/src/lib.rs`
- Modify: `core/scope-core/src/bins.rs` (public column accessors)
- Test: fixture generator test in `protocol` or `core` writing `protocol/testdata/tile-binary-conformance.bin` + `.json`

**Interfaces (Produces):**

```rust
// protocol/src/tile_binary.rs
pub const TILE_BINARY_MAGIC: u32 = 0x4254_5353; // "SSTB"
pub struct BinaryTileSeries<'a> {
    pub signal_id: u64,
    pub signal_path: &'a str,
    pub unit: Option<&'a str>,
    pub level: u32,
    pub bin_count: usize,
    pub t0: &'a [f64], pub t1: &'a [f64], pub first: &'a [f64], pub last: &'a [f64],
    pub min: &'a [f64], pub max: &'a [f64], pub sum: &'a [f64], pub sum_sq: &'a [f64],
    pub sample_count: &'a [u32], pub finite_count: &'a [u32], pub flags: &'a [u8],
}
pub fn encode_tile_response(series: &[BinaryTileSeries<'_>]) -> Vec<u8>;
pub fn decode_tile_response(bytes: &[u8]) -> Result<Vec<OwnedBinarySeries>, TileBinaryError>; // Rust-side decode for tests
```

```rust
// core/scope-core/src/bins.rs — accessors so tile_wire can borrow columns
impl BinLevel {
    pub fn t0_column(&self) -> &[f64];      // and t1/first/last/min/max/sum/sum_sq
    pub fn sample_count_column(&self) -> &[u32];
    pub fn finite_count_column(&self) -> &[u32];
    pub fn flags_column(&self) -> &[u8];    // bit meanings re-exported as consts
}
// core/scope-core/src/tile_wire.rs
pub fn binary_series<'a>(
    signal_id: u64, path: &'a str, unit: Option<&'a str>, level: u32, bins: &'a BinLevel,
) -> scope_protocol::tile_binary::BinaryTileSeries<'a>;
```

- [ ] **Step 1: Write the failing round-trip test** in `tile_binary.rs`: build two `BinaryTileSeries` (one with NaN-flagged nulls, a null unit, odd bin counts to exercise padding), encode, decode, assert equality field-by-field; assert every f64 column offset in the buffer is `% 8 == 0`.
- [ ] **Step 2: Implement encoder/decoder.** Encoding via `extend_from_slice(&v.to_le_bytes())` loops (no unsafe, no new deps); compute and reserve the exact capacity first. Decode validates magic, version (`scope_protocol::PROTOCOL_VERSION`), counts, and bounds; returns `TileBinaryError` variants (`BadMagic`, `Version { expected, actual }`, `Truncated`, `Malformed`).
- [ ] **Step 3: Run** `./scripts/test.sh core tile_binary` (workspace test run covers the protocol crate; the wrapper's core mode runs `cargo test --workspace --exclude signalscope-shell`).
- [ ] **Step 4: Fixture generator.** A test (in `protocol`, `#[test] fn tile_binary_conformance_fixture()`) builds a deterministic response (reuse the pyramid conformance data shape: 500 samples, NaN window 97..=103, three windows), writes `protocol/testdata/tile-binary-conformance.bin` under `REGENERATE_FIXTURES=1`, and otherwise decodes the stored file and asserts equality with the in-memory construction, plus writes/compares a `.json` sibling containing the same response as wire `EnvelopeBin`s (this is what the TS test consumes as expected values). Generate once: `REGENERATE_FIXTURES=1 ./scripts/test.sh core tile_binary_conformance`.
- [ ] **Step 5: `BinLevel` accessors + `tile_wire::binary_series`** — trivial borrows; unit test that a `BinLevel::from_wire` round-trips through `binary_series` → `encode` → `decode` equal to its `to_wire_vec()`.
- [ ] **Step 6: Format and commit.**

```bash
./scripts/format.sh
git add protocol/src core/scope-core/src protocol/testdata
git commit -m "feat(protocol): binary columnar tile transport codec"
```

### Task 10: TypeScript decoder + `BinColumns`

**Files:**

- Create: `frontend/src/app/bin-columns.ts`, `frontend/src/app/tile-binary.ts`
- Test: `frontend/src/app/tile-binary.test.ts` (or the repo's unit-test location pattern — match neighbors, e.g. `frontend/tests/unit/`; check where existing `*.test.ts` live with `ls frontend/src/**/*.test.ts frontend/tests`)

**Interfaces (Produces):**

```ts
// bin-columns.ts
export const HAS_FIRST = 1,
  HAS_LAST = 2,
  HAS_MIN = 4,
  HAS_MAX = 8,
  HAS_GAP = 16;
export interface BinColumns {
  readonly count: number;
  readonly t0: Float64Array;
  readonly t1: Float64Array;
  readonly first: Float64Array;
  readonly last: Float64Array;
  readonly min: Float64Array;
  readonly max: Float64Array;
  readonly sum: Float64Array;
  readonly sumSq: Float64Array;
  readonly sampleCount: Uint32Array;
  readonly finiteCount: Uint32Array;
  readonly flags: Uint8Array;
}
export interface ColumnarTile {
  signalId: string;
  signalPath: string;
  unit: string | null;
  level: number;
  bins: BinColumns;
}
export interface ColumnarTileResponse {
  requestId: string;
  series: ColumnarTile[];
}
export function binColumnsFromWire(bins: readonly EnvelopeBin[]): BinColumns;
export function wireBinFromColumns(
  bins: BinColumns,
  index: number,
): EnvelopeBin; // cold-path shim
export function sliceColumns(
  bins: BinColumns,
  start: number,
  end: number,
): BinColumns; // subarray views
// tile-binary.ts
export function decodeTileResponse(
  buffer: ArrayBuffer,
  requestId: string,
): ColumnarTileResponse;
```

- [ ] **Step 1: Write the failing conformance test**: load `protocol/testdata/tile-binary-conformance.bin` and `.json` from disk (unit tests run under vitest/node — use `readFileSync` with a path relative to the repo root as neighboring tests do), decode, and assert each series matches the JSON wire bins via `wireBinFromColumns` (null fields where flags are clear, `finite_count`/`sample_count` compared as `Number(...)` of the JSON strings). Also assert the decoder throws on a wrong version word.
- [ ] **Step 2: Implement.** `decodeTileResponse` walks the layout with a `DataView` for headers and constructs `Float64Array(buffer, byteOffset, count)` views for columns (no copies). Guard once at module load: `if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error("big-endian host unsupported");`. `signal_id` reads as `dataView.getBigUint64(offset, true).toString()`. `binColumnsFromWire` builds arrays from JSON bins (used by BakedPlane and tests); `sliceColumns` uses `.subarray` (zero-copy) for Phase 3.
- [ ] **Step 3: Run** the frontend unit suite: `./scripts/test.sh unit tile-binary`.
- [ ] **Step 4: Format and commit.**

```bash
./scripts/format.sh
git add frontend/src/app/bin-columns.ts frontend/src/app/tile-binary.ts frontend/tests
git commit -m "feat(frontend): binary tile decoder with typed-array bin columns"
```

### Task 11: Per-request bin budget

A 1000-series panel at 1920 px must not ship 1000 × 3840 bins. Cap total bins per request; the pyramid picks a coarser level when the per-series share is small. Coarser levels preserve exact min/max envelopes, so this is visually safe.

**Files:**

- Modify: `protocol/schema/scope-protocol.json` (`TileRequest` gains `"max_total_bins": "u32?"`), regenerate types
- Modify: `core/scope-core/src/pyramid.rs` (`query` honors a per-series target override), `shell/src-tauri/src/lib.rs` (`query_tiles*` divides the budget), `frontend/src/ui/app-shell.ts:2563-2568` (send the budget)

**Interfaces:**

- `Pyramid::query_with_target(&self, t0, t1, pixel_width: u32, max_bins: Option<u32>) -> PyramidQuery` — like `query` but the target is `min(pixel_width*2, max_bins)` when `max_bins` is `Some`; `query` delegates with `None`.
- Shell: `per_series = max(64, max_total_bins / series_count)` when the request carries a budget.
- Frontend sends `max_total_bins: 250_000`.

- [ ] **Step 1: Schema + codegen.** Add the field, run `node protocol/scripts/generate-types.mjs`, bump `"protocol_version": 17` → `18` in the schema (transport semantics change in Task 12 anyway; one bump covers the phase). Run `./scripts/test.sh frontend` (codegen diff check) and `./scripts/test.sh core` (serde defaults: absent field must deserialize as `None` — the generator emits `Option` for `u32?`; verify with a unit test in `protocol/src/lib.rs` deserializing a request without the field).
- [ ] **Step 2: Core test:**

```rust
#[test]
fn bin_budget_selects_a_coarser_level() {
    let time = (0..100_000).map(f64::from).collect::<Vec<_>>();
    let pyramid = Pyramid::from_samples(&time, &time);
    let unbudgeted = pyramid.query(0.0, 99_999.0, 1920);
    let budgeted = pyramid.query_with_target(0.0, 99_999.0, 1920, Some(256));
    assert!(budgeted.level > unbudgeted.level);
    assert!(budgeted.bins.len() <= 258); // target + neighbor bins
}
```

- [ ] **Step 3: Implement** (`query_with_target` clamps the existing `target` computation; the selection arithmetic from Task 6 is reused untouched). Shell computes `per_series` and passes it for every signal in the loop. Frontend adds the constant `const TILE_BIN_BUDGET = 250_000;` near `SAMPLE_CAP` in `app-shell.ts` and includes `max_total_bins: TILE_BIN_BUDGET` in the tile request.
- [ ] **Step 4: Run** `./scripts/test.sh core pyramid`, `./scripts/test.sh shell`, `./scripts/test.sh frontend`.
- [ ] **Step 5: Format and commit.**

```bash
./scripts/format.sh
git add protocol core/scope-core/src shell/src-tauri/src frontend/src
git commit -m "feat(protocol): per-request tile bin budget for many-series panels"
```

### Task 12: Shell binary command + wire-bench arm

**Files:**

- Modify: `shell/src-tauri/src/lib.rs` (new command `query_tiles_bin`, registered in `invoke_handler` at line 1848; delete `query_tiles` in Task 13 once the frontend has switched)
- Modify: `core/scope-core/src/benchmarks/mod.rs` (binary arm in `bench_tile_wire_cost`)

**Interfaces (Produces):**

```rust
#[tauri::command]
async fn query_tiles_bin(
    request: Envelope<TileRequest>,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<tauri::ipc::Response, String>
```

Returns raw bytes (`tauri::ipc::Response::new(Vec<u8>)`); the webview receives an `ArrayBuffer` from `invoke`.

- [ ] **Step 1: Implement the command.** Async so it leaves the IPC handler thread; the query runs in `tauri::async_runtime::spawn_blocking`:

```rust
#[tauri::command]
async fn query_tiles_bin(
    request: Envelope<TileRequest>,
    state: State<'_, Arc<Mutex<DataState>>>,
) -> Result<tauri::ipc::Response, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let state = Arc::clone(&state);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let data = state.lock().map_err(|error| error.to_string())?;
        let per_series = request.max_total_bins.map(|budget| {
            (budget / u32::try_from(request.signal_ids.len().max(1)).unwrap_or(u32::MAX)).max(64)
        });
        let mut owned: Vec<(u64, String, Option<String>, u32, scope_core::bins::BinLevel)> =
            Vec::with_capacity(request.signal_ids.len());
        for raw_id in &request.signal_ids {
            let signal_id = SignalId(*raw_id);
            let signal = data
                .store
                .signal(signal_id)
                .ok_or_else(|| format!("unknown signal id: {raw_id}"))?;
            let pyramid = data
                .pyramids
                .get(&signal_id)
                .ok_or_else(|| format!("pyramid is unavailable for signal id: {raw_id}"))?;
            let query = pyramid.query_with_target(
                request.window.t0,
                request.window.t1,
                request.pixel_width,
                per_series,
            );
            owned.push((
                *raw_id,
                signal.path.clone(),
                signal.unit.clone(),
                query.level,
                query.bins,
            ));
        }
        drop(data);
        let series: Vec<_> = owned
            .iter()
            .map(|(id, path, unit, level, bins)| {
                scope_core::tile_wire::binary_series(*id, path, unit.as_deref(), *level, bins)
            })
            .collect();
        Ok::<_, String>(scope_protocol::tile_binary::encode_tile_response(&series))
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}
```

(Adjust the `State` clone to how tauri exposes the inner `Arc` — `state.inner().clone()`; the compiler will tell you. Register `query_tiles_bin` in `tauri::generate_handler!`.)

- [ ] **Step 2: Bench arm.** In `bench_tile_wire_cost`, after the JSON measurement, build `BinaryTileSeries` from the same queries (keep the columnar `BinLevel`s from Task 5 — restructure the bench to hold `Vec<(String, u32, BinLevel)>` and derive both arms from it), measure `encode_tile_response` and report `binary_bytes`, `binary_encode_ms`, and the ratio. Install floors now: `"pass": binary_encode_ms <= 100.0 && binary_bytes <= 64 * 1024 * 1024` with matching asserts (the Task 11 budget bounds bins to 250k ≈ 18 MB; 64 MiB is generous).
- [ ] **Step 3: Run** `./scripts/test.sh shell` and `./scripts/test.sh bench core`; record the JSON→binary ratio in the commit message.
- [ ] **Step 4: Format and commit.**

```bash
./scripts/format.sh
git add shell/src-tauri/src/lib.rs core/scope-core/src/benchmarks/mod.rs
git commit -m "feat(shell): binary tile query command off the IPC thread"
```

### Task 13: Frontend columnar migration

The fat task: `DataPlane.queryTiles` returns `ColumnarTileResponse`; every tile consumer iterates typed arrays. `SampleResponse` paths (XY/FFT/histogram) are untouched.

**Files:**

- Modify: `frontend/src/app/data-plane.ts` (`DataPlane.queryTiles` type, `TauriPlane`, `BakedPlane`)
- Modify: `frontend/src/ui/app-shell.ts` (`tilesByPanel: Map<string, ColumnarTileResponse>`)
- Modify: `frontend/src/ui/panel.ts` (`renderData` tile plumbing, `renderForMode` time branch)
- Modify: `frontend/src/app/plot-capabilities.ts` (`prepareTimePlot` input `bins: BinColumns`; `autoRanges`, `stats`, `cursorAt`, hit adapters via columnar helpers)
- Modify: `frontend/src/render/canvas-renderer.ts` (`render`/`drawSeries` consume `ColumnarTile`)
- Modify: any helper the compiler flags (`valueAtTime`, `nearestLine`, `nearestVertex`, `timeAutoYRange`, `visibleStats` — wherever they live, follow the type errors)

**Interfaces:**

- `DataPlane.queryTiles(request: TileRequest): Promise<ColumnarTileResponse>`.
- `TauriPlane.queryTiles` invokes `query_tiles_bin` and decodes: `decodeTileResponse(await this.invoke<ArrayBuffer>("query_tiles_bin", { request: seal(request) }), request.request_id)`.
- `BakedPlane.queryTiles` keeps `queryPyramid` on its JSON levels and wraps each result with `binColumnsFromWire` — snapshot format unchanged, renderer identical for both hosts.
- New columnar helpers in `bin-columns.ts` (add in this task, with unit tests):

```ts
export function columnsYExtent(
  bins: BinColumns,
): { min: number; max: number } | null;
// single pass over min/max respecting HAS_MIN/HAS_MAX flags
export function columnsStats(
  bins: BinColumns,
  t0: number,
  t1: number,
): {
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
  n: number;
};
// window-overlap pass over min/max/sum/sumSq/finiteCount — same semantics as visibleStats
export function columnsValueAtTime(bins: BinColumns, t: number): number | null;
// binary search t0/t1, return last (or first) like valueAtTime does today — port its exact semantics
```

- [ ] **Step 1: Change the `DataPlane` interface and both planes.** Compile (`./scripts/test.sh frontend` typecheck) and let the errors enumerate every consumer. Fix them in dependency order:
  1. `app-shell.ts`: `tilesByPanel` type; `renderTiles` plumbing is type-generic (Maps), only signatures change.
  2. `panel.ts` `renderForMode`: `tiles.series` entries are `ColumnarTile`; the `bySeries.get(tile.signalPath)` matching keys rename `signal_path` → `signalPath`; the `prepareTimePlot` input becomes `bins: tile.bins` (`BinColumns`).
  3. `plot-capabilities.ts` `prepareTimePlot`: `autoRanges` uses `columnsYExtent` per series (replacing the `flatMap` + `timeAutoYRange` scan — compute the union of per-series extents); `stats()` uses `columnsStats`; `cursorAt`/`resolveAnnotation` use `columnsValueAtTime`; hit adapters (`nearestLine`/`nearestVertex`) iterate via index loops over the columns — port their loops, using `wireBinFromColumns` only if a helper is deeply wire-shaped and cold (hover-time, not frame-time).
  4. `canvas-renderer.ts` `render`/`drawSeries`: signature takes `{ series: ColumnarTile[] }`; `drawSeries` ports the existing 4-vertex loop to arrays (geometry unchanged in this task — Phase 5 optimizes):

```ts
const { t0, t1, first, last, min, max, flags, count } = series.bins;
let penDown = false;
for (let i = 0; i < count; i += 1) {
  const f = flags[i] as number;
  if (
    (f & (HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX)) !==
    (HAS_FIRST | HAS_LAST | HAS_MIN | HAS_MAX)
  ) {
    penDown = false;
    continue;
  }
  const x = toX(((t0[i] as number) + (t1[i] as number)) * 0.5);
  const gap = (f & HAS_GAP) !== 0;
  if (!penDown || gap) context.moveTo(x, toY(first[i] as number));
  else context.lineTo(x, toY(first[i] as number));
  context.lineTo(x, toY(min[i] as number));
  context.lineTo(x, toY(max[i] as number));
  context.lineTo(x, toY(last[i] as number));
  penDown = !gap;
}
```

- [ ] **Step 2: Delete the dead JSON path.** Remove `query_tiles` from `shell/src-tauri/src/lib.rs` and the handler list; remove the now-unused `queryTiles` JSON invoke from `TauriPlane`. Keep `SignalTile`/`TileResponse` in the schema (bake + fixtures still use `EnvelopeBin`); if `TileResponse` itself becomes unreferenced in Rust, keep it — schema types are the contract, and `knip`/clippy will tell you what is actually dead; only delete what both hosts no longer reference.
- [ ] **Step 3: Unit tests** for `columnsYExtent` / `columnsStats` / `columnsValueAtTime`: build `BinColumns` from wire fixtures with `binColumnsFromWire` and assert results equal the old wire implementations' outputs on the same data (port two or three cases from existing tests of `timeAutoYRange`/`visibleStats` if they exist; otherwise construct: bins with NaN gaps, all-NaN bins, window edges).
- [ ] **Step 4: Run everything.** `./scripts/test.sh frontend` (lint, typecheck, codegen check, unit), `./scripts/test.sh shell`, then `./scripts/run.sh native` against a small corpus for a manual smoke (plot renders, zoom/pan works, stats strip correct).
- [ ] **Step 5: Measure.** `./scripts/test.sh bench e2e` (the 1000-file artifact renders via `BakedPlane` — unchanged path, so this guards against regressions rather than proving the IPC win; the IPC win shows in `tile_wire_cost`).
- [ ] **Step 6: Format and commit.**

```bash
./scripts/format.sh
git add frontend/src shell/src-tauri/src
git commit -m "feat(frontend): consume binary columnar tiles end to end"
```

- [ ] **Step 7: Phase 2 handoff.** `./scripts/ci.sh all` (cross-layer change). `./scripts/version.sh bump minor && ./scripts/version.sh check`, commit manifests.

---

## Phase 3 — Client tile cache and request elision

### Task 14: Padded-window cache

Requests are padded to an aligned, wider window; pans and zooms inside the padding slice cached typed arrays (`subarray`, zero-copy) instead of refetching.

**Files:**

- Create: `frontend/src/app/tile-window-cache.ts`
- Test: unit tests beside it
- Modify: `frontend/src/ui/app-shell.ts` (`refreshTiles` uses the cache; `renderTiles` reads through it)

**Interfaces (Produces):**

```ts
export interface CachedPanelTiles {
  response: ColumnarTileResponse; // covers the padded window
  window: { t0: number; t1: number }; // the padded window actually fetched
  pixelWidth: number;
  idsKey: string; // sorted signal ids joined
}
export class TileWindowCache {
  /** Aligned padded window to request for a viewport: span doubled, snapped to
   *  a power-of-two grid of the span so consecutive pans resolve identically. */
  static padWindow(t0: number, t1: number): { t0: number; t1: number };
  get(panelId: string): CachedPanelTiles | null;
  /** Cached response sliced to the viewport, or null when not covering. */
  slice(
    panelId: string,
    idsKey: string,
    pixelWidth: number,
    t0: number,
    t1: number,
  ): ColumnarTileResponse | null;
  store(panelId: string, entry: CachedPanelTiles): void;
  invalidate(panelId?: string): void; // no arg: everything (catalog change)
}
```

`padWindow`: `span = t1 - t0; grid = 2 ** Math.ceil(Math.log2(span)); a = Math.floor(t0 / grid) * grid; return { t0: a, t1: a + 2 * grid }` — any viewport maps to one of at most two padded windows, so a pan sequence hits the cache until it crosses a grid boundary. `slice` requires `idsKey` and `pixelWidth` equality plus `[t0, t1] ⊆ padded window`, then per series binary-searches `t0`/`t1` columns (port `firstOverlapping`/`pastLastOverlapping` from `pyramid-query.ts` to typed arrays) and returns `sliceColumns(bins, max(0, start-1), min(count, end+1))` — the same ±1 neighbor rule as the pyramid. **Level correctness:** a cached fine level sliced narrower can only be finer than needed, never coarser; zooming **in** past 2× the cached density must refetch — enforce with `if ((sliceCount) > 4 * pixelWidth + 2) return null;` so extreme zoom-ins fall through to a real query.

- [ ] **Step 1: Write failing unit tests**: `padWindow` idempotence and alignment (two adjacent viewports of equal span produce the same padded window); `slice` returns null for wrong idsKey / non-covering window / over-dense slice; sliced bins equal an independently constructed `binColumnsFromWire` slice of the same wire data.
- [ ] **Step 2: Implement the class.**
- [ ] **Step 3: Wire into `refreshTiles`** (`app-shell.ts:2543-2606`): per panel, compute `idsKey` and the viewport; try `cache.slice(...)` — hit: `nextTiles.set(panel.id, sliced)` without IPC; miss: request `TileWindowCache.padWindow(window.t0, window.t1)` with the panel's `pixel_width` and `max_total_bins`, store the full response in the cache, and set the sliced view. Invalidate the cache wherever `this.catalog` is rebuilt or signals change (`grep -n "signalsByPath = " frontend/src/ui/app-shell.ts` — every assignment site calls `cache.invalidate()`), and per panel when a panel's series set changes (the `idsKey` check already guards correctness; invalidation just frees memory).
- [ ] **Step 4: Run** `./scripts/test.sh unit tile-window-cache`, `./scripts/test.sh frontend`, manual `./scripts/run.sh native` smoke: pan repeatedly — the network of `query_tiles_bin` calls (visible in devtools/logging) must go quiet between grid crossings.
- [ ] **Step 5: Format and commit.**

```bash
./scripts/format.sh
git add frontend/src/app/tile-window-cache.ts frontend/src/ui/app-shell.ts frontend/tests
git commit -m "perf(frontend): padded-window tile cache with request elision"
```

### Task 15: In-flight dedupe and gesture-aware refresh

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`scheduleRefresh`, `refreshTiles`)

- [ ] **Step 1: Dedupe.** Add fields `private refreshInFlight = false; private refreshQueued = false;`. `refreshTiles` becomes: if `refreshInFlight`, set `refreshQueued = true` and return; else loop — mark in flight, run the existing body, and on completion if `refreshQueued` was set, clear it and run once more. Stale-response dropping via `refreshToken` stays.
- [ ] **Step 2: Tighten the debounce.** With elision (Task 14) most gestures never reach IPC, so the 150 ms trailing debounce is now mostly latency, not protection. Change `scheduleRefresh` default `delay = 150` to `delay = 50`, and in `applyTimeWindow`, when `cache.slice` would hit (cheap check: the render path already sliced), the scheduled refresh is a no-op anyway — no further change needed.
- [ ] **Step 3: Run** `./scripts/test.sh frontend`; manual smoke with `./scripts/run.sh native`: drag continuously — at most one query in flight at a time; release — one trailing refine.
- [ ] **Step 4: Format and commit.**

```bash
./scripts/format.sh
git add frontend/src/ui/app-shell.ts
git commit -m "perf(frontend): dedupe in-flight tile refreshes"
```

- [ ] **Step 5: Phase 3 handoff.** `./scripts/test.sh frontend && ./scripts/test.sh unit`, bump patch, commit manifests.

---

## Phase 4 — Interaction loop hygiene

### Task 16: rAF-coalesced gesture rendering and gesture-end history

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`applyTimeWindow:2688`, `applyXRange:2703`, `commitHistory:1844`)
- Test: existing unit tests for history behavior (`grep -rn "HistoryStack" frontend` for the test file) — extend

- [ ] **Step 1: Coalesce renders.** In `applyTimeWindow` and `applyXRange`, replace the direct `this.renderTiles()` call with `this.scheduleRender()` (already exists at `:2662` and is rAF-based). The window-readout update (`renderWindowReadout`) stays synchronous — it is cheap DOM text.
- [ ] **Step 2: Defer history clones.** Today `commitHistory` runs two `structuredClone`s + two `JSON.stringify`s per pointer event. Make the gesture path lazy: add `private historyDirty: string | null = null;`, and a new method:

```ts
private markHistoryDirty(coalesceKey: string): void {
  if (this.restoringHistory) return;
  this.historyDirty = coalesceKey;
  this.clearHistoryCoalesceTimer();
  this.historyCoalesceTimer = window.setTimeout(() => {
    this.historyCoalesceTimer = null;
    const key = this.historyDirty;
    this.historyDirty = null;
    if (key !== null) this.history.commit(historySnapshot(this.workspace.snapshot()), key);
    this.history.commit(historySnapshot(this.workspace.snapshot()));
  }, 250);
}
```

`applyTimeWindow`/`applyXRange` call `this.markHistoryDirty(\`range:${panelId}\`)`instead of`this.commitHistory(...)`. All other `commitHistory()` call sites (structural edits) are unchanged. Undo granularity is preserved: one entry per settled gesture, exactly what the coalesce-key mechanism produced, but with zero clones during motion.

- [ ] **Step 3: Extend the history test** (wherever `HistoryStack`/undo behavior is unit-tested; if only `history.ts` is tested directly, add an app-level test is overkill — instead assert in the existing suite that `HistoryStack.commit` still coalesces; the deferral itself is covered by the e2e bench frame floor).
- [ ] **Step 4: Run** `./scripts/test.sh frontend`; manual smoke: drag/zoom, then Ctrl+Z restores the pre-gesture window in one step.
- [ ] **Step 5: Format and commit.**

```bash
./scripts/format.sh
git add frontend/src/ui/app-shell.ts frontend/tests
git commit -m "perf(frontend): rAF-coalesced gesture renders and deferred history clones"
```

### Task 17: Panel dirty-check and cached resolution

**Files:**

- Modify: `frontend/src/ui/panel.ts` (`renderData:934`), `frontend/src/ui/app-shell.ts` (resolution cache), `frontend/src/ui/workspace-view.ts` (no change expected — it already delegates)

- [ ] **Step 1: Dirty-check in `PanelView.renderData`.** The fields `lastInputState/lastTiles/lastSamples/lastWindow` already exist (`panel.ts:941-946`). At the top of `renderData`:

```ts
if (
  state === this.lastInputState &&
  tiles === this.lastTiles &&
  samples === this.lastSamples &&
  this.lastWindow !== null &&
  window.t0 === this.lastWindow.t0 &&
  window.t1 === this.lastWindow.t1 &&
  missing.length === 0 &&
  this.lastMissingEmpty
) {
  return 0;
}
```

Add `private lastMissingEmpty = true;` set in the body. **Precondition:** `WorkspaceModel` must not mutate `PanelState` in place — verify identity is a valid dirty signal (`grep -n "setPanelTimeWindow\|setLinkedWindow" frontend/src/app/*.ts` and confirm they produce new panel objects; if they mutate, compare `window` + a cheap monotonic `session revision` counter bumped by the workspace model instead of object identity — add `revision(): number` to the model in that case).

- [ ] **Step 2: Cache `resolvePanel`.** In `app-shell.ts`, add `private resolutionCache = new Map<string, { key: string; resolved: ResolvedSeries[] }>();` (import the return type `resolvePanel` produces). Key: `JSON.stringify([panel.series_rules ?? panel.series, panel.mode])` — inspect `resolvePanel`'s actual inputs in `frontend/src/app/resolution.ts` and include exactly: the panel's series/selector state, the catalog revision, and the named-sets revision. Add `private catalogRevision = 0;` bumped wherever `this.catalog` is rebuilt, and include it in the key. Route the three hot call sites (`panelSignalIds:2616`, `sampleWindow:2734`, `fitPanelView:2770`) plus the per-frame call in `renderState` (`app-shell.ts:345`) through a private `resolvedFor(panel): ResolvedSeries[]`.
- [ ] **Step 3: Run** `./scripts/test.sh frontend` + manual smoke: series add/remove, selector edits, named-set edits all still update panels (the cache key must change — if a case doesn't, the key is missing an input; fix the key, don't add manual invalidation calls).
- [ ] **Step 4: Format and commit.**

```bash
./scripts/format.sh
git add frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts
git commit -m "perf(frontend): panel dirty-check and cached selector resolution"
```

### Task 18: Arrival-time autoscale and lazy stats

**Files:**

- Modify: `frontend/src/app/plot-capabilities.ts` (`prepareTimePlot`), `frontend/src/ui/panel.ts` (`renderStats` behind visibility)

- [ ] **Step 1: Precompute Y extents once per prepared plot.** In `prepareTimePlot`, compute `const extents = input.series.map((s) => columnsYExtent(s.bins));` **eagerly at construction** (once per data arrival / window change, not per `autoRanges()` call), and make `autoRanges()` fold `extents` (union of non-null). `resolvePlotRanges` already calls `autoRanges()` per frame — now it costs a 1000-element fold, not a 3.6M-element scan.
- [ ] **Step 2: Stats only when visible.** In `panel.ts`, `renderData` calls `this.renderStats()` unconditionally (`:957`), and `renderStats` (`:1738`) computes `preparedPlot.stats()` before checking visibility. Reorder: check the stats strip's visibility first, return early, then compute. (Find the exact visibility flag in `renderStats` — the check exists at `:1739`; move it above the `stats()` call.)
- [ ] **Step 3: Run** `./scripts/test.sh frontend`; manual smoke: stats strip shows correct values when toggled on; autoscale identical to before (compare a plot's Y range before/after this commit on the same data).
- [ ] **Step 4: Format and commit.**

```bash
./scripts/format.sh
git add frontend/src/app/plot-capabilities.ts frontend/src/ui/panel.ts
git commit -m "perf(frontend): precomputed autoscale extents and lazy stats"
```

- [ ] **Step 5: Phase 4 handoff.** `./scripts/test.sh frontend && ./scripts/test.sh bench e2e` — frame p95 should drop measurably; record it. Bump patch, commit manifests.

---

## Phase 5 — Canvas2D geometry

### Task 19: Envelope-correct minimal stroke

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts` (`drawSeries`, `render`)

The current loop emits 4 same-x vertices per bin with miter joins. Replace with: bevel joins, one clip for the whole frame, degenerate-bin collapse, and skip of `setLineDash` when solid.

- [ ] **Step 1: Hoist per-series state.** In `render()`, set the clip once around the series loop (save/clip before `response.series.forEach`, restore after) instead of per `drawSeries`; set `context.lineJoin = "bevel"; context.lineCap = "butt";` once.
- [ ] **Step 2: Collapse degenerate bins.** In the columnar `drawSeries` loop (Task 13's port), when a bin is a single sample or flat (`min === max`), emit one vertex instead of four; otherwise emit exactly three (first, the far extreme, last) when `first`/`last` already coincide with the extremes — concretely:

```ts
const yFirst = toY(first[i] as number);
const yMin = toY(min[i] as number);
const yMax = toY(max[i] as number);
const yLast = toY(last[i] as number);
if (!penDown || gap) context.moveTo(x, yFirst);
else context.lineTo(x, yFirst);
if (yMin !== yMax) {
  // order the excursion to end nearest yLast, halving reversals
  const firstExtreme =
    Math.abs(yFirst - yMin) > Math.abs(yFirst - yMax) ? yMin : yMax;
  const secondExtreme = firstExtreme === yMin ? yMax : yMin;
  if (firstExtreme !== yFirst) context.lineTo(x, firstExtreme);
  context.lineTo(x, secondExtreme);
}
if (yLast !== yMax && yLast !== yMin) context.lineTo(x, yLast);
penDown = !gap;
```

This preserves the envelope invariant (min and max are both always stroked; gaps still break the pen) while cutting vertices ~2× and eliminating guaranteed 180° double-backs.

- [ ] **Step 3: Verify determinism.** `./scripts/test.sh frontend` (renderer unit tests where practical) and — critically — the **visual pass**: `./scripts/run.sh native`, compare a busy signal at several zoom levels against `main` side-by-side (screenshot both). The stroke silhouette must be identical; only join artifacts may differ (bevel vs miter spikes — spec-compatible, the Final Spec mandates no glows/decoration, not join style). Any silhouette difference is a bug.
- [ ] **Step 4: Measure.** The `.render-ms` readout on a single mc1000 signal at full window: record before/after (was ~100 ms).
- [ ] **Step 5: Format and commit.**

```bash
./scripts/format.sh
git add frontend/src/render/canvas-renderer.ts
git commit -m "perf(render): minimal envelope stroke with bevel joins"
```

### Task 20: Dense-region column strips

When bins-per-pixel ≥ 2 (zoomed out), per-bin vertices are invisible; draw per-pixel-column vertical strips through one path.

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts` (`drawSeries`)

- [ ] **Step 1: Implement the fast path** inside `drawSeries`, chosen per series when `series.bins.count > 2 * plot.width`:

```ts
// Accumulate exact per-column envelope, then stroke column verticals plus
// connectors; identical extrema, ~width vertices instead of 4×bins.
const columns = Math.max(1, Math.ceil(plot.width));
const colMin = new Float64Array(columns).fill(Number.POSITIVE_INFINITY);
const colMax = new Float64Array(columns).fill(Number.NEGATIVE_INFINITY);
const colGap = new Uint8Array(columns);
for (let i = 0; i < count; i += 1) {
  const f = flags[i] as number;
  if ((f & (HAS_MIN | HAS_MAX)) !== (HAS_MIN | HAS_MAX)) continue;
  const c = Math.min(
    columns - 1,
    Math.max(
      0,
      Math.floor(toX(((t0[i] as number) + (t1[i] as number)) * 0.5) - plot.x),
    ),
  );
  if ((min[i] as number) < (colMin[c] as number)) colMin[c] = min[i] as number;
  if ((max[i] as number) > (colMax[c] as number)) colMax[c] = max[i] as number;
  if ((f & HAS_GAP) !== 0) colGap[c] = 1;
}
for (let c = 0; c < columns; c += 1) {
  if (!Number.isFinite(colMin[c] as number)) continue;
  const x = plot.x + c + 0.5;
  context.moveTo(x, toY(colMax[c] as number));
  context.lineTo(x, toY(colMin[c] as number));
}
```

Gap columns simply don't connect (there are no connectors in this path; adjacent columns overlap visually at ≥1 px stroke width, which is exactly how the envelope reads today at this density). All-gap columns stay empty.

- [ ] **Step 2: Visual pass** as in Task 19 — zoomed-out spaghetti and single-series full-history views compared against the previous commit. Envelope silhouette must match; NaN windows must still show gaps.
- [ ] **Step 3: Measure `.render-ms`** on (a) 1 series full window, (b) a 100-series panel. Record both.
- [ ] **Step 4: Format and commit.**

```bash
./scripts/format.sh
git add frontend/src/render/canvas-renderer.ts
git commit -m "perf(render): per-column envelope strips for dense tiles"
```

- [ ] **Step 5: Phase 5 handoff.** `./scripts/test.sh frontend`, `./scripts/test.sh bench e2e` (frame floors should now pass at 1000 sources — if not, profile before closing), bump patch, commit manifests.

---

## Phase 6 — Closeout

### Task 21: ADR and docs

**Files:**

- Create: `docs/adr/0036-binary-tile-transport-and-render-path.md` (check `docs/adr/README.md` for the actual next number and register it there)
- Modify: `docs/implementation-roadmap.md`

- [ ] **Step 1: Write the ADR** recording: binary tile framing (the exact layout table from Phase 2), why the JSON tile path was removed for native, the bin-budget semantics, the padded-window client cache and its coherence rule, page-granular paging, and the deferral list (GPU renderer, density textures, binary snapshots). Decision + consequences, not deliberation (AGENTS brevity rule).
- [ ] **Step 2: Roadmap note** — one line linking the phase 5 bench floors to this plan's results.
- [ ] **Step 3: Format and commit.**

```bash
./scripts/format.sh
git add docs/adr docs/implementation-roadmap.md
git commit -m "docs(adr): binary tile transport and render path decisions"
```

### Task 22: Full verification

- [ ] **Step 1:** `./scripts/ci.sh all` — the complete local gate.
- [ ] **Step 2:** `./scripts/test.sh bench` — full bench suite. Paste the before/after table (from the numbers recorded in each phase's commits) into the PR description: `tile_latency`, `warm_tile_latency`, `tile_wire_cost` (json vs binary), `e2e_mc1000` first-plot / frame p95 / input_files, single-series `.render-ms`.
- [ ] **Step 3:** Manual acceptance on the real corpus: `./scripts/run.sh native`, open mc1000, and verify the original complaint is gone — zoom/pan on one signal's full history is smooth, and the 1000-series view is usable.
- [ ] **Step 4:** Close tasks #2 and #3 in the tracker; final `./scripts/version.sh bump patch && ./scripts/version.sh check` for this closing PR, commit manifests.

# Phase 5 Benchmark Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 5 performance benchmark suite from the approved spec (`docs/superpowers/specs/2026-08-04-phase5-benchmarks-design.md`): deterministic corpus generation, core release-bench floors, a Playwright bench project over a baked monte-carlo snapshot, JSON reporting, and off-PR CI wiring.

**Architecture:** Two automated layers share one deterministic corpus. Core layer: `#[ignore = "release benchmark"]` tests in `scope-core` (existing `bench_` idiom) with generous hard floors and per-scenario JSON output. E2E layer: a Playwright `bench` project measuring first-plot and pan/zoom frame timing on a `scope-bake`d 1000-source snapshot loaded over `file://`. The checked-in `examples/monte_carlo` (8 runs) is the smoke tier that keeps bench code paths green in PR CI.

**Tech Stack:** Rust (std-only PRNG, serde_json, tempfile, sha2 — all already dependencies), Playwright/TypeScript, bash script wrappers, GitHub Actions.

## Global Constraints

- All commands go through `./scripts/` wrappers; extend a wrapper rather than using ad-hoc `cargo`/`pnpm` in workflows (AGENTS.md).
- Run `./scripts/format.sh` before staging every commit. treefmt covers Rust, TS, shell, TOML, and Markdown.
- No new workspace dependencies. `unsafe_code = "forbid"`; clippy `all` + `pedantic` at warn, CI runs `-D warnings`.
- Corpus files are generated into `build/bench/` and never checked in.
- Floors (from the spec): mc cold open ≤60 s, warm reopen ≤15 s, huge build ≥2M samples/s, tile refresh p95 ≤20 ms / p99 ≤50 ms, e2e first plot ≤10 s, frame p95 ≤33 ms, stall ≤250 ms.
- Session workspace JSON is schema v20, snake_case keys (except `cursorT`), enums lowercase.
- New Playwright test dirs need a `frontend/knip.json` entry; new workflows need `permissions: contents: read` and `persist-credentials: false` (zizmor).
- Quiet output: benches print one JSON/`key=value` line each, no banners.
- The existing two benches in `benchmarks.rs` keep their behavior verbatim.

## File Map

- Convert: `core/scope-core/src/benchmarks.rs` → `core/scope-core/src/benchmarks/mod.rs` (+ `corpus.rs`, `report.rs`)
- Create: `examples/bench/mc1000.workspace.json`, `examples/bench/smoke.workspace.json`
- Create: `frontend/tests/bench/measure.ts`, `frontend/tests/bench/bench.spec.ts`, `frontend/tests/e2e/bench-smoke.spec.ts`
- Create: `scripts/collect-bench-report.mjs`, `.github/workflows/bench.yml`, `docs/adr/0035-benchmark-harness-and-performance-floors.md`
- Modify: `scripts/test.sh`, `scripts/lib.sh`, `scripts/ci.sh`, `scripts/export.sh`, `frontend/playwright.config.ts`, `frontend/package.json`, `frontend/knip.json`, `docs/adr/README.md`, `docs/implementation-roadmap.md`

---

### Task 1: Corpus generator module

Convert `benchmarks.rs` into a directory module and add the deterministic corpus generator.

**Files:**

- Move: `core/scope-core/src/benchmarks.rs` → `core/scope-core/src/benchmarks/mod.rs` (`git mv`; content unchanged in the move commit-wise, then add `mod corpus;` + `mod report;` declarations as those land)
- Create: `core/scope-core/src/benchmarks/corpus.rs`
- Test: unit tests inside `corpus.rs` (fast, not `#[ignore]`d, tempdir-based)

**Interfaces (Produces):**

```rust
pub struct TierSpec {
    pub name: &'static str,
    pub files: u32,
    pub rows: u32,           // rows per file, excluding header
    pub hz: f64,
    pub channels: &'static [&'static str],
    pub nan_every: u32,      // every Nth file gets a NaN window; 0 = never
    pub nan_rows: std::ops::Range<u32>,
}
pub fn mc1000() -> TierSpec   // 1000 files, 10_000 rows, 10 Hz, 5 channels, nan_every 20, nan_rows 4000..4200
pub fn wide100m() -> TierSpec // 1 file, 12_500_000 rows, 1000 Hz, 8 channels, nan_every 1, nan_rows 4_000_000..4_002_000
pub fn generate(spec: &TierSpec, dir: &Path) -> std::io::Result<()>
pub fn ensure(spec: &TierSpec) -> PathBuf   // generates under bench_root()/corpus/<name>, reuses via manifest
pub fn bench_root() -> PathBuf              // CARGO_MANIFEST_DIR/../../build/bench
```

- [ ] **Step 1: Move the module**

```bash
mkdir -p core/scope-core/src/benchmarks
git mv core/scope-core/src/benchmarks.rs core/scope-core/src/benchmarks/mod.rs
```

`lib.rs`'s `#[cfg(test)] mod benchmarks;` needs no change. Run `./scripts/test.sh core benchmarks` — the two existing benches still compile (they are ignored; the run should report them filtered/ignored, not error).

- [ ] **Step 2: Write failing unit tests** at the bottom of a new `core/scope-core/src/benchmarks/corpus.rs`, and add `mod corpus;` to `mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> TierSpec {
        TierSpec {
            name: "tiny",
            files: 3,
            rows: 100,
            hz: 10.0,
            channels: &["command", "response"],
            nan_every: 2,
            nan_rows: 40..50,
        }
    }

    #[test]
    fn generation_is_byte_stable() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        generate(&tiny(), a.path()).unwrap();
        generate(&tiny(), b.path()).unwrap();
        for index in 1..=3u32 {
            let name = format!("run_{index:04}.csv");
            assert_eq!(
                std::fs::read(a.path().join(&name)).unwrap(),
                std::fs::read(b.path().join(&name)).unwrap(),
                "{name} differs between runs"
            );
        }
    }

    #[test]
    fn files_have_expected_shape() {
        let dir = tempfile::tempdir().unwrap();
        generate(&tiny(), dir.path()).unwrap();
        let text = std::fs::read_to_string(dir.path().join("run_0001.csv")).unwrap();
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("time,command,response"));
        assert_eq!(lines.count(), 101); // rows + 1 inclusive end sample
    }

    #[test]
    fn nan_window_lands_only_in_selected_files() {
        let dir = tempfile::tempdir().unwrap();
        generate(&tiny(), dir.path()).unwrap();
        let with_gap = std::fs::read_to_string(dir.path().join("run_0002.csv")).unwrap();
        let without = std::fs::read_to_string(dir.path().join("run_0001.csv")).unwrap();
        assert!(with_gap.contains("NaN"));
        assert!(!without.contains("NaN"));
        let gap_lines: Vec<usize> = with_gap
            .lines()
            .enumerate()
            .filter(|(_, line)| line.contains("NaN"))
            .map(|(number, _)| number)
            .collect();
        // header is line 0, row r is line r + 1
        assert_eq!(gap_lines.first(), Some(&41));
        assert_eq!(gap_lines.last(), Some(&50));
    }

    #[test]
    fn ensure_reuses_existing_corpus() {
        let first = ensure(&tiny());
        let marker = first.join("run_0001.csv");
        let mtime = std::fs::metadata(&marker).unwrap().modified().unwrap();
        let second = ensure(&tiny());
        assert_eq!(first, second);
        assert_eq!(std::fs::metadata(&marker).unwrap().modified().unwrap(), mtime);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `./scripts/test.sh core corpus`
Expected: compile FAIL (`generate`, `ensure`, `TierSpec` not defined).

- [ ] **Step 4: Implement the generator** in `corpus.rs` above the tests:

```rust
use std::{
    io::{BufWriter, Write as _},
    ops::Range,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug)]
pub struct TierSpec {
    pub name: &'static str,
    pub files: u32,
    pub rows: u32,
    pub hz: f64,
    pub channels: &'static [&'static str],
    pub nan_every: u32,
    pub nan_rows: Range<u32>,
}

pub fn mc1000() -> TierSpec {
    TierSpec {
        name: "mc1000",
        files: 1000,
        rows: 10_000,
        hz: 10.0,
        channels: &["command", "response", "temperature", "pressure", "vibration"],
        nan_every: 20,
        nan_rows: 4000..4200,
    }
}

pub fn wide100m() -> TierSpec {
    TierSpec {
        name: "wide100m",
        files: 1,
        rows: 12_500_000,
        hz: 1000.0,
        channels: &["ch0", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7"],
        nan_every: 1,
        nan_rows: 4_000_000..4_002_000,
    }
}

pub fn bench_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/bench")
}

/// xorshift64*: deterministic, dependency-free.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(2_685_821_657_736_338_717).max(1))
    }

    fn next_f64(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / f64::from(1u32 << 21) / f64::from(1u32 << 21) / 2.0
    }
}

#[allow(clippy::cast_precision_loss)]
fn sample(spec: &TierSpec, file: u32, channel: usize, time: f64, noise: f64) -> f64 {
    let run = f64::from(file);
    let lane = channel as f64;
    let gain = 0.9 + run * 0.000_21 + lane * 0.05;
    let damping = 0.6 + run * 0.000_35;
    let phase = run * 0.017 + lane * 1.3;
    gain * (1.0 - (-damping * time * 0.01).exp()) * (1.0 + 0.2 * (time * (0.8 + lane * 0.11) + phase).sin())
        + 0.01 * noise
}

pub fn generate(spec: &TierSpec, dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for file in 1..=spec.files {
        let path = dir.join(format!("run_{file:04}.csv"));
        let mut writer = BufWriter::new(std::fs::File::create(path)?);
        writeln!(writer, "time,{}", spec.channels.join(","))?;
        let mut rng = Rng::new(u64::from(file) * 1_000_003);
        let gap = spec.nan_every != 0 && file % spec.nan_every == 0;
        for row in 0..=spec.rows {
            write!(writer, "{:.4}", f64::from(row) / spec.hz)?;
            for (channel, _) in spec.channels.iter().enumerate() {
                let noise = rng.next_f64(); // drawn unconditionally so gaps never shift the stream
                if gap && channel == 1 && spec.nan_rows.contains(&row) {
                    write!(writer, ",NaN")?;
                } else {
                    let time = f64::from(row) / spec.hz;
                    write!(writer, ",{:.6}", sample(spec, file, channel, time, noise))?;
                }
            }
            writeln!(writer)?;
        }
        writer.flush()?;
    }
    Ok(())
}

static GENERATION: Mutex<()> = Mutex::new(());

pub fn ensure(spec: &TierSpec) -> PathBuf {
    let _guard = GENERATION.lock().unwrap();
    let dir = bench_root().join("corpus").join(spec.name);
    let manifest = dir.join("manifest.txt");
    let stamp = format!("{spec:?}");
    if std::fs::read_to_string(&manifest).is_ok_and(|existing| existing == stamp) {
        return dir;
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
    generate(spec, &dir).unwrap();
    std::fs::write(&manifest, stamp).unwrap();
    dir
}
```

Notes for the implementer: the RNG advances once per non-time cell whether or not the cell is a gap, so byte-stability never depends on gap placement. The `ensure` test uses `name: "tiny"` and hits `bench_root()`; that writes `build/bench/corpus/tiny` in the real tree — acceptable (`build/` is untracked), and the reuse test depends on it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `./scripts/test.sh core corpus`
Expected: 4 passed. Also run `./scripts/test.sh core` to confirm no clippy/pedantic fallout (the suite runs `cargo test`; clippy runs in `ci.sh rust` — run `./scripts/ci.sh rust` if unsure).

- [ ] **Step 6: Add corpus entry-point benches** to `benchmarks/mod.rs` (these are the standalone generation path for manual native sessions):

```rust
mod corpus;
mod report;  // added in Task 2; omit until then

#[test]
#[ignore = "release benchmark"]
fn bench_corpus_mc1000() {
    let started = std::time::Instant::now();
    let dir = corpus::ensure(&corpus::mc1000());
    println!("bench_corpus_mc1000 dir={} seconds={:.1}", dir.display(), started.elapsed().as_secs_f64());
}

#[test]
#[ignore = "release benchmark"]
fn bench_corpus_wide100m() {
    let started = std::time::Instant::now();
    let dir = corpus::ensure(&corpus::wide100m());
    println!("bench_corpus_wide100m dir={} seconds={:.1}", dir.display(), started.elapsed().as_secs_f64());
}
```

- [ ] **Step 7: Run one generation for real**

Run: `cd /home/tanged/sources/signalscope && cargo test --release -p scope-core -- --ignored --test-threads=1 --show-output bench_corpus_mc1000` (via dev shell if needed: `./scripts/dev.sh cargo test ...`)
Expected: PASS; `build/bench/corpus/mc1000/` holds 1000 CSVs + manifest; rerun finishes in <1 s (reuse).

- [ ] **Step 8: Format and commit**

```bash
./scripts/format.sh
git add core/scope-core/src/benchmarks
git commit -m "feat(bench): deterministic corpus generator with mc1000 and wide100m tiers"
```

---

### Task 2: Report module

**Files:**

- Create: `core/scope-core/src/benchmarks/report.rs`
- Modify: `core/scope-core/src/benchmarks/mod.rs` (add `mod report;`)

**Interfaces (Produces):**

```rust
pub fn write_report(name: &str, value: serde_json::Value)       // -> build/bench/report/<name>.json
pub fn percentile(sorted_ms: &[f64], fraction: f64) -> f64      // input must be ascending
```

- [ ] **Step 1: Write failing tests** in `report.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_writes_pretty_json() {
        let dir = tempfile::tempdir().unwrap();
        write_report_at(dir.path(), "sample", serde_json::json!({ "pass": true }));
        let text = std::fs::read_to_string(dir.path().join("sample.json")).unwrap();
        assert!(text.contains("\"pass\": true"));
    }

    #[test]
    fn percentile_picks_expected_ranks() {
        let sorted = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        assert!((percentile(&sorted, 0.5) - 6.0).abs() < f64::EPSILON);
        assert!((percentile(&sorted, 0.95) - 10.0).abs() < f64::EPSILON);
        assert!((percentile(&[42.0], 0.99) - 42.0).abs() < f64::EPSILON);
    }
}
```

- [ ] **Step 2: Run to verify failure**: `./scripts/test.sh core report` → compile FAIL.

- [ ] **Step 3: Implement**

```rust
use std::path::Path;

pub fn write_report(name: &str, value: serde_json::Value) {
    write_report_at(&super::corpus::bench_root().join("report"), name, value);
}

fn write_report_at(dir: &Path, name: &str, value: serde_json::Value) {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(format!("{name}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
    println!("{name} {value}");
}

#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss, clippy::cast_sign_loss)]
pub fn percentile(sorted_ms: &[f64], fraction: f64) -> f64 {
    assert!(!sorted_ms.is_empty());
    let rank = ((sorted_ms.len() as f64 * fraction).ceil() as usize).clamp(1, sorted_ms.len());
    sorted_ms[rank - 1]
}
```

(`write_report_at` is `pub(crate)`-visible enough as a private fn used by tests in the same file.)

- [ ] **Step 4: Run to verify pass**: `./scripts/test.sh core report` → 2 passed.

- [ ] **Step 5: Format and commit**: `./scripts/format.sh && git add core/scope-core/src/benchmarks && git commit -m "feat(bench): per-scenario json report writer and percentile helper"`

---

### Task 3: Monte-carlo cold open and warm reopen benches

**Files:**

- Modify: `core/scope-core/src/benchmarks/mod.rs`

**Interfaces:**

- Consumes: `corpus::{ensure, mc1000, bench_root}`, `report::{write_report}`; `BatchJobs`/`BatchOptions`/`CommitSink` (`ingest/batch.rs`), `MemoryBudget`/`BudgetConfig` (`ingest/admission.rs`), `SignalStore` (`store.rs`), `Pyramid` (`pyramid.rs`).
- Produces: `struct StoreSink` (reused by Task 5): `StoreSink::new() -> Arc<Self>`, fields `store: Mutex<SignalStore>`, `pyramids: Mutex<BTreeMap<(SourceId, String), Pyramid>>`.

- [ ] **Step 1: Implement `StoreSink`** in `mod.rs` (replacing the existing minimal `Sink` is NOT allowed — the existing `bench_batch_ingests_one_thousand_synthetic_runs` keeps its `Sink`; add `StoreSink` alongside):

```rust
struct StoreSink {
    store: Mutex<SignalStore>,
    pyramids: Mutex<BTreeMap<(SourceId, String), Pyramid>>,
}

impl StoreSink {
    fn new() -> Arc<Self> {
        Arc::new(Self { store: Mutex::new(SignalStore::new()), pyramids: Mutex::new(BTreeMap::new()) })
    }
}

impl CommitSink for StoreSink {
    fn commit(
        &self,
        record: &SourceRecord,
        decoded: DecodedSource,
        pyramids: Vec<(String, Pyramid)>,
    ) -> Result<IngestSummary, IngestError> {
        let mut store = self.store.lock().unwrap();
        let row_count = decoded.row_count;
        let (source_id, signals) = store
            .transaction(|store| {
                let source_id = store.register_source(&record.path, record.key, record.prefix.clone())?;
                let mut ids = Vec::with_capacity(decoded.signals.len());
                for signal in decoded.signals {
                    ids.push(store.insert_signal(source_id, signal.local_path, signal.unit, signal.time, signal.values)?);
                }
                Ok::<_, StoreError>((source_id, ids))
            })
            .map_err(|error| IngestError::Store(error.to_string()))?;
        let mut map = self.pyramids.lock().unwrap();
        for (local_path, pyramid) in pyramids {
            map.insert((source_id, local_path), pyramid);
        }
        Ok(IngestSummary { source_id, row_count, signals })
    }
}
```

Adjust names to the real API while implementing (e.g. the exact `IngestError` variant for wrapping a store error, whether `register_source` takes `prefix` by value — check `store.rs:197` and `ingest/batch.rs:269`). The structure — transaction, register, insert each signal, stash pyramids by `(source_id, local_path)` — is the requirement.

- [ ] **Step 2: Write `bench_mc_cold_open`**

```rust
fn batch_options(cache_directory: Option<PathBuf>) -> BatchOptions {
    BatchOptions {
        worker_count: 8,
        budget: Arc::new(MemoryBudget::new(BudgetConfig {
            working_bytes: 512 * 1024 * 1024,
            resident_bytes: 1024 * 1024 * 1024,
        })),
        terminal_ttl: Duration::from_secs(60),
        cache_directory,
        recipe_directory: None,
        provider_registry: Arc::new(ProviderRegistry::builtin()),
    }
}

fn corpus_paths(dir: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            (path.extension().is_some_and(|ext| ext == "csv")).then_some(path)
        })
        .collect();
    paths.sort();
    paths
}

#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_mc_cold_open() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let cache = tempfile::tempdir().unwrap(); // fresh cache dir => always cold
    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache.path().to_path_buf())));

    let started = Instant::now();
    let id = jobs.submit(corpus_paths(&corpus), Arc::clone(&sink) as Arc<dyn CommitSink>);
    let status = jobs.join(id).unwrap();
    let ingest_seconds = started.elapsed().as_secs_f64();
    assert_eq!(status.state, BatchState::Done);

    // First-window tile queries: the ensemble panel asks every source for `response`.
    let pyramids = sink.pyramids.lock().unwrap();
    let query_started = Instant::now();
    let mut series = 0u32;
    for ((_, local_path), pyramid) in pyramids.iter() {
        if local_path == "response" {
            let query = pyramid.query(0.0, 1000.0, 1920);
            assert!(!query.bins.is_empty());
            series += 1;
        }
    }
    let first_window_ms = query_started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(series, 1000);

    let total_seconds = ingest_seconds + first_window_ms / 1000.0;
    report::write_report(
        "mc_cold_open",
        serde_json::json!({
            "bench": "mc_cold_open",
            "ingest_seconds": ingest_seconds,
            "first_window_ms": first_window_ms,
            "total_seconds": total_seconds,
            "target_seconds": 30.0,
            "floor_seconds": 60.0,
            "pass": total_seconds <= 60.0,
        }),
    );
    assert!(total_seconds <= 60.0, "cold open took {total_seconds:.1}s (floor 60s)");
}
```

Note: the `local_path` key may include a recipe/derived prefix depending on the CSV decoder's naming — verify with one file what `insert_signal` receives (`command`, `response`, …) and match exactly.

- [ ] **Step 3: Write `bench_mc_warm_reopen`**

```rust
#[test]
#[ignore = "release benchmark"]
fn bench_mc_warm_reopen() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let cache_dir = corpus::bench_root().join("cache/mc1000");
    std::fs::create_dir_all(&cache_dir).unwrap();

    // Populate the persistent cache (unmeasured; warm if a prior run left it).
    let warmup = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir.clone())));
    let id = jobs.submit(corpus_paths(&corpus), Arc::clone(&warmup) as Arc<dyn CommitSink>);
    assert_eq!(jobs.join(id).unwrap().state, BatchState::Done);
    drop(warmup);

    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir)));
    let started = Instant::now();
    let id = jobs.submit(corpus_paths(&corpus), Arc::clone(&sink) as Arc<dyn CommitSink>);
    let status = jobs.join(id).unwrap();
    let seconds = started.elapsed().as_secs_f64();
    assert_eq!(status.state, BatchState::Done);

    // Evidence decode was skipped: cache loads register paged columns.
    let store = sink.store.lock().unwrap();
    let paged = store.signals().filter(|signal| signal.is_paged()).count();
    let total = store.signals().count();
    assert_eq!(paged, total, "warm reopen decoded {}/{} signals instead of paging", total - paged, total);

    report::write_report(
        "mc_warm_reopen",
        serde_json::json!({
            "bench": "mc_warm_reopen",
            "seconds": seconds,
            "paged_signals": paged,
            "target_seconds": 5.0,
            "floor_seconds": 15.0,
            "pass": seconds <= 15.0,
        }),
    );
    assert!(seconds <= 15.0, "warm reopen took {seconds:.1}s (floor 15s)");
}
```

- [ ] **Step 4: Run both benches**

Run: `cargo test --release -p scope-core -- --ignored --test-threads=1 --show-output bench_mc_` (through the dev shell).
Expected: both PASS; `build/bench/report/mc_cold_open.json` and `mc_warm_reopen.json` exist with `"pass": true`. If a floor fails on real hardware, that is a finding — investigate before loosening anything.

- [ ] **Step 5: Format and commit**: `./scripts/format.sh && git add -A core/scope-core && git commit -m "feat(bench): mc1000 cold-open and warm-reopen floors"`

---

### Task 4: Huge-file cold build bench

**Files:** Modify: `core/scope-core/src/benchmarks/mod.rs`

**Interfaces:** Consumes `ingest::ingest_path` (`ingest/mod.rs:134`), `DecodeContext`/`CancelToken`, `Pyramid::from_signal`, `corpus::{ensure, wide100m}`, `report::write_report`.

- [ ] **Step 1: Write `bench_huge_cold_build`**

```rust
#[test]
#[ignore = "release benchmark"]
#[allow(clippy::cast_precision_loss)]
fn bench_huge_cold_build() {
    let dir = corpus::ensure(&corpus::wide100m());
    let path = dir.join("run_0001.csv");
    let mut store = SignalStore::new();
    let registry = ProviderRegistry::builtin();
    let cancel = CancelToken::default();
    let mut progress = |_: f64| {};
    let mut context = DecodeContext { progress: &mut progress, cancel: &cancel };

    let started = Instant::now();
    let summary = ingest::ingest_path(
        &registry,
        &path,
        &mut store,
        SourceKey(uuid::Uuid::from_bytes([7; 16])),
        "wide100m",
        &mut context,
    )
    .unwrap();
    let mut bins = 0usize;
    for id in &summary.signals {
        let pyramid = Pyramid::from_signal(store.signal(*id).unwrap());
        bins += pyramid.stored_bin_count();
        let query = pyramid.query(0.0, 12_500.0, 1920);
        assert!(!query.bins.is_empty());
    }
    let seconds = started.elapsed().as_secs_f64();
    let samples = summary.row_count as f64 * 8.0;
    let samples_per_second = samples / seconds;

    report::write_report(
        "huge_cold_build",
        serde_json::json!({
            "bench": "huge_cold_build",
            "seconds": seconds,
            "samples_per_second": samples_per_second,
            "stored_bins": bins,
            "target_samples_per_second": 5_000_000.0,
            "floor_samples_per_second": 2_000_000.0,
            "pass": samples_per_second >= 2_000_000.0,
        }),
    );
    assert!(samples_per_second >= 2_000_000.0, "built {samples_per_second:.0} samples/s (floor 2M)");
}
```

- [ ] **Step 2: Run it**: `cargo test --release -p scope-core -- --ignored --test-threads=1 --show-output bench_huge_cold_build`. First run pays wide100m generation (~2 GB, a minute or two); rerun to see the steady-state number.

- [ ] **Step 3: Format and commit**: `./scripts/format.sh && git add core/scope-core && git commit -m "feat(bench): 100M-point cold build throughput floor"`

---

### Task 5: Tile-latency and NaN-gap-at-scale benches

**Files:** Modify: `core/scope-core/src/benchmarks/mod.rs`

**Interfaces:** Consumes `StoreSink` (Task 3), `Pyramid::query`, `report::percentile`.

- [ ] **Step 1: Write `bench_tile_latency`** — panel-refresh percentiles. One "refresh" = the tile queries a 1000-source ensemble panel issues for one viewport change.

```rust
#[test]
#[ignore = "release benchmark"]
fn bench_tile_latency() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let cache_dir = corpus::bench_root().join("cache/mc1000");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let sink = StoreSink::new();
    let jobs = BatchJobs::new(batch_options(Some(cache_dir)));
    let id = jobs.submit(corpus_paths(&corpus), Arc::clone(&sink) as Arc<dyn CommitSink>);
    assert_eq!(jobs.join(id).unwrap().state, BatchState::Done);

    let pyramids = sink.pyramids.lock().unwrap();
    let ensemble: Vec<&Pyramid> = pyramids
        .iter()
        .filter_map(|((_, local_path), pyramid)| (local_path == "response").then_some(pyramid))
        .collect();
    assert_eq!(ensemble.len(), 1000);

    // Zoom ladder with 25% pans at each span: the scripted pan/zoom access pattern.
    let mut windows = Vec::new();
    for span in [1000.0, 300.0, 100.0, 30.0, 10.0, 3.0, 1.0] {
        let mut t0 = 0.0;
        while t0 + span <= 1000.0 && windows.len() < 200 {
            windows.push((t0, t0 + span));
            t0 += span * 0.25;
        }
    }

    let mut refresh_ms: Vec<f64> = windows
        .iter()
        .map(|&(t0, t1)| {
            let started = Instant::now();
            for pyramid in &ensemble {
                let query = pyramid.query(t0, t1, 1920);
                std::hint::black_box(query.bins.len());
            }
            started.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    refresh_ms.sort_by(f64::total_cmp);
    let (p50, p95, p99) = (
        report::percentile(&refresh_ms, 0.50),
        report::percentile(&refresh_ms, 0.95),
        report::percentile(&refresh_ms, 0.99),
    );

    report::write_report(
        "tile_latency",
        serde_json::json!({
            "bench": "tile_latency",
            "refreshes": refresh_ms.len(),
            "series_per_refresh": 1000,
            "p50_ms": p50, "p95_ms": p95, "p99_ms": p99,
            "target_p95_ms": 10.0, "floor_p95_ms": 20.0, "floor_p99_ms": 50.0,
            "pass": p95 <= 20.0 && p99 <= 50.0,
        }),
    );
    assert!(p95 <= 20.0, "refresh p95 {p95:.2}ms (floor 20ms)");
    assert!(p99 <= 50.0, "refresh p99 {p99:.2}ms (floor 50ms)");
}
```

Note the warm-cache load registers paged columns and paged fine levels, so deep-zoom queries (`span 1 s` can reach level 0–2 synthesis) run through the leased LRU — the out-of-core path the spec requires. Confirm during implementation that at least one ladder rung selects a level below `FINEST_STORED_LEVEL` (print `query.level` for the finest span once while developing; remove before commit).

- [ ] **Step 2: Write `bench_nan_gap_scale`**

```rust
#[test]
#[ignore = "release benchmark"]
fn bench_nan_gap_scale() {
    let corpus = corpus::ensure(&corpus::mc1000());
    let registry = ProviderRegistry::builtin();
    // run_0020 has the NaN window (nan_every = 20); run_0001 does not.
    for (name, expect_gap) in [("run_0020.csv", true), ("run_0001.csv", false)] {
        let mut store = SignalStore::new();
        let cancel = CancelToken::default();
        let mut progress = |_: f64| {};
        let mut context = DecodeContext { progress: &mut progress, cancel: &cancel };
        let summary = ingest::ingest_path(
            &registry, &corpus.join(name), &mut store,
            SourceKey(uuid::Uuid::from_bytes([9; 16])), "gapcheck", &mut context,
        ).unwrap();
        let response = summary.signals.iter()
            .map(|id| store.signal(*id).unwrap())
            .find(|signal| signal.path.ends_with("response"))
            .unwrap();
        let pyramid = Pyramid::from_signal(response);
        for level in 0..pyramid.level_count() {
            let bins = pyramid.level(level).unwrap();
            let has_gap = bins.iter().any(|bin| bin.has_gap);
            assert_eq!(has_gap, expect_gap, "{name} level {level}");
            let finite = bins.iter().filter_map(|bin| bin.min).all(f64::is_finite)
                && bins.iter().filter_map(|bin| bin.max).all(f64::is_finite);
            assert!(finite, "{name} level {level} has non-finite extrema");
        }
    }
    report::write_report(
        "nan_gap_scale",
        serde_json::json!({ "bench": "nan_gap_scale", "pass": true }),
    );
}
```

- [ ] **Step 3: Run both**: `cargo test --release -p scope-core -- --ignored --test-threads=1 --show-output bench_tile_latency bench_nan_gap_scale` (libtest runs every test matching either filter).
      Expected: PASS, report files written.

- [ ] **Step 4: Format and commit**: `./scripts/format.sh && git add core/scope-core && git commit -m "feat(bench): tile-latency percentiles and nan-gap invariants at scale"`

---

### Task 6: Workspace fixtures

**Files:**

- Create: `examples/bench/mc1000.workspace.json`, `examples/bench/smoke.workspace.json`
- Test: non-ignored unit test in `core/scope-core/src/benchmarks/mod.rs`

**Interfaces (Produces):** two schema-v20 session files consumed by `scope-bake --workspace`; selector `query` bindings so they work for any generated source set.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn workspace_fixtures_load_at_current_schema() {
    for (name, span) in [("mc1000", 1000.0), ("smoke", 10.0)] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../../examples/bench/{name}.workspace.json"));
        let session = crate::session::load_from_path(&path).unwrap();
        assert_eq!(session.tabs.len(), 1, "{name}");
        assert_eq!(session.tabs[0].panels.len(), 2, "{name}");
        assert!((session.linked_time.t1 - span).abs() < f64::EPSILON, "{name}");
    }
}
```

Run `./scripts/test.sh core workspace_fixtures` → FAIL (files missing). Check `session::load_from_path`'s exact name/signature in `core/scope-core/src/session/` first and adapt.

- [ ] **Step 2: Create `examples/bench/mc1000.workspace.json`**

```json
{
  "app": "signalscope",
  "schema_version": 20,
  "theme": "dark",
  "linked_time": {
    "t0": 0.0,
    "t1": 1000.0,
    "linked": true,
    "paused": false,
    "cursorT": null,
    "mode": "fixed"
  },
  "active_tab_id": "workspace-1",
  "tabs": [
    {
      "id": "workspace-1",
      "title": "Monte Carlo",
      "cursor_mode": "none",
      "focused_panel_id": null,
      "maximized_panel_id": null,
      "panels": [
        {
          "id": "panel-ensemble",
          "title": "ensemble response",
          "mode": "time",
          "axis_style": "gutter",
          "color_axis": "none",
          "bindings": [
            {
              "kind": "query",
              "selector": "response @*",
              "refs": [],
              "set_id": null
            }
          ],
          "color_by": "source",
          "overrides": [],
          "focus": [],
          "ghost_mode": "all",
          "split_by": "none",
          "annotations": [],
          "show_stats": false
        },
        {
          "id": "panel-detail",
          "title": "command and temperature",
          "mode": "time",
          "axis_style": "gutter",
          "color_axis": "none",
          "bindings": [
            {
              "kind": "query",
              "selector": "command @*",
              "refs": [],
              "set_id": null
            },
            {
              "kind": "query",
              "selector": "temperature @*",
              "refs": [],
              "set_id": null
            }
          ],
          "color_by": "channel",
          "overrides": [],
          "focus": [],
          "ghost_mode": "all",
          "split_by": "none",
          "annotations": [],
          "show_stats": false
        }
      ],
      "layout": [
        {
          "height": 0.5,
          "panels": [{ "panel_id": "panel-ensemble", "width": 1.0 }]
        },
        {
          "height": 0.5,
          "panels": [{ "panel_id": "panel-detail", "width": 1.0 }]
        }
      ]
    }
  ],
  "named_sets": [],
  "derived": [],
  "derived_bundles": [],
  "sources": []
}
```

`smoke.workspace.json` is identical except `"t1": 10.0`, tab title `"Smoke"`, and the detail panel binds `command @*` plus `response @*` (run_08 lacks `temperature`; `response` exists everywhere). If `session::load_from_path` rejects a field, fix the fixture to match `session/generated.rs` — the schema is the source of truth, not this JSON.

- [ ] **Step 3: Run to verify pass**: `./scripts/test.sh core workspace_fixtures` → PASS.

- [ ] **Step 4: Format and commit**: `./scripts/format.sh && git add examples/bench core/scope-core && git commit -m "feat(bench): checked-in bench workspace fixtures"`

---

### Task 7: `test.sh bench` subcommands and release-profile bake

**Files:**

- Modify: `scripts/test.sh` (bench dispatch + help), `scripts/export.sh` (release profile)

**Interfaces (Produces):** `./scripts/test.sh bench [corpus|core|e2e|all]`; `bench_e2e` shell function producing `build/bench/mc1000.html` and `build/bench/report/bake.json`.

- [ ] **Step 1: Switch `export.sh` to release profile.** Change its last line to `cargo run --quiet --release -p scope-core --bin scope-bake -- "$@"`. Debug-profile decode of a 1 GB corpus would dominate bake time for no benefit; demo and roundtrip bakes get faster too.

- [ ] **Step 2: Replace the `bench)` arm in `scripts/test.sh`** (current arm at line 66) and update `show_help`:

```bash
bench)
  bench_mode="${2:-all}"
  case "$bench_mode" in
  corpus)
    cargo test --release -p scope-core -- --ignored --show-output --test-threads=1 bench_corpus_
    ;;
  core)
    cargo test --release -p scope-core -- --ignored --show-output --test-threads=1 bench_
    ;;
  e2e)
    bench_e2e
    ;;
  all)
    cargo test --release -p scope-core -- --ignored --show-output --test-threads=1 bench_
    bench_e2e
    node "$signalscope_scripts_dir/collect-bench-report.mjs"
    ;;
  *)
    echo "unknown bench mode: $bench_mode" >&2
    exit 2
    ;;
  esac
  ;;
```

with `bench_e2e` defined above the dispatch:

```bash
bench_e2e() {
  local corpus_dir="$signalscope_root/build/bench/corpus/mc1000"
  if [ ! -f "$corpus_dir/manifest.txt" ]; then
    cargo test --release -p scope-core -- --ignored --test-threads=1 bench_corpus_mc1000
  fi
  local -a data_args=()
  local file
  for file in "$corpus_dir"/run_*.csv; do
    data_args+=(--data "$file")
  done
  local out="$signalscope_root/build/bench/mc1000.html"
  local max_bytes=268435456 # 256 MiB: keeps the file:// load tractable in Chromium
  local fidelity started elapsed bytes
  for fidelity in high standard; do
    started=$SECONDS
    "$signalscope_scripts_dir/export.sh" "${data_args[@]}" \
      --workspace "$signalscope_root/examples/bench/mc1000.workspace.json" \
      --range all --fidelity "$fidelity" --out "$out"
    elapsed=$((SECONDS - started))
    bytes=$(stat -c %s "$out")
    if [ "$bytes" -le "$max_bytes" ]; then
      mkdir -p "$signalscope_root/build/bench/report"
      printf '{ "bench": "bake", "seconds": %d, "bytes": %d, "fidelity": "%s" }\n' \
        "$elapsed" "$bytes" "$fidelity" >"$signalscope_root/build/bench/report/bake.json"
      SIGNALSCOPE_BENCH=1 pnpm --filter @signalscope/frontend bench
      return
    fi
  done
  echo "baked snapshot exceeds $max_bytes bytes at every fidelity" >&2
  exit 1
}
```

Note `export.sh` runs `build.sh web` on each call; pass the second attempt through unchanged (correct, just slower) — do not add `--no-build` juggling unless the double build proves painful.

- [ ] **Step 3: Verify shellcheck passes**: `shellcheck scripts/test.sh scripts/export.sh` (or `./scripts/ci.sh quality` for the full gate later). `./scripts/test.sh bench corpus` must run the corpus tests. `./scripts/test.sh bench e2e` will fail at `pnpm bench` (script doesn't exist yet) — expected until Task 8.

- [ ] **Step 4: Format and commit**: `./scripts/format.sh && git add scripts/test.sh scripts/export.sh && git commit -m "feat(bench): test.sh bench subcommands and release-profile bake"`

---

### Task 8: Playwright bench project and measurement helper

**Files:**

- Create: `frontend/tests/bench/measure.ts`, `frontend/tests/bench/bench.spec.ts`
- Modify: `frontend/playwright.config.ts`, `frontend/package.json`, `frontend/knip.json`

**Interfaces (Produces):**

```ts
// measure.ts
export async function startFrameProbe(page: Page): Promise<void>;
export interface FrameStats {
  p95Ms: number;
  maxMs: number;
  frames: number;
  longTasks: number;
  longestTaskMs: number;
}
export async function stopFrameProbe(page: Page): Promise<FrameStats>;
export async function interact(page: Page): Promise<void>; // wheel ladder, ctrl-drag pans, box zoom, wheel out
```

- [ ] **Step 1: Config + scripts + knip.** In `frontend/playwright.config.ts` add to `projects`:

```ts
    {
      name: "bench",
      testDir: "./tests/bench",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
```

and widen the webServer guard:

```ts
  webServer:
    process.env.SIGNALSCOPE_DEMO === "1" || process.env.SIGNALSCOPE_BENCH === "1"
      ? undefined
      : { command: "pnpm dev", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI },
```

In `frontend/package.json` scripts add `"bench": "playwright test --project=bench"`. In `frontend/knip.json` add `"tests/bench/*.ts"` to the `entry` array.

- [ ] **Step 2: Write `measure.ts`**

```ts
import type { Page } from "@playwright/test";

interface BenchWindow {
  __benchFrames: number[];
  __benchLongTasks: number[];
  __benchStop?: () => void;
}

export interface FrameStats {
  p95Ms: number;
  maxMs: number;
  frames: number;
  longTasks: number;
  longestTaskMs: number;
}

export async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bench = window as unknown as BenchWindow;
    bench.__benchFrames = [];
    bench.__benchLongTasks = [];
    let last = performance.now();
    let running = true;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        bench.__benchLongTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: false });
    bench.__benchStop = () => {
      running = false;
      observer.disconnect();
    };
    const tick = (now: number) => {
      bench.__benchFrames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function stopFrameProbe(page: Page): Promise<FrameStats> {
  return page.evaluate(() => {
    const bench = window as unknown as BenchWindow;
    bench.__benchStop?.();
    const frames = [...bench.__benchFrames].sort((a, b) => a - b);
    const rank = Math.min(frames.length - 1, Math.ceil(frames.length * 0.95));
    return {
      p95Ms: frames[rank] ?? 0,
      maxMs: frames.at(-1) ?? 0,
      frames: frames.length,
      longTasks: bench.__benchLongTasks.length,
      longestTaskMs: Math.max(0, ...bench.__benchLongTasks),
    };
  });
}

export async function interact(page: Page): Promise<void> {
  const canvas = page.locator(".overlay-canvas").first();
  await canvas.hover({ position: { x: 480, y: 200 } });
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, -240); // pointer-centered zoom in
    await page.waitForTimeout(80);
  }
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.move(480, 200);
    await page.keyboard.down("Control"); // ctrl+left drag pans (plot-gestures.ts dragIntent)
    await page.mouse.down();
    await page.mouse.move(320, 200, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await page.waitForTimeout(80);
  }
  await page.mouse.move(320, 150); // plain left drag = box zoom
  await page.mouse.down();
  await page.mouse.move(640, 320, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, 240); // zoom back out
    await page.waitForTimeout(80);
  }
}
```

TypeScript note: `page.evaluate` callbacks run in the browser; the `BenchWindow` interface must be declared inside each callback or in a shared ambient way that survives `tsc --noEmit` — if the compiler complains about the closure capturing the outer interface, redeclare the shape inline with `as unknown as { ... }` casts, matching the codebase's strictness settings.

- [ ] **Step 3: Write `bench.spec.ts`**

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { interact, startFrameProbe, stopFrameProbe } from "./measure";

const artifact = new URL("../../../build/bench/mc1000.html", import.meta.url);
const reportDir = new URL("../../../build/bench/report/", import.meta.url);

test("mc1000 snapshot first plot and pan/zoom stay interactive", async ({
  page,
}) => {
  test.setTimeout(240_000);
  expect(
    existsSync(fileURLToPath(artifact)),
    "bake first: ./scripts/test.sh bench e2e",
  ).toBe(true);

  const started = Date.now();
  await page.goto(artifact.href);
  await expect(page.locator(".plot-canvas").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 120_000,
  });
  const firstPlotMs = Date.now() - started;

  await startFrameProbe(page);
  await interact(page);
  const stats = await stopFrameProbe(page);

  mkdirSync(fileURLToPath(reportDir), { recursive: true });
  writeFileSync(
    new URL("e2e_mc1000.json", reportDir),
    JSON.stringify(
      {
        bench: "e2e_mc1000",
        first_plot_ms: firstPlotMs,
        frame_p95_ms: stats.p95Ms,
        frame_max_ms: stats.maxMs,
        frames: stats.frames,
        long_tasks: stats.longTasks,
        longest_task_ms: stats.longestTaskMs,
        floor_first_plot_ms: 10_000,
        floor_frame_p95_ms: 33,
        floor_stall_ms: 250,
        pass:
          firstPlotMs <= 10_000 &&
          stats.p95Ms <= 33 &&
          Math.max(stats.maxMs, stats.longestTaskMs) <= 250,
      },
      null,
      2,
    ),
  );

  expect(firstPlotMs, "first plot").toBeLessThanOrEqual(10_000);
  expect(stats.frames, "frame probe collected samples").toBeGreaterThan(100);
  expect(stats.p95Ms, "frame interval p95").toBeLessThanOrEqual(33);
  expect(
    Math.max(stats.maxMs, stats.longestTaskMs),
    "longest stall",
  ).toBeLessThanOrEqual(250);
});
```

- [ ] **Step 4: Run the full e2e bench**

Run: `./scripts/test.sh bench e2e`
Expected: bake completes (report `bake.json` records fidelity/bytes), Playwright bench passes, `build/bench/report/e2e_mc1000.json` written. This is the moment of truth for the composed budget — if a floor fails, capture the numbers in your handoff notes rather than silently retuning; floor changes go back through the user.

- [ ] **Step 5: Frontend gates**: `./scripts/test.sh unit` and `pnpm --filter @signalscope/frontend lint` via `./scripts/ci.sh frontend` (covers lint + knip `check:unused`).

- [ ] **Step 6: Format and commit**: `./scripts/format.sh && git add frontend && git commit -m "feat(bench): playwright bench project with frame-timing probe"`

---

### Task 9: Smoke spec in PR e2e

**Files:**

- Create: `frontend/tests/e2e/bench-smoke.spec.ts`
- Modify: `scripts/lib.sh` (add `bake_bench_smoke_artifact`), `scripts/test.sh` (e2e + full arms), `scripts/ci.sh` (`check_e2e`)

**Interfaces:** Consumes `measure.ts` helpers and `examples/bench/smoke.workspace.json`; produces `build/bench/smoke.html` in every e2e run.

- [ ] **Step 1: Add to `scripts/lib.sh`**, after `bake_roundtrip_artifact`:

```bash
bake_bench_smoke_artifact() {
  local -a data_args=()
  local file
  for file in "$signalscope_root"/examples/monte_carlo/run_*.csv; do
    data_args+=(--data "$file")
  done
  "$signalscope_scripts_dir/export.sh" --no-build "${data_args[@]}" \
    --workspace "$signalscope_root/examples/bench/smoke.workspace.json" \
    --range all --fidelity full --out "$signalscope_root/build/bench/smoke.html"
}
```

Call it right after `bake_roundtrip_artifact` in `scripts/test.sh` (e2e and full arms) and in `scripts/ci.sh check_e2e`. `--no-build` is safe there because `bake_roundtrip_artifact` just built the web bundle.

- [ ] **Step 2: Write `bench-smoke.spec.ts`** — keeps bench code paths green in PR CI; **no perf floors**:

```ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { interact, startFrameProbe, stopFrameProbe } from "../bench/measure";
import { expect, test } from "./fixtures";

const artifact = new URL("../../../build/bench/smoke.html", import.meta.url);

test("bench smoke: baked monte-carlo workspace renders and survives interaction", async ({
  page,
}) => {
  expect(
    existsSync(fileURLToPath(artifact)),
    "bake_bench_smoke_artifact must run first",
  ).toBe(true);
  await page.goto(artifact.href);
  await expect(page.locator(".plot-canvas").first()).toBeVisible();
  await expect(page.locator(".render-ms")).not.toHaveText("— ms");
  const readout = page.locator(".window-readout").first();
  const before = await readout.textContent();
  await startFrameProbe(page);
  await interact(page);
  const stats = await stopFrameProbe(page);
  expect(stats.frames).toBeGreaterThan(0);
  await expect(readout).not.toHaveText(before ?? "");
});
```

The readout assertion proves the scripted gestures actually change the viewport (same technique as `demo.spec.ts:30-36`). If ctrl-drag or box-zoom turn out to be intercepted by something in the baked host, fix `interact` in `measure.ts` — this smoke test existing is exactly so the full bench never rots silently.

- [ ] **Step 3: Run it**: `./scripts/test.sh e2e` — the smoke spec runs inside the desktop project alongside existing e2e specs.
      Expected: PASS.

- [ ] **Step 4: Format and commit**: `./scripts/format.sh && git add frontend scripts && git commit -m "feat(bench): smoke-tier bench spec in the pr e2e suite"`

---

### Task 10: Report collector

**Files:**

- Create: `scripts/collect-bench-report.mjs`

**Interfaces (Produces):** `node scripts/collect-bench-report.mjs` reads `build/bench/report/*.json`, writes `build/bench/report.json`, exits 1 if any entry has `"pass": false` or the directory is empty.

- [ ] **Step 1: Write it** (root-scripts idiom: `process.exitCode`, path via `import.meta.url`):

```js
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = join(root, "build", "bench", "report");

const names = (await readdir(reportDir).catch(() => []))
  .filter((name) => name.endsWith(".json"))
  .sort();
if (names.length === 0) {
  console.error(`no bench reports in ${reportDir}`);
  process.exitCode = 1;
} else {
  const entries = [];
  for (const name of names) {
    entries.push(JSON.parse(await readFile(join(reportDir, name), "utf8")));
  }
  const failed = entries
    .filter((entry) => entry.pass === false)
    .map((entry) => entry.bench);
  const report = { generated: new Date().toISOString(), entries };
  await writeFile(
    join(root, "build", "bench", "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `bench report: ${entries.length} entries -> build/bench/report.json`,
  );
  if (failed.length > 0) {
    console.error(`failing benches: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 2: Test by hand**: run `node scripts/collect-bench-report.mjs` with the report files from Tasks 3–8 present → prints entry count, exit 0. Rename one file's `"pass": true` to `false` in a scratch copy... instead: `node scripts/collect-bench-report.mjs` after temporarily moving `build/bench/report` aside → exit 1 with the "no bench reports" message; restore.

- [ ] **Step 3: Format and commit**: `./scripts/format.sh && git add scripts/collect-bench-report.mjs && git commit -m "feat(bench): report collector"`

---

### Task 11: CI gate and scheduled workflow

**Files:**

- Modify: `scripts/ci.sh` (bench arm + help)
- Create: `.github/workflows/bench.yml`

- [ ] **Step 1: `ci.sh`** — add to the second `case` (after `e2e`):

```bash
bench)
  "$signalscope_scripts_dir/test.sh" bench all
  ;;
```

and a `show_help` line: `bench     Full benchmark suite; writes build/bench/report.json`.

- [ ] **Step 2: `bench.yml`** — match `ci.yml`'s action versions exactly (check `actions/checkout` and upload-artifact versions used there before writing):

```yaml
name: bench

on:
  workflow_dispatch:
  schedule:
    - cron: "17 5 * * 1"

permissions:
  contents: read

jobs:
  bench:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: ./.github/actions/setup
        with:
          cachix-auth-token: ${{ secrets.CACHIX_AUTH_TOKEN }}
          cargo-cache-key: bench
      - run: ./scripts/ci.sh bench
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: bench-report
          path: build/bench/report.json
          if-no-files-found: warn
```

This is a separate workflow, so the `ci-ok` needs-list in `ci.yml` is untouched and PRs never gate on it.

- [ ] **Step 3: Lint the workflow**: `./scripts/ci.sh quality` (runs actionlint + zizmor + shellcheck over the new files).
      Expected: PASS.

- [ ] **Step 4: Format and commit**: `./scripts/format.sh && git add scripts/ci.sh .github/workflows/bench.yml && git commit -m "ci: non-blocking weekly bench workflow"`

---

### Task 12: ADR 0035 and roadmap update

**Files:**

- Create: `docs/adr/0035-benchmark-harness-and-performance-floors.md`
- Modify: `docs/adr/README.md` (add index row matching the existing format), `docs/implementation-roadmap.md` (Phase 5 progress note)

- [ ] **Step 1: Write the ADR.** Record the decision, not the deliberation; match the tone/length of ADR 0026 or 0033. Required content:
  - Context: Phase 5 needs repeatable performance evidence for the 1000-run monte-carlo workflow, multi-GB single files, and cache reuse; CI machines vary too much for tight thresholds.
  - Decision: two automated layers over one deterministic generated corpus (`build/bench/`, never committed); `#[ignore = "release benchmark"]` tests with generous hard floors that only catch order-of-magnitude regressions, each emitting one JSON report file; a Playwright bench project measuring first-plot and frame timing on a baked snapshot; the checked-in `examples/monte_carlo` corpus as the PR-CI smoke tier; a weekly non-blocking `bench.yml` uploading `build/bench/report.json`; the manual native workflow remains the acceptance authority (checklist in the Phase 5 spec).
  - The composed interaction budget: core tile-refresh p95 (floor 20 ms) plus browser frame p95 (floor 33 ms) inside a 30 fps budget; stalls over 250 ms fail.
  - Consequences: floors are deliberately loose — trend-watching happens on the reports, not the assertions; corpus generation costs ~3.5 GB of `build/`; the e2e layer measures the baked plane, so native IPC latency is only represented by the core tile scenario.
- [ ] **Step 2: Roadmap.** Under the Phase 5 heading in `docs/implementation-roadmap.md`, add a short paragraph: benchmark track landed (ADR 0035) — corpus tiers, core floors, Playwright bench project, weekly bench workflow, `./scripts/test.sh bench` entry point.
- [ ] **Step 3: Format and commit**: `./scripts/format.sh && git add docs && git commit -m "docs: adr 0035 benchmark harness and roadmap note"`

---

### Task 13: Full gates, version bump, handoff

- [ ] **Step 1: Full local gate**: `./scripts/ci.sh all` (includes format check, quality, rust, frontend, artifacts, e2e-with-smoke). Fix anything it finds.
- [ ] **Step 2: One full bench run for the record**: `./scripts/test.sh bench all` — paste the `build/bench/report.json` numbers into the handoff summary.
- [ ] **Step 3: Version bump** (final change): benchmarks/tooling/tests → patch. `./scripts/version.sh bump patch && ./scripts/version.sh check`, commit the manifest changes: `git add -A && git commit -m "chore: release v<new-version>"` (match the repo's existing bump-commit subject style — check `git log --oneline` for the last bump).
- [ ] **Step 4: Handoff notes** must include: report numbers from Step 2, any floor that needed discussion, and the reminder that the **manual native acceptance checklist** in the spec (`docs/superpowers/specs/2026-08-04-phase5-benchmarks-design.md`) is the user's final gate: `./scripts/test.sh bench corpus`, then `./scripts/run.sh native`, import `build/bench/corpus/mc1000/`, and work through the six checklist items.

---

## Self-Review Notes

- Spec coverage: corpus tiers (T1), cold open / warm reopen (T3), huge build (T4), tile latency + NaN gaps (T5), workspace fixtures (T6), bench subcommands + bake fallback (T7), Playwright bench + floors (T8), smoke tier in PR CI (T9), report collector (T10), CI gate + weekly workflow (T11), ADR + roadmap (T12), gates + bump + manual checklist handoff (T13).
- Deviation from spec, decided at planning: Tier S is the checked-in `examples/monte_carlo` (8 runs) rather than a generated 10-file miniature — zero PR-CI generation cost, already maintained by `quality_checks`. The smoke workspace binds `response`/`command` because `run_08` intentionally lacks `temperature`.
- Known API-adaptation points are flagged inline (StoreSink error mapping, `session::load_from_path` name, decoder `local_path` values, ci.yml action versions). Implementers must adapt to the real signatures, not force the sketches.

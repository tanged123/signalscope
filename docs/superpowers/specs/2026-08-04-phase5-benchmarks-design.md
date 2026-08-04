# Phase 5 benchmark suite design

2026-08-04. Scope: the performance benchmark track of Phase 5 only. Robustness
hardening (corrupt inputs), accessibility invariants, and release
bundle/artifact-size gates are separate follow-up specs.

## Goal

Prove the target workflow: open a 1000-run monte-carlo campaign (1000 s at
10 Hz per run), plot multiple signals per panel, and pan/zoom seamlessly.
Additionally cover the roadmap's cold multi-GB first plot, cache build and
reuse, tile latency, and 100M-point pan/zoom.

"Seamless" is a composed budget: core tile-query p95 plus browser frame p95
must fit inside a 33 ms (30 fps) interaction budget, with no stall over
250 ms.

## Architecture

Two automated layers and a manual acceptance layer share one deterministic
corpus; the automated layers share one report format.

- **Core layer (gates).** `core/scope-core/src/benchmarks/` becomes a module
  with one `#[ignore = "release benchmark"]` test per scenario, discovered by
  the existing `./scripts/test.sh bench` filter (`bench_`). Scenarios time
  public `scope-core` APIs only: `BatchJobs` ingest, sidecar-cache reopen,
  `Pyramid` build, and the store tile-query path. Each asserts a generous
  hard floor — loose enough that only order-of-magnitude regressions fail on
  slow runners — and emits structured JSON.
- **E2E layer (proof).** A Playwright `bench` project drives a `scope-bake`d
  snapshot of the monte-carlo corpus in Chromium and measures time-to-first-
  plot and pan/zoom frame timing. Loose floors, rich report.
- **Manual layer (acceptance).** The definitive acceptance run is the real
  workflow: `./scripts/run.sh native`, import the generated `mc1000` corpus
  through the ordinary file dialogs, and pan/zoom multiple signals per
  panel. The corpus is generatable standalone (`./scripts/test.sh bench
corpus`) so this run needs nothing but the app. A short checklist in this
  spec mirrors the automated thresholds; the automated layers exist because
  manual runs are not repeatable evidence, but the manual run has the final
  word on "seamless".
- **Corpus generator.** A test-only Rust module in `scope-core` writes
  seeded, byte-stable CSVs into `build/bench/corpus/<tier>/`, keyed by a
  params-hash manifest: repeat runs reuse the corpus, parameter changes
  regenerate it. Standalone generation runs through the same ignored-test
  filter (`bench_corpus_`) so no new binary is needed. Generation time is
  reported but excluded from scenario timings. Corpus files are never
  checked in.

No stored baselines. Floors catch catastrophic regressions; humans track the
reported numbers over time.

## Corpus tiers

- **Tier A `mc1000`.** 1000 CSVs, each 10,001 rows (0–1000 s at 10 Hz) with
  5 value channels sharing names across runs (`command`, `response`,
  `temperature`, `pressure`, `vibration`) and seeded per-run parameter
  variation. About 5% of runs carry a NaN dropout window so gap bits are
  exercised at scale. ≈1.1 MB per file, ≈1.1 GB total, 50M values.
- **Tier B `wide100m`.** One CSV, 12.5M rows × 8 channels = 100M values
  (≈2 GB text) with embedded NaN gaps. Covers cold multi-GB first plot and
  100M-point pan/zoom.
- **Tier S `mc-smoke`.** A 10-file miniature of Tier A. The bench code paths
  run against it inside the ordinary PR suites so the harness cannot rot
  between scheduled full runs.

## Core scenarios

Each emits one JSON object (name, metrics, floor, pass). Targets are the
expected numbers; floors are 2–3× looser.

| Scenario                | Measures                                                                                                                                                                                      | Target / floor                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `bench_mc_cold_open`    | Cold batch-ingest of all 1000 files (fresh cache dir; decode → pyramid → sidecar → commit) plus first-window tile queries for a multi-source panel                                            | ≤30 s / 60 s                    |
| `bench_mc_warm_reopen`  | Same corpus with sidecar caches present; asserts decode is skipped                                                                                                                            | ≤5 s / 15 s                     |
| `bench_huge_cold_build` | Tier B ingest and pyramid build throughput                                                                                                                                                    | ≥5M samples/s / 2M              |
| `bench_tile_latency`    | Scripted pan/zoom access pattern over both tiers (zoom ladder across levels, pans at each level, multi-series queries) under a constrained resident budget so out-of-core paging is exercised | p95 ≤10 ms / 20 ms; p99 / 50 ms |
| `bench_nan_gap_scale`   | Gap-bit propagation and finite-extrema invariants over the generated corpus's full pyramid                                                                                                    | correctness only                |

The two existing benches (bytes-per-sample compaction floor, 1000-file batch
throughput floor) remain unchanged.

## E2E monte-carlo scenario

- **Bench workspace fixture.** A checked-in workspace file defines the
  acceptance layout: a time panel with one shared channel bound across all
  1000 sources, plus a second panel with 2–3 more channels.
- **Bake.** `./scripts/export.sh --data <1000 files> --workspace <fixture>
--fidelity high --out build/bench/mc1000.html`. Bake wall time is reported
  without a floor (export path, not open path). If `high` exceeds the
  ADR 0024 snapshot size budget the bench drops to `standard`; the fidelity
  used is recorded in the report. If every fidelity exceeds the budget the
  bench fails explicitly rather than measuring a truncated corpus.
- **Playwright `bench` project.** A new project in `playwright.config.ts`,
  excluded from `./scripts/test.sh e2e`. It loads the snapshot and measures
  via in-page `performance.now()`/rAF instrumentation:
  - time-to-first-plot: navigation to first painted series stroke, floor
    10 s (render half of cold open; the ingest half is core-side);
  - interaction frame timing during scripted wheel-zoom ladder, drag pans,
    box zoom, and fit on the ensemble panel: frame-interval p95 floor 33 ms,
    longest stall floor 250 ms;
  - PerformanceObserver long-task counts, reported without a floor.
- **Smoke.** The same spec parameterized to Tier S runs in the regular e2e
  suite.

## Reporting and wiring

- Benches write per-scenario JSON files into `build/bench/report/`;
  `test.sh bench` assembles `build/bench/report.json` with a small `.mjs`
  collector.
- `./scripts/test.sh bench [corpus|core|e2e|all]`, default `all`: corpus
  generation → core benches → bake → Playwright bench → report. `bench
core` preserves today's fast path; `bench corpus` only generates the
  tiers, for manual native sessions.
- A new `./scripts/ci.sh bench` gate and a `bench.yml` workflow
  (`workflow_dispatch` plus weekly schedule) run the suite off the PR path
  and upload `report.json` as an artifact. PR CI is unchanged.
- ADR 0035 records the harness architecture, the floors-plus-report policy,
  and the composed 33 ms interaction budget. The roadmap Phase 5 section is
  updated when the work lands.

## Manual native acceptance checklist

Run after the automated suite passes, on the machine the workflow actually
targets:

1. `./scripts/test.sh bench corpus` (reuses the cached corpus when present).
2. `./scripts/run.sh native`; import `build/bench/corpus/mc1000/` through
   the ordinary import path (folder scan or multi-select dialog).
3. First plot of a shared channel across all 1000 sources appears within
   ~30 s of starting the import, with visible progress throughout.
4. Reopen the same corpus in a fresh session: first plot within ~5 s.
5. With one ensemble panel (one shared channel, 1000 sources) and a second
   panel holding 2–3 more channels: wheel zoom, drag pan, box zoom, and fit
   feel continuous — no visible hitching, no stroke dropouts, cursor
   readouts stay live.
6. Zoom into a NaN dropout window: strokes break at the gap and rejoin;
   extrema at coarse zoom match what fine zoom reveals.

Any failure here is a finding the automated suite missed; file it and add a
covering scenario before fixing.

## Error handling and testing

- The corpus generator is unit-tested for determinism (byte-stable digest),
  row and channel counts, and NaN-window placement. Generation failure
  aborts the suite before any timing runs.
- A failing floor prints the offending JSON line with target versus actual;
  no partial reports.
- The smoke tier keeps generator, bake, and bench-spec code paths green in
  PR CI without paying multi-GB costs.

## Out of scope

Corrupt-input hardening, accessibility invariants, release-bundle and
artifact-size regression gates, live streaming, and any new data-plane
transport (the e2e layer measures the baked plane; native IPC latency is
represented by the core tile-latency scenario).

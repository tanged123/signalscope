# Benchmark harness and performance floors

Status: accepted

## Context

Phase 5 needs repeatable performance evidence for the 1000-run Monte Carlo
workflow, multi-gigabyte single files, and cache reuse. CI machines vary too
much for tight thresholds to be useful as absolute targets.

## Decision

SignalScope uses two automated benchmark layers over one deterministic corpus.
The corpus is generated under `build/bench/` and is never committed. Ignored
release-profile core tests cover ingest, cache reopen, pyramid construction,
tile latency, and NaN-gap invariants. Each scenario has a deliberately loose
hard threshold and writes one JSON report.

A Playwright `bench` project measures first-plot and frame timing on a bounded
two-run preview slice of the generated Monte Carlo snapshot. The core suite
remains the 1,000-run ingest and cache workload; the browser slice keeps the
snapshot baker's retained pyramids and serialized HTML within ordinary
developer and CI memory budgets while still exercising a two-series ensemble.
The checked-in `examples/monte_carlo` corpus is the smoke tier used by
pull-request e2e tests. A scheduled, non-blocking `bench.yml` workflow runs the
full suite and uploads both `build/bench/report.json` and the per-scenario
files under `build/bench/report/`; report aggregation also runs during failure
cleanup so a failed floor remains diagnosable. The manual native workflow
remains the acceptance authority; its checklist is recorded in the Phase 5
benchmark specification.

The composed interaction budget is a core tile-refresh p95 maximum of 20 ms
plus a browser frame p95 maximum of 33 ms inside a 30 fps budget. Stalls over
250 ms fail the browser scenario.

## Consequences

The thresholds are intentionally loose and catch order-of-magnitude
regressions; trend watching happens through the reports. Corpus generation costs about
3.5 GB under `build/`. The e2e layer measures the baked plane, so native IPC
latency is represented only by the core tile scenario.

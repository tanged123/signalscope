# ADR 0029: Out-of-core columns, pyramids, and ensembles

- Status: Accepted
- Date: 2026-07-30

## Context

Raw columns cost 8–16 bytes per sample, while the original wire-shaped pyramid
cost about 120. Large source sets therefore exceed resident memory before
rendering becomes expensive.

## Decision

Compact before paging. Pyramid storage uses struct-of-arrays `BinLevel` values
with NaN sentinels, flags, and `u32` counts; protocol `EnvelopeBin` remains the
wire type. Levels 0–2 are synthesized per bounded query. Stored levels begin at 3.

Sidecar v4 stores shared time sections, value sections, and independently
checksummed, aligned bin levels. Columns and fine levels are page-backed;
levels with at most 32 bins stay resident. The app-owned cache root from ADR
0023 is the required fallback and owns derived spills and ensemble
materializations.

Pages use positioned reads, not `mmap`. Workspace policy forbids `unsafe`,
truncation must return an error instead of risking `SIGBUS`, and mapped files
cannot be deleted reliably on Windows. Leases prevent live eviction. Admission
fails when leases hold capacity.

Full-set ensemble levels are built independently from aligned per-run data.
They are keyed by set key, exact generation, and cache ABI. Filtered queries
use the bounded query-time path; stale generations are rejected. Ensemble
children are never merged because they no longer retain run identity.

The release benchmark harness measured:

- 18.251 stored bin bytes per raw sample at cutoff 3
- 683.5 synthetic CSV runs/s over 1,000 files
- 51.558 ms query-time latency at 64 members
- 0.011 ms mean materialized-query latency over 1,000 queries at 1,000 members

The enforced floors are 20 bytes/sample, 10 runs/s, and 250 ms for each query.

## Consequences

Cache hits no longer load complete sidecars into memory. Fine data competes
within a leased LRU budget, while coarse navigation stays resident. Cache and
materialization formats remain internal, versioned APIs; protocol payloads are
unchanged.

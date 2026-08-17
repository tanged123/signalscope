# Full-resolution rendering baseline

- Date: 2026-08-16
- Status: Approved

## Decision

SignalScope will present full-resolution source samples in every live panel.
Display width, series count, and memory budgets must not select coarser
pyramid levels or stride across samples. Operations that exceed available
resources fail visibly; they do not silently fall back to reduced data.

This establishes correctness at native resolution before further performance
work. Histogram bins and FFT output remain mathematical products of their
inputs, but both consume every source sample in their selected window. The
FFT's artificial 16,384-sample ceiling is removed.

## Data flow

Time panels keep the existing binary tile transport for the first pass, but
queries always materialize logical pyramid level zero for the requested
window. Level-zero bins are exact source samples. The ChartGPU feed emits one
point for each singleton level-zero bin instead of expanding its identical
first, minimum, maximum, and last fields into four vertices.

XY, FFT, and histogram panels keep the sample transport. Sample queries return
the complete window with one neighbour on each edge and `stride = 1`; frontend
per-mode, per-series, and per-panel point budgets are removed. XY continues to
request its full trajectory extent because out-of-window trajectory dimming is
part of its interaction contract.

Live sample requests use `max_points = 0` to select this uncapped behavior.
Positive `max_points` values remain reserved for explicit CSV export fidelity
and retain the existing bounded, strided response.

`HttpPlane` and `BakedPlane` apply the same full-resolution rendering
semantics when their available data contains level zero. Window caches and
padded-window request reuse remain because they avoid repeated I/O without
reducing samples.

## Export

Export is an explicit user operation and retains its independent fidelity
controls. HTML snapshots and CSV exports continue to offer preview, standard,
high, and full fidelity alongside visible and all-loaded range choices. Full
fidelity selects level zero; reduced export fidelity occurs only when the user
chooses it and never changes live rendering resolution.

Existing export estimates, warnings, and size budgets remain unchanged.

## Transitional architecture

The ingest pyramid and its coarse cached levels remain in this change to keep
the first implementation focused and reversible. Coarse levels have no live
workbench presentation consumer after this change; explicit reduced-fidelity
snapshots continue to consume the level chosen during export. A later measured
cleanup may replace the redundant live level-zero envelope transport with a
compact binary raw-sample format.

The implementation adds an ADR that supersedes the live presentation
reduction decisions in ADRs 0036, 0037, and the density-preservation portion
of ADR 0039. ADRs 0024 and 0025 remain authoritative for explicit exports. The
underlying gap, exact identifier, transport-version, and host-parity
invariants remain unchanged.

## Failure behavior

Allocation, transport, ChartGPU, and transform failures are reported through
the existing error surfaces. Live rendering must not catch these failures and
retry with reduced data. Explicit export behavior retains its existing
user-selected fidelity and size handling.

## Verification

Tests prove that:

- time queries return level zero regardless of viewport width or total-bin
  budget;
- level-zero ChartGPU feeds contain one vertex per source sample and retain
  NaN gap breaks;
- native and baked sample queries return every in-window sample with stride
  one;
- XY, FFT, and histogram receive uncapped source responses;
- FFT input is not limited to 16,384 samples;
- snapshot and CSV fidelity choices remain explicit and independent of live
  rendering;
- the live and baked planes remain behaviorally aligned.

The completed change runs focused Rust and frontend suites, formatting, the
cross-layer quality gate, and the full benchmark/e2e gate. Resource exhaustion
while live-rendering the raw mc1000 or wide100m scenarios is recorded as a
result rather than hidden by LOD.

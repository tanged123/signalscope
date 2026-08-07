# ADR 0039: Time-series-only identity-preserving WebGPU renderer

- Status: Accepted
- Date: 2026-08-07
- Supersedes: ADR 0017, ADR 0018, ADR 0019, ADR 0037, and ADR 0038; amends the render-path portion of ADR 0036

## Decision

SignalScope v1 plots time series only. XY, FFT, histogram, the generic mode
registry, and their session fields are removed without migration.

Every visible series is represented at every LOD. A pyramid level may reduce
samples within a series, but no panel-wide budget, aggregate density field,
band, merged geometry, or cardinality cutoff may remove or combine series.

Series rendering requires WebGPU. Rust remains the owner of out-of-core
storage and ordered extrema-preserving LOD. ChartGPU is an MIT-licensed
reference for device lifetime, packed coordinates, GPU-resident buffers, and
line shaders; it is not a runtime dependency or chart backend.

Visible tiles arrive in two generation-safe passes: a coarse request for every
visible series, followed by chunked fine requests. Fine residency is swapped
atomically; a budget failure keeps the complete coarse generation. Pan within a
padded resident window changes only the viewport. GPU line pages and descriptor
directories are shared by plot rendering and asynchronous nearest-series
picking, while axes and annotations remain Canvas2D overlays. Hover never
scans vertices or waits for a mapped buffer.

## Consequences

Sessions older than the new schema are rejected. Hosts without the required
WebGPU capabilities show an unsupported-host screen. Exact sample queries
remain available for CSV export, while ordinary plotting consumes bounded
pyramid tiles. The software-adapter proof runs through `./scripts/test.sh gpu`;
the `mc1000` and `dense10k` benchmark tiers report coarse-first plot,
refinement, upload, residency, frame, pick, and recovery floors.

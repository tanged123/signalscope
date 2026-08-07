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

## Consequences

Sessions older than the new schema are rejected. Hosts without the required
WebGPU capabilities show an unsupported-host screen. Exact sample queries
remain available for CSV export, while ordinary plotting consumes bounded
pyramid tiles.

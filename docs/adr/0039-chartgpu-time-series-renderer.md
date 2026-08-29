# ADR 0039: ChartGPU time-series renderer

- Status: Accepted
- Date: 2026-08-12

## Context

The Canvas2D time stroke path was the dominant cost in large multi-series
panels. The Phase 0 ChartGPU spike passed all nine gates, including the
binding capture recipe, while preserving the tile-pyramid density contract.
The result is recorded in
[`chartgpu-spike-results.md`](../superpowers/specs/2026-08-12-chartgpu-spike-results.md).

## Decision

Time-series panels render through ChartGPU at pinned revision
`671e1c157a6fd9a80df35d5b43795314214569d0`, vendored under
`frontend/vendor/chartgpu/` and bundled into the offline frontend. The
renderer consumes the existing columnar tile response, emits M4 points in
the established `first → min → max → last` order, inserts NaN gap vertices,
and rebases time by a per-response `tRef` for float32 safety. A shared
WebGPU device, pipeline cache, and external render loop serve all panel
instances.

ChartHost owns the ChartGPU instance and publishes the existing `PlotLayout`
contract with raw-time ranges and CSS-pixel plot geometry. View changes update
both axis bounds without refeeding series. The tile pipeline remains the
source of density-bounded data and `plot-hit` keeps its vertex-order
contract. PNG capture forces a fresh option object, calls `renderFrame()` in
the same animation frame, then composites every ChartGPU canvas in DOM order.

The renderer scope is deliberately time-only. XY, FFT, and histogram panels
remain on Canvas2D because their vertex and colorbar behavior is separate
from the tile envelope path. No protocol or session schema changes are
required.

There is no fork today. A scoped fork becomes justified only if windowed
refeeds miss the measured budget and ChartGPU's `setSeriesData` path is
needed, or if native dash support is required. Until then, the known
regression is that dashed time-series styles render solid. WebGPU is required
for time-series panels, including when viewing an exported snapshot.

## Consequences

The old Canvas2D time-stroke, path cache, and high-cardinality batching are
removed. The ChartGPU source and its pipeline are part of the frontend build,
so the snapshot budget increases once and the build inlines dynamic vendor
branches to keep the artifact self-contained. Unit tests mock ChartGPU;
Playwright launches Chromium with the SwiftShader WebGPU adapter for the
real render path.

This amends the render-path portion of ADR 0036. Its tile budget, gap bits,
finite extrema, and binary transport decisions remain authoritative.

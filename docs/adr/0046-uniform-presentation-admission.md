# ADR 0046: Uniform presentation admission

- Status: Accepted
- Date: 2026-08-29
- Amends: ADR 0044

## Context

The 3,000-visible-series check rejected an active layout solely from its series
count. It ignored physical panel width and the amount of CPU and GPU
presentation data requested for each series. Raising the constant merely moved
the failure into the browser or driver.

## Decision

Active layouts have no fixed series-count admission limit. Before querying
tiles, SignalScope plans one uniform bins-per-physical-pixel density across all
active panels. The preferred density is two. Conservative CPU and GPU byte
estimates derive from the browser's reported device memory and the WebGPU
adapter's maximum buffer size, with bounded fallback budgets when either value
is unavailable. Retained inactive-panel tile banks count against both estimates.

When the preferred density exceeds either budget, every panel is reduced by the
same factor. The status bar reports the effective density. SignalScope never
claims to know free VRAM: WebGPU does not expose it, and driver-private memory
is outside the estimate. If even the minimum request cannot fit, the request
continues at that minimum and the status reports the constraint instead of
silently dropping series.

The existing 3,000-series least-recently-used threshold remains only an
inactive-tab ChartGPU host retention policy. It does not reject or truncate the
active layout.

## Consequences

Layouts above 3,000 series can render. Ordinary layouts retain the preferred
two-bin density, while resource-heavy layouts degrade uniformly and visibly.
Zoom refinement still reaches level zero when the visible raw slice fits the
planned density. Exact free-memory pressure can still cause a WebGPU allocation
failure, which remains covered by ADR 0044's explicit device-failure handling.

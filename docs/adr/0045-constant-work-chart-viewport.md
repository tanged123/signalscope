# ADR 0045: Constant-work ChartGPU viewport updates

- Status: Accepted
- Date: 2026-08-29
- Amends: ADRs 0039 and 0040

## Context

ChartGPU's `setOption` resolves series and synchronizes renderer state. Using it
for pan, zoom, fit-to-all, or linked-time updates therefore made interaction
cost grow with the number of resident series. Publishing a replacement as a
sequence of larger series prefixes was worse: every prefix rebuilt work already
completed by the previous prefix and competed with pointer input.

## Decision

SignalScope pins the public `tanged123/ChartGPU` fork at revision
`fb788fad8664652a3c16c6711a4366cef1ac13c4`. The fork exposes
`setViewRange`, which updates resolved x and primary-y domains, invalidates only
axis and scale state, and requests a frame without resolving or traversing
resident series.

ChartHost uses one `setOption` call when tile data, series identity, or styling
changes. Pan, zoom, fit-to-all, linked-time, and resize-driven range changes use
`setViewRange`; they never progressively republish series. SignalScope retains
the existing panel-wide asynchronous tile preparation and atomic response swap
from ADR 0044.

## Consequences

Viewport interaction cost no longer scales with series count on the JavaScript
control path. A genuine data replacement can still take time, but it cannot
continue rebuilding increasingly large prefixes behind an active gesture. The
fork is now a required source dependency; upstream ChartGPU remains the source
for future merges.

## Amendment (2026-09-03)

The parent repository's `frontend/vendor/chartgpu` gitlink and checked-out
submodule identify `fb788fad8664652a3c16c6711a4366cef1ac13c4` as the required
fork revision (`fix(render): compile dash shader on WebGPU`). The previous
`9f4b3b06047cb99c743d22e83653b23a526a087a` pin was stale and is corrected here.
ADR 0052 keeps this host contract behind the SignalScope-owned typed
render-family boundary.

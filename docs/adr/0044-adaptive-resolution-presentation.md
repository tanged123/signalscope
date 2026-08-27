# ADR 0044: Adaptive-resolution presentation

- Status: Accepted
- Date: 2026-08-27
- Amends: ADRs 0036 and 0041

## Context

The full-resolution presentation baseline established native samples as the
correctness endpoint, but sending them for every viewport made ordinary
overview rendering depend on source size. A fixed total-bin split could also
give panels unequal density and turn resource pressure into invisible
degradation.

## Decision

Live time panels query the pyramid against physical device-pixel width. The
server refines an envelope while its projected bin width exceeds one device
pixel, targeting two bins per pixel where available, and reaches level zero
when the visible raw slice fits the viewport. Invalid or unavailable
resolution data fails clearly; it does not silently select a less accurate
fallback.

Panel refinement is asynchronous and panel-wide. A newer generation keeps the
current drawable response visible while its replacement is pending, then
prewarms every replacement and swaps the panel maps atomically. The cache
classifies entries as current, stale, or missing using response identity,
coverage, visible density, and projected bin width.

The live presentation path has no fixed total-bin split. Workspace tabs retain
their panel views under a 3,000-visible-series least-recently-used ceiling;
the active layout is never evicted. Shared WebGPU device loss releases chart
hosts, stops rendering, and presents an explicit reload action. Uncaptured GPU
errors are reported without disabling a healthy device.

`HttpPlane` and `BakedPlane` retain the same host-neutral `DataPlane` contract,
wire protocol, session schema, export fidelity controls, and offline snapshot
requirements. This changes only live presentation resolution selection;
level-zero data remains the full-resolution zoom endpoint and export behavior
is unchanged.

## Consequences

Overview queries transfer only the envelope density needed by the display,
while zooming preserves visible extrema and eventually shows exact samples.
Refinement can be briefly stale during a gesture, but the old response remains
drawable and the replacement cannot partially publish. Resource limits and
device failures are visible to the user instead of producing unequal or
invisible degradation. ADR 0036 continues to govern binary transport and
pyramid invariants, and ADR 0041 remains the source of the full-resolution
correctness endpoint as amended here.

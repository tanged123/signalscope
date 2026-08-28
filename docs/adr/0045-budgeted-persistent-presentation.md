# ADR 0045: Budgeted persistent presentation

- Status: Accepted
- Date: 2026-08-28
- Amends: ADR 0044
- Supersedes: ADR 0044's cache and residency policy

## Context

The fixed 3,000-visible-series residency ceiling conflated active-layout
admission with inactive-tab retention. It did not account for panel width,
prepared feed size, or the GPU capacity actually allocated by ChartGPU.
Replacing an overview with a zoomed detail also discarded the data needed for
an immediate fit-to-all view.

## Decision

Live presentation uses separate SignalScope-managed CPU and GPU soft budgets.
Auto budgets derive conservative ceilings from device memory and the acquired
WebGPU adapter's `maxBufferSize`; explicit positive byte preferences override
those ceilings without exceeding device hard limits. The budgets describe only
presentation data and make no claim about total or free system RAM or VRAM.

One bins-per-physical-pixel density is planned for the complete active layout.
The preferred density is two, and the planner lowers it uniformly when the
worst-case CPU or GPU estimate does not fit. Resolution can rise after a
250-millisecond stable period. There is no fixed series-count admission check.

Each panel retains byte-accounted prepared CPU overview and detail banks. The
active overview and selected bank are pinned. Active panels may lazily retain
matching overview and detail ChartGPU hosts, and fit-to-all selects a resident
overview synchronously. CPU and GPU eviction uses the fixed inactive-detail,
inactive-overview, superseded-detail, and then inactive-CPU order before
lowering active density. Bank publication remains generation-safe and atomic.

## Consequences

Deep zoom can refine to level-zero samples while a complete overview remains
available without another query when retained. Managed presentation usage is
observable and can be reduced by hiding signals, closing inactive tabs, or
raising an advanced budget preference. Allocation failures preserve the last
drawable bank and report the limiting managed resource.

The tile protocol, pyramid extrema and gap semantics, session schema, and
explicit export fidelity remain unchanged. ADR 0044's level-zero endpoint and
snapshot/export decisions remain accepted. WebGPU hard limits still bound each
allocation, while driver-private and pipeline memory remain outside the
managed ledger.

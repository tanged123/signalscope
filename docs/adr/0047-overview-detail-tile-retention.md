# ADR 0047: Overview/detail tile retention

- Status: Accepted
- Date: 2026-08-29
- Amends: ADRs 0044 and 0046

## Context

Keeping one tile response per panel makes deep refinement overwrite the wider
overview. A rapid zoom-out must then wait for a wider query, feed preparation,
and GPU publication before the newly exposed range has drawable data.

## Decision

Each panel retains at most two CPU tile responses for its current signal set:
the widest overview and the latest narrower detail. A viewport change
immediately publishes the narrowest retained response that covers the new
window. The existing debounced, generation-safe refresh then obtains any
needed refinement and replaces the panel data atomically.

Both retained responses count against the presentation budget. Inactive-panel
eviction continues to remove the whole panel cache. Signal-set changes replace
both entries rather than reusing incompatible data.

SignalScope retains one ChartGPU host per active panel. It does not keep a
second GPU plot or progressively publish individual series.

## Consequences

Zooming out after deep refinement can draw the retained overview without
waiting for transport or feed preparation. A single GPU data replacement may
still be needed when the overview is not already active. A viewport outside
both retained windows still waits for a new query. CPU use increases by at
most one bounded response per retained panel and remains visible to admission
planning.

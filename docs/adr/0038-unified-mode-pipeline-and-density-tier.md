# ADR 0038: Unified mode pipeline and density tier

- Status: Accepted
- Date: 2026-08-06
- Amends: ADR 0036's render-path section; the wire format is unchanged.

## Context

The four plot modes had separate acquisition and rendering paths. That made
request budgets, response preparation, and per-frame geometry easy to
diverge, and made adding another mode touch unrelated shell and panel code.
The approved design in
`docs/superpowers/specs/2026-08-06-unified-renderer-design.md` defines one
mode contract and a density tier for the budget-bound envelope case.

A 1000-series ghost panel exposed the remaining failure mode: 250 bins per
series over a 1415 px plot produced a measured 9 px vertical comb. The
individual strokes no longer represented the visual density of the data.

## Decision

Every plot mode implements the four-stage module contract
`{ data, configKey, prepare, project }` in `frontend/src/ui/modes/`. The shell
acquires data from the declared `ModeDataSpec`; `prepare` is response-scoped
and framework-cached; and `project` is the only mode code that runs per frame.
The renderer remains mode-blind and keeps its envelope and vertex-path entry
points.

Envelope panels use an aggregate density tier when the per-series allocation
falls below one bin per two device pixels:

```text
max(64, floor(TILE_BIN_BUDGET / N)) < deviceWidth / 2
```

The renderer accumulates ghost-styled, non-emphasized series as connected
envelope trapezoids in a device-pixel coverage grid. Gaps interrupt the
connection. Coverage maps to straight-alpha pixels using
`1 - (1 - a_pt)^k`; an offscreen Canvas2D surface is blitted below the
remaining focused, hued, or emphasized strokes. The raster is deterministic
from the response, viewport, and palette, and uses the same document canvas
factory as snapshot export, so it is snapshot-safe.

## Consequences

The comb artifact class is closed for the measured case: 157 bins over
1415 px predicted a 9 px pitch, matching the 2026-08-06 pixel-level
measurement. A fifth mode is one module plus one registry entry. Per-series
hit-testing is unchanged because the raster is display-only. Canvas2D work is
bounded by the plot area; a future GPU backend can replace the blit without
changing the upstream mode or acquisition stages.

The density tier intentionally changes only starved envelope panels.
Unstarved panels keep their stroke representation, while XY, FFT, and
histogram vertex paths are unchanged in this phase.

## Rejected

Scaling the tile budget with `N` grows wire and stroke cost linearly and leaves
the crowd visually muddy. Marginal bounding-box rendering for starved XY
envelopes draws area the trajectory never visited, for the same reason that
ADR 0037 rejects per-signal min/max reduction for trajectory semantics.

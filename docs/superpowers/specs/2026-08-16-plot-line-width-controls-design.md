# Plot Line Width Controls Design

## Goal

Give plot strokes the same global increase, decrease, and reset affordances as
plot fonts without replacing per-series style overrides.

## Decision

Add a global `plot_line_width_scale` appearance preference. It defaults to 1,
steps by 0.25, and clamps to 0.5-2. Settings display it as a percentage. The
command palette exposes increase, decrease, and reset commands; the Settings
palette supports its existing click and left/right adjustment behavior.

The scale multiplies the final series stroke width. Canvas renderers multiply
semantic and dimmed-path widths directly. ChartGPU first applies its normal or
ghost visibility compensation and emphasis increment, then multiplies that
result. Therefore one adjustment always changes the visible ChartGPU stroke,
while per-series width relationships remain intact. Axes, grids, annotations,
and other chrome strokes do not scale.

## Persistence and compatibility

Preferences schema 5 adds the field. Versions 1-4 migrate to scale 1, malformed
or out-of-range values are repaired, and snapshots without a preferences port
use the same default. The setting is not workspace/session state.

## Alternatives rejected

An absolute global width would flatten per-series overrides. A panel-local
control would conflict with plot font sizing and turn an appearance preference
into serialized analytical state. Scaling semantic widths before ChartGPU's
minimum would make some adjustments visually inert.

## Verification

TypeScript and Rust tests cover defaults, migration, repair, and the generated
conformance fixture. Renderer tests cover Canvas2D and ChartGPU scaling. UI
tests cover Settings adjustment, and Playwright covers the command path at the
end of the implementation plan.

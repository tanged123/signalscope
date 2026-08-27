# Plot Line Width Baseline Design

## Decision

The current 200% plot-line appearance becomes the new 100% baseline. The
global control remains 50–200% in 25% steps, so users can still make lines
thinner or thicker relative to the new baseline.

## Rendering

ChartGPU and Canvas2D multiply their final series stroke widths by a fixed 2×
baseline before applying `plot_line_width_scale`. At the new default scale of
`1`, every series therefore matches its former appearance at scale `2`.
Per-series width overrides and emphasis remain relative. Axes, grid lines,
markers, and other plot chrome do not change.

## Preferences

Preferences schema 6 keeps `plot_line_width_scale` with default `1`, bounds
`0.5` through `2`, and step `0.25`. Loading any schema 1–5 document resets the
field to `1`, including schema 5 documents that saved another value. Schema 6
documents preserve and repair their saved value normally. This intentionally
resets every existing user to the new 100% default once.

## Interface

Settings continues to show the stored scale as a percentage, so the default
reads `100%`. Increase, decrease, and reset commands retain their current
names and behavior.

## Verification

Tests cover the new default, the schema-5 reset, schema-6 preservation, the
doubled ChartGPU and Canvas2D output widths, the 100% Settings label, and the
existing increase/decrease/reset controls. Generated preference bindings and
the conformance fixture remain synchronized.

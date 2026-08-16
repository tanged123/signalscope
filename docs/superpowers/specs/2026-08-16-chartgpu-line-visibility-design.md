# ChartGPU Line Visibility Design

## Goal

Make ordinary and ghost time-series strokes readable in ChartGPU without
changing SignalScope's semantic styles, palette, Canvas2D renderers, or pinned
ChartGPU vendor code.

## Design

`ChartHost` translates semantic `SeriesStroke.width` values to ChartGPU widths.
It floors colored strokes at 2 CSS pixels and ghost strokes at 1.5 CSS pixels,
then adds the existing 0.4-pixel emphasis increment. Explicit widths above the
floor remain unchanged. Color and opacity behavior remain unchanged.

This adapter-only compensation accounts for ChartGPU's anti-alias coverage,
which makes the existing 1-1.4-pixel strokes appear substantially fainter than
the same values in Canvas2D. The vendored shader remains untouched.

## Verification

A ChartHost unit test covers normal, ghost, explicit wide, and emphasized
strokes. The frontend unit suite and formatter remain green. Visual confirmation
on Windows Chrome remains a manual follow-up because WSL2 has no WebGPU.

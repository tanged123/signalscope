# ADR 0063: Logarithmic X, Y and color scales

- Status: Accepted
- Date: 2026-09-09
- Amends: [0057](0057-continuous-line-color-axis.md) and [0060](0060-equal-axis-scale.md).

## Context

Users need logarithmic axes in the existing Limits editor, including continuous
color. Scaling must preserve source-time queries, saved limits, readouts, and
the shared live/offline presentation plane.

## Decision

The session owns optional `x_scale`, `y_scale`, and `color_axis.scale` fields.
Absent/null means linear; `log` means base 10. This is additive in session
schema 32. Rust and baked-session parsers reject unknown scale names and fixed
log limits that are non-positive, non-finite, or unordered. Limits are always
serialized in original units. Linked time retains its original coordinates.

The Limits editor validates one draft before publication. Changing scale
invalidates feed/style identity without changing data bindings or requesting
new transport data. Non-positive X/Y values create gaps; non-positive C values
use the neutral stroke treatment. Automatic log extents use positive values
from the available decimated presentation data. An empty positive domain shows
an empty plot with a 1–10 fallback; it never resurrects previously plotted data.
Time windows crossing zero display their positive portion. Choosing log for a
non-positive fixed draft switches that axis to automatic, visibly in the editor.

The existing adapters transform coordinates in double precision before packing
the immutable float32 feed. X retains an origin in display coordinates, keeping
small differences around large values. ChartHost uses these coordinates for its
value axes and converts ticks back to original units. PlotLayout retains raw
ranges and scale metadata; plot-math owns projection, inversion, pan and zoom.
Viewport-only changes continue to use setViewRange. Feed caches include scale
and retain one current descriptor per immutable input, with weak-key cleanup.

Color domain and attribute caches include scale. Colorbar interpolation uses
the same logarithmic normalization and retains its existing lifetime/export
path. No host-specific behavior or network dependency is added.

Axis equal compares original units per pixel and is disabled whenever X or Y
is logarithmic. C scaling does not affect that option.

The existing panel composition remains oversized. This change extracts its
saved/automatic/linked range policy into `ui/panel-ranges.ts`, with narrow state,
prepared-plot and YAxisPolicy inputs. The only remaining panel/workspace edits
are typed delegation and default-field wiring. App-shell keyboard navigation
also delegates to the existing scale math using the panel's displayed range.
These are an explicit limited composition
exception under ADR 0054. It does not exempt future behavior. Session tests
move to their own module before expanding parser behavior.

## Alternatives and tradeoffs

ChartGPU offers native logarithmic axes, but passing unshifted float32 X values
would lose small differences around large offsets. Transforming before packing
preserves the existing origin strategy and gives GPU and interaction math one
coordinate system. Ticks use the renderer's nice display-coordinate intervals,
which can include subdivisions of a decade.

Positive extents reflect selected tiles, not a new raw-data scan. M4 bins do not
retain the smallest positive interior sample when an extremum is negative;
log views therefore inherit the existing decimation approximation.

## Validation and implementation status

Implemented with focused tests for positive extents, geometric spacing, gaps,
original-value picking, cache replacement, range-only publication, atomic limits,
and restore. Shared parser cases cover Rust and TypeScript rejection semantics.
The browser XY test exercises all scales, autosave, and offline export. CI owns
the broad frontend, Rust, and browser validation; results are reported on the PR.

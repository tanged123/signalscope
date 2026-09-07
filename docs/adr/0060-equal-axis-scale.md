# ADR 0060: Equal axis scale

- Status: Accepted
- Date: 2026-09-07
- Amends: [ADR 0052](0052-typed-plot-families-and-explicit-x-line2d.md) (Cartesian viewport),
  [ADR 0005](0005-session-schema-versioning.md) (additive panel state).

## Context

XY geometry is distorted when one unit on X occupies a different number of
pixels from one unit on Y. The limits dialog needs a per-panel equal-scale
checkbox that survives session and offline snapshot restore.

## Decision

The generated session panel owns optional `axis_equal`; absent or null means
off. This is additive within the current session version. Old readers ignore
the field; current readers reject non-boolean values. No migration or tile
contract change is needed. The existing limits action publishes the flag with
the validated ranges and labels through history, autosave and panel refresh.

ChartHost owns the display invariant: X and Y have equal data units per pixel
inside the actual plot rectangle, after gutter or inline margins. It expands
the smaller span symmetrically, preserving the requested bounds and centers.
The requested ranges remain separate from adjusted display ranges so resizing
does not accumulate padding. Disabling restores the independent ranges.
The render request carries the flag; the published layout carries adjusted
ranges for picking, annotations and gestures. PNG capture uses the same view.

Wheel zoom scales both axes about the pointer. Axis-constrained box zoom scales
the other axis about its center. Equal-axis zooms publish both requested ranges
in one ChartHost update, before either can be padded against an old sibling
range. Independent-axis zooms retain their separate updates.
Panning preserves the equal scale. Resize and
range changes use `setViewRange`, preserving series buffers and the existing
shared-frame publication and disposal. No additional resource lifetime exists.
Time-X retains its linked time-window ownership: display padding does not change
the query window or the workspace time filter.

## Alternatives and tradeoffs

A square plot does not ensure equal units when the numeric spans differ.
Shrinking the plot rectangle would preserve exact fixed limits but waste space.
Expanding a range keeps the requested data visible, though displayed endpoints
may extend past fixed limits. The dialog explains this behavior.

## Validation

ChartHost tests compare X/Y units per pixel with gutter and inline axes,
viewport edits, resize round trips and disabling, without series republication.
Interaction tests cover wheel and constrained box zoom. Limits tests cover
apply, cancel and persistence; shared parser cases cover valid and invalid
flags in Rust and TypeScript. The XY browser test covers keyboard selection,
autosave and offline snapshot restore.

## Consequences and implementation status

Implemented for the current Cartesian Line2D renderer. Future nonlinear axes
must define their own equal-scale semantics before reusing this flag.

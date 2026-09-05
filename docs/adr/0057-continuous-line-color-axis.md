# ADR 0057: Continuous line color axis

- Status: Accepted
- Date: 2026-09-05
- Amends: [ADR 0052](0052-typed-plot-families-and-explicit-x-line2d.md),
  [ADR 0056](0056-xy-axis-and-bundle-bindings.md), and the composition-only scope below
  under [ADR 0054](0054-evidence-backed-architecture-guidance.md)

## Context

A trajectory needs to show a third measured quantity along its length. A
categorical series color identifies a trace; it cannot express a changing
measurement. The Final Spec requires a separate C binding and labeled scale.
The initial 64px right gutter compressed plots that already had a legend rail.
The user explicitly requested moving the scale into the legend, including
floating layouts; this supersedes the gutter placement in the visual reference.

## Decision

The session owns an optional panel color axis: a time, signal, or explicit
bundle binding, an optional fixed numeric range, and an optional label.
Unconfigured panels retain categorical styling. One color signal broadcasts;
bundles require exactly one member per Y source, independently of X grouping.
The native reducer requires exact shared timebases. Missing or ambiguous
bindings reject the panel atomically. Compatible units are required across C
members; unit conversion is explicit through derived signals.

`app/line-bindings.ts` resolves X and C into paired request groups. The existing
Line2D contract already returns an aligned table and preserves every requested
column's extrema and gaps. C signals are additional columns in that table;
`app/line-query.ts` assigns their presentation role and removes them from
plotted Y columns. C equal to X or Y reuses the corresponding column. No
independent C query, timestamp join, or separately decimated color samples are
allowed. With time X, a Y signal supplies the table's timebase and the returned
anchor supplies the displayed X coordinate. C=time uses that same anchor.
This reuses the existing binary and baked table semantics without a wire change.

The scale is shared across all visible traces in the panel. Automatic limits
use retained finite C samples in the active source-time window; padded
prefetch rows do not affect limits. X/Y viewport changes alone do not rescale
color. Fixed finite increasing limits clamp outliers. A constant automatic
domain maps to the colormap midpoint; no finite domain renders neutral strokes
and an explicit empty colorbar. Missing C on either endpoint makes the segment
neutral, preserving its geometry without implying a measured value.

SignalScope owns a deterministic viridis scale separate from theme palette
slots. It produces immutable per-sample RGBA attributes; ChartGPU interpolates
endpoint colors along segments and applies the existing opacity, width, dash,
and emphasis rules. This is a visualization of reduced source samples, not a
claim to reconstruct unretained color variation. ChartGPU owns attribute
buffers and their disposal. The extension requires unsampled, non-stepped,
non-streaming line data so renderer sampling cannot lose attribute alignment.
One plot still has one ChartGPU host and one atomic options publication.
Viewport-only changes retain attribute buffers and use `setViewRange`.

The C picker and shared X/Y/C limits editor are keyboard accessible. One
draft validates all ranges before a single publication; labels and ranges use
the existing panel fields. Time-X edits use the existing linked or local time
window, with Fit data restoring its extent. Automatic Y resets the sticky
extent. `ui/axis-limits.ts` owns the form and its listeners; `ui/panel-menu.ts`
owns shared trigger-relative positioning. Every edit schedules persistence.
The colorbar is one renderer-owned horizontal canvas. `ui/legend-color-scale.ts`
creates its legend mount and replaces the categorical color control while C is
active; the scale opens the C picker. The panel supplies the mount explicitly
to ChartHost after legend layout. Colorbar owns reparenting and drawing; legend
resize/placement refreshes it without republishing GPU series. Floating keys
and rosters stack the scale above their controls; horizontal rails put the scale
beside those controls. Badge, hidden, and collapsed-rail layouts use a compact
plot inset, without a dedicated gutter. ChartHost disposes the canvas and clears
its target reference. Plot PNGs retain a labeled inset even when the canvas is
mounted outside the chart; offline snapshots use the same presentation.
No schema or renderer attribute contract changes are needed.
Categorical choices remain saved and become effective again when C is cleared;
legend text, dash, focus, and picking continue to identify traces.

Deleting a signal prunes its explicit X and C bundle references, preserving
unaffected members. Exhausted X bindings reset to time with coordinate cleanup;
exhausted C bindings clear the scale. The existing line-binding state owner
handles this cleanup for workspace deletion paths.

Binding/range changes invalidate the appropriate prepared state. The controller
retains one overview and latest detail; its generation and abort rules govern
the entire colored response. Budget accounting includes auxiliary F64 columns,
prepared RGBA feeds, and GPU attributes. Native work clones signal handles
under the store lock and reduces after release, as before. Snapshots capture
the exact paired groups, including auxiliary C columns, and use the same scale
and renderer without network access. Baked reads may project a subset of the
captured scalar columns for the same X; this preserves correspondence and lets
C be cleared offline. Uncaptured columns remain unavailable. Session 30 migrates to 31 with C disabled;
older readers reject 31 before partial restore. Generated schemas and both
runtime parsers change together.

### Bounded composition scope

Per ADR 0054's explicit-amendment route, this feature permits typed wiring in
the still-oversized `ui/panel.ts`, `ui/app-shell.ts`, and `app/workspace.ts`.
The existing axis controls move to `ui/panel-axes.ts` before C controls are
added; scale, binding, attribute and buffer logic live in their named owners.
The remaining parent edits are callbacks, state fields and render context.
The legend-placement follow-up permits the same composition wiring for the
extracted legend scale mount and ChartHost target port; resource and layout
policy stay in those smaller owners.
In the ChartGPU fork, `config/types.ts` adds the attribute field,
`OptionResolver.ts` calls the extracted attribute validator, and
`ChartGPU.ts` rejects unsupported append before mutation. These changes need
the existing composition/entry points; decomposing every unrelated legend,
shell action and ChartGPU option would obscure the color-axis review.
This is a feature-specific exception, not clearance of any size violation.
The next behavior addition to any named oversized module requires renewed
decomposition or an explicit review; the roadmap retains the outstanding work.

## Alternatives and tradeoffs

Splitting each trace into many solid-color series multiplies renderer resources
and changes legend/picking identity. A second canvas line renderer duplicates
stroke and viewport policy. Independent color reduction corrupts sample
correspondence. The chosen ChartGPU attribute extension adds bounded linear
storage per retained row and keeps the existing presentation path. A dedicated
wire color role is unnecessary while its reduction semantics exactly match
an additional scalar column; revisit if categorical, stepped, or interpolated
color data requires different reduction.

## Validation

Tests must cover source matching and ambiguity, C=X/Y/time, incompatible
timebases/units, preservation of C-only extrema and gaps, shared and fixed
limits, constant/empty data, no padded-domain pollution, attribute alignment
and buffer lifetime, viewport publication, migration and malformed state,
live/baked correspondence, keyboard controls, layout and offline capture.
Legend placement coverage checks floating/rail/badge transitions, collapse,
constant/empty scales, capture after reparenting, and unchanged plot gutters.
Run the cross-layer CI gate after the complete vertical slice. Large-window
peak-memory measurements remain a separate roadmap item, not a measured claim.

## Consequences and implementation status

The feature is implemented. The color axis remains part of Line2D and does
not introduce a panel-kind registry or revive removed modes. The next review
trigger is a requirement for resampling, nonlinear normalization, or another
continuous-color plot family.

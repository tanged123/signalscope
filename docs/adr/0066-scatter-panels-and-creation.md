# ADR 0066: Scatter panels and panel creation

- Status: Accepted
- Date: 2026-09-12
- Amends: [ADR 0052](0052-typed-plot-families-and-explicit-x-line2d.md),
  [ADR 0065](0065-panel-toolbar-groups.md), and the composition-only size
  restriction in [ADR 0053](0053-module-boundaries-and-shared-primitives.md).

## Context

The panel creation study adds a second concrete Cartesian presentation:
sampled scatter. Existing paired data already retains actual source rows,
exact X/Y timebase correspondence, finite extrema, and source-time anchors.
These are sufficient for a sampled point plot, but time-envelope bin centers
are not actual source points and must not be rendered as scatter observations.

## Decision

Implementation has two parts: shared panel creation/data selection boundaries,
then the creation menu and scatter presentation. WorkspaceModel remains the
sole session owner. Panel creation defaults and layout mutations are separate
from presentation; shell callbacks publish changes through existing history,
refresh, and cache invalidation paths. The shell owns the layout menu and its
listener cleanup. Five header buttons provide add-left, add-right, minimize,
maximize, and the illustrated type picker with Left/Right placement. Creating
beside a maximized panel restores the grid and focuses the new panel. Separate
minimize/maximize controls restore the grid or expand the panel, with the
unavailable action disabled. Closing retains existing workspace behavior and
remains available in the dropdown. Only implemented types appear in the menu.

Session version 33 adds tagged PanelContent with line2d and scatter2d variants.
Version 32 migrates to line2d. Both concrete types share the existing Cartesian
axis, bindings, legend and annotation state; no speculative map or raster
fields are introduced. Unknown content fails at native and baked boundaries.

Scatter always queries the paired sample contract, including when X is time.
The existing reducer selects actual rows with shared X/Y correspondence;
scatter is explicitly sampled, not a density-preserving or exhaustive cloud.
No additional endpoint, reducer, interpolation, or combination cache is needed.
Continuous per-point color is not supported in this first scatter version;
native and baked readers reject a scatter color axis, and the UI omits that
assignment. Existing width settings control marker diameter (three times the
stroke width); dash identities map to circle, rectangle, and triangle markers.
The same native capture binding selection includes these paired groups, so
offline snapshots retain point positions and the same zoom fidelity limits.

The Cartesian renderer owns line versus point publication. Preparation owns
point-only hit testing: a segment between observations is never selectable in
a scatter panel. Existing axes, transforms, annotations, visibility, and one
ChartHost lifecycle are shared. Viewport changes retain setViewRange behavior;
data/style changes publish atomically with setOption. Controller cancellation,
generation checks, global density admission, and overview/detail retention are
unchanged. The shared query-selection predicate removes repeated policy tests.

This change permits bounded composition-only edits in panel.ts, app-shell.ts and workspace.ts:
extract panel contracts and replace existing layout callback wiring with a
narrow composition function, and delegate existing split/default construction
to panel-layout.ts and panel-defaults.ts. Workspace method changes are limited
to passing the selected content, composing a left split through the same admission
helper, and retaining revision publication. New menu, query, and rendering behavior lives in
their owning modules. This does not clear the remaining legend/shell size debt
or permit additional behavior in those oversized owners.

## Alternatives and tradeoffs

A separate scatter endpoint would duplicate the current correspondence
contract without improving the promised sampled view. Density reduction,
histograms, raster and geographic plots require their own contracts when
implemented. Converting line envelopes to points would invent observations.
Duplicating PanelView would duplicate axes, legends and resource lifecycle.

## Validation

Test creation placement, maximized creation/restore, menu keyboard dismissal
and cleanup, session migration and unknown content, point-only picking, paired
query selection, renderer publication, and native/offline capture. Browser
coverage exercises mixed plots, persistence and creation in constrained panels.
Performance beyond the existing adaptive sample budgets is not claimed.

## Consequences and implementation status

The first additional content shares Cartesian infrastructure with Line2D.
Future families are not required to implement line-specific capability methods.
The roadmap records remaining module extraction and measurement work.

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

Empty panels, including those created with N in a new workspace, offer the
same illustrated 2D line/Scatter choices in the plot area. 2D line
starts selected so direct signal drops still work. Choosing a type updates the
existing panel in place, retaining ID, layout, and axis settings. The choice
remains available until a binding is assigned. `app/panel-content.ts` rejects
changes to bound panels and no-op selections; WorkspaceModel publishes successful
changes through the existing revision/history/autosave path. PanelShell retains
the choice buttons across updates so keyboard focus survives selection.

Session version 33 adds tagged PanelContent with line2d and scatter2d variants.
Version 32 migrates to line2d. Both concrete types share the existing Cartesian
axis, bindings, legend and annotation state; no speculative map or raster
fields are introduced. Unknown content fails at native and baked boundaries.

Scatter always queries the paired sample contract, including when X is time.
The existing reducer selects actual rows with shared X/Y correspondence;
scatter is explicitly sampled, not a density-preserving or exhaustive cloud.
No additional endpoint, reducer, interpolation, or combination cache is needed.
Scatter supports the same time/signal/bundle C binding, labeled colorbar,
shared limits, and linear/log color scales as Line2D (ADR 0057).
X/Y/C retain the paired table's exact row correspondence; missing or nonpositive
log C uses the neutral series color without dropping the point.
Existing width settings now directly represent marker diameter in CSS pixels,
with a 2 px default and choices from 0.5 to 8 px. ChartGPU consumes a radius,
so ChartHost divides the diameter by two. The earlier width-times-three mapping
actually produced a radius, making its default 12 px across; saved scatter
widths receive the corrected presentation without changing stored settings.
Line widths retain their existing meaning and choices.
The same native capture binding selection includes these paired groups, so
offline snapshots retain point positions and the same zoom fidelity limits.

The Cartesian renderer owns line versus point publication. Preparation owns
point-only hit testing: a segment between observations is never selectable in
a scatter panel. Existing axes, transforms, annotations, visibility, and one
ChartHost lifecycle are shared. Viewport changes retain setViewRange behavior;
data/style changes publish atomically with setOption. Controller cancellation,
generation checks, global density admission, and overview/detail retention are
unchanged. The shared query-selection predicate removes repeated policy tests.

The September 16 amendment extends the ChartGPU attribute contract to scatter.
`config/scatterPointColors.ts` rejects sampling, animation, density rendering,
and variable point sizes when aligned colors are present. Append rejects before
mutation; replacements use one atomic setOption. The renderer's
`scatterPointColors.ts` owns finite-XY color compaction, cached by immutable
geometry/color identity, matching the existing geometry compaction. The shared
`pointColors.ts` owns buffer upload, replacement, and disposal for both line and
scatter. Viewport/uniform changes retain buffers; disabling C releases the
attribute buffer. The shader selects each point's RGBA or neutral fallback and
applies series opacity, so dimming and hover retain measured colors. Only the
current compacted color feed is retained beside the existing source attributes;
there is no independent C query or history cache.

This amendment permits only attribute declarations and the extracted validator
call in the oversized vendor `config/types.ts` and `config/OptionResolver.ts`,
plus extension of the existing append guard in `ChartGPU.ts`. New color policy
and resource behavior live in the named smaller modules. Session v33's existing
color_axis field is reused; this completes scatter support within the same PR
and introduces no additional schema or release version bump.

This change permits bounded composition-only edits in panel.ts, app-shell.ts and workspace.ts:
extract panel contracts and replace existing layout callback wiring with a
narrow composition function, and delegate existing split/default construction
to panel-layout.ts and panel-defaults.ts. Workspace method changes are limited
to passing the selected content, composing a left split through the same admission
helper, and retaining revision publication. New menu, query, and rendering behavior lives in
their owning modules. This does not clear the remaining legend/shell size debt
or permit additional behavior in those oversized owners.
The empty-panel follow-up permits only a status content input in PanelView and
a WorkspaceModel method delegating to the content guard and revision owner.

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
Color coverage checks sparse XY/color alignment, buffer retention and cleanup,
unsupported geometry rejection, smaller diameter selection, actual colored GPU
pixels, session restore, and offline colorbar rendering and C removal.
Performance beyond the existing adaptive sample budgets is not claimed.

## Consequences and implementation status

The first additional content shares Cartesian infrastructure with Line2D.
Future families are not required to implement line-specific capability methods.
The roadmap records remaining module extraction and measurement work.

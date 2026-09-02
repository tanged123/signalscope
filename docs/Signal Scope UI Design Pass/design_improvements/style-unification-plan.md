# Style unification design and implementation plan

Status: implementation plan for the improvement branch.
Design authority: `SignalScope Style Unification.dc.html`, reconciled with the
Final Spec and accepted ADRs

## Design plan

### Resolution model

Every rendered line property follows one visible cascade:

1. The panel toolbar owns plot-wide defaults. In this pass those are line width
   and ghost opacity; curve and point density remain truthful read-only facts
   (`linear` and `auto`) until the renderer exposes alternatives.
2. The legend encoding row owns set-wide rules. Its permanent color, dash, and
   width chips name both the property and its bound dimension. A flat rule
   visibly inherits the panel default. Assigning a dimension already used by
   another property swaps the bindings so a dimension never encodes two visual
   properties silently.
3. An expanded legend row owns literal per-series overrides. Overridden fields
   have an amber inset, the collapsed row has an amber mark, and the legend
   footer reports the number of style overrides. Field, series, and all-series
   reverts are separate actions.

Color is never a toolbar setting. Derivation and unbinding are never style-row
actions. Derived signals arrive as ordinary bound series. Muting remains a
reversible roster action; removing a binding remains in its binding-chip
drawer.

### Panel toolbar

The 26 px header is divided by hairline seams into stable groups:

- Binding: drag handle, editable title, binding chips, and add affordance.
- Axes: the existing gutter/inline axis presentation control. Scale choices are
  not invented in this pass because the time-only ChartGPU path currently has
  one truthful linear scale.
- Render defaults: editable line width and ghost opacity. Curve and point
  density labels remain absent until they expose truthful controls.
- Readout: statistics toggle and legend-size control.
- Window: split, maximize, and close actions, always at the right edge.

Narrow panels collapse optional facts before binding or window controls. Every
editable pointer control remains a native button with a keyboard path.

### Legend

The existing serialized badge → keys → roster → rail size ladder remains. Every
state above badge gains a permanent encoding row directly below the header. In
the rail the three chips wrap without dropping their `property ← source`
labels. Chip editors are in-legend drawers that push content down, keeping both
the affected rows and plot visible.

Clicking a singular row swatch expands that row in place. The inspector contains
only color and line fields, inherited provenance, field-level revert, mute, and
escape/close affordances. Only one row is expanded. The former floating series
card, quick-transform buttons, and remove action are deleted.

The footer is the resting discrepancy ledger: ghost count on the left, style
override count on the right. Opening the override count shows affected paths,
fields, and per-series/all-series reverts inside the legend.

### Statistics

Statistics become columns on legend rows and the bottom strip is removed. The
toolbar Σ control exposes visible-region statistics without changing plot
geometry; a floating legend overlays the plot and a rail reflows it only after
the existing explicit docking gesture.

The initial columns are `min`, `max`, `μ`, `rms`, and `@cur`, with `n` available
from the column picker. Values use four significant figures, tabular numerals,
right alignment, and a unit in the column header when the visible rows share
one. Columns drop from the right as the legend narrows while preserving the
sorted column. Column headings sort ascending/descending and the choice
survives focus changes and session round trips. The footer exports exactly the
visible columns for the current visible-region scope as CSV.

The table remains bounded by the resolved panel set and scrolls inside the
legend. The name cell is the legend row; it is not duplicated. A small
aggregate row summarizes the currently resolved set. Scope is stated as
`Σ visible region`; full-record and selection choices are not exposed until the
data plane can compute them truthfully.

## Implementation plan

1. Add session-schema fields for nullable color/dash/width encodings, panel line
   width, ghost opacity, selected statistic columns, and statistic sorting.
   Regenerate committed Rust/TypeScript types and add a migration from the
   current schema with behavior-preserving defaults.
2. Make `resolvePanel` apply panel defaults, dimension encodings, and literal
   overrides in order while reporting field-level override provenance. Add
   workspace mutations for atomic encoding swaps, individual style fields,
   panel defaults, stat columns, and sort state.
3. Recut the panel header into toolbar groups and replace the configuration
   popover with direct controls. Keep axis style and legend state reachable and
   preserve responsive window actions.
4. Add the permanent three-chip encoding row and in-legend rule drawers to
   keys, roster, and rail states. Move the override ledger into the legend
   footer.
5. Replace the floating series inspector with an inline row inspector and
   remove plot-local transforms and row-level unbinding.
6. Replace `.panel-stats` with a scrolling statistics legend table, sorting,
   column selection, min–max spans, current-value refresh, aggregate row, and
   CSV export.
7. Update session fixtures, unit tests, browser behavior tests, snapshots, and
   documentation. Run the frontend gate first, then the proportional full CI
   gate because the change crosses schema, Rust migration, frontend state, and
   browser behavior.

## Explicitly deferred

- Log/symlog axes, alternative curve interpolation, and user-selected
  decimation require renderer/data-contract work and are not represented by
  inert controls.
- Full-record/selection statistics, percentiles, pairwise comparisons, detailed
  histogram interactions, and aggregate group headers need data-plane or
  product semantics beyond this UI unification pass.
- Multi-row bulk style editing remains a follow-up after the singular inline
  editor and selector-based override behavior are stable.

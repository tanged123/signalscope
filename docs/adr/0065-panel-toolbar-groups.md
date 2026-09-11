# ADR 0065: Three panel toolbar groups

- Status: Accepted
- Date: 2026-09-11
- Amends: [ADR 0058](0058-session-title-and-contextual-chrome.md), replacing
  individually inline plot controls with three explicit dropdown groups.

## Context

Spacing alone did not make the panel header's control groups clear. The accepted
UI review requests Data & axes, Appearance, and Analysis dropdowns, with current
configuration summaries visible when closed. This structure must separate shared
interaction from the controls supplied by a plot family.

## Decision

`ui/panel-toolbar.ts` owns the three named group triggers, one open group at a
time, positioning, keyboard navigation, outside dismissal, and focus restoration.
`PanelToolbarGroups` requires a controls element and initial summary for each
group. Families publish summary changes through `setSummary`; controls keep their
existing callbacks and state owners. The interface contains no Line2D options.

`ui/line-toolbar.ts` supplies the current Line2D controls and their summaries.
Data & axes contains assignments, axis presentation, and limits; Appearance
contains line width, dimming, and legend presentation; Analysis contains statistics
and tip controls. `PanelAxes` continues to own the axis pickers and limits editor.
The panel title, binding summary, and split/maximize/close actions remain outside
the dropdowns. Dragging signals over Data & axes opens its controls for axis drops.

A setting picker replaces the group popup and uses its visible trigger as its
anchor. Existing picker components own their own navigation and dismissal; Escape
returns to the group trigger. This avoids nested popovers competing for panel
space. The shared toolbar reuses `positionPanelPopover`, and removes its document
listeners and ResizeObserver on disposal. Family disposal also closes its pickers.

Open-group state is transient. No session, protocol, or preference fields change;
the same controls and summaries run in live workspaces and offline snapshots.
The interface establishes a presentation boundary, not a registry or support for
additional plot types. New families still require ADR 0052's deliberate design.

## Alternatives and tradeoffs

Keeping every control inline avoids a click, but leaves grouping ambiguous and
consumes header space. Three dropdowns add a step to configuration; visible
summaries, tooltips for truncated text, and existing shortcuts retain context.
One generic settings menu would lose the requested stable three-part structure.

## Validation

`panel-toolbar.test.ts` checks family-supplied controls, focus navigation,
exclusive groups, picker handoff, dismissal, and teardown. Browser checks cover
closed summaries, all control paths at narrow widths, changing configuration,
axis and color bindings, statistics, legend modes, and offline round trips.

## Consequences and implementation status

The Line2D toolbar implementation and the shared component accompany this record.
PanelView retains composition and delegates the extracted toolbar behavior.
Revisit group applicability when a second concrete plot family is designed.

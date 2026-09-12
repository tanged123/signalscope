# ADR 0065: Compact panel configuration menus

- Status: Accepted after revised UI review
- Date: 2026-09-11
- Amends: [ADR 0058](0058-session-title-and-contextual-chrome.md)

## Context

Individually inline controls wrapped the panel header. The first dropdown pass
also consumed too much width and added another menu step for common settings.
The revised review requests compact menus that preserve visible configuration.

## Decision

The header has three short controls: plot, style, and readouts. Their values show
axis presentation, line width and active dimming, legend mode, enabled statistics,
and tip count. Full summaries are available in tooltips. Title, binding chips,
and panel layout actions remain directly accessible. The header does not wrap;
narrow control and binding strips scroll horizontally, including keyboard focus.

Plot contains signal assignment, X/color bindings, axis presentation, and limits.
Its existing signal pickers and limits editor replace the dropdown and return
focus to the axes summary. Dragging a signal over axes opens its drop targets.

Style directly lists width and dimming choices in labeled sections. Readouts
directly lists the four modes, the statistics toggle, and tip display/clear
actions. These use the existing menu keyboard navigation and dismissal.

## Ownership and compatibility

`LineToolbar` owns the three controls, transient axes dropdown state, summaries,
and menu cleanup. `PanelAxes` retains assignment, limits, and axis drop behavior.
`showPanelMenu` owns setting-menu navigation and document-listener cleanup;
optional section labels group its existing choices. Native details supplies
the axes disclosure. Disposal removes toolbar listeners and closes menus.

No generic toolbar registry or new panel types are introduced. Session,
preferences, protocol, and renderer behavior are unchanged. The simple legend
remains a line key; expanded and docked legends retain the full editing controls.
Internal legend state values remain compatible with existing sessions.

## Validation

The focused browser check exercises each menu, direct style choices, picker
focus restoration, and single-row headers in narrow panels. It captures the
closed header and open style menu in the running browser application.

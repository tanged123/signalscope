# ADR 0010: Workspace tabs and chrome hierarchy

- Status: Accepted
- Date: 2026-07-24

## Context

The original design specification called for one workspace with no tabs and
reserved named layout presets for recalling panel arrangements. In use, one
analysis often needs several simultaneously available panel grids: for
example, overview, guidance, and power views over the same loaded sources and
linked time window. Replacing one grid with a preset would discard that useful
working context.

The Phase 1 shell also exposed a conventional File/Edit/View-style menu row
whose entries had no behavior. It duplicated the functional toolbar, consumed
vertical plot space, and implied unavailable commands. Maximizing a panel then
hid its siblings without leaving a visible way to discover or switch among
them.

## Decision

SignalScope supports persistent workspace tabs in both the native workbench and
HTML snapshots. Each tab owns a title, focused panel, panels, and fractional
layout. The active tab identifier is session state. Loaded sources, favorite
signals, theme, and linked time remain global so switching tabs changes the
view of one analysis rather than creating an isolated document.

Session schema version 3 replaces the single top-level panel grid with
`WorkspaceTab[]`. The v2-to-v3 migration wraps the existing grid in
`Workspace 1`; v1 sessions continue through the existing migration ladder.
Panel identifiers remain unique across the session.

Workspace tabs and layout presets have different roles. A tab is a durable
working instance that retains plotted signals and panel state. A future layout
preset is a reusable template applied within a tab.

The application uses one global toolbar containing only implemented global
actions and global state. Empty conventional menu headings are not rendered;
future menus may return only when they contain real commands. A workspace-tab
strip sits above the panel grid and remains visible during panel maximize.
The visible ownership hierarchy is global application chrome, then the active
workspace tab, then panel-local controls.
Panel creation is contextual to that active workspace: `Split right` and
`Split down` are adjacent actions in each panel header rather than a separate
global `+ Panel` action. `N` is the keyboard path for `Split down`, creating
the first panel when the workspace is empty. While maximized, a separate
contextual panel rail lists sibling panels and offers an explicit `Restore
grid` action.

The derived formula editor is collapsed by default and therefore consumes no
permanent plot height. `ƒx Derived` in the global toolbar, `E`, and the command
palette open the same temporarily docked editor; opening focuses its input and
Escape collapses it. A future signal context action may duplicate this entry
point, but cannot be its only access path.

The signal tree is primary navigation, so its toolbar toggle is the leftmost
application action. It is expanded at startup, resizable from its right edge,
and collapses when that edge is dragged below the minimum useful width. The
toggle and command palette restore or hide it without requiring precise
pointer input. A five-pixel resize edge remains when collapsed, allowing a
rightward drag to restore the tree without consuming meaningful plot width.

## Consequences

Users can keep several analysis views available without duplicating loaded data
or losing linked-time context. Native and snapshot hosts retain identical
navigation because the behavior lives entirely in the shared presentation
plane.

The session schema gains another required migration rung before durable
autosave ships. The tab strip costs 28 pixels of vertical space, offset by
removing the inert 28-pixel menu row. Maximized mode costs a temporary
26-pixel contextual rail in exchange for keeping hidden panels discoverable.
The formula editor costs 30 pixels only while it is open.
Collapsing the signal tree returns all but its five-pixel resize edge to the
active workspace.

# Channel-first signal outline

**Date:** 2026-08-02

## Decision

Replace the configurable outline table with one channel-first signal tree. The
tree keeps P8's virtualization, selection, bulk actions, search, drag, and
keyboard behavior, but removes table modes and metadata controls.

The SIGNALS heading has no grouping select or column picker. Multi-source
channels render as collapsed group rows with a trailing source count. Expanding
a channel reveals its source series. Single-source channels remain flat rows.
The only columns are the channel/source outline and a fixed, right-aligned
VALUE column.

VALUE is a cursor readout, not catalog metadata. It remains blank unless an
active plot cursor supplies a live value for that exact series. Group values
are always blank. Catalog `last_value` never populates the outline.

UNIT is removed from the outline model, rows, headers, width calculations,
sorting, and column controls. Signal metadata may retain units for axes and
data-plane behavior; the dock does not present a dedicated unit field or unit
conflict marker.

Source alignment remains available from source child rows. Its action is
shown on hover or keyboard focus, while a non-identity alignment marker stays
visible. This preserves alignment without a source grouping mode.

## Channel mapping removal

Remove channel merging completely:

- delete merge, keep-separate, suggestion, and unmerge UI;
- delete channel-map catalog normalization and workspace mutations;
- delete channel alias badges, menus, popovers, styles, and tests;
- build catalog identity from each signal's source-local channel name; and
- remove `ChannelAlias`, `ChannelMapEntry`, and `Session.channel_map` from the
  generated session API.

Session schema v18 migrates v17 sessions before dropping `channel_map`. Every
stored `SeriesRef` whose source and canonical channel match a map entry is
rewritten to that entry's source-local alias. This covers named-set refs and
panel bindings, overrides, focus, X, and color references. Selector strings
remain unchanged; removing canonical aliases intentionally removes their
cross-source merge semantics.

This schema/API removal is a breaking change and requires a major application
version bump. A new ADR records the v18 migration and removal.

## Interaction and layout

- Channel groups start collapsed and read `▸ channel — N srcs`.
- Group click or caret toggles expansion; the checkbox selects all children.
- Source rows show the source name and an empty or live VALUE cell.
- Existing range selection, query-filtered select-all, bulk actions, double
  click, Enter, Space, drag, and context-independent keyboard paths remain.
- Search expands matching groups while filtering, as before.
- Sorting and regrouping commands are removed with their controls.
- The tree continues to virtualize rendered rows and never reads sample arrays.

## Verification

Unit tests cover fixed channel grouping, blank inactive values, live cursor
values, source alignment, and removal of merge affordances. Session tests cover
the v17-to-v18 ref migration and generated conformance fixture. End-to-end
tests cover the simplified heading, collapsed channel rows, expansion,
selection, source alignment, and cursor value clearing.

## 2026-08-02 amendment: selection cleanup

Source alignment and the bulk selection footer are deleted. Alignment metadata
was not applied to tile or sample queries, so protocol v14 and session v19
remove it; v18 sessions migrate by dropping the disconnected fields. Any future
clock normalization must transform every time-bearing query consistently.

Outline selection remains only for range selection, group selection, and
multi-signal drag payloads. Manual sets originate in SETS through the visible
`★+` action, the `F` command, or a selected-signal drop. Styling and visibility
remain panel-legend actions, while derivation remains in the formula editor.

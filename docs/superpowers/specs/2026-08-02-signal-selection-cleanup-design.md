# Signal selection cleanup

**Date:** 2026-08-02

## Decision

Remove manual source alignment and the signal-selection bulk footer. Both add
state and UI without owning behavior that belongs in the signal outline,
panel legend, or formula bar.

Outline selection remains ephemeral interaction state. It supports range
selection, selecting a channel group, and dragging multiple signals. It does
not expose bulk styling, visibility, derivation, or add-to-panel commands.

## Source time behavior

The current alignment editor changes source registry and session metadata, but
tile and sample queries use raw stored timestamps. Scale, offset, origin, and
unit therefore do not affect plots. Remove this disconnected feature instead
of retaining or repairing it.

Delete the alignment popover, marker, outline callback, frontend data-plane
method, protocol request, Tauri command, source registry transform, and core
alignment module. Remove alignment fields from source summaries and durable
source records.

Protocol version 14 removes the alignment request and source-summary fields.
Session schema version 19 removes `SourceRecord.time_domain`, `scale`, and
`offset`. The v18-to-v19 migration drops those fields. Existing sessions keep
source identity, paths, prefixes, provenance, reconciliation state, and every
workspace setting. Sources continue to use their stored raw numeric
timestamps, which matches current plotting behavior.

Real cross-source clock normalization, if needed later, is a new data-plane
feature whose transform must be applied consistently to summaries, tiles,
samples, derived computations, and export. This removal does not reserve a
partial implementation for it.

## Signal selection

Delete `BulkBar`, its mount, styles, callbacks, tests, and bulk-only AppShell
methods. In particular:

- adding remains double-click, Enter, or drag to a panel;
- styling and visibility remain in the panel legend and inspector;
- derivation remains in the formula bar and command palette; and
- saving a manual set moves to the SETS section.

Selection is reconciled with catalog keys after every signal reload, removing
deleted signals. Creating, switching, or closing workspace tabs clears it so
selection cannot leak between workspaces. The outline retains selected-row
rendering, shift-range selection, select-all-filtered, Escape-to-clear, and
multi-signal drag payloads.

## Manual sets

The SETS heading gains a compact `★+` button titled “Save selected signals as
set.” It is disabled when nothing is selected. Pressing `F` while not editing
text invokes the same command.

The SETS list is also a signal drop target. Dragging an outline row, channel
group, or existing multi-selection onto it opens the existing set-name row
with those exact source-local references. The drop does not bind the new set
to a panel. The existing naming, save, cancel, and manual pick-set storage
remain unchanged.

The visible button and `F` command provide keyboard equivalents for the drop
gesture. After a manual set is saved, selection remains unchanged so it can be
dragged to a panel or reused.

## Testing

- Selection tests cover catalog reconciliation and explicit clearing.
- Outline tests cover selection and drag without a footer or alignment UI.
- SETS tests cover disabled/enabled save controls and signal drop payloads.
- AppShell tests cover workspace selection clearing and manual-set naming.
- Rust migration tests cover v18-to-v19 field removal.
- Protocol code generation verifies the v14 alignment-type deletion.
- Playwright covers selecting signals, saving through `★+` and `F`, dropping
  onto SETS, deleting/reloading signals without stale selection, and the
  absence of alignment and bulk-footer surfaces.

This is a breaking protocol and session cleanup. The final implementation
increments the application major version from 2.0.0.

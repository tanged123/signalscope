# ADR 0058: Session display title and contextual chrome

- Status: Accepted
- Date: 2026-09-06
- Amends: [ADR 0020](0020-three-strip-chrome-and-hidden-application-menu.md)
  and [ADR 0048](0048-legend-console.md)

## Context

Dataset totals appeared in three corners and the global Layout menu duplicated
per-panel legend settings. Help opened a command palette whose focus was then
taken by the application menu. The session title was derived only from its file.

## Decision

The status bar owns aggregate dataset counts. The title bar owns an editable
session display title; the source footer owns import actions and progress.
Per-panel appearance, readout, and X/Y/C binding controls stay inline. The
header wraps on narrow panels so actions remain directly accessible. The title
has no dirty-state dot; an explicit Unsaved label in the status bar indicates
changes since the last explicit session save, independently of autosave.
The global legend menu and inactive Follow slot are
removed. Help lists gestures and registered shortcuts in a dismissible dialog.

`Session.title` is an additive nullable string in session schema 31. Missing
titles default to null in Rust and the baked parser; existing sessions retain
their file-name fallback. The workspace owns the saved value, and title edits
use its replacement/history/autosave path. Renaming does not change file paths.
Snapshots serialize the same title. Invalid non-string titles fail parsing.
No version migration is required for this optional field; future and unsupported
versions retain their existing rejection behavior.

`ui/session-title.ts` owns the temporary text input and commit/cancel lifecycle.
`ui/shell-markup.ts` owns shell structure; `ui/shell-status.ts` consumes existing
presentation callbacks. `ui/line-toolbar.ts` owns appearance-control grouping.
`ui/help-dialog.ts` owns its dialog and restores focus when it closes. The
application menu closes before executing commands so newly opened UI owns focus.
The oversized shell and panel remain composition roots; their new behavior is
implemented in these focused modules, not in further inline control logic.

Inline status metrics report the existing CPU chart-update duration and density
planner's CPU/GPU memory estimates, scoped to active workspace charts. They are
not GPU execution time, utilization, or measured process memory. Publication
uses existing render/plan callbacks, with no timers, data scans, GPU readbacks,
or new host API. A short constraint indicator remains visible when needed.
The status bar can wrap to keep metrics visible at narrower desktop widths.

UI labels, menus, form controls, muted prose, and signal-tree labels use the
selected UI font. Shared caption, text, body, and heading size tokens scale with
the UI size preference. Numeric/code readouts retain tabular monospace, and plot
content retains the independent plot font. Muted color does not change family.

## Alternatives and tradeoffs

Renaming the backing file would couple display identity to file-system actions
and would not work in snapshots. A nullable session title keeps both hosts equal.
Inline controls avoid an extra click for frequent changes, at the cost of a
second header row when a panel cannot fit them. Metric tooltips explain their
scope without requiring a disclosure to read the values.
Actual GPU utilization requires separate measured instrumentation work.

## Validation

Rust and baked-parser tests cover title round trips, missing titles, and invalid
types. UI tests cover Enter/blur commits, cancellation, literal imported text,
and estimate publication. Playwright covers Help dismissal/focus, title undo,
per-plot menus, wrapped layout, and UI font/size preferences across menus and
the signal tree. Existing snapshot checks validate the
shared offline artifact.

## Consequences and implementation status

Implemented in this change. Session/schema ownership and renderer scheduling
remain unchanged. Further oversized-module extraction remains on the roadmap;
these extractions do not exempt the remaining inline clusters from ADR 0053.

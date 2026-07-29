# All-Panels PNG Export

## Scope

PNG export supports two scopes:

- **Focused panel** remains the default and preserves the existing behavior.
- **All panels** writes one PNG per panel across every workspace tab.

All-panels export prompts once for a destination folder. Files are ordered by
workspace tab, then by panel layout. Names use
`<workspace>-<panel>.png`, sanitize reserved filename characters, and add
`-2`, `-3`, and subsequent suffixes for collisions.

## Architecture

The existing panel renderer remains the only PNG rendering path. While the
export dialog covers the workspace, the application visits each tab, restores
its full grid when maximized, waits for its panels to render, and captures each
panel with `composePanelPng`. It writes each PNG before rendering the next one
to keep memory bounded.

The native export port gains operations to select a destination folder and
write a named PNG inside it. The shell validates each filename and performs the
filesystem write; the frontend does not construct native output paths.

## State and Errors

Before traversal, export records the active tab and each tab's focused and
maximized panel. A `finally` path restores those values and refreshes the
original workspace after success, cancellation, or failure.

Cancelling the folder picker writes nothing. If a later render or write fails,
the error identifies the failed panel. Files already written remain in the
selected folder.

## Interface

Selecting PNG reveals a scope control with **focused panel** and
**all panels**. The focused option shows the existing byte estimate. The
all-panels option shows the number of PNG files; it does not eagerly render
every tab merely to calculate a byte estimate. Export remains disabled when no
panel is available.

## Validation

Tests cover:

- focused scope as the dialog default and all-panels scope propagation;
- filename sanitization, ordering, and collision suffixes;
- traversal of every tab, including maximized tabs;
- state restoration after success, cancellation, and failure;
- native folder selection and safe per-file writes;
- unchanged focused-panel export behavior;
- an end-to-end multi-tab export that leaves the original workspace active.

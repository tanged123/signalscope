# Drag-and-Drop Ingest and Direct Open Design

Supersedes `2026-08-02-unified-source-open-design.md` (the two-button chooser
modal).

## Decision

`Open…` invokes the native multi-file picker directly. `Open folder…` becomes a
secondary command. A window-wide drop target accepts data files, folders, and
workspace files. The files/folder chooser modal is deleted.

A custom in-app file explorer was designed and deliberately deferred: its one
unique benefit (mixed file-and-folder selection in a single dialog) is mostly
served by drag-and-drop, it competes for effort with the extensible-ingest
plan (`docs/superpowers/plans/2026-07-30-extensible-ingest.md`), and that plan
does not depend on it — Part B Task 3 derives picker filters and the drop
accept list from the provider registry against the native picker seam this
design keeps.

## Open commands

- `O`, the File menu `Open…`, the command palette, and `+ source` all invoke
  the filtered native multi-file dialog (`pick_sources`) directly. No
  intermediate chooser.
- `Open folder…` remains available in the File menu and command palette only.
  It invokes the native folder dialog, expands the folder through
  `scan_sources` (recursive), and batch-ingests the result — unchanged
  behavior, demoted placement.
- Cancelling either native dialog leaves the workspace unchanged.
- `SourceOpenDialog` (`frontend/src/ui/source-open-dialog.ts`) and its test
  file are deleted. `SourceOpenKind` and `pickIngestPaths` stay; the two
  commands call them directly.

## Drag-and-drop

- The native host adapter subscribes to the Tauri window drag-drop events and
  exposes dropped paths to the app shell through the ingest port. The snapshot
  host exposes nothing, so snapshots stay inert — no new renderer/host
  coupling and no network.
- While a drag hovers the window, a full-window overlay indicates the drop is
  accepted. Drops are ignored while any modal dialog is open.
- Classification, per dropped path:
  - `.signalscope` or `.json` files are workspace files. Exactly one may be
    dropped, alone: it opens through `loadSession(path)`, identical to the
    File menu open path. Invalid session files fail with the loader's own
    error.
  - Everything else — directories and data files — expands through
    `scan_sources` (recursive) per path; the merged, deduplicated file list
    enters the existing batch ingest path, identical to the picker flows.
- A drop mixing workspace and data files is rejected with a message and loads
  nothing. Multiple workspace files are rejected the same way.
- A drop whose expansion yields zero supported files reports the
  unsupported-format message naming the supported formats (from
  `SUPPORTED_FORMATS` today; from registry descriptors after extensible-ingest
  Part B Task 3).
- A rejected or empty drop leaves the workspace unchanged.

## Error handling

- Per-path `scan_sources` failures (permissions, vanished paths) surface
  through the existing ingest error reporting; remaining paths still load.
- Workspace-file drops reuse `loadSession`'s error handling untouched.

## Testing

Frontend unit tests cover: each open entry point invokes the file picker with
no intermediate modal; the folder command remains reachable from menu and
palette; drop classification (data, workspace, mixed → rejected, multiple
workspaces → rejected); folder expansion through a fake `scanSources`; the
zero-supported-files message; drops ignored while a modal is open; drop
support inert when the ingest port is null. Shell `scan_sources` tests are
unchanged; no new native commands are required.

Gate: `./scripts/test.sh frontend`, `./scripts/test.sh shell`, then
`./scripts/ci.sh all`. Version bump: minor, at implementation.

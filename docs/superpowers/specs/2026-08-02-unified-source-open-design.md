# Unified Source Open Design

> **Superseded** by `2026-08-02-dragdrop-and-direct-open-design.md`: the
> chooser modal is deleted in favor of direct open, a demoted folder command,
> and window-wide drag-and-drop.

## Decision

SignalScope exposes one `Open…` command. It opens a compact modal choice for
files or a folder because native cross-platform dialogs cannot select both in
one surface.

File selection returns supported files directly. Folder selection recursively
scans for supported files. Both results immediately enter the existing batch
ingest path; there is no separate folder preview or folder-specific loader.

## Interaction

- `O`, the File menu, the command palette, and `+ source` invoke the same
  chooser.
- The chooser is keyboard reachable, dismisses on Escape or outside click, and
  restores focus when closed.
- Choosing Files opens the filtered multi-file native dialog.
- Choosing Folder opens the native folder dialog, recursively scans it, and
  loads all supported files.
- Cancelling either native dialog leaves the workspace unchanged.

## Consequences

The separate `Open folder…` command and folder scan preview are deleted. The
native file and folder pickers remain separate host operations, while all
frontend orchestration and ingestion after selection is shared.

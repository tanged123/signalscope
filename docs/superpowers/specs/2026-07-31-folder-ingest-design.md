# Folder Ingest and Loading Progress

## Decision

Users can open a folder and load every detectable data source in it, with
recursion into subfolders as an explicit, default-on option. The backend
already does the hard parts — `ingest_batch` expands directories
recursively with extension filtering, and batch jobs already report
progress, per-file failures, and cancellation. This design adds the
missing UX: a folder picker, a scan-preview step so the user sees what a
folder drop will load _before_ it loads, and a progress bar whose fraction
is byte-weighted so large files don't render as a frozen 0%.

What this is not: a file manager. One picker, one preview dialog, one
progress strip. No tree browsers, no per-file checkboxes, no persisted
ingest preferences.

## UX flow

1. **Open Folder…** appears wherever **Open files…** does (the command
   palette entry `open-files` gains a sibling `open-folder`). It opens the
   native directory picker.
2. Picking a folder runs a **scan** (no ingest yet) and opens a small
   preview dialog:
   - Title: the folder's basename (full path in the tooltip).
   - Body: `N loadable files · <size>` plus a per-format breakdown
     (`Delimited text: 12 · MCAP: 3`), derived entirely from the scan
     response.
   - `Include subfolders` checkbox, **checked by default**; toggling
     re-scans and updates the counts.
   - `Load` / `Cancel`. Zero files found ⇒ "No loadable files found." and
     `Load` disabled.
3. `Load` closes the dialog and submits the scan's **explicit file list**
   to the existing batch ingest flow (`runBatchIngest`) — the recursion
   choice is honored because directories are expanded before submission,
   and everything downstream (admission, cancellation, failure reporting,
   set proposal) is unchanged.
4. The existing `.ingest-progress` strip gains a real progress bar:
   byte-weighted percent, `done/total` file counts, the basename(s) of the
   file(s) currently decoding, the existing failure list, and the existing
   Cancel button.

## Scan command

New shell command `scan_sources` (protocol v12):

- `ScanSourcesRequest { path: string, recursive: bool }`
- `ScanSourcesResponse { files: string[], total_bytes: u64, format_counts: FormatCount[] }`
- `FormatCount { label: string, count: u32 }` — labels come from
  `SUPPORTED_FORMATS` in `core/scope-core/src/ingest/mod.rs`.

Implementation reuses the shell's `expand_source` walk with a new
`recursive` flag (when false, subdirectories are skipped); detection stays
extension-based via the existing `supported_path`. Results are sorted and
deterministic. File sizes come from `fs::metadata`; unreadable entries are
skipped, not fatal. The scan never registers sources or touches the store.

The native folder picker is a second dialog command beside the existing
file picker (`pick_source_folder`, returning the chosen path or null).
Both live on the ingest port; the baked plane has no ingest port, so
snapshots are unaffected.

## Progress

- `BatchStatus.fraction` becomes **byte-weighted**: each file's weight is
  its size at job creation (minimum 1 so zero-byte and unstatable files
  still count); `fraction = settled_bytes / total_bytes`. Monotone, and a
  folder of mixed sizes no longer shows 90% while a 1 GB file is still
  decoding.
- `BatchStatus` gains `current_paths: string[]` — the paths currently in
  the `running` state, capped at 3 — so the progress strip can show what
  is being decoded right now.
- Protocol bumps 11 → 12 (new scan types plus the `BatchStatus` field);
  shell and frontend regenerate together, and `BatchStatus` is never
  persisted, so no migration is needed.
- Within-file progress (percent through a single file's decode) is
  **deferred**: it needs progress callbacks threaded through the decoders.
  Byte-weighted cross-file progress plus the current-file label is the
  deliverable here.

## Validation

- Shell tests: `scan_sources` recursive vs. non-recursive over a temp tree
  (nested supported/unsupported files), deterministic ordering, byte
  totals, format counts; empty folder.
- Core tests: byte-weighted fraction (small file done + large file pending
  stays near 0), minimum-weight rule, `current_paths` reflects running
  files and empties on terminal states.
- Frontend tests: preview dialog renders counts/size/format breakdown,
  re-scans on checkbox toggle, disables Load on zero files, and submits
  exactly the scanned file list; progress renderer shows the bar width,
  percent, and current basenames.
- Manual (`./scripts/run.sh`): open a folder containing `examples/`-style
  nested runs with and without recursion; cancel mid-load.

## Deferred

- Within-file decode progress (decoder callbacks).
- Dropping a folder from the OS file manager onto the window.
- Any persisted ingest preferences (last folder, recursion default).

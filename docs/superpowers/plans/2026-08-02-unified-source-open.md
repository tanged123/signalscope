# Unified Source Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate file and folder commands with one source-opening flow that always feeds the existing batch importer.

**Architecture:** A focused `SourceOpenDialog` owns only the Files/Folder choice. `AppShell` resolves either choice to a path list and calls `ingestPaths`; recursive folder scanning no longer has a separate preview UI.

**Tech Stack:** TypeScript, DOM APIs, Vitest/jsdom, Tauri dialog commands.

## Global Constraints

- Keep native file and folder picker operations because the host API cannot combine them cross-platform.
- Add no frontend runtime dependency.
- Preserve the existing batch ingest and progress pipeline.

---

### Task 1: Consolidate source opening

**Files:**

- Create: `frontend/src/ui/source-open-dialog.ts`
- Create: `frontend/src/ui/source-open-dialog.test.ts`
- Modify: `frontend/src/app/ingest.ts`
- Modify: `frontend/src/app/ingest.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/styles/app.css`
- Delete: `frontend/src/ui/folder-scan-dialog.ts`
- Delete: `frontend/src/ui/folder-scan-dialog.test.ts`
- Modify: `frontend/tests/e2e/app.spec.ts`

**Interfaces:**

- Produces: `SourceOpenDialog.open(onSelect): void`
- Produces: `pickIngestPaths(port, kind): Promise<string[]>`
- Consumes: `IngestPort.pickSources`, `pickSourceFolder`, `scanSources`, and the existing `AppShell.ingestPaths`

- [x] **Step 1: Write failing chooser and shell tests**

Assert that the modal routes Files and Folder choices, restores focus, that
folder selection scans recursively, and that the shell exposes one `Open…`
command rather than separate file/folder rows.

- [x] **Step 2: Run tests and verify the missing unified behavior fails**

Run `./scripts/test.sh unit source-open app-shell` and confirm failures refer to
the absent chooser and duplicate command.

- [x] **Step 3: Implement the shared flow**

Create `SourceOpenDialog`; replace `openFiles` and `openFolder` with one chooser
entry and one path-resolution method. Recursively scan selected folders, pass
the resulting files to `ingestPaths`, and delete `FolderScanDialog`.

- [x] **Step 4: Update interaction coverage**

Update Playwright expectations to find one `Open…` command and verify the
browser plane still reports it unavailable without a native ingest port.

- [x] **Step 5: Validate and commit**

Run `./scripts/format.sh`, `./scripts/ci.sh frontend`, and
`./scripts/test.sh e2e`; bump the patch version and commit the synchronized
manifests with the implementation.

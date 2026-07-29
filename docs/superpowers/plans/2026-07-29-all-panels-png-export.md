# All-Panels PNG Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export one PNG per panel across every workspace tab after one destination-folder prompt, while keeping focused-panel export as the default.

**Architecture:** Extend the typed export port with folder selection and a safe per-file directory write. Reuse the mounted `WorkspaceView` and existing `composePanelPng` path by rendering each tab behind the modal, writing each panel immediately, and restoring the captured workspace view state in `finally`.

**Tech Stack:** Rust 2024, Tauri 2, TypeScript, Canvas 2D, Vitest, Playwright, generated JSON protocol types.

## Global Constraints

- Use existing renderers and data structures; add no runtime dependency.
- Export every panel in every workspace tab, ordered by tab then layout.
- Focused panel remains the default PNG scope.
- All-panels export prompts for one folder and writes one file at a time.
- Restore active, focused, and maximized workspace state after every outcome.
- Preserve unrelated `.claude/settings.local.json`, `Panel 3.png`, and `good.signalscope`.

---

### Task 1: Typed folder export port

**Files:**

- Modify: `protocol/schema/scope-protocol.json`
- Modify generated: `protocol/src/generated.rs`
- Modify generated: `frontend/src/generated/protocol.ts`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `shell/src-tauri/src/lib.rs`

**Interfaces:**

- Produces: `ExportPort.pickDirectory(): Promise<string | null>`
- Produces: `ExportPort.saveFileToDirectory(directory, fileName, kind, dataBase64): Promise<string>`
- Produces: `SaveExportFileToDirectoryRequest`

- [ ] **Step 1: Write failing frontend and Rust tests**

Add a `TauriPlane` test expecting `pick_export_directory` and
`save_export_file_to_directory` invocations. Add Rust tests that accept
`plot.png` but reject paths such as `../plot.png` and `nested/plot.png`.

- [ ] **Step 2: Run tests to verify failure**

Run: `./scripts/test.sh frontend`

Expected: type or assertion failures because the port methods do not exist.

- [ ] **Step 3: Add the protocol request and implementations**

Add:

```json
"SaveExportFileToDirectoryRequest": {
  "kind": "object",
  "fields": {
    "directory": "string",
    "file_name": "string",
    "kind": "ExportFileKind",
    "data_base64": "string"
  }
}
```

Generate types through the repository workflow. Implement a Tauri folder
picker and validate `file_name` as exactly one normal path component before
joining it to the selected directory and writing decoded bytes.

- [ ] **Step 4: Run affected tests**

Run: `./scripts/test.sh frontend`

Run: `./scripts/ci.sh rust`

Expected: both pass.

### Task 2: Deterministic panel targets and restorable view state

**Files:**

- Modify: `frontend/src/app/png-export.ts`
- Create: `frontend/src/app/png-export.test.ts`
- Modify: `frontend/src/app/workspace.ts`
- Modify: `frontend/src/app/workspace.test.ts`

**Interfaces:**

- Produces: `panelPngTargets(tabs): PanelPngTarget[]`
- Produces: `WorkspaceModel.captureViewState(): WorkspaceViewState`
- Produces: `WorkspaceModel.showTabForExport(id): boolean`
- Produces: `WorkspaceModel.restoreViewState(state): void`

- [ ] **Step 1: Write failing target and state tests**

Cover tab/layout order, sanitized names, `-2` collision suffixes, full-grid
selection for a maximized tab, and exact restoration of active/focused/maximized
state.

- [ ] **Step 2: Run tests to verify failure**

Run: `./scripts/test.sh frontend`

Expected: imports fail because the helpers do not exist.

- [ ] **Step 3: Implement minimal helpers**

`panelPngTargets` walks each tab's layout cells, appends any unplaced panels,
and allocates case-sensitive unique names:

```ts
export interface PanelPngTarget {
  tabId: string;
  panelId: string;
  fileName: string;
}
```

`showTabForExport` selects a tab and clears only its maximized panel.
`restoreViewState` restores every recorded tab field and active tab directly.

- [ ] **Step 4: Run frontend tests**

Run: `./scripts/test.sh frontend`

Expected: pass.

### Task 3: Dialog scope and sequential all-tab export

**Files:**

- Modify: `frontend/src/ui/export-dialog.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/app.spec.ts`

**Interfaces:**

- Produces: `PngScope = "focused" | "all"`
- Changes: `ExportDelegate.runExport(format, range, fidelity, pngScope)`

- [ ] **Step 1: Write a failing Playwright dialog test**

Open the dialog as PNG, assert focused scope is active, click all panels,
assert the row displays the panel count, export, and assert the delegate
received `"all"`.

- [ ] **Step 2: Run e2e to verify failure**

Run: `./scripts/test.sh e2e`

Expected: the PNG scope controls are absent.

- [ ] **Step 3: Add PNG scope controls**

Add focused/all buttons using the existing flat option styles. Reset scope to
focused on every `open`. Focused displays its byte estimate; all displays the
number of files without eagerly rendering all tabs.

- [ ] **Step 4: Implement sequential export**

Generalize focused rendering to `buildPanelPng(panelId)`. For all scope:

```ts
const directory = await exporter.pickDirectory();
if (directory === null) return;
const viewState = this.workspace.captureViewState();
try {
  for (const target of panelPngTargets(this.workspace.tabs())) {
    this.workspace.showTabForExport(target.tabId);
    this.syncWorkspaceForExport();
    await this.refreshTiles();
    const bytes = await this.buildPanelPng(target.panelId);
    await exporter.saveFileToDirectory(
      directory,
      target.fileName,
      "png",
      toBase64(bytes),
    );
  }
} finally {
  this.workspace.restoreViewState(viewState);
  this.syncWorkspaceForExport();
  await this.refreshTiles();
}
```

Group targets by tab so each tab renders once, report the panel title on render
or write failure, and keep already-written files.

- [ ] **Step 5: Run frontend and e2e tests**

Run: `./scripts/test.sh frontend`

Run: `./scripts/test.sh e2e`

Expected: pass.

### Task 4: Final validation and release metadata

**Files:**

- Modify through wrapper: synchronized version manifests

- [ ] **Step 1: Format**

Run: `./scripts/format.sh`

Expected: all changed source and Markdown files are formatted.

- [ ] **Step 2: Run the complete gate**

Run: `./scripts/ci.sh all`

Expected: pass.

- [ ] **Step 3: Apply the minor version**

Run: `./scripts/version.sh bump minor`

Run: `./scripts/version.sh check`

Expected: synchronized version `0.12.0`.

- [ ] **Step 4: Re-run format and affected checks**

Run: `./scripts/format.sh`

Run: `./scripts/test.sh frontend`

Run: `./scripts/ci.sh rust`

Expected: pass.

- [ ] **Step 5: Review and commit only intended files**

Review `git diff`, leave unrelated files unstaged, and commit with a
conventional feature subject.

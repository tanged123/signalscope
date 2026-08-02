# Signal Selection Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete disconnected source alignment and the signal bulk-action footer while retaining reliable outline selection and moving manual-set creation onto SETS.

**Architecture:** Selection remains a small ephemeral model reconciled against catalog identity and cleared across workspace boundaries. SETS consumes the existing signal drag payload and exposes one visible/keyboard command for manual pick sets. Protocol v14 and session v19 remove alignment state through generated APIs and one explicit session migration rung.

**Tech Stack:** TypeScript, DOM/CSS, Vitest/jsdom, Playwright, Rust/Serde, Tauri commands, JSON schema code generation, repository shell wrappers.

## Global Constraints

- Work on the existing `multi_source_ui_improvements` staging branch; do not create or merge another branch.
- Use `apply_patch` for edits and `./scripts/*` wrappers for code generation, formatting, tests, and versioning.
- Preserve outline virtualization, selected-row rendering, shift-range selection, select-all-filtered, Escape-to-clear, and selected multi-signal drag payloads.
- Sources continue using raw stored numeric timestamps; do not add a replacement normalization path.
- Generated Rust and TypeScript protocol/session files change only through `./scripts/codegen.sh`.
- Protocol version 14 and session schema version 19 are breaking API changes with explicit docs and migration coverage.
- The final version bump is major from 2.0.0 to 3.0.0.
- Stage files explicitly and leave unrelated worktree changes untouched.

---

### Task 1: Reliable selection and manual sets on the SETS section

**Files:**

- Modify: `frontend/src/app/selection.ts`
- Modify: `frontend/src/app/selection.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/panel.test.ts`
- Modify: `frontend/src/ui/sets-list.ts`
- Modify: `frontend/src/ui/sets-list.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/styles/app.css`

**Interfaces:**

- Produces: `SelectionModel.retain(allowed: ReadonlySet<string>): void`.
- Produces: `parseSignalRefsPayload(data: string): SeriesRef[]` beside `parseSignalPayload`.
- Extends: `SetsListCallbacks` with `onSignalDrop(refs: readonly SeriesRef[]): void`.
- Consumes: existing `SIGNAL_DRAG_TYPE`, `AppShell.openSetNameRow(refs)`, and manual `NamedSet` creation.
- Produces: command `save-selection-as-set`, key `f`, `.sets-save-selection` button, and private AppShell lifecycle methods `reconcileSelection()` and `syncSelectionWorkspace()`.

- [ ] **Step 1: Add failing selection reconciliation tests**

Add to `selection.test.ts`:

```ts
it("retains only keys still present in the catalog", () => {
  const selection = new SelectionModel();
  const listener = vi.fn();
  selection.setAll(["live", "deleted"]);
  selection.onChange(listener);

  selection.retain(new Set(["live", "other"]));

  expect(selection.keys()).toEqual(["live"]);
  expect(listener).toHaveBeenCalledOnce();
  selection.selectRange(["live", "other"], "other");
  expect(selection.keys()).toEqual(["other"]);
});

it("does not notify when every selected key remains valid", () => {
  const selection = new SelectionModel();
  const listener = vi.fn();
  selection.setAll(["live"]);
  selection.onChange(listener);

  selection.retain(new Set(["live", "other"]));

  expect(listener).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the selection tests and verify RED**

Run: `./scripts/test.sh unit frontend/src/app/selection.test.ts`

Expected: FAIL because `SelectionModel.retain` does not exist.

- [ ] **Step 3: Implement `SelectionModel.retain`**

Add a method that preserves insertion order, removes keys outside `allowed`, clears `anchor` when its key is removed, and calls `notify()` exactly once only when the selected set changes:

```ts
retain(allowed: ReadonlySet<string>): void {
  const next = this.keys().filter((key) => allowed.has(key));
  if (next.length === this.selected.size) return;
  this.selected.clear();
  for (const key of next) this.selected.add(key);
  if (this.anchor !== null && !allowed.has(this.anchor)) this.anchor = null;
  this.notify();
}
```

- [ ] **Step 4: Run the selection tests and verify GREEN**

Run: `./scripts/test.sh unit frontend/src/app/selection.test.ts`

Expected: PASS.

- [ ] **Step 5: Add failing drag-payload and SETS drop tests**

In `panel.test.ts`, assert that the existing outline payload yields exact refs and malformed payloads are ignored:

```ts
expect(
  parseSignalRefsPayload(
    JSON.stringify({
      refs: [{ source_key: "run-01", channel: "temp" }],
      paths: ["run-01/temp"],
    }),
  ),
).toEqual([{ source_key: "run-01", channel: "temp" }]);
expect(parseSignalRefsPayload("not json")).toEqual([]);
expect(
  parseSignalRefsPayload(JSON.stringify({ refs: [{ source_key: 1 }] })),
).toEqual([]);
```

In `sets-list.test.ts`, provide `onSignalDrop`, dispatch `dragover`, `dragleave`, and `drop` with `SIGNAL_DRAG_TYPE`, and assert:

```ts
expect(element.classList.contains("drop-target")).toBe(true);
expect(dragover.defaultPrevented).toBe(true);
expect(element.classList.contains("drop-target")).toBe(false);
expect(onSignalDrop).toHaveBeenCalledWith([
  { source_key: "run-01", channel: "temp" },
]);
```

Update existing `SetsListView` test callbacks to include `onSignalDrop: vi.fn()`.

- [ ] **Step 6: Run the focused UI tests and verify RED**

Run: `./scripts/test.sh unit frontend/src/ui/panel.test.ts frontend/src/ui/sets-list.test.ts`

Expected: FAIL because `parseSignalRefsPayload` and `SetsListCallbacks.onSignalDrop` do not exist.

- [ ] **Step 7: Implement signal-ref parsing and SETS drop handling**

Export from `panel.ts`:

```ts
export function parseSignalRefsPayload(data: string): SeriesRef[] {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "refs" in payload &&
      Array.isArray(payload.refs) &&
      payload.refs.every(
        (ref) =>
          typeof ref === "object" &&
          ref !== null &&
          "source_key" in ref &&
          typeof ref.source_key === "string" &&
          "channel" in ref &&
          typeof ref.channel === "string",
      )
    ) {
      return payload.refs as SeriesRef[];
    }
  } catch {
    return [];
  }
  return [];
}
```

Bind SETS drag events once in `SetsListView`'s constructor. Accept only `SIGNAL_DRAG_TYPE`, add/remove `.drop-target`, prevent the accepted dragover default, parse refs on drop, and call `onSignalDrop` only for a non-empty valid payload.

- [ ] **Step 8: Run the focused UI tests and verify GREEN**

Run: `./scripts/test.sh unit frontend/src/ui/panel.test.ts frontend/src/ui/sets-list.test.ts`

Expected: PASS.

- [ ] **Step 9: Add failing AppShell tests for manual-set entry points and selection lifecycle**

Replace the bulk-action probe/tests in `app-shell.test.ts` with tests that assert:

```ts
const markup = shellMarkup();
expect(markup).toContain('class="sets-save-selection"');
```

Add a probe test for the selection command/button state:

```ts
shell.selection.clear();
shell.syncSelectionActions();
expect(saveButton.disabled).toBe(true);
shell.selection.toggle(catalog.refKey(ref));
shell.syncSelectionActions();
expect(saveButton.disabled).toBe(false);
shell.saveSelectedAsSet();
expect(setNameRow.hidden).toBe(false);
```

Add a workspace-boundary test that changes the active tab, calls `syncSelectionWorkspace()`, and expects selection to clear. Add a catalog test that selects one live and one deleted key, calls `reconcileSelection()`, and expects only the live key.

- [ ] **Step 10: Run the AppShell test and verify RED**

Run: `./scripts/test.sh unit frontend/src/ui/app-shell.test.ts`

Expected: FAIL because the SETS button and selection lifecycle methods do not exist and bulk markup remains.

- [ ] **Step 11: Implement the SETS heading, command, and lifecycle hooks**

Render:

```html
<div class="tree-heading sets-heading">
  <span>SETS</span>
  <button
    class="sets-save-selection"
    type="button"
    title="Save selected signals as set"
    disabled
  >
    ★+
  </button>
</div>
```

Register:

```ts
this.commands.register({
  id: "save-selection-as-set",
  title: "Save selected signals as set",
  keys: "f",
  enabled: () => this.selection.size() > 0,
  run: () => this.saveSelectedAsSet(),
});
```

Make the button run that command. `saveSelectedAsSet()` calls `openSetNameRow(this.selectedRefs())`. `SetsListCallbacks.onSignalDrop` calls `openSetNameRow(refs)`.

Add `syncSelectionActions()` to update `.sets-save-selection.disabled`; subscribe once to selection changes. Add `selectionWorkspaceId`, and make `syncSelectionWorkspace()` clear selection only when `workspace.activeTabId()` changes. Call it from `afterLayoutChange()`. Explicitly clear selection after `workspace.replace(...)` in new/load workspace paths. Implement `reconcileSelection()` to compute every current catalog ref key and call `selection.retain(...)`; call it from `reloadSignals()` before rendering the outline.

Style `.sets-heading` and `.sets-save-selection` as compact flat chrome using existing heading dimensions, `--fg-3`, and a border only on hover/focus. Keep `.tree-sets.drop-target` as the amber drag target.

- [ ] **Step 12: Run focused tests and the frontend unit suite**

Run:

```text
./scripts/test.sh unit frontend/src/app/selection.test.ts frontend/src/ui/panel.test.ts frontend/src/ui/sets-list.test.ts frontend/src/ui/app-shell.test.ts
./scripts/test.sh unit
```

Expected: PASS.

- [ ] **Step 13: Format and commit**

Run: `./scripts/format.sh`

Stage only Task 1 files and commit:

```text
feat(ui): save selected signals from the sets section
```

---

### Task 2: Delete the bulk footer and alignment frontend

**Files:**

- Delete: `frontend/src/ui/bulk-bar.ts`
- Delete: `frontend/src/ui/bulk-bar.test.ts`
- Delete: `frontend/src/ui/app-shell-sources.test.ts`
- Modify: `frontend/src/ui/signal-outline.ts`
- Modify: `frontend/src/ui/signal-outline.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/app/workspace.ts`
- Modify: `frontend/src/app/workspace.test.ts`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `frontend/src/styles/app.css`

**Interfaces:**

- Removes: `BulkBar`, `SignalOutlineCallbacks.onAlignSource`, `SignalOutlineView.setNonIdentitySources`, `WorkspaceModel.setSourceAlignment`, and `DataPlane.setSourceAlignment`.
- Changes: `new SignalOutlineView(listElement, selection, callbacks)` has three arguments and owns only its header/spacer rows.
- Retains: selection change callback, add-to-panel callback, derived removal, and signal drag payload behavior.

- [ ] **Step 1: Write failing absence tests**

Update `signal-outline.test.ts` so construction uses three arguments. Replace the alignment test with:

```ts
it("renders selectable source rows without alignment controls or a footer", () => {
  const { list } = viewFor(
    Catalog.build([signal("run-01", "temp"), signal("run-02", "temp")]),
  );
  list.querySelector<HTMLButtonElement>(".outline-caret")?.click();
  expect(list.querySelectorAll(".source-align")).toHaveLength(0);
  expect(list.querySelectorAll(".source-alignment-marker")).toHaveLength(0);
  expect(list.querySelector(".outline-bulk-footer")).toBeNull();
});
```

Update AppShell markup tests to assert no `.bulk-bar`, `.source-align`, or `.source-alignment-popover` strings. Remove tests for bulk style/hide/derive and the alignment popover.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `./scripts/test.sh unit frontend/src/ui/signal-outline.test.ts frontend/src/ui/app-shell.test.ts`

Expected: FAIL because the constructor still requires a footer and source rows still render alignment controls.

- [ ] **Step 3: Remove the outline footer and alignment rendering**

In `signal-outline.ts`:

- remove `onAlignSource` from callbacks;
- remove `bulkBarElement`, `nonIdentitySources`, and `setNonIdentitySources`;
- change the constructor to three arguments;
- render only `header` and `spacer` in `replaceChildren`;
- delete the source alignment marker/button branch; and
- retain derived-remove rendering unchanged.

Update all constructor sites and tests.

- [ ] **Step 4: Remove bulk-only AppShell behavior and files**

Delete the `BulkBar` import/property/construction, footer mount, `updateBulkBar`, `addSelectedToPanel`, `styleSelected`, `hideSelected`, `applyBulkStyle`, `applyBulkVisibility`, `forEachSelectedPanel`, `selectorForSelected`, and `deriveSelected`. Delete `bulk-bar.ts` and its test.

Do not remove `selectedRefs`, `saveSelectedAsSet`, `addRefsToPanel`, selector binding, panel legend style/visibility, or formula-bar derivation.

- [ ] **Step 5: Remove alignment frontend behavior**

Delete:

- AppShell `sourceSummaries`, alignment callback, non-identity propagation, `applySourceAlignment`, `sourceAlignmentIsIdentity`, `openSourceAlignment`, and cleanup map;
- `WorkspaceModel.setSourceAlignment` and its tests;
- `DataPlane.setSourceAlignment`, Tauri/Baked implementations, and `SourceAlignmentRequest` import; and
- `app-shell-sources.test.ts` after moving any surviving dock-footer assertions into `app-shell.test.ts`.

Keep `listSources()` and dock aggregate/format rendering.

- [ ] **Step 6: Delete obsolete CSS**

Remove `.source-align`, `.source-alignment-*`, `.outline-bulk-footer`, `.bulk-bar`, `.bulk-bar-*`, and descendant rules. Preserve `.tree-sets.drop-target`, selected outline rows, and SETS button styling from Task 1.

- [ ] **Step 7: Run grep and focused tests**

Run:

```text
rg -n "BulkBar|bulk-bar|source-align|source-alignment|setSourceAlignment|openSourceAlignment|applyBulkStyle|applyBulkVisibility" frontend/src frontend/tests
./scripts/test.sh unit frontend/src/ui/signal-outline.test.ts frontend/src/ui/app-shell.test.ts frontend/src/app/workspace.test.ts frontend/src/app/data-plane.test.ts
./scripts/test.sh unit
```

Expected: grep has no hits; all tests PASS.

- [ ] **Step 8: Format and commit**

Run: `./scripts/format.sh`

Stage only Task 2 files and commit:

```text
refactor(ui): remove bulk signal actions and alignment
```

---

### Task 3: Remove alignment from protocol, session, core, and shell

**Files:**

- Delete: `core/scope-core/src/alignment.rs`
- Modify: `core/scope-core/src/lib.rs`
- Modify: `core/scope-core/src/sources.rs`
- Modify: `core/scope-core/src/restore.rs`
- Modify: `core/scope-core/src/snapshot.rs`
- Modify: `core/scope-core/src/ingest/batch.rs`
- Modify: `core/scope-core/src/session.rs`
- Modify: `protocol/schema/scope-protocol.json`
- Modify: `protocol/schema/scope-session.json`
- Regenerate: `protocol/src/generated.rs`
- Regenerate: `core/scope-core/src/session/generated.rs`
- Regenerate: `frontend/src/generated/protocol.ts`
- Regenerate: `frontend/src/generated/session.ts`
- Modify: `shell/src-tauri/src/lib.rs`
- Modify: `frontend/src/app/baked-session.ts`
- Modify: `frontend/src/app/baked-session.test.ts`
- Modify: `frontend/src/app/workspace.ts`
- Modify: `frontend/src/app/workspace.test.ts`
- Modify: `frontend/src/app/history.test.ts`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `protocol/testdata/session-conformance.json`
- Modify: `frontend/tests/e2e/fixtures/roundtrip.signalscope`
- Create: `docs/adr/0031-remove-source-alignment.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/implementation-roadmap.md`

**Interfaces:**

- Protocol v14 `SourceSummary` contains only `source_id`, `source_key`, `prefix`, `path`, and `point_count`.
- Session v19 `SourceRecord` contains only `key`, `path`, `prefix`, `provider_id`, `decode_provenance`, and `reconcile_legacy`.
- Core `sources::SourceRecord` matches those identity/provenance fields.
- Produces: migration rung `18 => migrate_v18_remove_alignment(...) => 19`.

- [ ] **Step 1: Add the failing v18-to-v19 migration test**

In `session.rs`, serialize `Session::default()`, set `schema_version` to 18, add one source with all v18 alignment fields, migrate with `from_json`, and assert:

```rust
assert_eq!(session.schema_version, 19);
let serialized = serde_json::to_value(session).expect("serializes");
let source = &serialized["sources"][0];
assert!(source.get("time_domain").is_none());
assert!(source.get("scale").is_none());
assert!(source.get("offset").is_none());
assert_eq!(source["key"], "run-01");
assert_eq!(source["prefix"], "run_01");
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `./scripts/test.sh core migrates_v18_without_alignment`

Expected: FAIL because current schema version is 18 and fields remain serialized.

- [ ] **Step 3: Update both schema sources and regenerate**

In `scope-protocol.json`:

- bump `protocol_version` from 13 to 14;
- remove `SourceTimeUnit`, `SourceOriginKind`, `SourceTimeDomainSummary`, and `SourceAlignmentRequest`; and
- remove `time_domain`, `scale`, and `offset` from `SourceSummary`.

In `scope-session.json`:

- bump `schema_version` from 18 to 19;
- remove `TimeUnitState`, `OriginKindState`, and `TimeDomainState`; and
- remove `time_domain`, `scale`, and `offset` from `SourceRecord`.

Run: `./scripts/codegen.sh`

- [ ] **Step 4: Implement the session migration rung**

Add:

```rust
18 => {
    migrate_v18_remove_alignment(&mut value);
    value["schema_version"] = serde_json::json!(19);
    migrate(19, value)
}
```

Implement:

```rust
fn migrate_v18_remove_alignment(value: &mut serde_json::Value) {
    for source in value
        .get_mut("sources")
        .and_then(serde_json::Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if let Some(source) = source.as_object_mut() {
            source.remove("time_domain");
            source.remove("scale");
            source.remove("offset");
        }
    }
}
```

Remove alignment fields from `Session::default`, source test helpers, conformance fixtures, baked validation, workspace/demo defaults, and roundtrip fixtures.

- [ ] **Step 5: Run the migration test and verify GREEN**

Run: `./scripts/test.sh core migrates_v18_without_alignment`

Expected: PASS.

- [ ] **Step 6: Delete the core alignment model**

Delete `alignment.rs` and its `pub mod` entry. Reduce core `sources::SourceRecord` to identity/provenance, remove `identity_transform`, `set_time_domain`, `set_transform`, and the normalization test. Update every core fixture/constructor in restore, snapshot, ingest batch, and session tests.

- [ ] **Step 7: Delete shell alignment handling**

In `shell/src-tauri/src/lib.rs`:

- remove alignment imports and generated alignment protocol imports;
- simplify `source_summary` to identity/path/count fields;
- delete `restore_alignment` and its calls;
- simplify `core_source_record` and shell test records;
- delete `set_source_alignment`; and
- remove it from `tauri::generate_handler!`.

The tile and sample query functions remain unchanged because they already consume raw timestamps.

- [ ] **Step 8: Add ADR 0031 and update current documentation**

Record that alignment metadata was disconnected from queries, protocol v14 and session v19 delete it, existing v18 files migrate by dropping fields, and future clock normalization must transform every time-bearing API consistently. Add ADR 0031 to `docs/adr/README.md` and update `docs/implementation-roadmap.md` from schema v18 to v19 with a short removal note.

- [ ] **Step 9: Run schema/core/frontend verification**

Run:

```text
rg -n "SourceAlignmentRequest|SourceTimeDomainSummary|TimeDomainState|AffineTransform|alignment_origin|set_source_alignment|setSourceAlignment" core protocol shell frontend/src frontend/tests --glob '!**/dist/**'
./scripts/test.sh core session
./scripts/test.sh core sources
./scripts/test.sh frontend
```

Expected: grep has no hits; all tests, codegen checks, typecheck, build, and snapshot artifact checks PASS.

- [ ] **Step 10: Format and commit**

Run: `./scripts/format.sh`

Stage only Task 3 files and commit:

```text
feat(protocol)!: remove source alignment state
```

Commit body:

```text
Protocol v14 and session v19 delete alignment metadata that was never applied to tile or sample queries.
```

---

### Task 4: End-to-end behavior, design amendments, release, and verification

**Files:**

- Modify: `frontend/tests/e2e/signal-outline.spec.ts`
- Modify: `frontend/tests/e2e/workbench.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-02-channel-first-signal-outline-design.md`
- Modify: `docs/superpowers/plans/2026-08-02-channel-first-signal-outline.md`
- Modify: version manifests changed by `./scripts/version.sh bump major`

**Interfaces:**

- Verifies: `.sets-save-selection`, `F`, SETS drop target, catalog reconciliation, and absence of bulk/alignment surfaces.
- Produces: synchronized SignalScope version 3.0.0.

- [ ] **Step 1: Replace obsolete E2E expectations**

In `signal-outline.spec.ts`, replace bulk-footer set creation with:

```ts
await page.locator(".signal-search").fill("velocity_body/*");
await page.locator(".outline-scroll").focus();
await page.keyboard.press("ControlOrMeta+a");
await expect(page.locator(".sets-save-selection")).toBeEnabled();
await page.locator(".sets-save-selection").click();
await page.locator(".set-name-input").fill("all velocity");
await page.locator(".set-name-input").press("Enter");
await expect(
  page.locator(".tree-set", { hasText: "all velocity" }),
).toContainText("▣ 2");
await expect(page.locator(".bulk-bar")).toHaveCount(0);
```

Add one test that selects a row, presses `F`, cancels naming, drags that selected row onto `.tree-sets`, and saves a manual set. Assert the SETS drop target receives `.drop-target` during dragover and clears it after drop.

Add a stale-selection regression test: create a derived signal through the
formula bar, select its outline row, remove it with the row's derived-remove
button, and assert `.sets-save-selection` becomes disabled after the catalog
reload. Add a workspace-boundary regression: select a signal, create a new
workspace tab, and assert the new tab contains no selected outline rows and
the SETS save button is disabled.

In `workbench.spec.ts`, delete alignment-popover assertions and bulk-bar count assertions. Preserve outline selection and drag-to-panel coverage by asserting selected-row state and the resulting panel binding.

- [ ] **Step 2: Run E2E and verify behavior**

Run: `./scripts/test.sh e2e`

Expected: all desktop Playwright tests PASS.

- [ ] **Step 3: Amend prior design/plan history**

Append a dated amendment to the channel-first design and plan: alignment and the bulk footer are deleted; outline selection exists only for range/group/multi-drag; manual sets are created from SETS via `★+`, `F`, or drop; protocol v14/session v19 remove disconnected alignment state. Preserve historical text rather than silently rewriting it.

- [ ] **Step 4: Run the deletion grep gate**

Run:

```text
rg -n "BulkBar|bulk-bar|source-align|source-alignment|SourceAlignmentRequest|SourceTimeDomainSummary|TimeDomainState|AffineTransform|alignment_origin|set_source_alignment|setSourceAlignment" core protocol shell frontend/src frontend/tests --glob '!**/dist/**'
```

Expected: no hits.

- [ ] **Step 5: Format and run proportional complete verification**

Run:

```text
./scripts/format.sh
./scripts/format.sh --check
./scripts/ci.sh rust
./scripts/ci.sh frontend
./scripts/ci.sh e2e
./scripts/ci.sh quality
```

Expected: all affected gates PASS. If the existing spellcheck false positive remains in the untouched P6 plan, report that exact pre-existing quality limitation and leave the unrelated file unchanged.

- [ ] **Step 6: Bump and verify the major version**

Run:

```text
./scripts/version.sh bump major
./scripts/version.sh check
./scripts/format.sh
./scripts/format.sh --check
```

Expected: every release manifest reports 3.0.0 and formatting is unchanged.

- [ ] **Step 7: Review final staged and unstaged state**

Run:

```text
git status --short
git diff --check
git diff --cached --check
```

Stage only Task 4 and version files. Confirm no unrelated path is staged or modified.

- [ ] **Step 8: Commit the release integration**

Commit:

```text
feat(ui)!: remove bulk signal controls
```

Commit body:

```text
Manual sets now originate from SETS, while selection remains limited to outline navigation and drag payloads.
```

- [ ] **Step 9: Verify final branch state**

Run:

```text
git status --short
git log -6 --oneline
./scripts/version.sh check
```

Expected: clean `multi_source_ui_improvements`, implementation commits present, release manifests synchronized at 3.0.0.

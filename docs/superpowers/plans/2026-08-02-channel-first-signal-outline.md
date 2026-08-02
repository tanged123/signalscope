# Channel-first Signal Outline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the configurable signal tree-table with a quiet channel-first outline, make VALUE cursor-only, remove UNIT from the dock, and delete channel mapping from the product and session schema.

**Architecture:** Keep the existing catalog, selection model, and virtualized outline component, but reduce the outline model to fixed channel groups and series rows. Remove channel alias normalization and migrate session v17 references back to source-local channel names before schema v18 drops `channel_map`.

**Tech Stack:** TypeScript, DOM/CSS, Vitest/jsdom, Playwright, Rust/Serde, JSON schema code generation, repository shell wrappers.

## Global Constraints

- The Final Spec remains authoritative; the production UI must not import the prototype.
- The dock never reads sample arrays and remains virtualized for 10,000+ signals.
- VALUE is a fixed column and is empty unless an active cursor supplies a live series value.
- UNIT, sorting, regrouping, column picking, and channel mapping have no dock UI or outline-model state.
- Source alignment remains keyboard-accessible and visible on source series hover/focus; non-identity state uses `≠`.
- Session v17 files migrate to v18; unknown future versions still fail clearly.
- Generated Rust and TypeScript session files are changed only through `./scripts/codegen.sh`.
- Use only `./scripts/*` wrappers for formatting, tests, code generation, and versioning.
- Preserve unrelated worktree changes and stage files explicitly.

---

### Task 1: Fixed channel-first outline model and view

**Files:**

- Modify: `frontend/src/app/outline-model.ts`
- Modify: `frontend/src/app/outline-model.test.ts`
- Modify: `frontend/src/ui/signal-outline.ts`
- Modify: `frontend/src/ui/signal-outline.test.ts`
- Modify: `frontend/src/styles/app.css`

**Interfaces:**

- Consumes: `Catalog`, `CatalogSeries`, `SeriesRef`, `SelectionModel`, and `SignalOutlineCallbacks.onAlignSource(sourceKey, anchor)`.
- Produces: `buildOutlineRows(catalog, { filter, expanded })`, fixed `OutlineGroupRow`/`OutlineSeriesRow` types, and `SignalOutlineView.setLiveValues(values)` with cursor-only rendering.

- [ ] **Step 1: Replace outline-model tests with fixed channel semantics**

Use this options helper and assert collapsed-by-default groups, filter expansion, flat single-source rows, and retained virtualization:

```ts
function options(overrides: Partial<OutlineOptions> = {}): OutlineOptions {
  return { filter: "", expanded: new Set(), ...overrides };
}

it("starts multi-source channels collapsed and flattens single-source channels", () => {
  const rows = buildOutlineRows(catalog, options());
  expect(
    rows.find((row) => row.kind === "group" && row.label === "temp"),
  ).toMatchObject({ expanded: false, aggregate: "2 srcs" });
  expect(
    rows.some((row) => row.kind === "series" && row.path.endsWith("/temp")),
  ).toBe(false);
  expect(
    rows.find((row) => row.kind === "series" && row.path === "run_01/solo"),
  ).toMatchObject({ depth: 0, channel: "solo", source: "run_01" });
});

it("expands an explicit channel and forces matches open while filtering", () => {
  const expanded = buildOutlineRows(
    catalog,
    options({ expanded: new Set(["group:channel:temp"]) }),
  );
  expect(
    expanded.filter(
      (row) => row.kind === "series" && row.path.endsWith("/temp"),
    ),
  ).toHaveLength(2);
  const filtered = buildOutlineRows(catalog, options({ filter: "temp" }));
  expect(filtered.filter((row) => row.kind === "series")).toHaveLength(2);
});
```

Delete tests for source/none grouping, sorting, PTS, units, last values, aliases, and `formatTableValue`.

- [ ] **Step 2: Run the model test and verify it fails**

Run: `./scripts/test.sh unit frontend/src/app/outline-model.test.ts`

Expected: FAIL because `OutlineOptions` still requires `groupBy`, `sort`, and `collapsed`, and groups start expanded.

- [ ] **Step 3: Reduce `outline-model.ts` to fixed channel grouping**

Use these public shapes:

```ts
export interface OutlineSeriesRow {
  kind: "series";
  key: string;
  ref: SeriesRef;
  path: string;
  depth: 0 | 1;
  channel: string;
  source: string;
}

export interface OutlineGroupRow {
  kind: "group";
  key: string;
  label: string;
  expanded: boolean;
  refs: readonly SeriesRef[];
  childKeys: readonly string[];
  paths: readonly string[];
  aggregate: string;
}

export interface OutlineOptions {
  filter: string;
  expanded: ReadonlySet<string>;
}
```

Group only by `CatalogSeries.channel`. A group with one member emits one depth-0 series row. A larger group emits one group row and emits depth-1 source rows only when `options.expanded` contains its key or the filter is non-empty. Remove `GroupBy`, `OutlineColumn`, `OutlineSort`, unit/value/point aggregation, alias aggregation, and sorting helpers.

- [ ] **Step 4: Run the model test and verify it passes**

Run: `./scripts/test.sh unit frontend/src/app/outline-model.test.ts`

Expected: PASS, including the 10,000-row virtualization/performance assertion.

- [ ] **Step 5: Write failing DOM tests for the quiet outline**

Replace regrouping, unmerge, dynamic-column, sorting, and source-group alignment tests with:

```ts
it("renders fixed CHANNEL and VALUE columns with blank inactive values", () => {
  const { list, view } = viewFor(Catalog.build([signal("run-01", "temp", 42)]));
  expect(list.dataset.cols).toBe("channel,value");
  expect(list.querySelector('[data-column="unit"]')).toBeNull();
  expect(list.querySelector('[data-column="source"]')).toBeNull();
  expect(list.querySelector('[data-column="value"]')?.textContent).toBe("");
  view.setLiveValues(new Map([["run-01/temp", "9.0000"]]));
  expect(list.querySelector('[data-column="value"]')?.textContent).toBe(
    "9.0000",
  );
  view.setLiveValues(new Map());
  expect(list.querySelector('[data-column="value"]')?.textContent).toBe("");
});

it("starts channel groups collapsed and aligns source rows after expansion", () => {
  const onAlignSource = vi.fn();
  const { list, view } = viewFor(
    Catalog.build([signal("run-01", "temp"), signal("run-02", "temp")]),
    { onAlignSource },
  );
  expect(list.querySelectorAll('[data-row-kind="series"]')).toHaveLength(0);
  list.querySelector<HTMLButtonElement>(".outline-caret")?.click();
  const source = list.querySelector<HTMLElement>('[data-path="run-01/temp"]');
  source?.querySelector<HTMLButtonElement>(".source-align")?.click();
  expect(onAlignSource).toHaveBeenCalledWith(
    "run-01",
    source?.querySelector(".source-align"),
  );
  view.setNonIdentitySources(new Set(["run-01"]));
  expect(
    list.querySelector('[data-path="run-01/temp"] .source-alignment-marker')
      ?.textContent,
  ).toBe("≠");
});
```

- [ ] **Step 6: Run the DOM test and verify it fails**

Run: `./scripts/test.sh unit frontend/src/ui/signal-outline.test.ts`

Expected: FAIL because the view still renders configurable metadata columns, catalog last values, and source alignment only in source-group mode.

- [ ] **Step 7: Simplify `SignalOutlineView` and its CSS**

Implement one grid template:

```ts
this.listElement.dataset.cols = "channel,value";
this.listElement.style.setProperty(
  "--outline-columns",
  "18px minmax(88px, 1fr) 60px",
);
```

Remove grouping, sorting, width-budget, opt-in column, merge, alias, unit-conflict, and popover state/methods. Replace `collapsed` with `expanded`; toggling a group adds/removes its key. The header contains select-all, a plain CHANNEL label, and a right-aligned VALUE label. Group labels include `— N srcs` in the outline cell and append an empty VALUE cell. Series values use exactly:

```ts
const value = this.liveValues.get(row.path) ?? "";
```

Render `align` and the non-identity marker on non-derived series rows. Keep the align button visually hidden until row hover or `:focus-within`; keep `≠` visible. Preserve selection, keyboard, drag, derived removal, and virtualization behavior.

- [ ] **Step 8: Run focused frontend tests**

Run: `./scripts/test.sh unit frontend/src/app/outline-model.test.ts frontend/src/ui/signal-outline.test.ts`

Expected: PASS.

- [ ] **Step 9: Format and commit**

Run: `./scripts/format.sh`

Stage only the five Task 1 files and commit:

```text
fix(ui): restore a channel-first signal outline
```

---

### Task 2: Remove grouping controls and channel-map behavior

**Files:**

- Delete: `frontend/src/app/channel-map.ts`
- Delete: `frontend/src/app/channel-map.test.ts`
- Modify: `frontend/src/app/catalog.ts`
- Modify: `frontend/src/app/catalog.test.ts`
- Modify: `frontend/src/app/workspace.ts`
- Modify: `frontend/src/app/workspace.test.ts`
- Modify: `frontend/src/app/history.test.ts`
- Modify: `frontend/src/ui/bulk-bar.ts`
- Modify: `frontend/src/ui/bulk-bar.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`
- Modify: `frontend/src/ui/app-shell-sources.test.ts`
- Modify: `frontend/src/styles/app.css`

**Interfaces:**

- Consumes: Task 1's fixed `SignalOutlineView` callbacks and catalog identity.
- Produces: `Catalog.build(signals)` using source-local channels only, a merge-free `BulkBar`, and shell markup with a bare SIGNALS heading.

- [ ] **Step 1: Write failing catalog and shell-removal tests**

Delete mapped-catalog/workspace/history tests and add these assertions:

```ts
it("keeps differently named source-local channels separate", () => {
  const catalog = Catalog.build([
    summary("run-01", "run_01/temp", "temp"),
    summary("run-02", "run_02/temperature", "temperature"),
  ]);
  expect(catalog.channels().map((channel) => channel.name)).toEqual([
    "temp",
    "temperature",
  ]);
});
```

```ts
it("renders a quiet SIGNALS heading without table controls or suggestions", () => {
  const markup = shellMarkup();
  expect(markup).not.toContain("signal-group-select");
  expect(markup).not.toContain("outline-columns-button");
  expect(markup).not.toContain("channel-suggestions");
});
```

Update `bulk-bar.test.ts` to assert actions are exactly add, style, hide, save, and derive; no merge action exists.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `./scripts/test.sh unit frontend/src/app/catalog.test.ts frontend/src/app/workspace.test.ts frontend/src/ui/bulk-bar.test.ts frontend/src/ui/app-shell.test.ts frontend/src/ui/app-shell-sources.test.ts`

Expected: FAIL because controls, suggestion host, merge action, and catalog mapping still exist.

- [ ] **Step 3: Remove channel-map application behavior**

Change `Catalog.build` to accept only `signals`, set both `sourceChannel` and `channel` from the source-local path, and remove alias lookup fallback. Delete channel-map workspace methods and helper functions. Leave the generated `Session.channel_map` field untouched until Task 3, but stop reading or mutating it.

Delete `channel-map.ts` and its tests. Remove merge enablement and callbacks from `BulkBar`. Remove from `AppShell`:

- `ChannelAlias` and channel-map imports;
- pending merge/menu/column-picker fields;
- outline merge/unmerge callbacks;
- grouping and column-picker event bindings;
- `cycle-signal-grouping` command and shortcut;
- merge-name flow, context menu, suggestions, and helper functions;
- catalog construction with `workspace.channelMap()`; and
- grouping controls, column picker, and suggestion host markup.

Keep ordinary set naming independent from removed merge naming. Remove the matching CSS blocks for grouping controls, column popover, merge menu/suggestions, alias badges, unmerge popover, and unit conflicts.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `./scripts/test.sh unit frontend/src/app/catalog.test.ts frontend/src/app/workspace.test.ts frontend/src/app/history.test.ts frontend/src/ui/bulk-bar.test.ts frontend/src/ui/app-shell.test.ts frontend/src/ui/app-shell-sources.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the full frontend unit suite**

Run: `./scripts/test.sh unit`

Expected: PASS with no imports or selectors referring to channel-map or grouping controls.

- [ ] **Step 6: Format and commit**

Run: `./scripts/format.sh`

Stage only Task 2 files and commit:

```text
refactor(ui): remove channel mapping and outline controls
```

---

### Task 3: Remove channel mapping from session schema v18

**Files:**

- Create: `docs/adr/0030-remove-channel-mapping.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/implementation-roadmap.md`
- Modify: `protocol/schema/scope-session.json`
- Modify: `protocol/testdata/session-conformance.json`
- Modify: `frontend/tests/e2e/fixtures/roundtrip.signalscope`
- Modify: `core/scope-core/src/session.rs`
- Modify: `core/scope-core/src/session/generated.rs` (generated)
- Modify: `frontend/src/generated/session.ts` (generated)
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/baked-session.ts`
- Modify: affected Rust and TypeScript session tests

**Interfaces:**

- Consumes: v17 `channel_map: { canonical, aliases[] }[]` and all persisted `SeriesRef` locations.
- Produces: session schema v18 without channel-map types/field and `migrate_v17_channel_refs(value)`.

- [ ] **Step 1: Write the failing v17 migration test**

Add a session test that creates a valid v17 JSON value with this map:

```rust
value["channel_map"] = serde_json::json!([{
    "canonical": "temp",
    "aliases": [
        {"source_key": "run-01", "name": "temperature"},
        {"source_key": "run-02", "name": "T_amb"}
    ]
}]);
```

Place `{ "source_key": "run-01", "channel": "temp" }` in named-set refs and every panel ref location: binding refs, override target_ref, focus ref, x_ref, and color_ref. Assert `from_json` returns schema v18, has no channel-map field in serialized JSON, and each ref is rewritten to `temperature`. Include a run-02 ref rewritten to `T_amb` and an unmapped ref left unchanged.

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `./scripts/test.sh core session::tests::migrates_v17_channel_refs`

Expected: FAIL because schema version 18 and the migration rung do not exist.

- [ ] **Step 3: Amend the schema and regenerate**

Set `schema_version` to 18, remove `ChannelAlias`, `ChannelMapEntry`, and `Session.channel_map`, then run:

```text
./scripts/codegen.sh
```

Remove `channel_map` from TypeScript defaults, baked-session validation, fixtures, and conformance data.

- [ ] **Step 4: Implement the v17-to-v18 migration rung**

Add this dispatch shape:

```rust
17 => {
    migrate_v17_channel_refs(&mut value);
    value["schema_version"] = serde_json::json!(18);
    migrate(18, value)
}
```

`migrate_v17_channel_refs` builds a lookup keyed by `(source_key, canonical)` from `channel_map`, recursively visits object fields, rewrites only objects containing string `source_key` and `channel` fields that match the lookup, removes top-level `channel_map`, and leaves selector strings untouched. This catches all current and future nested `SeriesRef` locations without rewriting unrelated strings.

- [ ] **Step 5: Run schema and session tests**

Run: `./scripts/test.sh core session`

Run: `./scripts/test.sh frontend`

Expected: PASS; codegen diff check is clean and session fixtures use v18.

- [ ] **Step 6: Record the architecture change**

Create ADR 0030 with Status Accepted, Date 2026-08-02, and these decisions: channel identity is source-local; sets provide reusable grouping; session v18 drops channel mapping; v17 explicit refs migrate to aliases; selector strings retain their text and lose canonical merge semantics. Add it to `docs/adr/README.md` and amend the implementation roadmap's current session version from 17 to 18.

- [ ] **Step 7: Format and commit**

Run: `./scripts/format.sh`

Stage schema, generated outputs, migration/tests, fixtures, ADR, and roadmap explicitly, then commit:

```text
feat(session)!: remove channel mapping
```

Add the commit body:

```text
Session v18 rewrites mapped refs to source-local channel names before dropping channel_map.
```

---

### Task 4: End-to-end behavior, specification cleanup, and release validation

**Files:**

- Delete: `frontend/tests/e2e/channel-map-facets.spec.ts`
- Modify: `frontend/tests/e2e/signal-outline.spec.ts`
- Modify: `frontend/tests/e2e/workbench.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-01-signals-at-scale-design.md`
- Modify: `docs/superpowers/plans/2026-08-02-signals-at-scale-p8-tree-table.md`
- Modify: version manifests changed by `./scripts/version.sh bump major`

**Interfaces:**

- Consumes: fixed channel outline, cursor value stream, source alignment popover, session v18.
- Produces: user-level coverage and version 2.0.0-or-later manifests synchronized from the current branch version.

- [ ] **Step 1: Rewrite the Playwright outline test**

Assert:

```ts
await expect(page.locator(".signal-group-select")).toHaveCount(0);
await expect(page.locator(".outline-columns-button")).toHaveCount(0);
await expect(page.locator('[data-column="unit"]')).toHaveCount(0);
await expect(
  page.locator('.signal-outline-header [data-column="value"]'),
).toHaveText("VALUE");
await expect(
  page.locator('[data-row-kind="group"] .outline-caret').first(),
).toHaveText("▸");
```

Expand one multi-source channel, verify source rows appear, and verify its checkbox selects all children. Move the pointer into a plotted panel with cursor tracking active and assert at least one VALUE cell becomes non-empty; move out or disable cursor and assert all VALUE cells become empty. Update the source alignment test to expand a channel and click the source-row `align` action. Delete merge-suggestion and unmerge scenarios.

- [ ] **Step 2: Run E2E and verify it passes**

Run: `./scripts/test.sh e2e`

Expected: PASS for the simplified heading, collapsed groups, cursor-only values, selection, and alignment.

- [ ] **Step 3: Amend the signals-at-scale spec and P8 record**

Append a dated amendment that supersedes P8's configurable tree-table and channel-map sections: fixed channel-first outline, CHANNEL/VALUE only, blank inactive VALUE, no UNIT/sorting/regrouping/column picker, source alignment on source series, and channel mapping removed by session v18. Preserve the old text as historical context rather than silently rewriting it.

- [ ] **Step 4: Run complete relevant validation**

Run in order:

```text
./scripts/format.sh
./scripts/format.sh --check
./scripts/test.sh frontend
./scripts/test.sh core session
./scripts/test.sh e2e
```

Expected: all commands PASS.

- [ ] **Step 5: Apply and verify the required major version bump**

Run:

```text
./scripts/version.sh bump major
./scripts/version.sh check
```

Review the manifest diff and confirm every version is synchronized.

- [ ] **Step 6: Commit the final integration**

Stage only E2E, spec/plan amendments, and version manifests, then commit:

```text
chore(release): finalize the channel-first outline
```

- [ ] **Step 7: Final worktree review**

Run:

```text
git status --short
git diff --stat HEAD~4..HEAD
git log -5 --oneline
```

Expected: no unstaged or staged changes; the four implementation commits plus the approved design commit are visible.

## 2026-08-02 amendment: selection cleanup

The later selection-cleanup implementation supersedes this plan's source
alignment and bulk-footer work. Protocol v14 and session v19 remove disconnected
alignment state. Outline selection is retained only for range/group selection
and multi-signal drag payloads. Manual sets are created from SETS through `★+`,
`F`, or a selected-signal drop; panel legends own style and visibility, and the
formula editor owns derivation.

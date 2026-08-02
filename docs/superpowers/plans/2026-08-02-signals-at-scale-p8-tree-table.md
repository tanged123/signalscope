# Signals at Scale P8 — Tree-Table Consolidation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the dock's three signal surfaces — tree mode, table mode, and the channel-map dialog — into ONE virtualized outline table ("tree-table"): columns always present, rows optionally grouped (`group ← channel · source · none`), one selection model, one implementation. Tree vs table was a false dichotomy that tripled dev upkeep; the map dialog's only load-bearing feature (unmerge) moves onto the merged-channel row.

**Architecture:** A new pure module `outline-model.ts` supersedes both `tree-model.ts` and `table-model.ts`; a new `SignalOutlineView` supersedes `SignalTreeView` + `SignalTableView` + `ChannelMapView`. The SETS section (currently rendered by `SignalTreeView`) is extracted first so the tree view can be deleted cleanly. Everything renders from catalog metadata only — never sample data.

**Tech Stack:** TypeScript, CSS, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-01-signals-at-scale-design.md` — §6 as amended 2026-08-02 ("Tree-table") and the §5 P8 amendment (map view deleted, unmerge on the row). Visual authority: the updated design mock panels — §6 ("TABLE MODE — solves b, d", the wide outline) and §10 (the 280 px dock) in `docs/Signal Scope UI Design Pass/SignalScope Signals at Scale.dc.html`. Assumes P6+P7 as landed at v1.4.2 (`f73e297`).

## Global Constraints

- Use `./scripts/` wrappers only; final gate `./scripts/ci.sh frontend`; **no Rust/protocol/schema/codegen changes** — v17 stays the only schema. All new dock state (grouping, sort, collapsed set, visible columns, selection) is ephemeral, never serialized.
- The dock never touches sample data: counts, units, and last value come from `SignalSummary` metadata. 10k rows must scroll at 60 fps — virtualize, render only the window.
- No UI surface renders one element per item unbounded; the outline is virtualized, popovers are bounded.
- Amber interaction-only; every pointer action has a keyboard path; mono tabular numerals for values; micro-caps headers per the P7 conventions already in `app.css`.
- Start from a clean worktree (`git status` clean). Run `./scripts/format.sh` before staging; stage only intentional files.

## Locked decisions (do not revisit during execution)

1. **Grouping semantics.** Default `group ← channel`. A group with exactly one child renders as a flat series row (no caret, both dimensions visible via columns) — this reproduces today's single-source flattening (`ƒx derived/run_07… 1 K 0.0133` in §10). A non-empty filter forces all groups expanded (today's tree behavior). `group ← none` = flat rows, no group rows anywhere.
2. **Outline column rule.** The first column shows the grouping dimension: group label at depth 0, the child's _other_-dimension value indented at depth 1 (§6 mock: `▾ derived/temp` then `· run_01`). The second column shows the other dimension: aggregate on group rows (`8 srcs` / `5 chs`), the plain value on child rows. Headers follow: `group ← none`/`channel` → `CHANNEL`, `SOURCE`; `group ← source` → `SOURCE`, `CHANNEL`. Below 320 px pane width the second-column header abbreviates (`SRCS`/`CHS`) per §10.
3. **Columns.** Canonical set `CHANNEL · SOURCE · UNIT · VALUE`, priority in that order; `PTS` is opt-in via the `⊞ ▾` picker (the picker is built to list any future metadata column; today PTS is the only entry). As the pane narrows, columns drop right-to-left by priority — opt-in columns first, then VALUE, UNIT, SOURCE; the outline column never drops. Never squeeze, never a second layout. Min-width budget (px): checkbox 22, outline column 96, second column 84, UNIT 44, VALUE 64, PTS 56.
4. **Sorting.** Header click cycles asc → desc → none. While grouped: clicking the outline (group-dimension) column sorts the groups by label; any other column sorts children **within** groups (group order stays catalog order). With `group ← none`: classic flat sort. Ties keep stable input order (existing `compareColumn` semantics).
5. **Controls.** The SIGNALS heading row hosts exactly two controls, replacing the `tree`/`table`/`map` buttons: a `group ←` token with a styled native `<select>` (`channel`/`source`/`none` — native select = free keyboard path) and a `⊞ ▾` button opening a checkbox popover of opt-in columns (Escape closes, one popover at a time). The `toggle-dock-view` command (`mod+shift+t`) becomes `cycle-signal-grouping` ("Cycle signals grouping", same keys, cycles channel → source → none). The `open-channel-map` command and its ⌘⇧P binding are **deleted**.
6. **Row gestures (one model, superseding both old ones).** Series row: plain click toggles selection; ⇧click ranges over `filteredKeys()`; ⌘/Ctrl-click toggles; dblclick or Enter fires `onAddToPanel(refs)`; Space toggles selection; drag carries the whole selection when the row is in it, else the row; context-menu opens the existing merge popover. Group row: caret **and** row-body click expand/collapse; the checkbox (a real button, `aria-label` "Select N signals in <label>") toggles all children; dblclick adds all children to the panel; drag/context-menu as series rows over the children. ⌘A selects all filtered; Escape clears selection. Arrow/Home/End move the active row (existing table keydown model).
7. **Bulk bar.** One mount, always: the bulk bar is the outline's sticky footer row (`position: sticky; bottom: 0` inside the scroll container), visible when selection is non-empty, at every pane width. The tree-mode dock-bottom mount and the `setFooterInTable` shuffling are deleted. Bulk-bar behavior/actions unchanged (P7 treatment stands).
8. **Unmerge on the row.** The `N names` chip on a merged channel group row becomes a button; it opens a popover titled with the canonical name, listing `source: original-name` per alias (bounded by source count) and one `unmerge` action firing `onUnmerge(canonical)` — wired to the same workspace mutation `ChannelMapView` used. Escape closes; one popover at a time. `ChannelMapView`, its test, its styles, and its dialog markup are deleted. The near-match `.channel-suggestions` footer row is unchanged and becomes the only suggestion surface.
9. **Live values** keep flowing: `setLiveValues` overrides `summary.last_value` for series rows; group rows always render `—` in VALUE. VALUE formats to 4 decimals, `—` for null (keep `formatTableValue`).
10. **Selection survives regrouping** for free: keys are catalog `refKey`s, independent of row shape. Do not clear selection on group/filter/sort changes (only Escape and existing clear paths do).

---

### Task 1: Outline model (pure module)

**Files:**

- Create: `frontend/src/app/outline-model.ts`, `frontend/src/app/outline-model.test.ts`
- Delete (end of task): `frontend/src/app/tree-model.ts`, `frontend/src/app/table-model.ts` and their test files (port still-relevant cases into `outline-model.test.ts`)

**Interfaces — produces (later tasks rely on these exact shapes):**

```ts
import type { SeriesRef } from "../generated/session";
import type { Catalog } from "./catalog";

export type GroupBy = "channel" | "source" | "none";
export type OutlineColumn = "channel" | "source" | "unit" | "value" | "pts";
export interface OutlineSort {
  column: OutlineColumn;
  direction: "asc" | "desc";
}
export interface OutlineSeriesRow {
  kind: "series";
  key: string; // catalog.refKey(ref)
  ref: SeriesRef;
  path: string;
  depth: 0 | 1;
  channel: string; // canonical channel name
  source: string; // sourceName (display), never UUID
  unit: string | null;
  pts: number;
  value: number | null;
}
export interface OutlineGroupRow {
  kind: "group";
  key: string; // `group:${groupBy}:${label}`
  groupBy: "channel" | "source";
  label: string;
  expanded: boolean;
  refs: readonly SeriesRef[]; // all children
  childKeys: readonly string[]; // refKey per child
  paths: readonly string[];
  aggregate: string; // "8 srcs" | "5 chs"
  unit: string | null; // shared unit or null
  unitConflict: boolean;
  pts: number; // sum of children
  names: readonly string[]; // channel groups: distinct source-local names; source groups: []
  aliases: readonly string[]; // channel groups: "sourceName: localName"; source groups: []
}
export type OutlineRow = OutlineGroupRow | OutlineSeriesRow;

export interface OutlineOptions {
  filter: string;
  groupBy: GroupBy;
  sort: OutlineSort | null;
  collapsed: ReadonlySet<string>; // group keys
}
export function buildOutlineRows(
  catalog: Catalog,
  options: OutlineOptions,
): OutlineRow[];
// moved verbatim from tree-model.ts (they survive; their old homes do not):
export function filterCatalogSeries(
  catalog: Catalog,
  filter: string,
): CatalogSeries[];
export function virtualSlice(
  count,
  scrollTop,
  viewportHeight,
  rowHeight,
  overscan?,
): VirtualSlice;
export function formatTableValue(value: number | null): string; // moved from signal-table.ts
```

- [ ] **Step 1: Write failing table-driven tests** in `outline-model.test.ts` (build a fixture catalog with ≥2 sources × ≥3 channels, one merged channel with 2 names, one single-source channel, one derived signal):
  - `group ← channel` reproduces tree semantics: multi-source channels emit a group row followed by depth-1 series rows when expanded; the single-source channel emits one flat `kind: "series"` row (locked 1); group `aggregate` = `"N srcs"`, `pts` = sum, `unit` = shared unit or `null` + `unitConflict` when sources disagree; merged channel carries `names`/`aliases`.
  - `collapsed` containing a group key suppresses its children and sets `expanded: false`; a non-empty `filter` forces expansion regardless.
  - `group ← source` mirrors: groups labeled by `sourceName`, `aggregate` = `"N chs"`, children are that source's channels; a source with one channel flattens.
  - `group ← none` emits only series rows.
  - Filtering: `filter: "temp*"` keeps only matching series and drops empty groups (port the existing `filterCatalogSeries` selector/substring cases from `tree-model.test.ts`).
  - Sorting: flat sort asc/desc/null on each column with stable ties; grouped sort on a non-outline column reorders children within each group but not the groups; grouped sort on the outline column reorders groups by label (locked 4).
  - Perf: `Catalog.build` of 20 sources × 500 channels → `buildOutlineRows` with `group ← none` returns 10 000 rows in < 100 ms (`performance.now()` bracket).
- [ ] **Step 2:** Run `./scripts/test.sh unit outline-model` — expect FAIL (module missing).
- [ ] **Step 3: Implement `outline-model.ts`.** Move `filterCatalogSeries` + `virtualSlice` from `tree-model.ts` and `formatTableValue` from `signal-table.ts` unchanged. `buildOutlineRows`: filter → group by the chosen dimension (Map insertion order = catalog order) → flatten single-child groups → apply sort per locked 4 → emit rows honoring `collapsed`/filter-forces-expanded. Reuse the aggregation logic from `table-model.ts`'s `channelRows` (unit-set/conflict, pt sum) rather than rewriting it.
- [ ] **Step 4:** Run `./scripts/test.sh unit outline-model` — PASS.
- [ ] **Step 5:** Delete `tree-model.ts`, `table-model.ts`, and their test files; update the two remaining importers (`signal-tree.ts`, `signal-table.ts` — both die in Task 5; for now point their imports at `outline-model.ts` so the build stays green). Run `./scripts/test.sh unit` — PASS. **Commit** `feat(frontend): outline model unifies tree and table row building`.

---

### Task 2: Extract the SETS list

**Files:**

- Create: `frontend/src/ui/sets-list.ts`, `frontend/src/ui/sets-list.test.ts`
- Modify: `frontend/src/ui/app-shell.ts` (construct `SetsListView` beside the tree; move the `setNamedSets` call), `frontend/src/ui/signal-tree.ts` (delete `renderSets`, `setNamedSets`, `setsElement`, and the set callbacks)

**Interfaces — produces:**

```ts
export interface SetsListCallbacks {
  onSetBind(setId: string): void;
  onSetRemove(setId: string): void;
}
export class SetsListView {
  constructor(element: HTMLElement, callbacks: SetsListCallbacks);
  setCatalog(catalog: Catalog): void; // for live-query counts
  setNamedSets(sets: readonly NamedSet[]): void;
}
```

- [ ] **Step 1: Failing tests:** rendering named sets produces the existing row anatomy (★ name, count detail, `live`/`▣ N` badge, ✕ remove); click fires `onSetBind`; Delete key fires `onSetRemove`; drag sets `SET_DRAG_TYPE` payload `{set_id}`; empty state text `Saved sets appear here`. (Port these assertions from wherever `signal-tree.test.ts` covers sets today.)
- [ ] **Step 2: Implement by CUTTING** `renderSets` and its listeners out of `signal-tree.ts` into `SetsListView` — do not rewrite; same class names so `app.css` needs no changes. Rewire `app-shell.ts`: construct `SetsListView` on `.tree-sets`, route `setNamedSets`/`setCatalog` calls to it, pass through the existing set callbacks.
- [ ] **Step 3:** Run `./scripts/test.sh unit "sets-list|signal-tree|app-shell"` — PASS. **Commit** `refactor(ui): extract SETS list from the signal tree`.

---

### Task 3: SignalOutlineView (the one component)

**Files:**

- Create: `frontend/src/ui/signal-outline.ts`, `frontend/src/ui/signal-outline.test.ts`
- Modify: `frontend/src/styles/app.css` (outline styles; reuse/rename the `signal-table-*` grid classes — the P7 table treatment is the visual base: header micro-caps, `▣`/`▢` checks, amber-tint selected rows, footer bulk bar)

**Interfaces — produces:**

```ts
export interface SignalOutlineCallbacks {
  onSelectionChange(): void;
  onAddToPanel(refs: readonly SeriesRef[]): void;
  onRemoveDerived(path: string): void;
  onMergeChannels?(
    aliases: readonly ChannelAlias[],
    clientX: number,
    clientY: number,
  ): void;
  onUnmerge?(canonical: string): void;
}
export class SignalOutlineView {
  constructor(
    listElement: HTMLElement,
    selection: SelectionModel,
    callbacks: SignalOutlineCallbacks,
    bulkBarElement: HTMLElement, // mounted as sticky footer, locked 7
  );
  setCatalog(catalog: Catalog): void;
  setFilter(filter: string): void;
  setGroupBy(groupBy: GroupBy): void;
  getGroupBy(): GroupBy;
  cycleGroupBy(): void; // channel → source → none → channel
  setOptInColumns(columns: readonly OutlineColumn[]): void; // from the ⊞▾ picker
  setLiveValues(values: ReadonlyMap<string, string>): void;
  filteredKeys(): readonly string[]; // all filtered series refKeys, expansion-independent
  destroy(): void;
}
```

- [ ] **Step 1: Failing tests** (fixture catalog as Task 1; jsdom with stubbed `clientHeight`):
  - Renders a header row with select-all check + sortable column buttons (`aria-sort` cycles) and rows from `buildOutlineRows`; virtualization: with 1 000 rows and a 400 px viewport, DOM row count ≤ `ceil(400/22) + 17` (window + overscan + header).
  - Group row: caret glyph `▸`/`▾`; body click toggles expansion; checkbox click selects/deselects all `childKeys`; dblclick fires `onAddToPanel` with the group's `refs`; merged group renders the `N names` chip and alias sub-line (existing classes `channel-names-badge`, `channel-alias-line`), `unit?` marker on conflict.
  - Series row: plain click toggles selection; ⇧click ranges; dblclick and Enter fire `onAddToPanel([ref])`; Space toggles; derived rows show `ƒx` and ✕ firing `onRemoveDerived`; live value from `setLiveValues` wins over `last_value`; VALUE formatting per `formatTableValue`.
  - `⌘A` inside the list selects exactly `filteredKeys()`; Escape clears; selection survives `setGroupBy` (assert same keys selected after regroup — locked 10).
  - Drag: dragging a selected row serializes the whole selection (`SIGNAL_DRAG_TYPE` payload `{refs, paths}` — same shape panels already accept); dragging an unselected group row serializes its children.
  - `N names` chip click opens the unmerge popover (title = canonical, one row per alias, `unmerge` fires `onUnmerge("temp")`, Escape closes) — locked 8.
  - Bulk bar element is a child of the list container with the sticky-footer class and stays mounted across re-renders.
- [ ] **Step 2:** Run `./scripts/test.sh unit signal-outline` — FAIL.
- [ ] **Step 3: Implement.** Port mechanics, don't reinvent: virtual window + spacer from `signal-table.ts`'s `render()`; keyboard model from its `keydown()`; row selection/drag/context-menu handlers from both old views per locked 6; group-row anatomy (caret, chip, alias line, count-as-cell) from `signal-tree.ts`'s `rowElement`. Grid columns come from the current visible-column set (Task 4 narrows it; until then all requested columns render). Second-column header text follows locked 2.
- [ ] **Step 4:** Run `./scripts/test.sh unit signal-outline` — PASS. **Commit** `feat(ui): SignalOutlineView — the unified tree-table`.

---

### Task 4: Heading controls + responsive column model

**Files:**

- Modify: `frontend/src/ui/signal-outline.ts` (+test) — ResizeObserver-driven column dropping; `frontend/src/ui/app-shell.ts` (heading markup ~3765–3772: replace the `signal-view-toggle` buttons with the `group ←` select and `⊞ ▾` button), `frontend/src/styles/app.css`

- [ ] **Step 1: Failing tests:**
  - Column dropping: with canonical + PTS requested and a container width that fits everything, all five render; shrink below the budget (locked 3 min-widths) → PTS drops first, then VALUE, then UNIT, then SOURCE; the outline column and checkbox never drop; expose the computed set for assertion (e.g. `data-cols="channel,source,unit,value"` on the list element; jsdom: drive the private `applyWidth(px)` directly since ResizeObserver doesn't fire).
  - Heading controls: the select's options are `channel`/`source`/`none` and change fires `setGroupBy`; `⊞ ▾` opens a popover with a PTS checkbox toggling `setOptInColumns(["pts"])`/`([])`; Escape closes; `cycleGroupBy` steps channel → source → none → channel and the select reflects it.
  - Header abbreviation below 320 px (`SRCS`/`CHS`) per locked 2.
- [ ] **Step 2: Implement.** ResizeObserver on the list element → `applyWidth` computes visible columns from the priority list and min-width budget, sets `data-cols` and an inline `grid-template-columns`. App-shell owns the two controls (they live on the SIGNALS heading row) and calls `setGroupBy`/`setOptInColumns`.
- [ ] **Step 3:** Run `./scripts/test.sh unit "signal-outline|app-shell"` — PASS. **Commit** `feat(ui): group selector, column picker, priority-drop responsive columns`.

---

### Task 5: App-shell rewire + the deletion checklist

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` — anchors (v1.4.2): imports ~84–89, fields ~126–130, tree ctor ~440, table ctor ~467, `channelMapView` wiring ~501–541, `toggle-dock-view` command ~867, `open-channel-map` command just after, map open ~1195, filter fan-out ~1338–1344, `data-dock-view` listeners ~1421, `setCatalog` fan-out ~2651, `toggleDockView`/`setDockView`/mode-dependent `filteredKeys` ~3236–3283, dock markup ~3763–3775
- Delete: `frontend/src/ui/signal-tree.ts`, `frontend/src/ui/signal-table.ts`, `frontend/src/ui/channel-map-view.ts` + their test files (surviving assertions were ported in Tasks 2–3)

- [ ] **Step 1: Failing app-shell tests:** one `SignalOutlineView` is constructed; filter input fans out to outline only; `mod+shift+t` cycles grouping; the palette has `cycle-signal-grouping` and does NOT have `open-channel-map` or `toggle-dock-view`; the dock contains no `data-dock-view` buttons, no `.channel-map-button`, no `.table-scroll`; `onUnmerge` routes to the same workspace mutation the map view used (~lines 501–541); bulk-bar visibility still tracks selection size.
- [ ] **Step 2: Rewire.** Replace `tree`/`table` fields and ctors with one `outline` on `.tree-scroll` (rename class to `.outline-scroll`); collapse every `this.tree?.…`/`this.table?.…` call site (`setCatalog`, `setFilter`, `setLiveValues`, `setNamedSets` → sets list, `filteredKeys`); markup: delete `.table-scroll` and the three toggle buttons, add the heading controls (Task 4), move `.bulk-bar` inside the outline container. If `SignalTreeView.setSignals` still has a caller (grep), convert it to `setCatalog(Catalog.build(...))`; otherwise it dies with the file.
- [ ] **Step 3: Delete** the three view files + tests, the `dockMode`/`setDockView`/`toggleDockView`/`setFooterInTable` machinery, the map dialog styles (`channel-map-*` in `app.css` except any class the merge suggestion footer shares), and the `open-channel-map` command + ⌘⇧P binding.
- [ ] **Step 4: Grep gate** — zero hits outside `docs/` and git history:
      `grep -rn "dockMode\|setDockView\|toggleDockView\|data-dock-view\|TableGranularity\|buildTreeRows\|buildTableRows\|SignalTreeView\|SignalTableView\|ChannelMapView\|channel-map-overlay\|open-channel-map\|setFooterInTable" frontend/src frontend/tests`
- [ ] **Step 5:** Run `./scripts/test.sh unit` — PASS. **Commit** `feat(ui): one tree-table dock — tree/table/map surfaces deleted`.

---

### Task 6: E2E, perf smoke, visual acceptance, gate

**Files:**

- Modify: `frontend/tests/e2e/table-mode.spec.ts` → rename `signal-outline.spec.ts` and rewrite; `frontend/tests/e2e/channel-map-facets.spec.ts` (drop map-dialog cases, keep merge-suggestion + facet cases, add unmerge-popover case); any other spec the grep gate or selectors break; version manifests

- [ ] **Step 1: E2E:** grouped default shows channel groups; expand → source rows; group checkbox selects children and the bulk bar appears as the outline footer; ⌘A after typing a selector selects exactly the match count; `style…` on a 100+ selection produces ONE override (assert overrides length); regroup to `source` keeps the selection; sort SOURCE while grouped reorders within a group only; `group ← none` + sort VALUE is flat-sorted; merged channel's `N names` chip → popover → `unmerge` restores original channels; near-match footer row still merges; no `tree`/`table`/`map` buttons exist.
- [ ] **Step 2: Perf smoke:** load the large generated workspace (reuse the P4 perf fixture path), assert first outline paint < 100 ms after catalog set and scrolling stays virtualized (DOM row bound). No sample fetches from dock interactions (existing network-assertion pattern from the P4 gate).
- [ ] **Step 3: Screenshots:** wide dock (drag the resize handle wide) against the §6 mock; 280 px dock against §10. Save to the handoff scratch, list deltas.
- [ ] **Step 4:** `./scripts/ci.sh frontend` — PASS. `./scripts/version.sh bump minor && ./scripts/version.sh check`. **Commit**; report changed files, commands run, screenshot deltas.

---

## Remediation addendum — 2026-08-02 post-implementation review (Tasks 7–8)

Edward's visual review of the landed P8 (`f5d99df`) against §10 found the
outline unusable as rendered. Root causes, verified in code:

1. **Grid off-by-one (the main bug).** The header renders `1 + N` tracks
   (check cell + one cell per column), but data rows render only `N` cells:
   `groupElement`/`seriesElement` put caret + checkbox + label together in
   ONE "outline cell", which lands in the 22 px check track. The label is
   crushed to zero width (group rows show no name at all) and every data
   cell shifts one column left — the `3 chs` aggregate renders under
   SOURCE, unit `—` under CHS. Rows and header must share one template with
   the checkbox in its own first-track cell for BOTH row kinds.
2. **Width budget can never show §10's four columns at 280 px.** Locked
   decision 3's minimums sum to 22+96+84+44+64 = 310 px, so VALUE is always
   dropped at the default dock width — §10 shows CHANNEL·SRCS·UNIT·VALUE
   all present at 280. The budget was wrong in this plan, not in luna's
   implementation. Locked decision 3 is superseded by locked decision 11
   below. Fixed-px tracks also waste pane width; the outline column must
   flex.
3. **Control/row styling far from the mock:** the `group ←` select and
   `⊞ ▾` button render as large chrome instead of the mock's 10 px micro
   token; aggregate text (`3 chs`) duplicates the abbreviated header
   (`CHS`); numeric cells are not right-aligned tabular.

Process lesson (again): the jsdom tests asserted structure but nothing
about track alignment — the §10 screenshot comparison is part of DONE.

## Locked decisions — remediation (supersede where noted)

11. **Column template (supersedes locked 3's px budget).** Tracks:
    check 18 px · outline `minmax(88px, 1fr)` · second column 40 px ·
    UNIT 32 px · VALUE 60 px · PTS 56 px (opt-in). Canonical four fit any
    pane ≥ 238 px — never dropped at the 280 px dock. Drop order below
    that / with opt-ins that don't fit: PTS, then VALUE, then UNIT, then
    the second column; outline column and check never drop. The outline
    column is the only flexible track.
12. **Row anatomy = header anatomy.** Every row renders `1 + N` cells on
    the shared template: cell 1 = checkbox (`▣`/`▢`; button on group rows,
    marker on series rows); cell 2 = caret (group rows only) + label
    (+ `N names` badge, alias sub-line, `ƒx`, ✕); cells 3+ = data columns.
    §10 order confirmed: `▣ · ▸ temp 3 names · 9 · K · —`.
13. **Aggregate cell copy:** bare count (`9`) when the second-column
    header is abbreviated (pane < 320 px), `9 srcs`/`9 chs` when wide.
    Right-aligned tabular numerals for the second column, PTS, and VALUE;
    UNIT `--fg-3`; selected rows keep the P7 amber row tint.
14. **Heading controls restyle:** `group ← channel ▾` is a 10 px
    letter-spaced mono micro-token (`--fg-3`, no box until hover —
    `appearance: none` on the select, hairline border only on
    focus-visible), options lowercase; `⊞ ▾` matches. Same height as the
    SETS/SIGNALS headings — the controls must not inflate the heading row.
15. **Sources section (answers "what is this for"):** the per-source rows
    (`run_01.csv · 3,003 pts · align ▾`) were the P6 alignment rail. The
    outline now owns the source dimension, so the listing is duplicate UI
    and is **deleted**. What survives, unchanged, in the dock footer area:
    ingest progress, the near-match suggestion row, the aggregate
    (`N sources · M signals · X pts`), `+ source`, and the loaded-format
    readout. Alignment moves onto the outline's source group rows
    (`group ← source`): an `align ▾` button opening the existing
    `source-alignment-popover` (same `onAlignment` plumbing) and a `≠`
    marker when the transform is non-identity. Reaching it costs one
    grouping switch — acceptable for an occasional operation; do NOT add a
    context-menu system for this.

---

### Task 7: Grid alignment, column budget, mock-fidelity pass

**Files:**

- Modify: `frontend/src/ui/signal-outline.ts` (+`signal-outline.test.ts`), `frontend/src/styles/app.css` (outline + heading-control styles)

- [ ] **Step 1: Failing tests:**
  - Every rendered row has exactly `header.children.length` cells (structure parity — this is the off-by-one regression test); the group row's label cell textContent equals `row.label` (non-empty for a source group).
  - `applyWidth(280)` keeps all four canonical columns (`data-cols` includes `value`); `applyWidth(230)` drops `value` only; `applyWidth(300)` with PTS opted in drops `pts` first.
  - `--outline-columns` uses `minmax(88px, 1fr)` for the outline track and the locked fixed widths for the rest.
  - Aggregate cell reads `9` at `applyWidth(280)` and `9 srcs` at `applyWidth(400)` (locked 13, same threshold as the header abbreviation).
  - Series-row checkbox marker and group-row checkbox button both sit in cell 1 (`.outline-check-cell`); caret sits in cell 2.
- [ ] **Step 2: Implement** locked 11–12: build the template from visible columns; move the checkbox out of the outline cell into a dedicated first cell for both row kinds; caret + label (+ badges) in cell 2; drop logic re-ordered per locked 11.
- [ ] **Step 3: Styling pass** per locked 13–14: right-aligned tabular numeric cells, UNIT `--fg-3`, amber selected tint (port the P7 `signal-table` selected/hover rules to the outline classes if they died with `signal-table.ts`), compact heading token, lowercase select options.
- [ ] **Step 4:** `./scripts/test.sh unit signal-outline` — PASS. Screenshot the 280 px dock against §10 and a wide dock against §6; attach to the handoff. **Commit** `fix(ui): outline rows share the header grid; column budget fits the 280px dock`.

---

### Task 8: Delete the per-source rows; alignment onto source group rows

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`renderSourceRows` ~3388–3450, `sourceRow` ~3501, alignment popover ~3557–3640, dock markup `.source-rows` ~3719), `frontend/src/ui/signal-outline.ts` (+test), `frontend/src/ui/app-shell-sources.test.ts` or equivalent, `frontend/src/styles/app.css`

**Interfaces — produces:**

```ts
// SignalOutlineCallbacks gains:
onAlignSource?(sourceKey: string, anchor: HTMLElement): void;
// SignalOutlineView gains:
setNonIdentitySources(keys: ReadonlySet<string>): void; // drives the ≠ marker
```

- [ ] **Step 1: Failing tests:** the dock renders no `.source-row` elements and no `align ▾` outside the outline; ingest progress, `.channel-suggestions`, aggregate footer, `+ source`, and the format readout still render; with `group ← source`, a source group row shows `align ▾` firing `onAlignSource(source_key, buttonElement)` and shows `≠` iff its key is in `setNonIdentitySources`; series rows and channel group rows show neither.
- [ ] **Step 2: Implement.** Delete the per-source row rendering from `renderSourceRows` (keep everything else it renders); export/reuse the existing alignment popover builder so app-shell's `onAlignSource` opens it anchored to the outline button with the same unit/scale/offset controls and `onAlignment` commit path; app-shell feeds `setNonIdentitySources` from the source records it already holds. Group-row `align ▾` gets the source key from `row.refs[0].source_key`.
- [ ] **Step 3: Grep gate:** `grep -rn "source-row\b\|sourceRow(" frontend/src frontend/tests` → hits only in the alignment popover module and its tests.
- [ ] **Step 4:** Update e2e specs that touched `.source-row`/`align ▾` (alignment round-trip now: switch grouping to source → `align ▾` → popover → apply). `./scripts/ci.sh frontend` — PASS. `./scripts/version.sh bump patch && ./scripts/version.sh check`. **Commit** `fix(ui): per-source rows deleted; alignment lives on outline source groups`.

---

## Self-review notes (already applied)

- Decision coverage: one component/no modes → T3+T5; group semantics + one-click child select → T1/T3; ⌘A-on-query bulk workflow → T3/T6; sort-within-groups → T1; group ▾ + ⊞▾ only controls → T4; one column model + priority drop → T4; selection survives regrouping → T3 (locked 10); style… = one rule → already true (bulk bar unchanged), asserted in T6; perf/no-sample-data → T1 perf test + T6 smoke; map deletion + unmerge-on-row → T3 (popover) + T5 (deletion).
- Supersede-don't-parallel: the deletion checklist (T5 Step 4) is the phase gate, mirroring P1's bundle grep.
- Type consistency: `OutlineRow`/`GroupBy`/`OutlineColumn` (T1) are consumed by name in T3/T4; `SignalOutlineCallbacks.onAddToPanel` replaces both `onPlotSignal(s)` and `onPlotRow`; `onUnmerge(canonical: string)` matches the existing workspace mutation signature wired at app-shell ~501–541; drag payload `{refs, paths}` unchanged so panel drop code is untouched.

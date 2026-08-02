# Signals at Scale P4 — Table Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The signals dock gains an operating mode: a virtualized, sortable, selector-filtered flat table of every series (or channel), with real multi-select shared with the tree and a bulk bar — select 142 things, act once.

**Architecture:** Two new pure modules (`selection.ts`, `table-model.ts`) plus one view (`signal-table.ts`); the dock header toggles tree/table over the same catalog, filter, and selection. One small additive protocol change supplies the VALUE column from pyramid metadata (never sample scans). Bulk actions compose the P2/P3 machinery: selector overrides, named sets, `afterSeriesAdded`.

**Tech Stack:** TypeScript, Vitest, Playwright; one bounded Rust/protocol task.

**Spec:** `docs/superpowers/specs/2026-08-01-signals-at-scale-design.md` (§ "Table mode"). Read it first. Assumes P3 as landed at `5b262f3`.

## Global Constraints

- Use `./scripts/` wrappers only; `./scripts/codegen.sh` for the schema task; final gate `./scripts/ci.sh all` (one Rust-touching task ⇒ full gate).
- **Perf rule (spec):** dock and table never read sample data. Counts, units, bounds, and last value come from `SignalSummary` only. 10k rows must scroll smoothly — every row list is virtualized via `virtualSlice`; no per-row `offsetWidth` measurement; sort/filter recompute at most once per input event.
- No unbounded per-row DOM: the table renders only the virtual viewport (assert in tests by row count, not pixels).
- Amber is interaction-only; selection highlight uses the existing `--amber-3` row treatment from the design mock (drop-target semantics, not chrome).
- Every pointer action has a keyboard path (arrows/Space/Shift+arrows/⌘A documented per task).
- Run `./scripts/format.sh` before staging; stage only intentional files.

## Locked decisions (do not revisit during execution)

1. **Selection and dock view mode are ephemeral** — held by the shell, shared between tree and table, never serialized. The session schema does not change in P4 (v17 stays the only schema change of this effort). "Selection is workspace state" (spec) reads as app-level shared state, like text selection — not durable state.
2. **VALUE column source:** new additive `SignalSummary.last_value: f64?` populated in the shell from the signal's pyramid **coarsest level's final bin `last`** (coarse levels are resident by design; the values `Column` may be paged/spilled and must not be touched). No pyramid yet, or an all-NaN tail bin with null extrema → `null` → the cell renders `—`.
3. **⌘A selects all filtered rows** (the current selector/substring match set), scoped to when the dock (tree or table) has focus. This is the spec's "query → select → act" workflow.
4. **`style…`/`hide` write ONE override when possible:** if the current selection exactly equals the current filter's match set, the override targets that selector string (`target_selector`); otherwise one `target_ref` override per selected series (bounded — an explicit hand-pick is small by construction). Never 142 entries for a query-shaped selection.
5. **`derive ƒx`** is enabled when the selection spans exactly one channel (any number of sources) or a single series; it focuses the formula bar prefilled with the quoted channel name (MATLAB dialect, e.g. `'temp'`). Multi-channel selections disable the action with a title explaining why. Nothing more in P4.
6. **Channel-granularity rows** (the series/channels toggle) act on all member series: selecting a channel row selects its member series refs; bulk actions see refs, never channel objects.
7. **Tree click behavior is unchanged for plain clicks;** ⌘/Ctrl-click toggles selection, ⇧click range-selects over currently visible rows. The table uses the same modifiers plus checkbox-style glyphs (`▣`/`▢`).
8. **Sort:** click a header cycles asc → desc → unsorted (default order = catalog order). Sort keys: channel/source/unit lexicographic, pts/value numeric with nulls last. `aria-sort` is set on the active header.

---

### Task 1: `last_value` on the wire

**Files:**

- Modify: `protocol/schema/scope-protocol.json` (`SignalSummary`), `shell/src-tauri/src/lib.rs` (`signal_summary` ~106 and its call sites), a core pyramid accessor if none exists (`core/scope-core/src/pyramid.rs`)
- Generated: `protocol/src/generated.rs`, `frontend/src/generated/protocol.ts`
- Test: Rust test beside the accessor; existing shell summary tests updated

**Interfaces:**

- Produces: `SignalSummary.last_value: number | null` (TS) / `Option<f64>` (Rust).

- [ ] **Step 1:** Add `"last_value": "f64?"` to `SignalSummary` in the protocol schema; run `./scripts/codegen.sh`.
- [ ] **Step 2:** In core, locate the pyramid's coarsest level (the existing pyramid type that `lib.rs` holds per signal). If no accessor exists, add `pub fn last_finite_value(&self) -> Option<f64>` returning the final bin's `last` when finite (respecting the invariant that all-NaN bins may hold null extrema — return `None` then, do NOT fall back to scanning raw columns). Unit-test: a pyramid over `[1.0, 2.0, NaN]` tail behavior per the existing gap invariants; empty signal → `None`.
- [ ] **Step 3:** `signal_summary` gains a `last_value: Option<f64>` parameter (or a pyramid lookup at its call sites — follow how `lib.rs` already reaches pyramids for tile queries); populate everywhere it is constructed, `None` when the pyramid is absent.
- [ ] **Step 4:** Run `./scripts/test.sh core && ./scripts/test.sh shell` — PASS. Frontend compiles unchanged (`last_value` is additive/optional).
- [ ] **Step 5: Commit.** `feat(protocol): additive last_value on SignalSummary from resident pyramid metadata`

---

### Task 2: Selection model

**Files:**

- Create: `frontend/src/app/selection.ts`
- Test: `frontend/src/app/selection.test.ts`

**Interfaces — produces (Tasks 3–6 consume these exact names):**

```ts
export class SelectionModel {
  has(key: string): boolean; // key = Catalog.refKey(ref)
  size(): number;
  keys(): readonly string[]; // insertion order
  toggle(key: string): void; // also sets the range anchor
  selectRange(orderedVisible: readonly string[], toKey: string): void; // anchor→toKey inclusive
  setAll(keys: readonly string[]): void; // ⌘A payload; keeps anchor
  clear(): void;
  onChange(listener: () => void): () => void; // returns unsubscribe
}
```

- [ ] **Step 1: Failing tests:** toggle on/off; range from anchor forward and backward over a visible-key array; range with no anchor behaves like toggle; `setAll` replaces; listeners fire once per mutation; `keys()` order stable.
- [ ] **Step 2–4:** Implement (a `Set` + anchor string + listener array, ~60 lines), run `./scripts/test.sh unit selection`, commit `feat(frontend): shared dock selection model`.

---

### Task 3: Table model

**Files:**

- Create: `frontend/src/app/table-model.ts`
- Test: `frontend/src/app/table-model.test.ts`

**Interfaces — produces:**

```ts
export type TableGranularity = "series" | "channels";
export type TableColumn = "channel" | "source" | "unit" | "pts" | "value";
export interface TableSort {
  column: TableColumn;
  direction: "asc" | "desc";
} // absent = catalog order
export interface TableRow {
  key: string; // refKey for series rows; `channel:<name>` for channel rows
  refs: readonly SeriesRef[]; // 1 for series rows, N members for channel rows
  channel: string;
  source: string; // sourceName; channel rows: `<N> srcs`
  unit: string | null;
  pts: number; // channel rows: sum
  value: number | null; // channel rows: null
}
export function buildTableRows(
  catalog: Catalog,
  filter: string, // selector-first, substring fallback (same rule as the tree — reuse the P2 helper, do not reimplement)
  sort: TableSort | null,
  granularity: TableGranularity,
): TableRow[];
```

- [ ] **Step 1: Failing tests:** series granularity lists one row per catalog series with `value` from `summary.last_value`; channels granularity groups with member refs, summed pts, `value: null`; filter `temp* @ run_0[1-2]` restricts rows; substring fallback works; each sort column asc/desc including nulls-last for value; catalog order when sort is null; a 10,000-series synthetic catalog builds + `virtualSlice`s in under 250 ms (coarse CI-safe bound, one assertion).
- [ ] **Step 2–4:** Implement, run `./scripts/test.sh unit table-model`, commit `feat(frontend): dock table model — filter, sort, granularity`.

---

### Task 4: Table view

**Files:**

- Create: `frontend/src/ui/signal-table.ts`
- Test: `frontend/src/ui/signal-table.test.ts`
- Modify: dock styles (beside the tree styles — `grep -rn "tree-row" frontend/src/styles`)

**Interfaces:**

- Consumes: `buildTableRows`, `SelectionModel`, `virtualSlice`, `Catalog`.
- Produces: `SignalTableView` with `setCatalog`, `setFilter`, `setGranularity`, callbacks `{ onSelectionChange }`; drag support: dragging a selected row carries all selected refs via the existing `SIGNAL_DRAG_TYPE` payload shape (reuse `dragPayload` semantics from `signal-tree.ts`).

Grid per the design mock: header `▢ | CHANNEL | SOURCE | UNIT | PTS | VALUE` (`26px 1fr 90px 50px 60px 70px`), mono 11px, `PTS`/`VALUE` right-aligned tabular numerals, selected rows `--amber-3` background. Header cells are buttons cycling sort (locked decision 8). The series/channels granularity toggle sits in the table header row's left cell.

Interactions: click row = toggle (via `SelectionModel.toggle`); ⇧click = `selectRange` over the _currently rendered order_ (full filtered order, not just the viewport); ⌘/Ctrl-click = toggle without clearing; ⌘A (dock focused) = `setAll(filtered keys)`; Escape = `clear`. Keyboard: table container is focusable, Up/Down move an active row cursor, Space toggles, ⇧+arrows extend, Home/End jump. `aria-multiselectable="true"`, rows `role="row"` with `aria-selected`.

- [ ] **Step 1: Failing view tests:** renders only the virtual viewport for 1,000 rows (assert DOM row count < 60); click/⇧click/⌘A drive the `SelectionModel` correctly; sort click re-orders and sets `aria-sort`; granularity toggle swaps row shapes; dragstart payload carries all selected refs when dragging a selected row, only the dragged row's refs otherwise.
- [ ] **Step 2–4:** Implement, run `./scripts/test.sh unit signal-table`, commit `feat(ui): virtualized signals table with multi-select`.

---

### Task 5: Dock toggle + shared selection

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (dock markup + wiring), `frontend/src/ui/signal-tree.ts`, `frontend/src/ui/signal-tree.test.ts`, `frontend/src/ui/app-shell.test.ts`

- [ ] **Step 1:** Dock header gains the `tree | table` segmented toggle from the design mock (beside the `SIGNALS` heading; same segmented-control pattern as the panel-mode toggle in `panel.ts`). The shell owns one `SelectionModel` and the current mode; toggling swaps which view fills the dock scroll area — both receive the same catalog and filter-box value. Selection, filter, and scroll-to-top survive the toggle. Keyboard: the toggle is two buttons; add a `toggle-dock-view` command to the registry (palette + shortcut per the registry's conventions).
- [ ] **Step 2:** Tree selection: `signal-tree.ts` rows honor ⌘/Ctrl-click toggle and ⇧click range using the same `SelectionModel` and the tree's visible row order (locked decision 7 — plain click behavior unchanged). Selected rows get the `--amber-3` treatment. Channel rows select member refs (locked decision 6).
- [ ] **Step 3:** ⌘A handling in the shell keydown path (~1150): when dock has focus, `setAll` of the active view's filtered keys; `preventDefault` only then (never steal ⌘A from inputs or panels).
- [ ] **Step 4: Tests:** toggle swaps views and preserves selection; tree modifier-clicks mutate the shared model; ⌘A scoping.
- [ ] **Step 5:** Run `./scripts/test.sh unit`, commit `feat(ui): dock tree/table toggle with shared selection`.

---

### Task 6: Bulk bar

**Files:**

- Create: `frontend/src/ui/bulk-bar.ts`, `frontend/src/ui/bulk-bar.test.ts`
- Modify: `frontend/src/ui/app-shell.ts` (mount + action wiring)

The bar docks at the bottom of the signals dock whenever `selection.size() > 0`, replacing nothing (source footer sits below it): `142 selected · add to panel · style… · hide · save as set · derive ƒx` with the hint `⇧click range · ⌘A all filtered` right-aligned (mock at spec §6). All actions are buttons (keyboard reachable); the bar announces via `aria-live="polite"`.

Action semantics (wired in the shell, unit-tested against the workspace model):

- **add to panel** → `addSeriesRefs(focusedPanelId ?? addPanelRow().id, selectedRefs)` then `afterSeriesAdded` (P3 threshold applies — 142 series arrive ghosted, by design).
- **style…** → a minimal popover (reuse the inspector's slot/dash/width controls): writes per locked decision 4 — one `addSelectorOverride(panelId?…)` — note: overrides are per-panel; the style action applies to **every panel that currently resolves any selected series** (iterate panels, apply where intersecting). Test exactly this fan-out.
- **hide** → same targeting rule with `{visible: false}`.
- **save as set** → pick named set from selected refs, `nextSetId()`, name via the P2 inline name-row pattern.
- **derive ƒx** → locked decision 5: single-channel selections focus the formula bar prefilled `'channelname'`; otherwise disabled with explanatory title.

- [ ] **Step 1: Failing tests:** visibility follows selection size; count text; each action's payload (including the style fan-out across two panels and the one-override-for-query-selection rule vs per-ref for hand-picks); derive enablement logic.
- [ ] **Step 2–4:** Implement, run `./scripts/test.sh unit bulk-bar`, commit `feat(ui): bulk action bar over the dock selection`.

---

### Task 7: E2E, acceptance, gate

**Files:**

- Create: `frontend/tests/e2e/table-mode.spec.ts`
- Modify: `docs/implementation-roadmap.md`, version manifests

- [ ] **Step 1: Playwright** (existing fixtures): toggle to table; filter `temp*`; ⌘A; bulk-add to a panel → panel arrives ghosted (>4) with correct count; style… → recolor applies; save as set → set row appears with `▣ N`; VALUE column shows numbers for fixture signals (or `—` — assert cell format, not values); sort by SOURCE reorders; toggle back to tree — selection highlights persist.
- [ ] **Step 2: Acceptance re-check (spec §8):** the 10k-row build bound lives in Task 3's unit test; assert here that the dock issues **zero** sample/tile requests while table mode is open (spy on the data-plane mock the e2e fixtures already use, or assert via the request log if one exists — if neither is practical, add the assertion at unit level against `BakedPlane` call counts and say so in the handoff).
- [ ] **Step 3:** Roadmap sentence; `./scripts/ci.sh all` (Task 1 touched Rust) — PASS.
- [ ] **Step 4:** `./scripts/version.sh bump minor && ./scripts/version.sh check`; commit; report changed files, commands run, open items.

---

## Self-review notes (already applied)

- Spec coverage: tree/table toggle ✓ (T5), virtualized metadata-only table ✓ (T3/T4), series/channel granularity ✓ (T3), sortable + selector-filtered ✓ (T3/T4), real multi-select + ⇧click + ⌘A ✓ (T2/T4/T5), selection shared tree↔table ✓ (T5), bulk bar with all five actions ✓ (T6), style-writes-a-rule-not-142-entries ✓ (locked 4, T6), 10k perf ✓ (T3 bound + T7 zero-request assert), VALUE column ✓ (T1).
- Deviations locked and visible: selection/view-mode ephemeral (locked 1 — the spec's round-trip acceptance list names selectors, sets, rules, overrides, focus, channel map; selection is not in it); derive ƒx minimal (locked 5); last_value from resident pyramid only (locked 2).
- Type consistency: `SelectionModel` keys are `Catalog.refKey` strings everywhere; `TableRow.refs` feeds `addSeriesRefs`/`dragPayload` directly; `buildTableRows` filter reuses the P2 selector-fallback helper rather than a third filter implementation.

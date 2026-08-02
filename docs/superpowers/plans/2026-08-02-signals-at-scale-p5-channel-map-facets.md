# Signals at Scale P5 — Channel Map + Facet Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Name drift gets a non-destructive alias layer (canonical channels, near-match suggestions, merge gesture, map view) applied at catalog build so every surface speaks canonical names; panels gain `split by ▸ source | channel` small-multiple faceting. This completes the signals-at-scale spec.

**Architecture:** A pure `channel-map.ts` supplies normalization heuristics and merge suggestions; `Catalog.build` gains a `channelMap` parameter and canonicalizes at the one place channel identity is minted — selectors, rules, legends, tree, and table inherit canonical names with zero changes. Facets are a resolution-level grouping (`facetCells`) rendered as a DOM grid of per-cell canvases reusing the existing `prepareTimePlot` path. Frontend-only; schema v17 already carries `channel_map` and `split_by`.

**Tech Stack:** TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-01-signals-at-scale-design.md` (§ "Channel map", "Facet split"). Read it first. Assumes P4 as landed at `37e67ad` (v1.3.0).

## Global Constraints

- Use `./scripts/` wrappers only; final gate `./scripts/ci.sh frontend`; no Rust/protocol/schema/codegen changes.
- **Never auto-merge.** Suggestions are suggest-only; a wrong silent merge is worse than drift (spec). Every merge is an explicit user action.
- **Non-destructive:** original per-source names survive — in the map, in `CatalogSeries.sourceChannel`, on demand in tooltip and inspector. Unmerge restores exactly the pre-merge state.
- The facet grid is capped at 16 cells; never render one cell per dimension value unbounded (the P3 hard rule applies to cells too).
- Amber interaction-only; near-match flags use `--cmd-yellow` (the design mock's choice); unit-mismatch flags likewise text-level, no new status colors.
- Right-click is never the only path: every context-menu action also exists in the bulk bar or a palette command.
- Run `./scripts/format.sh` before staging; stage only intentional files.

## Locked decisions (do not revisit during execution)

1. **Canonicalization point:** `Catalog.build(signals, channelMap)` maps each signal's `(source_key, local name)` through the map; `CatalogSeries.channel` becomes the canonical name, `CatalogSeries.sourceChannel` keeps the original. Everything downstream (selector matching, rules, tree, table, legend, refs) uses `channel` untouched.
2. **Serialized refs are never rewritten by a merge.** Old picks/overrides/focus entries carrying pre-merge channel names resolve through an alias index in the catalog (`(source_key, sourceChannel)` → series), extending the existing `byAlias` pattern. Unmerge therefore breaks nothing either.
3. **"Keep separate" = identity entries.** Dismissing a suggestion writes `{canonical: <name>, aliases: [<the source/name pairs>]}` identity entries into `channel_map`; the suggester skips names already covered by any entry. Dismissals thereby serialize with the workspace (no new schema field).
4. **Canonical name on merge = the most common name** among the merged members (ties → lexicographically first). Renaming a canonical is unmerge + re-merge in P5; no rename editor.
5. **Suggestion heuristics** (spec: case/underscore/unit-suffix): two channel names are near-matches when `normalize()` outputs collide, where `normalize` lowercases, strips `_`/`-`/` `, and strips one trailing unit suffix from the list `c, k, f, degc, degk, degf, ms, s, v, mv, a, ma, pa, kpa, bar, pct, percent` (after an `_` separator only — `temp_c` → `temp`, but `metric` stays `metric`). Nothing fancier; false negatives are fine, false positives are not.
6. **Unit mismatch flags, never converts:** a canonical channel whose members carry ≥2 distinct non-null units gets `unitConflict: true` — flagged in tree row, table row, and map view; conversion stays a ƒx concern (spec).
7. **Merge gesture surfaces:** (a) bulk-bar action `merge as channel…` enabled when the dock selection spans ≥2 distinct channels (keyboard path); (b) tree/table row context menu with the same action (pointer path); (c) suggestions row in the tree footer and map view with `merge` / `keep`. All call the same shell handler.
8. **Facets apply to time mode only in P5.** Other modes show the `split ▸` control disabled with a title ("split applies to time panels"). The spec's facet language is time-axis-shaped; XY/FFT/histogram faceting is unspecified and out of scope.
9. **Facet color inheritance:** cells inherit panel rules minus the split dimension — when `color_by === split_by`, per-cell hues remap to the other dimension (source ↔ channel); otherwise `color_by` applies unchanged per cell. Focus/ghost semantics apply within cells as normal.
10. **Y-link is ephemeral** (defaults linked: one shared y-range across cells; unlinked: per-cell autorange). `split_by` serializes (v17 field); the link toggle does not — it is a view knob like the dock's selection, and the round-trip acceptance list does not include it.
11. **Past 16 cells:** render the first 16 in catalog order plus a final non-plot cell `+N more — tighten the selector`. No paging UI.
12. **Cursor:** the linked cursor line draws in every cell at the shared t; the cursor tooltip reads from the hovered cell only; measure/annotations stay per-cell and are disabled in facet view for P5 (annotations anchor to the unsplit plot; splitting hides them until unsplit — document in the handoff).

---

### Task 1: Channel-map module

**Files:**

- Create: `frontend/src/app/channel-map.ts`
- Test: `frontend/src/app/channel-map.test.ts`

**Interfaces — produces:**

```ts
export interface MergeSuggestion {
  names: readonly { sourceKey: string; sourceName: string; channel: string }[]; // ≥2 distinct channel names
  canonical: string; // per locked decision 4
}
export function normalizeChannelName(name: string): string; // locked decision 5
export function suggestMerges(
  catalog: Catalog,
  map: readonly ChannelMapEntry[],
): MergeSuggestion[];
export function canonicalFor(
  map: readonly ChannelMapEntry[],
  sourceKey: string,
  name: string,
): string; // name itself when unmapped
```

- [ ] **Step 1: Failing tests:** `normalizeChannelName` table (`temperature`→`temperature`, `Temp_C`→`temp`, `T_amb`→`tamb`, `tmp`→`tmp` — note `tmp`≁`temp` under these heuristics: the design mock's `tmp ≈ temp` needs edit-distance we are NOT doing; assert it is absent); `suggestMerges` groups `temp`/`Temp_C` across sources, skips names covered by map entries (including identity entries), never suggests within one source; `canonicalFor` resolves mapped and unmapped names.
- [ ] **Step 2–4:** Implement, run `./scripts/test.sh unit channel-map`, commit `feat(frontend): channel name normalization and merge suggestions`.

---

### Task 2: Catalog canonicalization

**Files:**

- Modify: `frontend/src/app/catalog.ts`, `frontend/src/app/catalog.test.ts`, call sites of `Catalog.build` (`grep -rn "Catalog.build" frontend/src` — the shell's `reloadSignals` passes `workspace` channel map; tests pass `[]`)

**Interfaces:**

- `Catalog.build(signals: readonly SignalSummary[], channelMap: readonly ChannelMapEntry[] = [])`.
- `CatalogSeries` gains `sourceChannel: string` (original local name; equals `channel` when unmapped).
- `CatalogChannel` gains `unitConflict: boolean` and `names: readonly string[]` (distinct source names, for the tree's `3 names` badge).
- `get(ref)` resolves canonical refs first, then `(source_key, sourceChannel)` aliases (locked decision 2).

- [ ] **Step 1: Failing tests:** map entry `{canonical: "temp", aliases: [{source_key: s7, name: "temperature"}, {source_key: bench, name: "T_amb"}]}` → one `CatalogChannel` named `temp` spanning all sources, `names` lists three, member series keep `sourceChannel`; old ref `{source_key: s7, channel: "temperature"}` resolves via `get`; `refFromPath` returns canonical refs; `unitConflict` true for K + °C members, false when units agree or are null; unmapped catalogs behave exactly as before (regression: existing tests pass with the default parameter).
- [ ] **Step 2–4:** Implement, update call sites, run `./scripts/test.sh unit`, commit `feat(frontend): catalog canonicalizes channels through the workspace map`.

---

### Task 3: Workspace channel-map APIs

**Files:**

- Modify: `frontend/src/app/workspace.ts`, `frontend/src/app/workspace.test.ts`

**Interfaces — produces:**

```ts
channelMap(): readonly ChannelMapEntry[];
mergeChannels(canonical: string, aliases: readonly ChannelAlias[]): void;  // replaces any entry with the same canonical
unmergeChannel(canonical: string): void;
keepSeparate(aliases: readonly ChannelAlias[]): void;   // identity entries per name (locked decision 3)
```

- [ ] **Step 1: Failing tests:** merge/unmerge round-trip; merging an already-mapped alias moves it (no duplicate aliases across entries — merging steals the alias from its old entry, dropping emptied entries); `keepSeparate` writes identity entries; history undo snapshot covers `channel_map` (extend the `history.ts` test if `channel_map` is not yet snapshotted — check `frontend/src/app/history.ts` and add it if missing).
- [ ] **Step 2–4:** Implement, run, commit `feat(frontend): workspace channel map mutations`.

---

### Task 4: Merge gesture + originals on demand + flags

**Files:**

- Modify: `frontend/src/ui/bulk-bar.ts` (+test), `frontend/src/ui/signal-tree.ts` (+test), `frontend/src/ui/signal-table.ts` (+test), `frontend/src/ui/app-shell.ts` (handler + tree-footer suggestions row), `frontend/src/ui/panel.ts` (inspector original name), tooltip helpers in `app-shell.ts` (~3350–3420)

- [ ] **Step 1: Bulk-bar merge action** (locked decision 7a): visible when the selection spans ≥2 distinct channels; opens the inline name row prefilled with the locked-decision-4 canonical; confirm → `mergeChannels` + catalog rebuild + selection cleared. Unit-test enablement and payload.
- [ ] **Step 2: Context menu** (7b): a minimal shared context-menu component in the shell (there is no precedent — keep it one function returning a positioned popover of buttons, Escape closes, reuse inspector popover styling) attached to tree and table rows via `contextmenu`; single action in P5: `Merge as channel…` (same handler). Do not let this grow into a menu framework.
- [ ] **Step 3: Suggestions row** (7c): tree footer row per the mock — `N near-matches · <summary> · merge · keep` from `suggestMerges` (computed on catalog rebuild, capped at 3 shown); `merge` applies the suggestion, `keep` calls `keepSeparate`. Both buttons keyboard-reachable. Test the row renders and both paths.
- [ ] **Step 4: Originals on demand:** cursor tooltip rows and the series inspector path row append ` (run_07: temperature)` when `sourceChannel !== channel` (tooltip: only in the hovered/itemized rows, never in ghost group rows). Tree channel rows show the `N names` badge (amber-3 chip per mock) when `names.length > 1`; tree/table/map flag `unitConflict` channels with a `--cmd-yellow` `unit?` marker. Tests for each.
- [ ] **Step 5:** Run `./scripts/test.sh unit`, commit `feat(ui): merge gesture, near-match suggestions, original names on demand`.

---

### Task 5: Channel map view

**Files:**

- Create: `frontend/src/ui/channel-map-view.ts`, `frontend/src/ui/channel-map-view.test.ts`
- Modify: `frontend/src/ui/app-shell.ts` (mount, dock-header button, palette command)

A dialog (follow `export-dialog.ts` conventions — same open/close/focus-trap pattern) titled `CHANNEL MAP — WORKSPACE`, three sections per the mock: merged entries (`temp ← run_01…06: temp · run_07: temperature · bench: T_amb`, per-entry `unmerge`), consistent channels (collapsed count line, expandable, virtualized past 30), and pending near-matches with `merge`/`keep`. Reached by a dock-header `map` button and a `open-channel-map` command registered in the registry (palette-visible; no new global shortcut — ⌘⇧P is the command palette itself and the design's "⌘⇧P" reference means reachable _via_ it).

- [ ] **Step 1: Failing tests:** renders the three sections from a workspace fixture; unmerge fires; suggestion merge/keep fire; unit-conflict entries flagged; virtualization bound.
- [ ] **Step 2–3:** Implement + wire, run, commit `feat(ui): workspace channel map view`.

---

### Task 6: Facet resolution

**Files:**

- Modify: `frontend/src/app/resolution.ts`, `frontend/src/app/resolution.test.ts`

**Interfaces — produces:**

```ts
export interface FacetCell {
  key: string; // dimension value (sourceKey or channel name)
  label: string; // sourceName or channel
  series: ResolvedSeries[]; // re-hued per locked decision 9
}
export interface FacetLayout {
  cells: FacetCell[];
  overflow: number;
} // overflow = hidden value count
export function facetCells(
  catalog: Catalog,
  panel: PanelState,
  namedSets: readonly NamedSet[],
): FacetLayout;
// panel.split_by === "none" → single cell, key "all", series = resolvePanel output verbatim
```

- [ ] **Step 1: Failing tests:** split by source over 3×2 series → 3 cells of 2, labels are sourceNames; split by channel → 2 cells of 3; `color_by === split_by` remaps per cell to the other dimension (assert hues restart per cell); `color_by !== split_by` keeps panel-level hues; 20 distinct values → 16 cells + `overflow: 4`; `"none"` passthrough equals `resolvePanel`.
- [ ] **Step 2–4:** Implement (group `resolvePanel` output; re-run hue assignment inside each cell when remapping), run, commit `feat(frontend): facet cell resolution with rule inheritance`.

---

### Task 7: Facet rendering + header control

**Files:**

- Modify: `frontend/src/ui/panel.ts` (+test), panel styles

Header gains `split ▸` (menu: `none · source · channel`, writes `setSplitBy` — add the trivial `WorkspaceModel.setSplitBy(panelId, dim)` with a test in this task) and, when split, a `⛓y` link toggle (locked decision 10). When `split_by !== "none"` and mode is `time` (locked decision 8): the plot area becomes a CSS grid (auto columns, max 4×4) of cells — each cell is a canvas + slim label strip (`--fg-3` mono 10px, the cell's `label`), rendered through the existing `prepareTimePlot`/`renderData` path with the cell's series and the shared time window; linked-y computes one range over all cells' extrema, unlinked per-cell. The legend strip shows the split dimension's count token as inert text (`split ← source · N cells`); rosters/chips still operate on the whole panel. Cursor: the shared-t line draws in each cell; hover/hit-test works per cell (tooltip from the hovered cell). Unsplit restores the single-canvas path (assert no leaked cell canvases). Annotations hidden while split (locked decision 12).

- [ ] **Step 1: Failing tests:** split renders N cell canvases + labels (bounded by cap); y-link toggle changes per-cell ranges; unsplit restores single canvas; split control disabled for `xy` mode; overflow cell text for >16 values; cursor line present in every cell (assert via the render-call fan-out, not pixels).
- [ ] **Step 2–4:** Implement, run `./scripts/test.sh unit panel`, commit `feat(ui): facet split small multiples with linked time and y`.

---

### Task 8: Acceptance, e2e, gate — spec close-out

**Files:**

- Create: `frontend/tests/e2e/channel-map-facets.spec.ts`
- Modify: `docs/implementation-roadmap.md`, version manifests

- [ ] **Step 1: Spec §8 acceptance, Playwright:** load a fixture with `temp`/`temperature`/`T_amb` drift across sources (extend `fixtures/` if none has drift — a third small CSV is fine); accept the near-match / run the merge gesture → the three plot as ONE channel in a panel bound to `temp` (assert legend/`CH` count); originals recoverable (inspector shows `(bench: T_amb)`; unmerge restores three channels). Facets: bind 4 sources × 2 channels, split by source → 4 cells; split by channel → 2; unsplit restores. Round-trip: save/reload workspace → `channel_map` and `split_by` survive (re-asserting the P1 acceptance with the last two fields now exercised).
- [ ] **Step 2: Roadmap close-out:** mark the signals-at-scale spec fully landed (P1–P5), one short paragraph; note the two documented deferrals (tooltip row expansion, facet annotations) as follow-ups.
- [ ] **Step 3: Gate.** `./scripts/ci.sh frontend` — PASS.
- [ ] **Step 4:** `./scripts/version.sh bump minor && ./scripts/version.sh check`; commit; report changed files, commands run, and the deferral list.

---

## Self-review notes (already applied)

- Spec coverage: workspace-scoped non-destructive map ✓ (T2/T3), applied at catalog build so all surfaces speak canonical ✓ (T2, locked 1), near-match suggestions on load / suggest-only ✓ (T1/T4), merge gesture from multi-select + context menu ✓ (T4, locked 7), map view from dock header + palette ✓ (T5), originals on demand in detail + cursor popup ✓ (T4), unit mismatch flags not converts ✓ (locked 6), facet split with shared time axis + y-link ✓ (T6/T7), 16-cell cap ✓ (locked 11), rule inheritance minus split dimension ✓ (T6, locked 9), cursor spans cells / measure per-cell ✓ (locked 12), unsplit restores ✓ (T7), acceptance: one-merge drift fix + full round-trip ✓ (T8).
- Deviations locked and visible: no edit-distance in heuristics so the mock's `tmp ≈ temp` is out of scope (locked 5 — conservative by the spec's own "false positives worse" rule); facets time-mode-only (locked 8); annotations hidden while split (locked 12); canonical rename via unmerge+remerge (locked 4).
- Type consistency: `ChannelMapEntry`/`ChannelAlias` are the v17 generated types; `CatalogSeries.sourceChannel` (T2) is what T4's originals-on-demand and T1's suggester consume; `FacetCell.series: ResolvedSeries[]` feeds the T7 render path unchanged.

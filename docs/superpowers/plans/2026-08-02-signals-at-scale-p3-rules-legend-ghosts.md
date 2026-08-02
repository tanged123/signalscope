# Signals at Scale P3 — Rules, Matrix Legend, Ghosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dimension-mapped coloring (`color ← source`), a selector-targeted override stack with revert, the matrix legend (count tokens + focused chips only, virtualized rosters), and ghost-by-default with the full focus interaction set.

**Architecture:** `resolution.ts` grows from override-application to full style resolution: each resolved series gets a `display` (`focus`/`rule`/`ghost`) and a rule-derived hue; overrides may now target selectors (P2 grammar). The renderer takes explicit per-series stroke styles instead of inferring dimming. The legend strip re-renders from the focus stack and dimension counts — never one element per series. Frontend-only; schema v17 already carries every field (`color_by`, `ghost_mode`, `focus`, `overrides.target_selector`).

**Tech Stack:** TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-01-signals-at-scale-design.md` (§ "Style rules", "Matrix legend", "Ghost by default"). Read it first. Assumes P2 is landed on the staging branch.

## Global Constraints

- Use `./scripts/` wrappers only; final gate `./scripts/ci.sh frontend`; no Rust/protocol/schema/codegen changes.
- **Hard rule (spec):** no UI surface renders one element per series or per dimension value unbounded. Rosters virtualize (reuse `virtualSlice` from `tree-model.ts`); inline chips render the focus stack only, capped at 8 then `+n`; the strip is one line, never wraps or scrolls.
- Color (plus opacity) is the only rule-driven visual channel. Dash and width exist solely as manual overrides — never map them to a dimension.
- Ghost stroke: `--fg-4`, 1 px, 0.5 alpha, solid, no per-series styling; ghosts stay hit-testable.
- Amber is interaction-only. Series identity must not depend on color alone (focus chips carry names). Every pointer action has a keyboard path.
- Renderer stays deterministic from tiles + viewport + tokens: styles are computed inputs, not renderer-internal state.
- Run `./scripts/format.sh` before staging; stage only intentional files.

## Locked decisions (do not revisit during execution)

1. **Display state:** `focused` = matches a focus-stack entry. `display = focused ? "focus" : panel.ghost_mode === "ghost" ? "ghost" : "rule"`. Empty focus + `"all"` → everything rule-colored, nothing dimmed (matches P2 behavior). Empty focus + `"ghost"` → everything ghosted.
2. **Hue by rule:** distinct dimension values, in first-appearance order over the resolved list, take palette slots `(index % 7) + 1`. Dimension value per series: `source` → `sourceKey`; `channel` → `channel`; `focus` → index of the matching focus entry (non-matching series in `"all"` mode fall back to source); `set` → index of the contributing binding; `attr` → `summary.unit ?? "—"`.
3. **Override stack order:** `panel.overrides` applies first-to-last; later entries win per-field. `target_ref` matches one series; `target_selector` matches via P2 `seriesMatches` (both may apply to the same series). A series with any applied override is `overridden` (◆).
4. **Overrides do not style ghosts.** For `display === "ghost"` only `visible: false` (exclusion) is honored; color/dash/width/opacity apply when the series is focus- or rule-displayed.
5. **Mute** = override `{visible: false}`: ⌥click a series mutes via `target_ref`; ⌥click a roster slice mutes via `target_selector` (`* @ run_07` for a source slice, `run_07` being the sourceName; `temp @ *` for a channel slice). Unmute = revert that override.
6. **Arrival threshold:** one add gesture (drop, ⏎, set bind, palette add) resolving ≤ 4 _new_ series auto-focuses them (append `kind: "series"` entries); > 4 new series sets `ghost_mode: "ghost"` and leaves focus untouched. Implemented once in the shell (`afterSeriesAdded`), not per call site.
7. **Migrated parity overrides stay.** P1 migration gave every legacy series an explicit override; they now read as manual overrides (◆) and revert to rule colors individually or via "revert all". No silent cleanup.
8. **`addSeriesRef` stops allocating `color_slot` overrides.** New series are rule-colored. Delete the first-free-slot code and its tests.
9. **Cursor-popup grouped rows are not click-expandable in P3** (the tooltip is hover-transient; the roster is the expansion surface). Focused series always itemize; ghosts collapse per channel with a value range. The spec's "expandable" lands with P4's persistent surfaces.
10. **Legend dimension labels** are `SRC` and `CH` (the design mock's `RUN` is its data's source naming, not a label spec).

---

### Task 1: Style resolution v2

**Files:**

- Modify: `frontend/src/app/resolution.ts`, `frontend/src/app/resolution.test.ts`

**Interfaces:**

- Consumes: `seriesMatches`/`parseSelector` from `selector.ts`, `CatalogSeries.sourceName`.
- Produces (every later task consumes these exact names):

```ts
export type SeriesDisplay = "focus" | "rule" | "ghost";
export interface ResolvedSeries {
  ref: SeriesRef;
  path: string;
  display: SeriesDisplay;
  hue: number | null; // 1..7 palette slot; null when display === "ghost"
  dash: DashStyle; // "solid" for ghosts
  width: number; // 1 for ghosts
  opacity: number; // 0.5 for ghosts
  visible: boolean;
  focused: boolean;
  overridden: boolean; // ◆ marker
}
export interface DimensionCounts {
  sources: number;
  channels: number;
}
export function resolvePanel(catalog, panel, namedSets): ResolvedSeries[]; // signature unchanged
export function dimensionCounts(
  resolved: readonly ResolvedSeries[],
): DimensionCounts;
export function appliedOverrides(
  catalog,
  panel,
): { index: number; override: SeriesOverride; matchCount: number }[];
```

`colorSlot` is deleted from `ResolvedSeries` — the compiler surfaces every consumer; they all migrate to `hue` in Tasks 3–5.

- [ ] **Step 1: Failing tests** covering each locked decision: hue assignment per dimension (`color_by: "source"` on 2×3 series → sources get slots 1,2; `"channel"` → channels get 1,2,3; 8th distinct value wraps to slot 1); focus-order hues under `color_by: "focus"`; display states for both `ghost_mode`s with empty and non-empty focus; a selector override (target selectors are full selectors — channel term first: `temp* @ run_01` widens one source's temp series across the panel; test exactly that); later-override-wins per field; ghost ignores color overrides but honors `visible: false`; `overridden` true only when an override applied; `dimensionCounts`; `appliedOverrides` matchCount.
- [ ] **Step 2: Run.** `./scripts/test.sh unit resolution` — FAIL.
- [ ] **Step 3: Implement.** Order: resolve refs (unchanged) → compute focused/display → assign rule hues by first-appearance dimension values → apply override stack (parse each `target_selector` once per resolve; a selector that fails to parse applies to nothing) → ghost style flattening last (`hue: null, dash: "solid", width: 1, opacity: 0.5`).
- [ ] **Step 4: Run.** PASS. **Step 5: Commit.** `git commit -m "feat(frontend): rule-driven style resolution with selector overrides and ghost display"`

---

### Task 2: Workspace model — rules, overrides, ghost mode

**Files:**

- Modify: `frontend/src/app/workspace.ts`, `frontend/src/app/workspace.test.ts`

**Interfaces — produces:**

```ts
setColorBy(panelId: string, dimension: StyleDimension): void;
setGhostMode(panelId: string, mode: GhostMode): void;
toggleGhostMode(panelId: string): void;
addSelectorOverride(panelId: string, selector: string, style: Partial<Pick<SeriesOverride, "color_slot" | "dash" | "width" | "opacity" | "visible">>): void;
removeOverride(panelId: string, index: number): void;
clearOverrides(panelId: string): void;
clearFocus(panelId: string): void;
focusEntries(panelId: string): readonly FocusEntry[];
```

`setSeriesOverride` keeps its signature but now merges into an existing `target_ref` override or appends (no slot allocation anywhere). In `addSeriesRef`, delete the first-free `color_slot` override creation (locked decision 8) and update its tests.

- [ ] **Step 1: Failing tests** for each method; `removeOverride` splices by index; `clearFocus` empties; `addSeriesRef` no longer writes overrides.
- [ ] **Step 2–4: Implement, run** `./scripts/test.sh unit workspace`, **commit** `feat(frontend): workspace APIs for rules, override stack, ghost mode, focus`.

---

### Task 3: Renderer takes explicit stroke styles

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`, `frontend/src/render/canvas-renderer.test.ts`, `frontend/src/ui/panel.ts` (call sites only)

**Interfaces:**

- `RenderOptions` gains `styles?: readonly SeriesStroke[]` (parallel to the tiles array), replacing `dimmed`:

```ts
export interface SeriesStroke {
  hue: number | null; // 1..7 → var(--series-N); null → var(--fg-4) ghost stroke
  dash: DashStyle;
  width: number;
  alpha: number;
}
```

- `emphasisIndex` survives for hover: emphasized series renders `alpha: min(1, alpha + 0.4)`, `width + 0.4`; with an emphasis active, non-emphasized _focused/rule_ series drop to 0.25 alpha (design: "others drop to 25%"), ghosts keep their 0.5.
- `resolveSeriesStyle`'s dash-band rollover (`color_slot` → dash cycling) is deleted with its tests — dash never derives from color anymore. Keep `SERIES_TOKENS`/`COLOR_SLOTS` exported (palette source).

- [ ] **Step 1: Failing renderer tests:** ghost stroke params (fg-4 token, 1 px, 0.5 alpha, solid); emphasis alpha math; hue → token mapping; XY/colormap paths (`PathRenderOptions.dimmed` at ~337, ~616) unchanged — they are window-dimming, not focus, leave them.
- [ ] **Step 2: Implement**, updating `panel.ts` `renderData`/`renderForMode` to build `styles` from `ResolvedSeries` (`hue/dash/width/opacity`) — the `focused`-based `dimmed[]` inference and `resolveSeriesStyle(series.color_slot, …)` calls go away.
- [ ] **Step 3: Run.** `./scripts/test.sh unit "canvas-renderer|panel"` — PASS. **Step 4: Commit.** `refactor(render): explicit per-series strokes; ghost stroke; dash decoupled from color`

---

### Task 4: Matrix legend — count tokens, rosters, focused chips

**Files:**

- Modify: `frontend/src/ui/panel.ts` (legend region ~1494–1590, markup builder), `frontend/src/ui/panel.test.ts`, dock/panel styles (`grep -rn "legend-chip\|legend-overflow" frontend/src/styles`)

**Interfaces:**

- Consumes: `dimensionCounts`, `resolvePanel` output, `virtualSlice` (import from `../app/tree-model`), `evaluateSelector` for roster search.
- Produces callbacks on `PanelCallbacks`: `onFocusToggle(id, entry: FocusEntry)`, `onMuteSelector(id, selector: string)`, `onMuteSeries(id, ref)` (wired in Task 6's shell step alongside existing ones).

Strip layout (one line): `SRC` token `N ▾` · focused source chips · `CH` token `M ▾` · focused channel/series chips · right-aligned `color ← <dimension>` readout (Task 7 opens the rules popover from it). Focus-stack chips render in stack order with color key (their resolved hue), name, `✕`; past 8 chips, one `+n` chip opening the roster pre-filtered to focused entries.

Roster popover (per dimension token): search input (selector grammar, filters rows), virtualized row list — row = dimension value: color key (when that dimension drives color), name, series count. Row interactions: hover → emphasize the slice (all matching series get `emphasisIndex` treatment — extend `setEmphasis` to accept a predicate or list); click → `onFocusToggle` with `{kind: "source"|"channel", …}`; ⌥click → `onMuteSelector` with the slice selector (locked decision 5); focused rows show ✓. Escape closes; rows are buttons (keyboard operable).

**Deletes:** `legendChip`, `updateLegend` chips-per-series, `layoutLegend` and its `offsetWidth` measurement loop, `.legend-overflow` button + menu + `closeLegendOverflow`/`setLegendOverflowOpen`/`syncLegendOverflowButton`, and their CSS. `grep -n "legend-overflow\|legendChips" frontend/src` must return nothing after this task.

- [ ] **Step 1: Failing view tests:** strip shows `SRC 8` / `CH 2` for a 16-series resolve with counts from `dimensionCounts`; zero focus → no chips, strip still one line; 3 focused entries → 3 chips with ✕ firing `onFocusToggle`; 10 focused → 8 chips + `+2`; roster renders virtualized rows (assert row count ≤ viewport, not per-series DOM); roster search filters; click/⌥click callbacks fire with correct payloads.
- [ ] **Step 2: Implement.** **Step 3: Run** `./scripts/test.sh unit panel` + deletion greps. **Step 4: Commit.** `feat(ui)!: matrix legend — dimension tokens, virtualized rosters, focus chips only`

---

### Task 5: Panel header — binding chips, focus chip, all/ghost toggle

**Files:**

- Modify: `frontend/src/ui/panel.ts` (header markup + `renderHeader` region ~526–560), `frontend/src/ui/panel.test.ts`, `frontend/src/ui/app-shell.ts` (callback wiring), styles

One chip per binding: set → `★ <name> · <count>`; query → `<selector> · <count>`; pick → one grouped chip per channel `<channel> ×N ▾`. Chip `▾` opens a small popover: member list (virtualized past 30) with per-member ✕ (`removeSeriesRef`) and a "remove binding" row (`removeBinding(panelId, index)` — add to `WorkspaceModel` with a test, mirroring `removeOverride`). Right side of header: focus chip `focus <first-name> · k/n ✕` (✕ = `clearFocus`) when focus is non-empty, and the `all` toggle button reflecting `ghost_mode` (`toggleGhostMode`), both keyboard-reachable. `x-chip`/`c-chip` stay as-is.

- [ ] **Step 1: Failing tests:** grouped pick chips collapse 8 same-channel refs into one `temp ×8` chip; set binding chip shows live count; member popover ✕ removes one ref; remove-binding removes the binding; focus chip shows `2/16` and clears; all-toggle flips ghost_mode.
- [ ] **Step 2: Implement** (chips replace nothing here — the header had no per-series chips; this is additive except that panels' legend no longer names unfocused series, so chips are now the roster entry point).
- [ ] **Step 3: Run + commit.** `feat(ui): grouped binding chips, focus chip, all/ghost toggle in panel header`

---

### Task 6: Ghost interactions on the plot

**Files:**

- Modify: `frontend/src/ui/panel.ts` (pointer handlers ~500–520, hover/hit region), `frontend/src/ui/app-shell.ts` (new callbacks + `afterSeriesAdded`), `frontend/src/app/plot-hit.ts` only if the nearest-line test needs a tolerance parameter, tests beside each

Behaviors (spec §9, all against `ResolvedSeries` and the existing hit-test):

- **Hover a ghost/any series:** nearest-line hit (generous tolerance ~6 px) → temporary emphasis + name tag `run_03 / temp — click to focus` positioned near the pointer (reuse the annotation/tooltip element pattern at `app-shell.ts` `tooltipRow`; the tag is per-panel, `--surface-2`, mono 10 px).
- **Click** (no modifier) on a hit series → `toggleFocus(panelId, {kind: "series", ref})` via `onFocusToggle`.
- **⌥click** → mute (`onMuteSeries` → override `visible: false`).
- **Tab/⇧Tab** while the panel is focused and the cursor is active: walk to the neighboring series ordered by value at cursor t (order from the cursor readout values the panel already computes; when cursor is off, resolved order) — moves the temporary emphasis; Enter pins focus on the emphasized series.
- **Esc** → clear temporary emphasis; if none, `clearFocus`.
- **`afterSeriesAdded(panelId, addedRefs)`** in `app-shell.ts`, called by every add path (signal drop, set drop/click, ⏎ bind, palette add): locked decision 6. Unit-test the threshold logic directly.

- [ ] **Step 1: Failing tests** (panel-level where DOM-testable, plot-hit unit tests for tolerance/ordering; keyboard walk as a unit test over the ordering function).
- [ ] **Step 2: Implement.** **Step 3: Run** `./scripts/test.sh unit`. **Step 4: Commit.** `feat(ui): ghost hover, click-to-focus, mute, tab walk, arrival threshold`

---

### Task 7: Rules popover + inspector as override editor

**Files:**

- Modify: `frontend/src/ui/panel.ts` (inspector region ~1595–1700, new rules popover from the `color ←` readout), `frontend/src/ui/panel.test.ts`, styles

Rules popover (from the legend's `color ← <dim>` token): five dimension rows (`focus/source/channel/set/attr`) — click sets `color_by` (one action recolors the whole panel — spec acceptance); below, `OVERRIDES · n` listing `appliedOverrides` rows: ◆, target text (`ref` path or selector), the overridden fields, and `revert` (→ `removeOverride(index)`); footer `revert all` (→ `clearOverrides`). Virtualize the list past 30.

Inspector changes (it already writes overrides via `setSeriesOverride`): add a ◆ + `revert` row when the series has a `target_ref` override; delete the highlight/clear-highlight actions (focus lives on legend/plot/roster now); color swatches/dash/width stay and keep writing the override. Chip ◆ markers: focus chips and roster rows for overridden series render the ◆.

- [ ] **Step 1: Failing tests:** dimension row click fires `onSetColorBy`; override rows list target text + revert fires with the right index; revert-all; inspector ◆/revert; highlight action gone (`grep -n "highlight" frontend/src/ui/panel.ts` → only CSS-class leftovers you also remove).
- [ ] **Step 2: Implement.** **Step 3: Run + commit.** `feat(ui): style rules popover and override editor with revert`

---

### Task 8: Cursor popup grouping, e2e, gate

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (tooltip build ~2380–2400), `frontend/src/ui/app-shell.test.ts`, `frontend/tests/e2e/` (new `focus-and-rules.spec.ts`), `docs/implementation-roadmap.md`, version manifests

- [ ] **Step 1: Tooltip grouping:** past 12 rows — focused series itemize (color key, name, value); ghosts collapse to one row per channel `<channel> · N ghosts · <min> → <max>` (locked decision 9). Unit-test the row-building function with 16 ghost + 2 focused series.
- [ ] **Step 2: Playwright:** load the multi-source fixture; bind 16 series (> 4 → arrives ghosted, focus empty — assert ghost stroke count via canvas probe or legend state); click a plot line → focus chip appears; legend `SRC` roster → click one source → whole-source focus (spec acceptance: isolate one run = one click); switch `color ← channel` in rules popover → assert re-render without error; override revert round-trip; workspace save/reload → focus, ghost_mode, color_by, overrides all round-trip (spec acceptance).
- [ ] **Step 3: Deletion sweep:** `grep -rn "legend-overflow\|legendChips\|color_slot" frontend/src/ui frontend/src/render` — `color_slot` survives only in `workspace.ts`/`resolution.ts` (override field) and generated types.
- [ ] **Step 4: Gate.** `./scripts/ci.sh frontend` — PASS.
- [ ] **Step 5: Version.** `./scripts/version.sh bump minor && ./scripts/version.sh check`; commit; report changed files, commands, open items.

---

## Self-review notes (already applied)

- Spec coverage: `color_by` rules ✓ (T1/T2/T7), selector overrides + ◆ + revert ✓ (T1/T7), matrix legend + rosters + focused-only chips ✓ (T4), grouped header chips ✓ (T5), ghost render ✓ (T3), full §9 interaction set ✓ (T6), arrival threshold ✓ (T6), cursor grouping ✓ (T8), one-action recolor + one-click isolate acceptance ✓ (T7/T8 e2e), round-trip re-assert ✓ (T8). Deletions: per-series legend + reflow loop + `+N` ✓ (T4), slot allocation ✓ (T2), dash-band rollover ✓ (T3), highlight actions ✓ (T7).
- Deviations locked and visible: decision 9 (tooltip expansion deferred to P4), decision 10 (SRC/CH labels), decision 7 (parity overrides stay).
- Type consistency: `ResolvedSeries.hue` (T1) is what T3 `SeriesStroke.hue`, T4 chips, and T7 swatches consume; `onFocusToggle`/`onMuteSelector`/`onMuteSeries` names match between T4 and T6; `removeBinding` defined in T5 where first used.

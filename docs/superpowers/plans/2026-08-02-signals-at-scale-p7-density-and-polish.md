# Signals at Scale P7 — Density, Anatomy, and Surface Polish Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fit-and-finish gap between the implementation and the design mocks: dock density and tree anatomy, the legend strip's full detail (ghost token, chip keys, readouts), table mode's visual/bulk-bar treatment, the style-rules popover anatomy, and chrome copy/aggregation. The mocks in `docs/Signal Scope UI Design Pass/SignalScope Signals at Scale.dc.html` (§3, §4, §6, §10) are the pixel authority.

**Architecture:** No new machinery — every task restyles or completes surfaces P2–P6 already built, against data the catalog/resolution layer already provides. The design's quality comes from compressing chrome into 10–11px letter-spaced mono micro-labels, right-aligned count columns, and exactly one accent (amber) doing interaction work; that is the standard each task is measured against.

**Tech Stack:** TypeScript, CSS, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-01-signals-at-scale-design.md` (as amended 2026-08-02). Runs AFTER P6 — it assumes the legend strip, ⇧click gestures, and `align ▾` popover exist. Do not modify P6 surfaces except where a task below names them.

## Global Constraints

- Use `./scripts/` wrappers only; final gate `./scripts/ci.sh frontend`; no Rust/protocol/schema/codegen changes.
- Final Spec + AUDIT v3 mocks govern visuals: flat surfaces, 1px seams, radii ≤ 4px (existing 2px convention stays), amber interaction-only, `--series-*` for data color, mono tabular numerals for values. Light theme must keep working — every new color is a token, never a literal.
- No unbounded per-item UI; anything new that lists items virtualizes past a threshold.
- Datatip/cursor-dot colors derive from the series line color — this is correct behavior, do not "fix" it to amber (Edward, 2026-08-02).
- Run `./scripts/format.sh` before staging; stage only intentional files.

## Locked decisions (do not revisit during execution)

1. **Dock filter block (from §10):** input row ≤ 26 px; the `/` glyph sits outside the input; the box border is `--border-strong` idle → `--amber-5` while focused or holding a valid selector; the match-count line (`16 signals · 8 sources` left, `⏎ add · ⌘S set` right, 9.5–10 px) renders whenever the input is non-empty — not only for valid selectors (fallback mode shows `N matches`).
2. **Tree row anatomy (from §10):** light `▸`/`▾` carets (text glyphs, `--fg-3`, no solid triangles); source counts right-aligned as a column (`--fg-3`, 10 px), never inline after an em-dash; merged channels show the amber `N names` chip and an indented alias sub-line (`run_01…06: temp · run_07: temperature`, `--fg-3` 10 px); derived rows lead with an amber `ƒx` glyph; the near-match footer row uses `--cmd-yellow` for the count and amber for `merge`.
3. **Dock footer (from §10):** the rail closes with the aggregate `N sources · M signals` + right-aligned `X pts`, and a second line `+ source` + a right-aligned format readout. The readout shows the formats **actually loaded** — distinct extensions of the loaded sources' paths, uppercased, deduped, `·`-separated (one CSV source → `CSV`; CSV + MCAP → `CSV · MCAP`) — not a static label. Only the empty workspace shows the supported-format hint `CSV · MCAP` as a load affordance. `+ source` opens the load dialog; the readout is inert. This replaces whatever the spinner-stack deletion (P6 Task 3) left behind; sits below the source rows.
4. **Strip details (from §4/§10, additive to P6 Task 2):** (a) a focused source-slice chip renders one dash-key per focused/rendered channel of that source (the mock's `run_07` chip carries teal+cyan keys) — keys come from each channel's resolved hue; (b) the right-side readout is `color ← <dim> · line style flat · <gesture hints>`, where `line style flat` flips to `line style ◆ overridden` when any dash/width override applies; (c) when `ghost_mode === "ghost"` and ghost count > 0, a `N ghosts ▾` token renders before the hints, opening the roster pre-filtered to ghosts; (d) when a dimension has exactly one focused value among many, its count token reads `<name> +N ▾` (the mock's `temp +11 ▾`), otherwise `<count> ▾`.
5. **Table treatment (from §6):** the bulk bar is the table's own footer row (not a separate dock-bottom bar) — `142 selected` in `--fg-1`, actions as amber text-links separated by spaces, right-aligned hint `⇧click range · ⌘A all filtered` in `--fg-4`; move the existing bulk-bar component's mount point and restyle, keep its behavior/tests. Selected rows get the `--amber-3` full-row tint with `▣`; unselected show `--fg-4` `▢`. Header cells are 10 px letter-spaced micro-caps; UNIT renders `--fg-3`; PTS/VALUE right-aligned tabular; VALUE formats to 4 decimals, `—` for null.
6. **Style-rules popover (from §3):** exact anatomy — title `STYLE RULES — PANEL N`; three rule rows: `color ← <dimension>` (the interactive row; clicking the dimension opens the five-option choice; the row's right side shows the 8-swatch palette strip), `dash ← — flat`, `width ← — flat` (both `--fg-4`, non-interactive, they document that line style is not a data channel); then `OVERRIDES · n` rows: color/dash key · target text (`run_07 / derived/temp` or the selector) · `--fg-4` field summary (`width 2.5 · highlight`) · amber `revert`; footer `revert all`. Replace the current five-row dimension list with this layout; behavior (callbacks) unchanged.
7. **Chrome:** active workspace tab drops to `--surface-0` with an inset top seam (`box-shadow: inset 0 1px 0 var(--border-strong)` per the mock); the status-bar left cluster aggregates (`N sources · M signals · X pts · render …`) — same fix P6 makes for the title bar, applied here; the formula bar idle state shows `derived/name = expression · drop signals here` in `--fg-4`.
8. **Plot left gutter** tightens toward the mock's ~56 px to the y-spine (tick labels end-aligned at spine − 8); do not clip 5-digit tick labels — clamp the tightening to the widest current label.
9. **Annotations tray:** check the Final Spec (`design_handoff_signalscope_ui/SignalScope Final Spec.dc.html`) for a specified annotations list surface. If specified, keep it but hide the tray entirely when the panel has zero annotations. If not specified, the tray renders only while annotations exist and collapses behind the header Σ toggle otherwise. Either way: never a permanent empty strip (the §10 mock has no tray).
10. **Table double-click** = add that row's refs to the focused panel (the one obvious missing affordance for "useful": act on a single row without the bulk bar). Keyboard: Enter on the active row does the same.

---

### Task 0: Facet split renders blank + interactions dead (functional — do this first; cherry-pickable ahead of the rest)

**Files:**

- Modify: `frontend/src/ui/panel.ts` (`renderFacetTime` ~1093–1140, `clearFacetGrid`), `frontend/src/ui/panel.test.ts`, `frontend/src/styles/app.css` (`.facet-grid` template)

**Root causes (verified):** (1) each facet cell's canvas is rendered **before** it is appended to the DOM; `surface.ts:20` sizes from `canvas.clientWidth/clientHeight`, which are 0 detached → every cell paints a 1×1 px backing store. (2) `renderFacetTime` hides the panel `overlay`, killing all pointer interactions (hover, ⇧click, cursor tooltip) in facet view. (3) `.facet-grid` hardcodes `repeat(4, 1fr)` tracks regardless of cell count.

- [ ] **Step 1: Failing tests:** with 8 cells and non-empty tiles, each `.facet-cell-canvas` has a backing store larger than 1×1 after render (jsdom: assert the render call received a non-degenerate layout, or stub `clientWidth` post-attach — follow how existing canvas tests fake dimensions); hover over a cell emits emphasis/name-tag for that cell's series; ⇧click in a cell fires `onFocusToggle`; grid uses `ceil(sqrt(n))` columns (assert inline style/CSS var, e.g. 8 cells → 3 columns wide... use `cols = ceil(sqrt(n))`, `rows = ceil(n / cols)`).
- [ ] **Step 2: Fix render order:** build all cell elements, append them to `facetGrid` (which is already visible), **then** run each cell's `renderer.render` — reading `clientWidth` after attachment forces layout synchronously, so no rAF deferral is needed. Keep the existing per-cell `CanvasRenderer`.
- [ ] **Step 3: Restore interactions:** keep the overlay hidden (it belongs to the single-plot surface) but delegate `pointermove`/`click`/`pointerleave` on `facetGrid`: resolve the target cell, translate coordinates into the cell's renderer layout, and reuse the Task-1-of-P6 hit adapter path against that cell's series and prepared plot. The shared-t cursor line (`renderFacetCursor`) is unchanged; the tooltip reads from the hovered cell only (P5 locked decision 12 stands).
- [ ] **Step 4: Adaptive tracks** per Step 1's formula (set `grid-template-columns/rows` inline or via CSS custom properties from the cell count; the 16-cap + overflow cell is unchanged).
- [ ] **Step 5: Disambiguate the two splits (the naming collision):** the facet control keeps `split ▸`; the layout-split control loses the word `split` — glyph-only `→` and `↓` buttons with tooltips `Split panel right — new panel` / `Split panel down — new panel` and unchanged aria-labels. Facet cells are views of one binding (spec §7), layout splits create real panels; the labels must stop claiming otherwise.
- [ ] **Step 6:** `./scripts/test.sh unit panel` — PASS; then a manual/e2e smoke: split by source on an 8-source workspace shows 8 populated mini plots. **Commit** `fix(ui): facet cells render after attach, per-cell interactions, adaptive grid, split naming`.

---

### Task 1: Dock — filter block, tree anatomy, footer

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (dock markup + count line), `frontend/src/ui/signal-tree.ts` (+test), `frontend/src/app/tree-model.ts` (+test — expose alias/derived/count fields the rows need if missing), `frontend/src/styles/app.css`

- [ ] **Step 1: Failing tests:** filter input row height ≤ 26 px (assert class/structure, style in CSS); count line present with non-empty input in both selector and fallback modes with the locked copy; tree rows: caret glyph text `▸`/`▾`, count in a right-aligned `.tree-count` cell (assert element, not string concatenation), amber `N names` chip + alias sub-line for a merged channel, `ƒx` glyph on derived rows; footer aggregate + `+ source` rows render and `+ source` fires the load callback; the format readout shows `CSV` for an all-CSV workspace, `CSV · MCAP` for a mixed one (from source paths, derived synthetic sources excluded), and the supported-format hint only when zero sources are loaded.
- [ ] **Step 2: Implement** (markup + CSS per locked decisions 1–3; the `/` glyph moves outside the input; amber focus border via `:focus-within` + a `has-selector` class).
- [ ] **Step 3:** `./scripts/test.sh unit "signal-tree|tree-model|app-shell"` — PASS. **Commit** `fix(ui): dock density — filter block, tree row anatomy, aggregate footer`.

---

### Task 2: Strip details — chip keys, readouts, ghost token

**Files:**

- Modify: `frontend/src/ui/panel.ts` (strip region from P6 Task 2, +test), `frontend/src/styles/app.css`

- [ ] **Step 1: Failing tests:** source-slice chip renders one dash-key per focused channel (fixture: focus `run_07` with `temp`+`temp_sp` rendered → 2 keys); readout shows `line style flat` with no dash/width overrides and `line style ◆ overridden` with one; `ghost_mode: "ghost"` with 14 ghosts → `14 ghosts ▾` token opening the roster filtered to ghosts (assert the roster receives the filter); dimension token reads `temp +11 ▾` when exactly one of 12 channels is focused, `12 ▾` when zero or several.
- [ ] **Step 2: Implement** per locked decision 4. **Step 3:** `./scripts/test.sh unit panel` — PASS. **Commit** `fix(ui): strip detail — per-channel chip keys, line-style readout, ghost token`.

---

### Task 3: Table mode treatment + row activation

**Files:**

- Modify: `frontend/src/ui/signal-table.ts` (+test), `frontend/src/ui/bulk-bar.ts` (+test), `frontend/src/ui/app-shell.ts` (mount move), `frontend/src/styles/app.css`

- [ ] **Step 1: Failing tests:** bulk bar renders as the table's footer row with the locked copy/roles (count `--fg-1`… — assert classes and text, colors live in CSS); selected row carries the tint class + `▣`, unselected `▢`; header micro-caps classes; VALUE formats 4-decimal / `—`; double-click and Enter on a row fire the add-to-panel callback with that row's refs; tree mode still shows the bar (dock-bottom) when selection is non-empty — table mode must not orphan tree-selection actions (keep the existing mount for tree mode, move only table mode's).
- [ ] **Step 2: Implement** per locked decisions 5 and 10. **Step 3:** `./scripts/test.sh unit "signal-table|bulk-bar"` — PASS. **Commit** `fix(ui): table mode per §6 — footer bulk bar, row treatment, row activation`.

---

### Task 4: Style-rules popover anatomy

**Files:**

- Modify: `frontend/src/ui/panel.ts` (rules popover from P3 Task 7, +test), `frontend/src/styles/app.css`

- [ ] **Step 1: Failing tests:** popover shows the three rule rows (only `color ←` interactive; dash/width rows present, `--fg-4`, inert); palette swatch strip on the color row; override rows show key · target · field summary · `revert` (fires with index); `revert all` footer; dimension choice still fires `onSetColorBy`.
- [ ] **Step 2: Implement** per locked decision 6 — this is a re-layout of the existing popover; keep every callback signature. **Step 3:** `./scripts/test.sh unit panel` — PASS. **Commit** `fix(ui): style-rules popover matches §3 anatomy`.

---

### Task 5: Chrome — tabs, status bar, formula bar, gutter, annotations tray

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` / `frontend/src/ui/workspace-tabs.ts` (+tests), `frontend/src/ui/panel.ts` (tray visibility), `frontend/src/render/canvas-renderer.ts` (gutter width only, +test), `frontend/src/styles/app.css`

- [ ] **Step 1:** Active-tab inset seam (CSS + one class assertion). Status-bar left cluster aggregates per locked decision 7 (test the copy). Formula-bar idle hint text (test).
- [ ] **Step 2:** Gutter tightening per locked decision 8 — adjust the renderer's left-margin computation; renderer test asserts labels stay unclipped for a 5-digit tick fixture and the margin shrinks for a 4-char one. Renderer determinism: margin derives from tick-label measurement already in the layout pass — no new inputs.
- [ ] **Step 3:** Annotations tray per locked decision 9 — first check the Final Spec and write the finding in the commit body; implement the corresponding visibility rule (test: zero annotations → no tray element).
- [ ] **Step 4:** `./scripts/test.sh unit` — PASS. **Commit** `fix(ui): chrome polish — tab seam, aggregated status, formula hint, gutter, tray visibility`.

---

### Task 6: Visual acceptance + gate

**Files:**

- Modify: touched e2e specs; version manifests

- [ ] **Step 1:** Update e2e selectors broken by the re-layouts (bulk-bar mount, tree row structure). Add smoke: table double-click adds to panel; ghost token opens filtered roster.
- [ ] **Step 2:** Re-take the 1440×880 reference screenshot (same procedure as P6 Task 5) plus a table-mode screenshot against §6 and a rules-popover screenshot against §3; list remaining deltas in the handoff.
- [ ] **Step 3:** `./scripts/ci.sh frontend` — PASS. `./scripts/version.sh bump patch && ./scripts/version.sh check`; commit; report.

---

## Self-review notes (already applied)

- Coverage vs the review: dock density/filter block ✓ (T1), tree anatomy ✓ (T1), dock footer aggregate ✓ (T1, explicitly completing what P6 T3 leaves), strip run-control details incl. ghost token + chip keys + flat readout ✓ (T2), table usefulness/treatment + row activation ✓ (T3), rules popover ✓ (T4), tab seam / status aggregation / formula hint / gutter / annotations tray ✓ (T5), screenshot acceptance ✓ (T6). Datatip color intentionally untouched (line-colored is correct — Global Constraints).
- Sequencing: depends on P6 (strip, gestures, align popover). If P6 is still in flight, land it first; T1's footer step assumes the spinner stack is already gone.
- Type consistency: no new interfaces — T2 consumes `ResolvedSeries.hue/display` and the P6 strip; T3 moves the existing `bulk-bar` component; T4 keeps `onSetColorBy`/`removeOverride` signatures.

# Signals at Scale P6 — Focus Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four defects found in visual review against the §10 pixel reference: click-to-focus collides with annotations, plot interactions diverge across panel modes, the legend/focus strip (§4) is missing (its tokens got folded into the panel header), and the dock's per-source spinner stack violates the unbounded-element rule. Plus two nits (filter placeholder, title-bar aggregation).

**Architecture:** One mode-agnostic series hit-test adapter ends the per-mode interaction drift; the strip is a dedicated 26 px row under the panel header (the §10 reference is authoritative for its layout); per-source alignment collapses into an on-demand popover. §9's focus gesture moves to ⇧click — the spec is amended (see below); the spec, not the current code, remains the target.

**Tech Stack:** TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-01-signals-at-scale-design.md` — re-read it: amended 2026-08-02 (§9 ⇧click focus; cross-cutting: mode-universal interactions, on-demand alignment). Pixel reference: §10 of `docs/Signal Scope UI Design Pass/SignalScope Signals at Scale.dc.html` (1440×880 mock). Assumes P5 as landed at `0ba48b7` (v1.4.0).

## Global Constraints

- Use `./scripts/` wrappers only; final gate `./scripts/ci.sh frontend`; no Rust/protocol/schema/codegen changes.
- No UI surface renders one element per series, source, or dimension value unbounded — this plan _removes_ one such violation; do not introduce another.
- The strip is one line, 26 px, never wraps or scrolls. Amber interaction-only. Keyboard path for every pointer action.
- Interaction handlers must contain **zero** `mode === "time"`-style branches after Task 1; mode-specific geometry lives only inside hit adapters.
- Run `./scripts/format.sh` before staging; stage only intentional files.

## Locked decisions (do not revisit during execution)

1. **Gesture map (all panel modes, identical):** plain click = annotation remove/pin only (existing radii). **⇧click = focus toggle** on the hit series. **⌥click = mute.** Hover = transient emphasis + name tag `run_03 / temp — ⇧click to focus`; **hover never mutates focus state** — emphasis is render-only and clears on pointerleave. Tab/⇧Tab walk, Enter pins, esc clears emphasis then focus. The hint text everywhere reads `hover explore · ⇧click focus · ⌥ mute · esc clear`.
2. **Strip layout (from the §10 mock, 26 px row under the header):** left → right: `SRC` label + count token `8 ▾` · focused source-slice chips (dash key, name, ✕) · `CH` label + count token `2 ▾` · focused channel/series chips · right-aligned hint `color ← <dim> · <gesture hints>`. The `color ←` readout moves here from the header and remains the rules-popover anchor. Count tokens remain the roster entry points.
3. **Header (after the move):** `⠿ Panel N · mode toggle · binding chips … right: focus chip "focus <label> · k/n ✕" (visible when focus non-empty; ✕ = clearFocus) · GHOST/all toggle · split ▸ · axes · Σ ⊞ ⤢ ✕`. Nothing else — SRC/CH/color← leave the header.
4. **Alignment UI:** each source row keeps `name · N pts` plus one `align ▾` button opening a popover with the existing unit/scale/offset controls for that source (same `onAlignment` plumbing, same commit semantics). One popover open at a time; Escape closes; the permanent spinner stack is deleted. A source whose alignment differs from identity shows a small `≠` marker on the row.
5. **XY hit-testing gains the `visible` filter** the time path already has (parity while unifying — muted/hidden series are never hit).
6. **FFT/histogram hit adapters** test against the traces those modes already compute for rendering (nearest polyline for FFT, nearest step-edge/bar for histogram). If the prepared-plot type does not retain its traces, retain them (same pattern as `xyTraces`). No sample re-fetch, no re-computation in the handler.
7. **Title bar:** `<session-name> — N sources · M signals` (e.g. `Untitled — 8 sources · 23 signals`), always aggregated; the single-source `firstName` form is deleted. The status bar keeps its existing counts.
8. **Filter placeholder:** `glob @ source · unit:K` — it advertises the grammar; the leading `/` glyph outside the input stays.
9. **The §10 mock is the visual acceptance reference.** The handoff includes a fresh 1440×880 screenshot mirroring the mock's state (multi-source workspace, one ghosted panel with two focused series, hover tag visible) for human comparison. No pixel-diff in CI.

---

### Task 1: Universal series hit adapter + gesture rebind

**Files:**

- Modify: `frontend/src/ui/panel.ts` (`plotClick` ~1583, `seriesHit` ~1611, `updateHover` ~1655, overlay listeners ~792), `frontend/src/ui/panel.test.ts`, `frontend/src/app/plot-capabilities.ts` (+test) if adapters land there (preferred — it is the per-mode seam ADR 0019 mandates)
- Test: extend `frontend/src/app/plot-hit.test.ts` / `xy-hit.test.ts` patterns for the two new adapters

**Interfaces — produces:**

```ts
export interface SeriesHit {
  path: string;
  distance: number;
}
export interface SeriesHitAdapter {
  seriesAt(
    layout: PlotLayout,
    x: number,
    y: number,
    threshold: number,
  ): SeriesHit | null;
}
// one adapter per mode, built alongside each prepare*Plot; PanelView holds
// this.hitAdapter and interaction code calls ONLY the adapter.
```

- [ ] **Step 1: Failing adapter tests:** FFT adapter returns the nearest spectrum polyline within threshold (fixture traces, on/off-threshold cases); histogram adapter returns the nearest step edge; both respect `visible === false` exclusion; XY adapter now excludes invisible series (locked 5); time adapter unchanged behavior via the shared interface.
- [ ] **Step 2: Failing gesture tests** in `panel.test.ts`: ⇧click fires `onFocusToggle`, plain click never does (fires annotation pin path when applicable, else nothing); ⌥click fires `onMuteSeries`; identical assertions run in a `describe.each(["time", "xy", "fft", "histogram"])` block — this is the universality contract; hover sets emphasis + tag but never fires `onFocusToggle`; esc clears emphasis first, focus second.
- [ ] **Step 3: Implement.** Build the four adapters; `seriesHit` becomes a one-line delegation to `this.hitAdapter`; delete its mode branches; rebind `plotClick` per locked decision 1 (the annotation remove/pin priority now only runs on unmodified clicks); update hover-tag copy to `— ⇧click to focus`; update the Tab/Enter/esc path to be adapter-driven (no mode gate).
- [ ] **Step 4: Verify no interaction mode-branches remain:** `grep -n 'mode === "time"\|mode === "xy"' frontend/src/ui/panel.ts` — hits allowed only in render/prepare code paths (facet gate at ~973/~2132, split control at ~896), none in interaction handlers.
- [ ] **Step 5:** Run `./scripts/test.sh unit panel` — PASS. **Commit.** `fix(ui): universal plot gestures — shift-click focus, adapters for every mode`

---

### Task 2: The legend/focus strip (§4's missing row)

**Files:**

- Modify: `frontend/src/ui/panel.ts` (panel markup — insert the strip row between header and plot; move the SRC/CH tokens, `color ←` readout out of the header; header right per locked decision 3), `frontend/src/ui/panel.test.ts`, panel styles (26 px row, `--surface-1`, `border-bottom: 1px solid var(--border-faint)`, mono 10px per the mock)

- [ ] **Step 1: Failing tests:** the strip exists as its own row with `SRC`/`CH` labels and count tokens (roster popovers open from the strip, not the header); focused entries render as strip chips with dash key + ✕ (✕ fires `onFocusToggle` removal); chips cap at 8 + `+n`; the hint text renders `color ← source · hover explore · ⇧click focus · ⌥ mute · esc clear` and the `color ←` token opens the rules popover; header shows the `focus <label> · k/n ✕` chip when focus is non-empty and hides it when empty; header no longer contains SRC/CH tokens (assert absence).
- [ ] **Step 2: Implement.** The strip is a fixed grid row (panel template gains a 26 px row; maximized/facet layouts account for it). Reuse the existing roster popover and chip components — this task _moves and completes_ P3's surfaces, it does not reinvent them.
- [ ] **Step 3:** Run `./scripts/test.sh unit panel` — PASS. **Commit.** `fix(ui): dedicated legend/focus strip per §4 — tokens, focused chips, hints out of the header`

---

### Task 3: Delete the spinner stack; alignment on demand

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`renderSourceRows` / the row builder ~3455–3510), `frontend/src/ui/app-shell-sources.test.ts`, dock styles

- [ ] **Step 1: Failing tests:** a source row renders `name · N pts · align ▾` and **no** select/number inputs; clicking `align ▾` opens one popover with unit/scale/offset prefilled; apply routes through the existing `onAlignment` callback unchanged; opening a second row's popover closes the first; Escape closes; a non-identity source shows the `≠` marker; 200 sources render only virtualized compact rows (assert no input elements in the container).
- [ ] **Step 2: Implement** per locked decision 4 — the popover reuses the exact controls being deleted from the rows (cut, don't rewrite). Keyboard: `align ▾` is a button; controls are tabbable; Enter applies.
- [ ] **Step 3:** Run `./scripts/test.sh unit app-shell` — PASS. **Commit.** `fix(ui): per-source alignment moves behind an on-demand popover; spinner stack deleted`

---

### Task 4: Nits — placeholder + title aggregation

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (placeholder ~3543; session-identity ~3095–3105), `frontend/src/ui/app-shell.test.ts`

- [ ] **Step 1:** Placeholder → `glob @ source · unit:K` (locked 8). Title → `<session-name> — N sources · M signals` from the aggregate counts the status bar already computes (locked 7); update the `.source-name` usage accordingly (it may simply show the session name now — follow the title-bar markup).
- [ ] **Step 2:** Tests for both; run `./scripts/test.sh unit app-shell`; **commit** `fix(ui): selector-grammar placeholder; aggregated workspace title`.

---

### Task 5: E2E, reference screenshot, gate

**Files:**

- Modify: `frontend/tests/e2e/focus-and-rules.spec.ts` (gesture updates: click → ⇧click), other specs touched by the strip move; version manifests

- [ ] **Step 1:** Update every e2e assertion that clicked-to-focus to ⇧click; add: gesture parity smoke across all four modes (⇧click focuses in each); strip presence with focused chips after isolating a source; annotation pin still works with plain click on a time panel with focus active (the original conflict, now a regression test); source `align ▾` popover round-trip.
- [ ] **Step 2: Reference screenshot** (locked 9): drive the app (`./scripts/run.sh web` + Playwright screenshot at 1440×880, or the demo tooling if it is closer) into the mock's state — multi-source load, panel bound to a 16-series set, ghosted, two series focused, hover tag showing. Save to the handoff (scratch artifact, not committed) and compare by eye against §10; list any remaining deltas in the handoff report.
- [ ] **Step 3:** `./scripts/ci.sh frontend` — PASS.
- [ ] **Step 4:** `./scripts/version.sh bump patch && ./scripts/version.sh check`; commit; report: changed files, commands run, screenshot deltas still open.

---

## Self-review notes (already applied)

- Issue coverage: (1) click/annotation conflict + mode divergence → T1 (spec amended to ⇧click; `describe.each` universality contract); (2) missing §4 strip → T2 (moved out of header, focused chips + hint + roster entry restored); (3) unbounded spinner stack → T3 (deleted; on-demand popover; spec gained the general rule); (4) missing focus affordances → T1 hover tag/copy + T2 focus chip + hint line; nits → T4. Visual acceptance vs §10 → T5.
- The spec amendments (⇧click, mode-universal interactions, on-demand alignment) are committed with this plan — future phases inherit them; the mock's `click focus` hint text is superseded.
- Type consistency: `SeriesHitAdapter.seriesAt` matches T1's tests and `PanelView.seriesHit` delegation; strip reuses P3's roster/chip components and `onFocusToggle` payloads unchanged; T3 reuses the existing `onAlignment` callback signature.

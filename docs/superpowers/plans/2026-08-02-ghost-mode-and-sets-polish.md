# Ghost Mode and Sets Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ghost mode a useful default focus and consistent styling across plot modes while polishing cursor copy, set inspection, set dragging, and search copy.

**Architecture:** Derive the first-source fallback in `resolvePanel`, then carry resolved nullable hue and opacity through arbitrary-path and cursor rendering. Keep set expansion as local `SetsListView` state resolved against the current catalog.

**Tech Stack:** TypeScript, DOM, Canvas 2D, Vitest, Playwright

## Global Constraints

- Do not change protocol or session schemas.
- Ghost strokes are `--fg-4`, solid, 1 px, and 0.5 opacity.
- The global cursor line remains amber.
- Use repository scripts for formatting and tests.
- Implement inline without subagents, as requested.

---

### Task 1: Derive a First-source Ghost Focus

**Files:**

- Modify: `frontend/src/app/resolution.ts`
- Test: `frontend/src/app/resolution.test.ts`

**Interfaces:**

- Consumes: ordered `ResolvedRef[]` from `resolveRefs`
- Produces: `resolvePanel(catalog, panel, namedSets): ResolvedSeries[]` with a first-source fallback when `panel.ghost_mode === "ghost" && panel.focus.length === 0`

- [ ] **Step 1: Write the failing test**

Add a resolution case where source `a` has multiple channels and source `b`
has one. Assert that empty explicit focus in ghost mode resolves source `a` as
`focus, focus` and source `b` as `ghost`.

- [ ] **Step 2: Verify the test fails**

Run `./scripts/test.sh unit resolution.test.ts` and confirm all entries are
currently ghosted.

- [ ] **Step 3: Implement minimal derived focus**

Build an effective focus list before display and hue assignment:

```ts
const effectiveFocus =
  panel.focus.length === 0 && panel.ghost_mode === "ghost" && refs[0]
    ? [
        {
          kind: "source",
          ref: null,
          source_key: refs[0].ref.source_key,
          channel: null,
        },
      ]
    : panel.focus;
```

Use it for matching and focus-color assignment without mutating `panel`.

- [ ] **Step 4: Verify the focused test passes**

Run `./scripts/test.sh unit resolution.test.ts`.

### Task 2: Share Ghost Strokes Across Plot Modes

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`
- Modify: `frontend/src/ui/panel.ts`
- Test: `frontend/src/render/canvas-renderer.test.ts`

**Interfaces:**

- Consumes: `ResolvedSeries.hue`, `dash`, `width`, and `opacity`
- Produces: `PlotPath` fields `hue: number | null` and `alpha: number`

- [ ] **Step 1: Write failing renderer tests**

Render a path with `hue: null`, `alpha: 0.5`, and color-map values. Assert its
stroke uses `fg4`, its alpha is 0.5, and no sequential-ramp segment is drawn.

- [ ] **Step 2: Verify the tests fail**

Run `./scripts/test.sh unit canvas-renderer.test.ts`.

- [ ] **Step 3: Implement path style propagation**

Replace arbitrary-path `colorIndex` styling with nullable hue and alpha. In
`drawPath`, reserve dimmed styling for XY underlays, otherwise use `fg4` for a
null hue and the series token for a numeric hue. Only color-map a path when its
hue is non-null. Pass the resolved fields from XY, FFT, and histogram paths.

- [ ] **Step 4: Verify renderer and panel tests pass**

Run `./scripts/test.sh unit canvas-renderer.test.ts panel.test.ts`.

### Task 3: Subdue Ghost Cursor Readouts

**Files:**

- Modify: `frontend/src/render/overlay-renderer.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/styles/app.css`
- Test: `frontend/src/render/overlay-renderer.test.ts`
- Test: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Produces: `CursorPoint.colorIndex: number | null` and `CursorPoint.alpha: number`
- Produces: grouped tooltip copy `<channel> · <count> signals`

- [ ] **Step 1: Write failing cursor tests**

Assert a null-color cursor point uses `fg4` at reduced opacity and grouped rows
use `signals`, not `ghosts`.

- [ ] **Step 2: Verify the tests fail**

Run `./scripts/test.sh unit overlay-renderer.test.ts app-shell.test.ts`.

- [ ] **Step 3: Implement cursor styling and copy**

Pass ghost display through time, FFT, and histogram cursor-point construction.
Render null-color points with `fg4`; apply point alpha separately so the amber
cursor line keeps its current opacity. Mark grouped ghost tooltip rows with a
CSS class and reduce their opacity.

- [ ] **Step 4: Verify cursor tests pass**

Run `./scripts/test.sh unit overlay-renderer.test.ts app-shell.test.ts panel.test.ts`.

### Task 4: Expand and Drag Saved Sets

**Files:**

- Modify: `frontend/src/ui/sets-list.ts`
- Modify: `frontend/src/styles/app.css`
- Test: `frontend/src/ui/sets-list.test.ts`
- Test: `frontend/tests/e2e/workbench.spec.ts`

**Interfaces:**

- Consumes: `Catalog`, `NamedSet`, `evaluateSelector`
- Produces: disclosure rows `.tree-set-member` and unchanged `SET_DRAG_TYPE` payload `{ set_id: string }`

- [ ] **Step 1: Write failing set-list tests**

Assert the caret toggles `aria-expanded`, query members reflect live matches,
pick members show stored paths, clicking the caret does not bind the set, and
drag start uses copy semantics with the existing payload.

- [ ] **Step 2: Verify the tests fail**

Run `./scripts/test.sh unit sets-list.test.ts`.

- [ ] **Step 3: Implement local disclosure state**

Track expanded set IDs, render an independent caret, and append member rows
resolved from the catalog. Preserve row click, keyboard bind/delete, remove,
and drag behavior. Add compact indentation and grab styling.

- [ ] **Step 4: Extend the existing drag E2E**

Expand the created set, assert its member path is visible, then drag the parent
set row into the second panel and assert the set binding chip appears.

- [ ] **Step 5: Verify set tests pass**

Run `./scripts/test.sh unit sets-list.test.ts`.

### Task 5: Simplify Search Copy and Validate

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`
- Test: `frontend/src/ui/app-shell.test.ts`
- Modify: version manifests through `scripts/version.sh`

**Interfaces:**

- Produces: signal search placeholder `Search signals…`

- [ ] **Step 1: Update the placeholder test and implementation**

Change the markup and assertion from `glob @ source · unit:K` to
`Search signals…`.

- [ ] **Step 2: Run focused frontend tests**

Run `./scripts/test.sh unit resolution.test.ts canvas-renderer.test.ts overlay-renderer.test.ts sets-list.test.ts app-shell.test.ts panel.test.ts`.

- [ ] **Step 3: Format and run final E2E**

Run `./scripts/format.sh`, `./scripts/test.sh frontend`, and
`./scripts/test.sh e2e`.

- [ ] **Step 4: Bump and validate the patch version**

Run `./scripts/version.sh bump patch` and `./scripts/version.sh check`, then
run `./scripts/format.sh --check`.

- [ ] **Step 5: Review and commit only task files**

Inspect staged and unstaged diffs separately, stage the named files, and commit
with a conventional subject explaining the ghost-mode and set-browser polish.

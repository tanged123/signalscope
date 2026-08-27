# Plot Line Width Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the former 200% series-stroke appearance the new 100% default and reset all existing users to it once.

**Architecture:** Keep `plot_line_width_scale` as a user-facing 0.5–2 multiplier, but add a fixed 2× baseline multiplier to both renderers. Bump preferences to schema 6 so schema 1–5 documents reset this field to 1 while schema 6 preserves valid saved choices.

**Tech Stack:** Rust, TypeScript, Vitest, Playwright, Canvas2D, ChartGPU, JSON schema code generation

## Global Constraints

- The design in `docs/superpowers/specs/2026-08-16-plot-line-width-baseline-design.md` is authoritative.
- Use repository scripts for formatting, generation, tests, and quality checks.
- Modify only series strokes; axes, grids, markers, annotations, and chrome remain unchanged.
- Preserve unrelated staged, unstaged, and untracked user work.
- Skip commit steps only if git is read-only; never skip tests.

---

### Task 1: Reset Existing Preferences to the New Baseline

**Files:**

- Modify: `protocol/schema/scope-preferences.json`
- Modify: `protocol/testdata/preferences-conformance.json`
- Modify: `frontend/src/generated/preferences.ts`
- Modify: `core/scope-core/src/preferences/generated.rs`
- Modify: `frontend/src/app/preferences.ts`
- Test: `frontend/src/app/preferences.test.ts`
- Modify: `core/scope-core/src/preferences.rs`
- Modify: `docs/adr/0023-global-preferences-file.md`

**Interfaces:**

- Consumes: `plot_line_width_scale: number` from preferences schema 5.
- Produces: preferences schema 6, where documents from schema 1–5 load with `plot_line_width_scale: 1` and schema 6 documents preserve a repaired 0.5–2 value.

- [ ] **Step 1: Write failing frontend migration tests**

Change the default schema assertion to 6 and split line-width migration coverage so schema 5 resets while schema 6 preserves:

```ts
expect(defaultPreferences().schema_version).toBe(6);

const reset = parsePreferences(
  JSON.stringify({
    ...defaultPreferences(),
    schema_version: 5,
    plot_line_width_scale: 0.5,
  }),
);
expect(reset?.plot_line_width_scale).toBe(1);

const preserved = parsePreferences(
  JSON.stringify({
    ...defaultPreferences(),
    plot_line_width_scale: 0.63,
  }),
);
expect(preserved?.plot_line_width_scale).toBe(0.75);
```

- [ ] **Step 2: Run the frontend preference test and verify RED**

Run: `./scripts/test.sh unit preferences`

Expected: FAIL because the generated schema version is 5 and schema 5 values are still preserved.

- [ ] **Step 3: Write failing Rust migration tests**

Add direct assertions that schema 5 value `0.5` resets to `1.0` and schema 6 value `0.63` repairs to `0.75`.

- [ ] **Step 4: Run the Rust preference test and verify RED**

Run: `./scripts/test.sh core preferences`

Expected: FAIL because schema 5 still follows current-version repair behavior.

- [ ] **Step 5: Implement schema 6 migration**

Set the schema source to version 6 and regenerate committed bindings with:

```text
./scripts/codegen.sh
```

In TypeScript, accept versions 1–6 and choose the width candidate only for schema 6:

```ts
plot_line_width_scale: clampPlotLineWidthScale(
  value.schema_version === PREFERENCES_SCHEMA_VERSION
    ? size(value.plot_line_width_scale, defaults.plot_line_width_scale)
    : defaults.plot_line_width_scale,
),
```

In Rust, handle versions 1–5 by repairing a cloned JSON object after inserting `plot_line_width_scale: 1.0`; handle version 6 with normal `repair_current` behavior. Update the conformance fixture to schema 6 and amend ADR 0023 with the baseline and one-time reset semantics.

- [ ] **Step 6: Run preference tests and verify GREEN**

Run:

```text
./scripts/test.sh unit preferences
./scripts/test.sh core preferences
```

Expected: both suites pass.

### Task 2: Double the Series-Stroke Baseline

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`
- Test: `frontend/src/render/canvas-renderer.test.ts`
- Modify: `frontend/src/render/chart-host.ts`
- Test: `frontend/src/render/chart-host.test.ts`
- Test: `frontend/src/ui/app-shell.test.ts`
- Test: `frontend/tests/e2e/settings-and-undo.spec.ts`

**Interfaces:**

- Consumes: `Palette.lineWidthScale`, whose default remains 1.
- Produces: series width `semanticWidth * 2 * lineWidthScale` after ChartGPU minimum-width and emphasis compensation.

- [ ] **Step 1: Change renderer expectations and verify RED**

At `lineWidthScale: 1.5`, expect the Canvas2D series width to be `4.2` for a semantic width of `1.4`. Expect ChartGPU widths `[6, 4.5, 7.8, 7.2]` for the existing compensated fixture.

Run: `./scripts/test.sh unit canvas-renderer chart-host`

Expected: FAIL with the existing half-sized widths.

- [ ] **Step 2: Implement the fixed baseline multiplier**

Add one shared renderer constant per module:

```ts
const PLOT_LINE_WIDTH_BASELINE = 2;
```

Multiply final data-series widths by `PLOT_LINE_WIDTH_BASELINE` in normal Canvas2D paths, color-mapped Canvas2D paths, and ChartGPU paths. Do not change furniture or marker widths.

- [ ] **Step 3: Run renderer and UI tests and verify GREEN**

Run:

```text
./scripts/test.sh unit canvas-renderer chart-host app-shell
```

Expected: renderer tests pass and Settings still reports the default as 100%.

- [ ] **Step 4: Run deferred browser coverage**

Run: `./scripts/ci.sh e2e`

Expected: Settings adjustment and reset coverage passes with the 100% default.

### Task 3: Format, Verify, and Deliver

**Files:**

- Review: all files listed in Tasks 1–2

**Interfaces:**

- Consumes: completed schema migration and renderer baseline changes.
- Produces: formatted, generated, tested, committed, and pushed implementation.

- [ ] **Step 1: Format and inspect generated consistency**

Run:

```text
./scripts/format.sh
./scripts/test.sh frontend
```

Expected: formatting and generated-diff checks pass.

- [ ] **Step 2: Run the complete quality gate**

Run: `./scripts/ci.sh all`

Expected: format, quality, Rust, frontend, end-to-end, and build checks pass.

- [ ] **Step 3: Review only the intended diff**

Run:

```text
git diff --check
git diff --cached --check
git status --short
```

Confirm unrelated user work remains outside the feature commit.

- [ ] **Step 4: Commit and push**

Stage only the files listed in Tasks 1–2 plus this plan and commit:

```text
git commit -m "fix: make thick plot lines the default"
git push origin better_charts_reattempt
```

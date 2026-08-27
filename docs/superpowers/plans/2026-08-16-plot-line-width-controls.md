# Plot Line Width Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted global increase, decrease, and reset controls for plot series widths.

**Architecture:** Preferences schema 5 stores a global line-width scale. The style system carries it in `Palette`; Canvas2D multiplies path widths, while ChartGPU multiplies its compensated final width. AppShell exposes Settings adjustment and command-palette actions without changing per-series session overrides.

**Tech Stack:** TypeScript, Rust, JSON schema/codegen, Vitest, Playwright, Canvas2D, ChartGPU.

## Global Constraints

- Use `./scripts/` wrappers for codegen, formatting, tests, and CI.
- `protocol/schema/scope-preferences.json` is authoritative; do not hand-edit generated outputs.
- Do not modify `frontend/vendor/chartgpu/` or add runtime dependencies.
- Preserve unrelated staged and unstaged work.
- Run Playwright only after the complete implementation is in place.
- Do not bump the version; this remains an intermediate change on the existing 1.0.0 feature branch.

---

### Task 1: Persist the global line-width scale

**Files:**

- Modify: `protocol/schema/scope-preferences.json`
- Regenerate: `frontend/src/generated/preferences.ts`
- Regenerate: `core/scope-core/src/preferences/generated.rs`
- Modify: `frontend/src/app/preferences.ts`
- Test: `frontend/src/app/preferences.test.ts`
- Modify: `core/scope-core/src/preferences.rs`
- Modify: `protocol/testdata/preferences-conformance.json`
- Modify: `docs/adr/0023-global-preferences-file.md`

**Interfaces:**

- Produces: `Preferences.plot_line_width_scale: number`, `PLOT_LINE_WIDTH_SCALE`, and `clampPlotLineWidthScale(value: number): number`.

- [ ] **Step 1: Write failing preference tests**

Assert that defaults and old-schema migration produce scale `1`, values clamp
and round to quarter steps, and `applyPreferences` writes
`--plot-line-width-scale`.

- [ ] **Step 2: Verify the tests fail**

Run: `./scripts/test.sh unit preferences`

Expected: FAIL because the generated `Preferences` type and preference helpers
do not contain the line-width scale.

- [ ] **Step 3: Add schema 5 and regenerate**

Set `schema_version` to `5`, add
`"plot_line_width_scale": "f64"` after `plot_font_size`, then run:

```bash
./scripts/codegen.sh
```

- [ ] **Step 4: Implement defaults, repair, and migration**

Use this contract in both TypeScript and Rust:

```text
minimum 0.5; maximum 2; default 1; step 0.25
```

Accept schema versions 1-5, default the new field for versions 1-4, update the
conformance fixture, and append a schema-5 amendment to ADR 0023.

- [ ] **Step 5: Verify preference tests**

Run:

```bash
./scripts/test.sh unit preferences
./scripts/test.sh core preferences
```

Expected: both commands exit 0.

---

### Task 2: Scale Canvas2D and ChartGPU series strokes

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`
- Test: `frontend/src/render/canvas-renderer.test.ts`
- Modify: `frontend/src/render/chart-host.ts`
- Test: `frontend/src/render/chart-host.test.ts`
- Modify: `frontend/src/styles/tokens.css`

**Interfaces:**

- Consumes: `Palette.lineWidthScale` sourced from `--plot-line-width-scale`.
- Produces: all data-series strokes scaled globally; non-series plot furniture remains unchanged.

- [ ] **Step 1: Write failing renderer tests**

Set test palettes to `lineWidthScale: 1.5`. Assert Canvas2D emits width `2.1`
for a semantic `1.4` path and ChartGPU emits width `3` for a compensated `2`
normal stroke. Also retain tests proving wider per-series styles keep their
relative width.

- [ ] **Step 2: Verify the tests fail**

Run: `./scripts/test.sh unit canvas-renderer chart-host`

Expected: FAIL because both renderers ignore `lineWidthScale`.

- [ ] **Step 3: Implement final-width scaling**

Add `lineWidthScale` to `Palette` and parse the CSS token with fallback `1`.
Canvas2D multiplies regular, dimmed, and color-mapped series widths. ChartGPU
uses:

```ts
const width =
  (Math.max(style.width, minimumWidth) + (isEmphasized ? 0.4 : 0)) *
  request.palette.lineWidthScale;
```

- [ ] **Step 4: Verify renderer tests**

Run: `./scripts/test.sh unit canvas-renderer chart-host`

Expected: all renderer tests pass.

---

### Task 3: Add Settings and command controls

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`
- Test: `frontend/src/ui/app-shell.test.ts`
- Test: `frontend/tests/e2e/settings-and-undo.spec.ts`

**Interfaces:**

- Consumes: `PLOT_LINE_WIDTH_SCALE` and `clampPlotLineWidthScale`.
- Produces: `Plot line width` Settings row plus `Plot line width: increase`, `decrease`, and `reset` commands.

- [ ] **Step 1: Write the failing unit test**

Call the real Settings entry provider on an AppShell probe. Assert the line
width row shows `100%`, right-adjust writes `1.25`, and left-adjust writes
`0.75` from the original value.

- [ ] **Step 2: Verify the unit test fails**

Run: `./scripts/test.sh unit app-shell`

Expected: FAIL because no Plot line width setting exists.

- [ ] **Step 3: Implement the controls**

Register increase, decrease, and reset commands in the View/display group.
Add a keep-open Settings row with percentage formatting and left/right
adjustment. Clamp the field in `updatePreferences` and include it in Reset
appearance.

- [ ] **Step 4: Add the end-to-end interaction assertion**

Extend `settings-and-undo.spec.ts` to adjust the Settings row to `125%`, then
run the reset command and observe `100%`.

- [ ] **Step 5: Run final verification**

Run:

```bash
./scripts/format.sh
./scripts/test.sh frontend
./scripts/test.sh core preferences
./scripts/ci.sh e2e
```

Expected: every command exits 0.

- [ ] **Step 6: Commit only task files**

Review staged and unstaged diffs separately, then commit the schema, generated
outputs, implementation, tests, ADR amendment, design, and plan with:

```bash
git commit -m "feat: add global plot line width controls"
```

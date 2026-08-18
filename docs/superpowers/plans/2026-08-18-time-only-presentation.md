# Time-only presentation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove XY, spectrum, and histogram panels and everything that exists only to serve them, leaving ChartGPU as the single plotter.

**Architecture:** Deletion in dependency order, bottom of the stack last. Frontend consumers go first so the tree stays buildable, then the Canvas2D drawing stack with the palette and tick extraction it forces, then the Rust migration ladder, then the schema itself. The uncapped sample request disappears with its only consumer; comma-separated value export keeps the capped one.

**Tech Stack:** TypeScript, Vitest (jsdom), Playwright, Rust, JSON schema codegen, ChartGPU (vendored submodule, pinned — do not modify).

**Spec:** [`docs/superpowers/specs/2026-08-18-time-only-presentation-design.md`](../specs/2026-08-18-time-only-presentation-design.md)

## Why the tasks are ordered this way

Deleting bottom-up leaves the tree red between tasks. Each task here ends
with a green build and a passing suite:

1. Frontend consumers of the three modes.
2. The Canvas2D drawing stack, whose only callers Task 1 removed.
3. The migration ladder, which is independent of the schema's shape.
4. The schema itself, now that no ladder rung and no consumer references
   the fields being removed.
5. The end-to-end and benchmark surface.
6. The records.

Do not reorder. In particular, resetting the ladder (Task 3) before
changing the schema (Task 4) is what keeps Task 4 from having to rewrite
twenty migration rungs toward a shape that no longer has the fields they
populate.

## Global Constraints

- Use the `./scripts/` wrappers only. Frontend unit tests: `./scripts/test.sh unit <filter>`. Rust: `./scripts/test.sh core <filter>`. Codegen: `./scripts/codegen.sh`. Formatting: `./scripts/format.sh`. Never call `pnpm`, `vitest`, `npx`, or `cargo` directly.
- Run `./scripts/format.sh` before every commit. Markdown is formatted like source.
- Do **not** edit anything under `frontend/vendor/chartgpu/`. It is a pinned submodule at revision `671e1c157a6fd9a80df35d5b43795314214569d0`.
- Generated files (`frontend/src/generated/`, `protocol/src/generated.rs`, `core/scope-core/src/session/generated.rs`, `core/scope-core/src/preferences/generated.rs`) are committed outputs. Never hand-edit them; change the schema and run `./scripts/codegen.sh`.
- Time-series behavior must not change. Full resolution (ADR 0041), the padded render feed and interleaved single-precision vertices (ADR 0042), and vertex order, gap vertices, and the plot layout contract (ADR 0039) all stay exactly as they are.
- Backward compatibility is deliberately abandoned. Do not write a migration rung. Do not preserve a v21 reader.
- Do not run `./scripts/ci.sh e2e` or `./scripts/test.sh bench` until Task 6.
- Do not bump the version. Version bumps happen once, when the pull request is complete.
- Commit after every task with a conventional commit message.

---

### Task 1: Remove the three panel modes from the frontend

Everything reachable only through XY, spectrum, or histogram goes, including the uncapped sample request that exists solely to feed them.

**Files:**

- Delete: `frontend/src/app/spectrum.ts`, `frontend/src/app/histogram.ts`, `frontend/src/app/xy-hit.ts`, `frontend/src/app/colormap.ts`, `frontend/src/app/sample-window-cache.ts`, and their `.test.ts` siblings
- Delete: `frontend/src/app/xy.ts` after moving `lerpSample` out
- Modify: `frontend/src/app/csv-export.ts:2`
- Modify: `frontend/src/app/plot-capabilities.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Test: `frontend/src/ui/panel.test.ts`, `frontend/src/ui/app-shell.test.ts`, `frontend/src/app/plot-capabilities.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `lerpSample(time: readonly number[], values: readonly number[], query: number): number` moves verbatim to `frontend/src/app/samples.ts` and is exported from there; `csv-export.ts` is its only consumer. `PreparedPlot` keeps its member names but loses polymorphism — `prepareTimePlot(input: TimePlotInput): PreparedPlot` becomes the only construction. `policyFor` is removed; the time policy becomes a single exported constant `TIME_POLICY: PlotInteractionPolicy`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/ui/app-shell.test.ts`. This is the assertion that the slowness is actually gone — no presentation path may issue an uncapped sample request.

```ts
test("no live refresh issues an uncapped sample request", async () => {
  const querySamples = vi.fn(() =>
    Promise.resolve({ request_id: "r", series: [] }),
  );
  const shell = await shellFixture({ querySamples });

  await shell.refreshTiles();

  expect(querySamples).not.toHaveBeenCalled();
});
```

`app-shell.test.ts` has no shared fixture helper; tests construct the shell inline as `new AppShell(document.createElement("div"), { … })` — see line 430 for the full options object to copy. Build the shell that way with a stub plane whose `querySamples` is the spy above, and reach `refreshTiles` the way the neighbouring tests reach private members.

Add to `frontend/src/ui/panel.test.ts`:

```ts
it("offers no mode selection", () => {
  const panel = panelFixture();
  expect(panel.element.querySelectorAll("[data-panel-mode]")).toHaveLength(0);
  expect(panel.element.querySelector(".xy-drop-strip")).toBeNull();
});
```

Match the existing fixture helper and the actual mode-button attribute used in `panelMarkup()`; read `frontend/src/ui/panel.ts:2991` onward to confirm the selector before writing the assertion.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./scripts/test.sh unit app-shell panel`

Expected: FAIL. The shell still fetches samples for non-time panels, and the panel still renders four mode buttons and the XY drop strip.

- [ ] **Step 3: Move `lerpSample` and delete the XY module**

Append `lerpSample` verbatim from `frontend/src/app/xy.ts:32-58` to `frontend/src/app/samples.ts`, keeping its doc comment and its `export`. Change `frontend/src/app/csv-export.ts:2` to:

```ts
import { lerpSample } from "./samples";
```

Then delete `frontend/src/app/xy.ts` and `frontend/src/app/xy.test.ts`. `XyTrace`, `pairSamples`, and `traceExtent` have no remaining consumer and go with the file.

- [ ] **Step 4: Delete the mode-specific modules**

```bash
git rm frontend/src/app/spectrum.ts frontend/src/app/spectrum.test.ts \
       frontend/src/app/histogram.ts frontend/src/app/histogram.test.ts \
       frontend/src/app/xy-hit.ts frontend/src/app/xy-hit.test.ts \
       frontend/src/app/colormap.ts frontend/src/app/colormap.test.ts \
       frontend/src/app/sample-window-cache.ts frontend/src/app/sample-window-cache.test.ts
```

If a listed test file does not exist, drop it from the command rather than creating it.

- [ ] **Step 5: Collapse `plot-capabilities.ts` to the time domain**

Delete `prepareXyPlot`, `prepareFftPlot`, and `prepareHistogramPlot` in full, along with `XyPlotInput`, `FftPlotInput`, `HistogramPlotInput`, and any helper used only by them. Delete the `./xy` and `./xy-hit` imports.

Replace the four-entry `POLICIES` record with the single policy, exported directly:

```ts
export const TIME_POLICY: PlotInteractionPolicy = {
  xAxis: "linked-time",
  cursorLink: "time",
  pan: new Set(["x", "y"]),
  zoom: new Set(["x", "y", "box"]),
  fit: true,
  stickyAutoY: true,
  windowNote: null,
};
```

Delete `policyFor` and change `prepareTimePlot`'s `interaction: POLICIES.time` to `interaction: TIME_POLICY`. Keep the `PreparedPlot` interface members exactly as they are — panel code calls them and they stay meaningful for one domain.

- [ ] **Step 6: Remove the mode render paths from `panel.ts`**

Delete `renderXy`, `renderSpectra`, and `renderHistogram` in full. In `renderForMode`, delete the three leading `if (state.mode === …)` branches so the method begins at the `this.gpu === null` guard. Delete the `MODES` constant at `:88-93`, `XY_HOVER_RADIUS`, the `xyTraces` field and every use, `hasColorbar` and every use, and the `../app/spectrum`, `../app/xy`, and `../app/histogram` imports.

In `panelMarkup()`, remove the mode-button group, the `.xy-drop-strip` element, the `.panel-mode-note` span, and the `x:`/`c:` chips. Remove the methods and call sites that drive them: `setDropStripVisible`, `overStrip`, the aspect toggle wiring, and the mode-note update. Remove the `state.mode === "xy"` conditions at `:666`, `:931`, `:942`, `:985`, `:1004`, `:1807`, `:1816`, `:2077` and the `mode === "fft"` / `mode === "histogram"` branches at `:1840` and `:1847`, keeping whichever arm is correct when the mode is always time.

Leave `PanelState.mode` alone — Task 4 removes it from the schema.

- [ ] **Step 7: Remove the sample fetch from `app-shell.ts`**

In `refreshTilesPass`, delete the entire `else` branch that queries samples, so the time branch is unconditional. Delete `nextSamples`, `this.samplesByPanel`, the `sampleWindowCache` field and its `invalidate` call at `:2596`, the `SampleWindowCache` import at `:44`, and the `sampleWindow` method at `:2859`. Drop the now-unused `samples` argument where the shell calls `renderData`, and drop the corresponding parameter from `Panel.renderData` and `renderForMode`.

Leave `buildVisibleCsv` and its `querySamples` call at `:2319` exactly as they are — that is the capped export path and it stays.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `./scripts/test.sh unit`

Expected: PASS. Delete assertions in existing tests that exercised the removed modes; do not weaken an assertion about time-panel behavior to make it pass.

- [ ] **Step 9: Typecheck and lint**

Run: `./scripts/ci.sh frontend`

Expected: PASS. `knip` is part of this gate and will name any module left unreferenced — delete whatever it reports rather than suppressing it.

- [ ] **Step 10: Format and commit**

```bash
./scripts/format.sh
git add -A frontend/src
git commit -m "feat!: remove XY, spectrum, and histogram panels"
```

---

### Task 2: Delete the Canvas2D drawing stack and extract plot theme

Task 1 removed the only three callers of `renderPaths`. What remains in `canvas-renderer.ts` is a drawing stack with no consumer and a palette-and-tick module that never got its own file — which is why `chart-host.ts:9` imports across a Canvas2D boundary it has no business touching.

**Files:**

- Create: `frontend/src/render/plot-theme.ts`
- Create: `frontend/src/render/plot-theme.test.ts`
- Delete: `frontend/src/render/canvas-renderer.ts`, `frontend/src/render/canvas-renderer.test.ts`
- Modify: `frontend/src/render/chart-host.ts:9-10`, `frontend/src/render/overlay-renderer.ts:8`, `frontend/src/ui/panel.ts`
- Modify: `frontend/src/render/plot-fonts.test.ts:3`, `frontend/src/styles/palette.test.ts:4`, `frontend/src/render/chart-host.test.ts:6`, `frontend/src/ui/panel.test.ts:10`

**Interfaces:**

- Consumes: the collapsed panel from Task 1.
- Produces: `frontend/src/render/plot-theme.ts` exports `interface Palette` (identical to today's minus its `sequential` field), `interface SeriesStroke`, `const SERIES_TOKENS`, `const COLOR_SLOTS`, `hueIndex(hue: number): number`, `ticks(min: number, max: number, count: number): number[]`, `formatTicks(values: readonly number[]): string[]`, `resolvePalette(): Palette`, and `invalidatePalette(): void`. Palette caching moves from a per-instance field to one module-level cache; `invalidatePalette()` clears it.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/render/plot-theme.test.ts`:

```ts
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  COLOR_SLOTS,
  SERIES_TOKENS,
  formatTicks,
  hueIndex,
  invalidatePalette,
  resolvePalette,
  ticks,
} from "./plot-theme";

describe("plot theme", () => {
  it("wraps hues into the categorical slot range", () => {
    expect(hueIndex(1)).toBe(0);
    expect(hueIndex(COLOR_SLOTS + 1)).toBe(0);
    expect(hueIndex(0)).toBe(0);
  });

  it("generates and formats ticks", () => {
    expect(ticks(0, 10, 6).length).toBeGreaterThan(0);
    expect(formatTicks([0, 1])).toHaveLength(2);
  });

  it("resolves a palette with one entry per series token and caches it", () => {
    invalidatePalette();
    const first = resolvePalette();
    expect(first.series).toHaveLength(SERIES_TOKENS.length);
    expect(resolvePalette()).toBe(first);
    invalidatePalette();
    expect(resolvePalette()).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit plot-theme`

Expected: FAIL — `./plot-theme` does not resolve.

- [ ] **Step 3: Create the module**

Create `frontend/src/render/plot-theme.ts` by moving, verbatim where possible, from `canvas-renderer.ts`: the `Palette` and `SeriesStroke` interfaces, `SERIES_TOKENS`, `COLOR_SLOTS`, `FALLBACK_MONO`, `hueIndex`, `ticks`, `formatTicks`, and the plot font and line-width scale helpers that `resolvePalette` calls.

Drop `Palette.sequential` and the `SEQ_TOKENS` lookup that filled it — the sequential ramp went with `colormap.ts` in Task 1.

Convert the private `resolvePalette` method into a module function over a module-level cache:

```ts
let cached: Palette | null = null;

/** Clears the cached palette; call when the theme changes. */
export function invalidatePalette(): void {
  cached = null;
}

/**
 * The plot palette read from CSS custom properties, cached until the theme
 * changes. Lives here rather than on a renderer so both the graphics-device
 * chart host and the overlay can read it without importing each other.
 */
export function resolvePalette(): Palette {
  if (cached !== null) return cached;
  const styles = getComputedStyle(document.documentElement);
  cached = {
    background: styles.getPropertyValue("--surface-0").trim(),
    border: styles.getPropertyValue("--border-strong").trim(),
    fg2: styles.getPropertyValue("--fg-2").trim(),
    fg3: styles.getPropertyValue("--fg-3").trim(),
    fg4: styles.getPropertyValue("--fg-4").trim(),
    grid: styles.getPropertyValue("--grid").trim(),
    series: SERIES_TOKENS.map((token) => styles.getPropertyValue(token).trim()),
    fontPlot:
      styles.getPropertyValue("--font-plot").trim() ||
      styles.getPropertyValue("--font-mono").trim() ||
      FALLBACK_MONO,
    fontSize: plotFontSize(styles),
    lineWidthScale: plotLineWidthScale(styles),
  };
  return cached;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/test.sh unit plot-theme`

Expected: PASS.

- [ ] **Step 5: Repoint consumers and delete the Canvas2D module**

Change `frontend/src/render/chart-host.ts:9-10` to:

```ts
import { formatTicks, hueIndex } from "./plot-theme";
import type { Palette, SeriesStroke } from "./plot-theme";
```

Change `frontend/src/render/overlay-renderer.ts:8` to import `SERIES_TOKENS` from `./plot-theme`.

In `frontend/src/ui/panel.ts`, drop the `CanvasRenderer` field, the `.plot-canvas` lookup at `:624`, and the `<canvas class="plot-canvas">` element in `panelMarkup()` at `:3029`. Replace `this.renderer.paletteColors()` at `:1141` with `resolvePalette()`, and `this.renderer.invalidateTheme()` at `:1520` with `invalidatePalette()`, importing both from `../render/plot-theme`. Repoint the `COLOR_SLOTS` import at `:56`. Keep `this.overlayRenderer.invalidateTheme()`.

Then:

```bash
git rm frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts
```

Repoint the `canvas-renderer` imports in `frontend/src/render/plot-fonts.test.ts:3`, `frontend/src/styles/palette.test.ts:4`, `frontend/src/render/chart-host.test.ts:6`, and `frontend/src/ui/panel.test.ts:10` to `./plot-theme` or `../render/plot-theme` as appropriate. Delete any assertion in those files that covered the removed drawing stack.

- [ ] **Step 6: Run the full unit suite**

Run: `./scripts/test.sh unit`

Expected: PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `./scripts/ci.sh frontend`

Expected: PASS.

- [ ] **Step 8: Format and commit**

```bash
./scripts/format.sh
git add -A frontend/src
git commit -m "refactor(frontend): extract plot theme and delete the Canvas2D plot renderer"
```

---

### Task 3: Reset the session migration ladder

Independent of the schema's shape, and doing it first is what keeps Task 4 from having to rewrite twenty rungs toward a shape that has lost the fields they populate.

**Files:**

- Modify: `core/scope-core/src/session.rs:112-262` and its migration helpers
- Test: `core/scope-core/src/session.rs` test module

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `migrate` is deleted. `SessionError::UnsupportedVersion(u32)` keeps its variant and message and becomes the response to every version that is not current.

- [ ] **Step 1: Write the failing test**

Add to the test module in `core/scope-core/src/session.rs`:

```rust
#[test]
fn earlier_schema_versions_are_rejected() {
    for version in 1..SCHEMA_VERSION {
        let value = serde_json::json!({
            "app": "signalscope",
            "schema_version": version,
        });
        assert!(matches!(
            from_value(value),
            Err(SessionError::UnsupportedVersion(_))
        ));
    }
}
```

The current-version constant is `SESSION_SCHEMA_VERSION` (`session.rs:21`). Match the deserialization entry point's actual name by reading `session.rs:60-115`; do not introduce new names.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh core earlier_schema_versions_are_rejected`

Expected: FAIL. The ladder migrates old versions forward instead of rejecting them.

- [ ] **Step 3: Delete the ladder**

Delete the `migrate` function in full. Its current-version arm at `:259` is `SESSION_SCHEMA_VERSION => Ok(serde_json::from_value(value)?)` — that behavior is all that survives. Change the call site at `:73` to deserialize directly when `head.schema_version == SESSION_SCHEMA_VERSION` and to return `SessionError::UnsupportedVersion(head.schema_version)` otherwise.

Delete the helpers that existed only for rungs: `migrate_v1_layout`, `migrate_v5_annotations`, `migrate_v8_color`, `migrate_v10_sources`, `migrate_v13_ensembles`, `migrate_v16_bindings`, `migrate_v17_channel_refs`, `migrate_v18_remove_alignment`, and `default_tab_cursor_modes`. Delete the panel-traversal helper below `SessionError` if nothing else calls it. Delete every existing migration test.

- [ ] **Step 4: Bring the benchmark workspace fixtures to the current version**

`examples/bench/smoke.workspace.json` and `examples/bench/mc1000.workspace.json` both carry `"schema_version": 20`. They load today only because the ladder migrates them, so resetting it breaks the benchmark — the very thing Task 6 relies on for evidence. Change the number in both files to `21`.

Nothing else needs to change. The v20 rung only inserted `axis_equal`, which Task 4 removes anyway, and the generated structs carry no `deny_unknown_fields`, so absent and stale keys are both tolerated.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./scripts/test.sh core session`

Expected: PASS, including a current-version round trip.

- [ ] **Step 6: Run the Rust gate**

Run: `./scripts/ci.sh rust`

Expected: PASS. `clippy` will flag any helper left unused — delete it rather than allowing it.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add core/scope-core/src/session.rs examples/bench/smoke.workspace.json examples/bench/mc1000.workspace.json
git commit -m "feat!: reject sessions from earlier schema versions"
```

---

### Task 4: Collapse the session schema

**Files:**

- Modify: `protocol/schema/scope-session.json`
- Regenerate: `frontend/src/generated/session.ts`, `core/scope-core/src/session/generated.rs`
- Modify: `frontend/src/ui/panel.ts`, `frontend/src/ui/app-shell.ts`, `frontend/src/app/workspace.ts`, and any other consumer the typechecker names
- Test: `frontend/src/app/session-conformance.test.ts`, `core/scope-core/src/session.rs`

**Interfaces:**

- Consumes: the ladder reset from Task 3.
- Produces: `schema_version` 22. `PanelMode` has the single variant `"time"`. `AnnotationDomain` has the single variant `"time"`. `PanelState` loses `x_ref`, `color_axis`, `color_ref`, `c_label`, and `axis_equal`. The `ColorAxis` type is removed.

- [ ] **Step 1: Edit the schema**

In `protocol/schema/scope-session.json`: set `"schema_version"` to `22`; change `PanelMode` variants to `["time"]`; change `AnnotationDomain` variants to `["time"]`; delete the `ColorAxis` type definition; and delete the `x_ref`, `color_axis`, `color_ref`, `c_label`, and `axis_equal` fields from `PanelState`.

- [ ] **Step 2: Regenerate**

Run: `./scripts/codegen.sh`

Expected: `frontend/src/generated/session.ts` and `core/scope-core/src/session/generated.rs` are rewritten. Do not hand-edit either.

- [ ] **Step 3: Run the typechecker to enumerate the work**

Run: `./scripts/ci.sh frontend`

Expected: FAIL, with one error per remaining reference to a removed field. Treat that list as the worklist for Step 4.

- [ ] **Step 4: Remove the field consumers**

Work the typechecker's list. Every site is a leftover from Task 1 — panel state construction, workspace defaults, session save and restore, and command handlers that set an axis reference or colour axis. Delete each reference rather than defaulting it. Where a panel-state literal is constructed, drop the removed keys.

Update `frontend/src/app/session-conformance.test.ts` and the Rust session tests so their fixtures carry `schema_version: 22` and no removed fields.

Bump `examples/bench/smoke.workspace.json` and `examples/bench/mc1000.workspace.json` to `22` as well — Task 3 left them at `21` — and delete their now-dead `x_ref`, `color_axis`, `color_ref`, and `c_label` keys from both panels in each file. Serde ignores unknown keys, so this is hygiene rather than correctness, but leaving them would misrepresent the schema.

- [ ] **Step 5: Run both suites**

Run: `./scripts/test.sh unit && ./scripts/test.sh core session`

Expected: PASS.

- [ ] **Step 6: Run the frontend and Rust gates**

Run: `./scripts/ci.sh frontend && ./scripts/ci.sh rust`

Expected: PASS.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add -A protocol core frontend/src examples/bench
git commit -m "feat!: collapse the session schema to time-only panels"
```

---

### Task 5: Prune the end-to-end and benchmark surface

Task 2 removed `.plot-canvas`, which both benchmark scenarios wait on. Retargeting them is not cosmetic — holding the in-pad pan floor is the evidence that this deletion did not regress the path ADR 0042 optimized.

**Files:**

- Delete: `frontend/tests/e2e/modes.spec.ts`
- Modify: `frontend/tests/e2e/interactions.spec.ts`, `frontend/tests/e2e/workbench.spec.ts`
- Modify: `frontend/tests/bench/bench.spec.ts`
- Modify: `frontend/tests/e2e/bench-smoke.spec.ts` if it waits on the same selector

**Interfaces:**

- Consumes: the markup from Tasks 1 and 2.
- Produces: no new exports. Both benchmark scenarios keep their names, `e2e_mc1000` and `e2e_mc1000_pan`, and their existing floors.

- [ ] **Step 1: Delete the mode suite**

```bash
git rm frontend/tests/e2e/modes.spec.ts
```

Its 519 lines exercise XY, spectrum, and histogram exclusively.

- [ ] **Step 2: Prune the surviving suites**

In `frontend/tests/e2e/interactions.spec.ts` and `frontend/tests/e2e/workbench.spec.ts`, delete the tests and blocks that switch panel mode, drop a signal on the XY strip, assert on a colourbar, or read the mode note. Keep everything that exercises time panels, linked time, annotations, statistics, undo, and export.

- [ ] **Step 3: Retarget the benchmark selector**

In `frontend/tests/bench/bench.spec.ts`, both scenarios wait on `.plot-canvas`, which no longer exists. Replace each with a wait on the chart host's canvas:

```ts
await expect(page.locator(".chart-host canvas").first()).toBeVisible({
  timeout: 120_000,
});
```

Leave the `.render-ms` wait, the frame probe, the report writes, and every floor exactly as they are. Apply the same substitution in `frontend/tests/e2e/bench-smoke.spec.ts` if it uses that selector.

- [ ] **Step 4: Lint the test sources**

Run: `./scripts/ci.sh frontend`

Expected: PASS. `eslint` covers `tests` as well as `src`.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add -A frontend/tests
git commit -m "test: prune the removed panel modes and retarget bench selectors"
```

---

### Task 6: Record the decision and run the full gate

**Files:**

- Create: `docs/adr/0043-time-only-presentation.md`
- Modify: `docs/adr/README.md`, `docs/adr/0005-session-schema-versioning.md`, `docs/adr/0015-window-sample-requests.md`
- Modify: `docs/implementation-roadmap.md`, `README.md`

**Interfaces:**

- Consumes: the behavior established by Tasks 1-5.
- Produces: documentation only.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0043-time-only-presentation.md`:

```markdown
# ADR 0043: Time-only presentation and a single plotter

- Status: Accepted
- Date: 2026-08-18
- Supersedes: ADRs 0016, 0017, 0018, 0019, and 0037
- Amends: ADRs 0005 and 0015

## Context

XY panels were slow at full resolution because the sample path never
received the binary columnar treatment the tile path got in ADR 0036:
JSON transport, a full copy to normalize gap values, one interpolation per
sample per series for the colour channel, and only then a Canvas2D stroke.
Every one of those costs was paid for three panel modes, and the uncapped
sample request had exactly one consumer — those panels.

Four modes also carried structural weight out of proportion to their use:
hand-written dispatch in the panel, four prepared-plot implementations
behind one polymorphic interface, and palette and tick resolution living
inside the Canvas2D module that the graphics-device renderer imported
across.

## Decision

SignalScope presents time-series panels only. XY, spectrum, and histogram
are removed with the code that served them alone, and ChartGPU is the
single plotter.

They are removed rather than ported because a flavor seam designed against
one implementation would be a guess. The seam is cut when the second
flavor returns and the duplication is real.

Palette resolution, series tokens, hue indexing, and tick generation move
out of the Canvas2D module into their own module. The Canvas2D drawing
stack is deleted; the overlay renderer is independent and unchanged.

Sample queries survive for comma-separated value export, which is already
bounded by its user-selected fidelity under ADR 0025. This narrows
ADR 0015 to the export path.

The session schema advances to version 22 with a single panel mode, a
single annotation domain, and no XY-only panel fields. The migration
ladder is reset: every rung is deleted and any earlier version is rejected
through the existing unsupported-version error. Sessions and snapshots
written by earlier versions stop loading. This amends ADR 0005, which
requires a rung and a test per bump, as a single deliberate break accepted
for this change.

## Consequences

The product loses three panel types until they are reintroduced. The
remaining plotter is small enough to make fast and to reason about, and
reintroduction starts from one renderer rather than four.

Reintroducing XY requires two things this change defers. The sample path
needs the binary columnar transport the tile path already has. Per-vertex
colour mapping on a two-dimensional line has no ChartGPU equivalent — the
capability exists only on its three-dimensional point cloud series, so a
scoped fork or a binned-segment approximation will be needed. Neither is
chosen here; both are recorded so the constraint is not rediscovered.

Time-series behavior is unchanged: full resolution under ADR 0041, and the
padded render feed, windowed presentation math, interleaved
single-precision vertices, and time rebase under ADR 0042.
```

- [ ] **Step 2: Add the ADR to the index**

In `docs/adr/README.md`, add after the line for ADR 0042:

```markdown
43. [Time-only presentation and a single plotter](0043-time-only-presentation.md)
```

- [ ] **Step 3: Amend the two amended records**

Append to `docs/adr/0005-session-schema-versioning.md`:

```markdown
## Amendment (2026-08-18, ladder reset)

Schema version 22 removes the non-time panel modes and their fields. The
migration ladder was reset rather than extended: every rung is deleted and
any version other than the current one is rejected through
`UnsupportedVersion`. Sessions and snapshots written by earlier versions no
longer load. This is a single deliberate break accepted for that change and
does not relax the rule for future bumps, which continue to require a rung
and a migration test. See [ADR 0043](0043-time-only-presentation.md).
```

Append to `docs/adr/0015-window-sample-requests.md`:

```markdown
## Amendment (2026-08-18, export-only)

The live presentation consumers of windowed sample requests — XY, spectrum,
and histogram panels — were removed by
[ADR 0043](0043-time-only-presentation.md). Sample queries remain only for
comma-separated value export, which is bounded by its user-selected
fidelity under ADR 0025. No live path issues an uncapped sample request.
```

- [ ] **Step 4: Update the roadmap and README**

In `docs/implementation-roadmap.md`, add a paragraph recording that presentation is time-only, linking ADR 0043, and naming the two prerequisites for reintroducing XY. In `README.md`, remove XY, FFT, and histogram from the described panel modes and any feature list that names them.

- [ ] **Step 5: Run the complete local gate**

Run: `./scripts/ci.sh all`

Expected: PASS. This runs format, quality, rust, frontend, and e2e.

- [ ] **Step 6: Run the benchmark suite**

Run: `./scripts/test.sh bench`

Expected: both `e2e_mc1000` and `e2e_mc1000_pan` report `pass: true` in `build/bench/report/`. Compare `frame_p95_ms` against the numbers recorded when ADR 0042 landed and report both. A regression here means the deletion disturbed the time path; report it rather than adjusting a floor.

- [ ] **Step 7: Format and commit**

```bash
./scripts/format.sh
git add docs README.md
git commit -m "docs: record time-only presentation"
```

---

## Handoff notes

Report these with the finished work:

- `frame_p95_ms` for `e2e_mc1000` and `e2e_mc1000_pan`, against the ADR 0042 numbers;
- the line-count change in `frontend/src/ui/panel.ts`, `frontend/src/app/plot-capabilities.ts`, and `core/scope-core/src/session.rs`;
- anything `knip` or `clippy` reported as newly unused that was not in this plan's delete lists.

Known follow-ups, deliberately not in scope:

- binary columnar transport for the sample path, needed before any flavor returns;
- per-vertex colour mapping on a 2D line, which ChartGPU does not support and which XY requires;
- the flavor seam itself, to be cut when the second panel type lands.

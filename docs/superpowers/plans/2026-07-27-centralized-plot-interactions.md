# Centralized Plot Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make histogram pan, zoom, box zoom, and fit honor stored viewport ranges while centralizing plot range and gesture policy outside `PanelView`.

**Architecture:** Prepared plot adapters compute their automatic axis ranges, while a pure `app/plot-gestures.ts` module resolves stored/automatic ranges and converts interaction policy into allowed axes and gesture intents. A DOM-bound `PlotInteractionController` owns event wiring and touch/drag state, calling a narrow `PlotInteractionHost` supplied by `PanelView`.

**Tech Stack:** TypeScript 5.9, Vitest 4, Canvas, Pointer Events, Playwright 1.57, repository shell wrappers.

## Global Constraints

- Histogram interaction changes only its viewport; linked-time changes still trigger re-binning.
- Annotation and cursor gestures remain available even when view-control policy denies pan or zoom.
- `PlotInteractionController` imports only `PlotLayout`, `PlotInteractionPolicy`, `plot-math`, and `plot-gestures`.
- `frontend/src/app/plot-math.ts` and its tests remain unchanged.
- No runtime or test-environment dependency is added.
- Existing desktop and touch bindings remain unchanged.
- Use `./scripts/test.sh frontend`, `./scripts/test.sh e2e`, and `./scripts/ci.sh all`; do not bypass repository wrappers.

---

### Task 1: Adapter-owned automatic ranges and shared range resolution

**Files:**

- Create: `frontend/src/app/plot-gestures.ts`
- Create: `frontend/src/app/plot-gestures.test.ts`
- Modify: `frontend/src/app/plot-capabilities.ts`
- Modify: `frontend/src/app/plot-capabilities.test.ts`
- Modify: `frontend/src/render/y-axis.ts`
- Modify: `frontend/src/render/y-axis.test.ts`
- Modify: `frontend/src/ui/panel.ts`

**Interfaces:**

- Produces: `PreparedPlot.autoRanges(): { x: readonly [number, number] | null; y: readonly [number, number] | null }`.
- Produces: `PlotInteractionPolicy.stickyAutoY: boolean`.
- Produces: `resolveRanges(policy, stored, auto, window): { x: Range; y: Range } | null`.
- Changes: `YAxisPolicy.resolve(seriesKey, automatic, serialized)` where `automatic` is `() => readonly [number, number] | null`.

- [ ] **Step 1: Write failing adapter auto-range tests**

Add literal expectations to `plot-capabilities.test.ts` for all modes:

```ts
expect(time.autoRanges()).toEqual({ x: [0, 5], y: [1.88, 4.12] });
expect(xy.autoRanges()).toEqual({ x: [1, 5], y: [2, 8] });
expect(fft.autoRanges()).toEqual({ x: [1, 3], y: [-90, 3] });
expect(histogram.autoRanges()).toEqual({ x: [0, 10], y: [0, 4.24] });
```

Add empty finite-data cases expecting `{ x: null, y: null }`. Give every `prepareXyPlot` fixture the new `window: { t0, t1 }` input.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
./scripts/test.sh frontend
```

Expected: type/test failure because `autoRanges`, `stickyAutoY`, and XY `window` do not exist.

- [ ] **Step 3: Implement adapter auto-ranges**

Move the finite-bin padded extent calculation into the time adapter module, add `window` to `XyPlotInput`, and implement:

```ts
autoRanges() {
  return {
    x: [input.window.t0, input.window.t1],
    y: timeAutoYRange(input.series.flatMap((entry) => entry.bins)),
  };
}
```

XY uses `traceExtent(..., input.window.t0, input.window.t1)`, FFT uses its finite frequency bounds and `[-90, 3]`, and histogram uses finite first/last edges plus the peak-count formula. Every adapter returns both axes as `null` when it has no finite drawable data.

- [ ] **Step 4: Write failing `YAxisPolicy` laziness/signature tests**

Change existing fixtures to return ranges and add:

```ts
it("does not compute automatic range when serialized range is usable", () => {
  const policy = new YAxisPolicy();
  let calls = 0;
  expect(
    policy.resolve(
      "a",
      () => {
        calls += 1;
        return [-1, 1];
      },
      [-100, 300],
    ),
  ).toEqual([-100, 300]);
  expect(calls).toBe(0);
});
```

- [ ] **Step 5: Run the focused test and verify RED**

Run `./scripts/test.sh frontend`.

Expected: `YAxisPolicy.resolve` still expects bins and `autoYRange` is still exported from the renderer module.

- [ ] **Step 6: Implement the `YAxisPolicy` contract**

Keep `isUsableYRange`; remove renderer-owned bin extent calculation; accept the lazy automatic range directly:

```ts
resolve(
  seriesKey: string,
  automatic: () => readonly [number, number] | null,
  serialized: readonly [number, number] | null,
): [number, number] {
  if (isUsableYRange(serialized)) return [...serialized];
  // reset key and latch as before
  this.sticky ??= usableCopy(automatic());
  return this.sticky ?? [-1, 1];
}
```

- [ ] **Step 7: Write failing shared range-resolution tests**

In `plot-gestures.test.ts`, cover histogram stored ranges, stored-over-auto, linked-time x, sticky vs non-sticky y, and missing ranges. Use a real `YAxisPolicy` callback for sticky behavior:

```ts
expect(
  resolveRanges(
    histogramPolicy,
    {
      x: [2, 4],
      y: [1, 3],
    },
    { x: [0, 10], y: [0, 8] },
    { t0: 20, t1: 30 },
  ),
).toEqual({ x: { min: 2, max: 4 }, y: { min: 1, max: 3 } });
```

- [ ] **Step 8: Run the focused test and verify RED**

Run `./scripts/test.sh frontend`.

Expected: module/export failure for `resolveRanges`.

- [ ] **Step 9: Implement and wire shared range resolution**

Implement `resolveRanges` with linked-time x precedence and stored-over-auto local axes. In `PanelView`, prepare the adapter first and, when `stickyAutoY` is true, pass `YAxisPolicy.resolve(seriesKey, () => auto.y, state.y_range)` as the effective automatic y range while leaving `stored.y` null; otherwise pass the adapter automatic range and serialized range directly. Call `resolveRanges` once, return without drawing on `null`, and pass the returned ranges to the renderer. Delete all four inline fallback calculations.

- [ ] **Step 10: Run Task 1 gate and commit**

Run:

```bash
./scripts/test.sh frontend
git add frontend/src/app/plot-capabilities.ts frontend/src/app/plot-capabilities.test.ts frontend/src/app/plot-gestures.ts frontend/src/app/plot-gestures.test.ts frontend/src/render/y-axis.ts frontend/src/render/y-axis.test.ts frontend/src/ui/panel.ts
git commit -m "feat: centralize plot range resolution"
```

### Task 2: Pure gesture policy resolvers

**Files:**

- Modify: `frontend/src/app/plot-gestures.ts`
- Modify: `frontend/src/app/plot-gestures.test.ts`

**Interfaces:**

- Produces: `wheelAxes`, `panAxes`, `boxZoomAxes`, `dragIntent`, and `allowsFit`.
- Consumes: `PlotInteractionPolicy` and `ZoomDragMode`.

- [ ] **Step 1: Write table-driven failing tests**

Cover plain/shift/alt wheel, y-only pan, box/y intersection, missing box capability, left-click fall-through, pan mouse buttons/modifiers, and fit:

```ts
expect(wheelAxes(yOnly, { shift: false, alt: false })).toEqual({
  x: false,
  y: true,
});
expect(boxZoomAxes(boxAndY, "xy")).toEqual({ x: false, y: true });
expect(dragIntent(noViewControls, 0, { ctrl: false, meta: false })).toBe(
  "click",
);
```

Add a real-policy regression asserting histogram exposes x/y pan and x/y/box zoom after Task 4.

- [ ] **Step 2: Run the focused test and verify RED**

Run `./scripts/test.sh frontend`.

Expected: missing gesture resolver exports.

- [ ] **Step 3: Implement minimal pure resolvers**

Implement each resolver as a direct policy-set intersection. `dragIntent` returns pan only when the pressed binding is a pan binding and at least one pan axis is allowed; left button otherwise returns box when `box` plus an axis are allowed, then `click`; unsupported buttons return `none`.

- [ ] **Step 4: Run Task 2 gate and commit**

Run:

```bash
./scripts/test.sh frontend
git add frontend/src/app/plot-gestures.ts frontend/src/app/plot-gestures.test.ts
git commit -m "feat: enforce plot gesture policies"
```

### Task 3: Extract the DOM interaction controller

**Files:**

- Create: `frontend/src/ui/plot-interactions.ts`
- Modify: `frontend/src/ui/panel.ts`

**Interfaces:**

- Produces: `PlotInteractionController` with `setPolicy(policy)` and `isDragging()`.
- Consumes: `PlotInteractionHost` methods declared in the approved design.

- [ ] **Step 1: Establish the unchanged behavior gate**

Run:

```bash
./scripts/test.sh e2e
```

Expected: existing desktop and mobile suites pass before extraction.

- [ ] **Step 2: Move gesture wiring and state verbatim**

Create `PlotInteractionController`, moving wheel, pointerdown/up/cancel, double-click, desktop pan/marquee, touch state, pinch, long press, tap, double tap, `box`, and `dragging`. Replace direct panel fields with a controller instance. The host delegates layout, range callbacks, annotation operations, cursor publication, gesture hints, overlay box updates, and axis editing back to existing `PanelView` methods.

- [ ] **Step 3: Apply policy only at existing effect points**

Use `wheelAxes`, `panAxes`, `boxZoomAxes`, `dragIntent`, and `allowsFit`. Do not restructure the state machine. Empty gated axis sets fall through to click/tap inspection. Keep axis-label double-click ungated.

- [ ] **Step 4: Run extraction gates and commit**

Run:

```bash
./scripts/test.sh frontend
./scripts/test.sh e2e
git add frontend/src/ui/plot-interactions.ts frontend/src/ui/panel.ts
git commit -m "refactor: extract plot interaction controller"
```

### Task 4: Enable and prove histogram viewport interactions

**Files:**

- Modify: `frontend/src/app/plot-capabilities.ts`
- Modify: `frontend/src/app/plot-gestures.test.ts`
- Modify: `frontend/tests/e2e/modes.spec.ts`
- Modify: `frontend/tests/e2e/touch.spec.ts`
- Modify: `docs/adr/0018-histogram-semantics.md`

**Interfaces:**

- Changes histogram policy to pan `{x,y}`, zoom `{x,y,box}`, fit true, sticky-auto-y false.

- [ ] **Step 1: Write failing desktop histogram viewport test**

Add a helper that parses the first numeric bound from the histogram bin tooltip. In histogram mode:

1. hover a fixed overlay point and record fitted interval;
2. wheel zoom and assert the interval changes;
3. ctrl-drag horizontally and assert the interval moves in drag direction;
4. double-click and assert the fitted interval returns.

- [ ] **Step 2: Write failing touch histogram viewport test**

Switch to histogram on mobile, enable the track cursor, sample the fixed-position bin readout, dispatch a one-finger drag, resample and assert it changed, dispatch a double tap, then assert the fitted readout returns.

- [ ] **Step 3: Run e2e and verify RED**

Run `./scripts/test.sh e2e`.

Expected: histogram interval does not change because its policy denies pan/zoom.

- [ ] **Step 4: Enable histogram policy and amend ADR 0018**

Set histogram pan/zoom sets to the full policy. Replace “No zoom or pan” with viewport-only camera semantics and explicitly note that this bullet alone supersedes the earlier decision; source-window changes still re-bin.

- [ ] **Step 5: Run Task 4 gates and commit**

Run:

```bash
./scripts/test.sh frontend
./scripts/test.sh e2e
git add frontend/src/app/plot-capabilities.ts frontend/src/app/plot-gestures.test.ts frontend/tests/e2e/modes.spec.ts frontend/tests/e2e/touch.spec.ts docs/adr/0018-histogram-semantics.md
git commit -m "feat: add histogram viewport interactions"
```

### Task 5: Final quality gate and synchronized minor version

**Files:**

- Modify through script: workspace manifests and lockfiles reported by `./scripts/version.sh bump minor`

- [ ] **Step 1: Review staged and unstaged scope**

Run:

```bash
git status --short
git diff
git diff --cached
```

Confirm only plan/spec implementation files and synchronized version manifests changed.

- [ ] **Step 2: Run full pre-version gate**

Run:

```bash
./scripts/install-hooks.sh
./scripts/ci.sh all
```

Expected: formatting, quality, Rust, frontend, artifact, desktop e2e, and mobile e2e gates pass.

- [ ] **Step 3: Bump and validate the minor version**

Run:

```bash
./scripts/version.sh bump minor
./scripts/version.sh check
```

Expected: all release manifests advance from `0.3.3` to `0.4.0`.

- [ ] **Step 4: Run fresh post-version verification and commit**

Run:

```bash
./scripts/ci.sh format
./scripts/test.sh frontend
./scripts/version.sh check
git add Cargo.toml Cargo.lock frontend/package.json pnpm-lock.yaml shell/tauri.conf.json
git commit -m "chore: bump version to 0.4.0"
```

- [ ] **Step 5: Inspect final history and worktree**

Run:

```bash
git status --short
git log --oneline --decorate -8
```

Expected: clean worktree with focused conventional commits and synchronized version metadata.

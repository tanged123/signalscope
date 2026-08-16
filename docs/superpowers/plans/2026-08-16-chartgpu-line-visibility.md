# ChartGPU Line Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal and ghost ChartGPU series readable while preserving SignalScope's semantic stroke styles.

**Architecture:** Apply renderer-specific minimum widths only in `ChartHost`, after style resolution and before creating ChartGPU line-series options. Keep the pinned ChartGPU vendor, palette, opacity, and Canvas2D behavior unchanged.

**Tech Stack:** TypeScript, ChartGPU, Vitest.

## Global Constraints

- Use repository scripts for formatting and tests.
- Do not modify `frontend/vendor/chartgpu/`.
- Add no runtime dependencies.
- Preserve unrelated staged and unstaged work.
- Do not bump the version; this is an intermediate fix on the existing 1.0.0 feature branch.

---

### Task 1: Compensate thin ChartGPU series widths

**Files:**

- Modify: `frontend/src/render/chart-host.ts`
- Test: `frontend/src/render/chart-host.test.ts`

**Interfaces:**

- Consumes: `SeriesStroke.width`, `SeriesStroke.hue`, and the existing emphasis state.
- Produces: ChartGPU `lineStyle.width` values floored at 2 for colored strokes and 1.5 for ghost strokes, with 0.4 added for emphasis.

- [ ] **Step 1: Write the failing test**

Add a ChartHost test that renders normal width 1.4, ghost width 1, explicit
width 2.6, and emphasized normal width 1.4. Assert emitted widths of 2, 1.5,
2.6, and 2.4 respectively.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/test.sh unit chart-host`

Expected: FAIL because ChartHost currently forwards 1.4 and 1 directly.

- [ ] **Step 3: Write the minimal implementation**

In `chart-host.ts`, define renderer-local minimum-width constants and compute:

```ts
const minimumWidth = ghost ? 1.5 : 2;
const width = Math.max(style.width, minimumWidth) + (isEmphasized ? 0.4 : 0);
```

Pass `width` to `lineStyle`. Update the existing emphasis expectation from 1.9
to 2.4 because emphasis is applied after the normal-stroke floor.

- [ ] **Step 4: Run verification**

Run:

```bash
./scripts/test.sh unit chart-host
./scripts/format.sh
./scripts/test.sh frontend
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit only task files**

```bash
git add frontend/src/render/chart-host.ts frontend/src/render/chart-host.test.ts docs/superpowers/specs/2026-08-16-chartgpu-line-visibility-design.md docs/superpowers/plans/2026-08-16-chartgpu-line-visibility.md
git commit -m "fix: strengthen ChartGPU series visibility"
```

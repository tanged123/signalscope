# Frontend Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove speculative frontend machinery (the unwired expression stub with its eval-blocklist sandbox, the subscriber-less linked-time observer), record the expression-layer decision as an ADR, cache renderer style reads off the hot path, and remove the host discriminant that invites the UI branching ADR 0001 forbids.

**Architecture:** The frontend keeps only what the walking skeleton exercises. Expressions are decided (not built): evaluation belongs to `scope-core`'s compute module behind the protocol — a new ADR pins that so nobody re-plants an eval sandbox in the webview. `LinkedTimeModel` shrinks to a validated state holder until a second panel exists to subscribe. The renderer resolves its palette once per theme and reallocates the canvas bitmap only on resize.

**Tech Stack:** TypeScript 5.9, Vitest, Canvas 2D, Playwright.

## Global Constraints

- **Depends on Plan 03** for Task 2 (`linked-time.ts` types come from generated code after Plan 03; running this first creates avoidable conflicts). Tasks 1, 3, 4, 5 have no plan dependencies.
- Run all commands through `./scripts/` wrappers (`./scripts/dev.sh pnpm …` outside the dev shell).
- The e2e specs assert on visible text ("native data plane" appears in the signal-tree footer; render-ms updates) — keep user-visible strings identical.
- ESLint (typescript-eslint strict) + `tsc --noEmit` gate everything; commit messages lowercase imperative.

---

### Task 1: Delete the expression stub; decide the layer in an ADR

**Files:**

- Delete: `frontend/src/app/expression.ts`, `frontend/src/app/expression.test.ts`
- Create: `docs/adr/0008-expression-evaluation-layer.md`
- Modify: `docs/adr/README.md` (add the new ADR to its index list)

**Interfaces:**

- Produces: nothing — `expression.ts` is imported only by its own test (verify in Step 1), so deletion is clean. The ADR is the deliverable: it pins where the future feature lives.

- [ ] **Step 1: Verify the stub is unwired, then delete it**

```bash
grep -rn "expression" frontend/src --include="*.ts" | grep -v expression.ts | grep -v expression.test.ts
```

Expected: no hits (the `.formula-input` in `app-shell.ts` has no handler and no import). Then:

```bash
git rm frontend/src/app/expression.ts frontend/src/app/expression.test.ts
```

- [ ] **Step 2: Write the ADR** — `docs/adr/0008-expression-evaluation-layer.md`:

```markdown
# ADR 0008: Expressions evaluate in the native compute layer

- Status: Accepted
- Date: 2026-07-24

## Context

Derived-signal expressions could evaluate as sandboxed JavaScript in the
presentation plane or in the native compute module behind the protocol. A
Phase 0 frontend stub parsed `deriv`/`integ`/`smooth`/`$` references and
gate-checked strings with an eval blocklist, while `scope-core::compute`
already implements the same transforms in Rust — seeding both answers.

## Decision

Expression evaluation is a protocol request served by `scope-core`'s
compute module (ADR 0001: the native plane owns compute). The frontend may
parse references for editor affordances but never evaluates. Snapshots bake
derived results like any other signal. The dormant frontend stub — and its
blocklist "sandbox", which pre-committed to in-browser eval — was removed
rather than left as false assurance.

## Consequences

One authoritative implementation of derived-signal semantics. The derived
formula bar stays inert until the protocol request exists. No JavaScript
evaluation of user expressions ever runs in the webview.
```

Add to `docs/adr/README.md`'s list: `- [0008 – Expression evaluation layer](0008-expression-evaluation-layer.md)` (match the file's existing list format).

- [ ] **Step 3: Run checks and commit**

Run: `./scripts/test.sh frontend` — Expected: PASS (one fewer test file).

```bash
git add -A frontend/src/app docs/adr
git commit -m "remove dormant expression stub and pin evaluation to the compute layer"
```

---

### Task 2: Shrink `LinkedTimeModel` to what has callers

**Files:**

- Modify: `frontend/src/app/linked-time.ts`, `frontend/src/app/linked-time.test.ts`, `frontend/src/ui/app-shell.ts`

**Interfaces:**

- Consumes: type re-exports from Plan 03 (`LinkedTimeState`, `TimeWindow`, `TimeMode` sourced from generated code) — keep those lines untouched at the top of the file.
- Produces: `LinkedTimeModel` with exactly `snapshot(): Readonly<LinkedTimeState>` and `setLinked(linked: boolean): void`. The listener set, `subscribe`, `setWindow`, `setCursor`, `publish`, and the `origin` parameters are deleted (~40 of 74 lines with no non-test caller; ADR 0006's linked-time _shape_ is unaffected — it lives in the session schema).

- [ ] **Step 1: Rewrite the class** (below the type re-export lines):

```ts
export class LinkedTimeModel {
  constructor(
    private state: LinkedTimeState = {
      t0: 0,
      t1: 60,
      linked: true,
      cursorT: null,
      mode: "fixed",
      paused: false,
    },
  ) {
    if (
      !Number.isFinite(state.t0) ||
      !Number.isFinite(state.t1) ||
      state.t1 <= state.t0
    ) {
      throw new Error("Time window must be finite and increasing");
    }
  }

  snapshot(): Readonly<LinkedTimeState> {
    return { ...this.state };
  }

  setLinked(linked: boolean): void {
    this.state = { ...this.state, linked };
  }
}
```

- [ ] **Step 2: Update the one caller**

In `app-shell.ts`'s `bindControls`, change `this.time.setLinked(linked, "toolbar");` to `this.time.setLinked(linked);`.

- [ ] **Step 3: Rewrite the tests** — `frontend/src/app/linked-time.test.ts` keeps only behavior that still exists:

```ts
import { describe, expect, it } from "vitest";
import { LinkedTimeModel } from "./linked-time";

describe("LinkedTimeModel", () => {
  it("rejects a non-increasing window", () => {
    expect(
      () =>
        new LinkedTimeModel({
          t0: 5,
          t1: 5,
          linked: true,
          cursorT: null,
          mode: "fixed",
          paused: false,
        }),
    ).toThrow(/finite and increasing/);
  });

  it("snapshots are copies and setLinked updates state", () => {
    const model = new LinkedTimeModel();
    const before = model.snapshot();
    model.setLinked(false);
    expect(before.linked).toBe(true);
    expect(model.snapshot().linked).toBe(false);
  });
});
```

- [ ] **Step 4: Run checks and commit**

Run: `./scripts/test.sh frontend` — Expected: PASS.

```bash
git add frontend/src/app/linked-time.ts frontend/src/app/linked-time.test.ts frontend/src/ui/app-shell.ts
git commit -m "shrink linked-time model to its exercised surface"
```

---

### Task 3: Renderer — cache the palette, stop reallocating the bitmap

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`, `frontend/src/ui/app-shell.ts`

**Interfaces:**

- Produces: `CanvasRenderer.invalidateTheme(): void` — `AppShell.toggleTheme` must call it; everything else is internal.

- [ ] **Step 1: Extract and cache the palette**

In `canvas-renderer.ts`, add above the class:

```ts
interface Palette {
  background: string;
  border: string;
  fg2: string;
  fg3: string;
  grid: string;
  series: string[];
}
```

In the class:

```ts
export class CanvasRenderer {
  private palette: Palette | null = null;
  private renderedWidth = 0;
  private renderedHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Drop the cached palette; call when the theme changes. */
  invalidateTheme(): void {
    this.palette = null;
  }

  private resolvePalette(): Palette {
    if (this.palette !== null) return this.palette;
    const styles = getComputedStyle(document.documentElement);
    this.palette = {
      background: styles.getPropertyValue("--surface-0").trim(),
      border: styles.getPropertyValue("--border-strong").trim(),
      fg2: styles.getPropertyValue("--fg-2").trim(),
      fg3: styles.getPropertyValue("--fg-3").trim(),
      grid: styles.getPropertyValue("--grid").trim(),
      series: SERIES_TOKENS.map((token) =>
        styles.getPropertyValue(token).trim(),
      ),
    };
    return this.palette;
  }
```

In `render(...)`, replace the `const styles = getComputedStyle(…); const colors = { … };` block with `const colors = this.resolvePalette();` — the per-frame style resolution (14 reads forcing style recalc on every pan/zoom/resize frame) happens at most once per theme.

- [ ] **Step 2: Reallocate the backing store only on real size change**

In `prepareCanvas()`, wrap the two assignments (each assignment clears the GPU-side bitmap even when the value is unchanged):

```ts
const targetWidth = Math.round(width * ratio);
const targetHeight = Math.round(height * ratio);
if (
  targetWidth !== this.renderedWidth ||
  targetHeight !== this.renderedHeight
) {
  this.canvas.width = targetWidth;
  this.canvas.height = targetHeight;
  this.renderedWidth = targetWidth;
  this.renderedHeight = targetHeight;
}
```

(The full-scene `fillRect` in `render` already repaints the surface, so skipping reallocation changes no pixels.)

- [ ] **Step 3: Invalidate on theme toggle**

In `app-shell.ts` `toggleTheme()`, before `this.renderCanvas();` add:

```ts
this.renderer?.invalidateTheme();
```

- [ ] **Step 4: Run checks and commit**

Run: `./scripts/test.sh frontend` then `./scripts/test.sh e2e` — Expected: PASS; the "theme is a pure token swap" spec proves the invalidation path repaints with light-theme colors.

```bash
git add frontend/src/render/canvas-renderer.ts frontend/src/ui/app-shell.ts
git commit -m "cache renderer palette and reuse the canvas backing store"
```

---

### Task 4: Replace the `host` discriminant with a source label

**Files:**

- Modify: `frontend/src/app/data-plane.ts`, `frontend/src/ui/app-shell.ts`

**Interfaces:**

- Produces: `DataPlane.sourceLabel: string` replaces `DataPlane.host: "native" | "snapshot"`. ADR 0001 bans UI host-branching; exposing the enum invited call sites to `if (plane.host === …)`. A display label is data, not a branch point.

- [ ] **Step 1: Change the interface and both implementations**

In `data-plane.ts`:

```ts
export interface DataPlane {
  /** Human-readable description of where the data comes from. */
  readonly sourceLabel: string;
  listSignals(): Promise<SignalSummary[]>;
  queryTiles(request: TileRequest): Promise<TileResponse>;
}
```

`TauriPlane`: replace `readonly host = "native" as const;` with `readonly sourceLabel = "native data plane";`
`BakedPlane`: replace `readonly host = "snapshot" as const;` with `readonly sourceLabel = "baked demo source";`

(These are the exact strings the footer shows today, so the e2e-visible text is unchanged.)

- [ ] **Step 2: Update the shell markup**

In `app-shell.ts`: `shellMarkup(this.plane.host)` becomes `shellMarkup(this.plane.sourceLabel)`; the function signature becomes `function shellMarkup(sourceLabel: string): string` and the footer line becomes:

```ts
<span>${sourceLabel}</span>
```

(deleting the `host === "native" ? … : …` ternary — the last host branch in the UI).

- [ ] **Step 3: Run checks and commit**

Run: `./scripts/test.sh frontend` and `./scripts/test.sh e2e` — Expected: PASS.

```bash
git add frontend/src/app/data-plane.ts frontend/src/ui/app-shell.ts
git commit -m "expose a source label instead of a host discriminant"
```

---

### Task 5: Cross-reference the dev-port constant + final gate

**Files:**

- Modify: `scripts/run.sh`

Both declaration sites (`frontend/package.json` and `shell/src-tauri/tauri.conf.json`) are JSON and cannot carry comments, so the cross-reference lives in `scripts/run.sh`, which already mentions the port in its help text.

- [ ] **Step 1: Document the coupling in `scripts/run.sh`**

Near the top of `scripts/run.sh` (after the `source`/`ensure_dev_shell` lines), add:

```bash
# Port 4173 is declared twice by necessity: frontend/package.json ("dev"
# script) and shell/src-tauri/tauri.conf.json (devUrl). Change both together.
```

- [ ] **Step 2: Run the full gate**

Run: `./scripts/ci.sh all` — Expected: every stage PASS.

- [ ] **Step 3: Commit and hand off**

```bash
git add scripts/run.sh
git commit -m "document the dev-port coupling between vite and tauri"
```

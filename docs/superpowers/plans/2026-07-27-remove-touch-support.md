# Remove Touch Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove touch and mobile-emulation support from the SignalScope
frontend, recording the decision as an ADR and documenting how to reimplement
it properly if the product later needs it.

**Architecture:** Deletion in dependency order so every commit leaves the tree
green — decision documents first, then the tests that exercise touch, then the
touch handlers, then the pinch math they call, then the coarse-pointer CSS.
Nothing is rewritten; the removed code is recoverable from git and the
reimplementation appendix cites it.

**Tech Stack:** TypeScript, Vitest, Playwright, plain CSS.

## Global Constraints

- Use the `./scripts/` wrappers for every build, test, format, and version
  operation. If an operation lacks a wrapper, add one rather than reaching for
  generic tooling.
- `./scripts/test.sh frontend` after each code task; `./scripts/test.sh e2e`
  after Task 2 and Task 6; `./scripts/ci.sh all` before handoff.
- The PR's final commit is a synchronized version bump via
  `./scripts/version.sh bump minor` followed by `./scripts/version.sh check`.
- Preserve user worktree changes. Stage only the files each task names.
- Accepted ADRs are amended with a superseding record, never silently
  rewritten.
- `touch-action: none` on `.overlay-canvas` (`frontend/src/styles/app.css:725`)
  **stays**. It is not mobile support: without it, a touchscreen laptop lets
  the browser claim drags over the plot for page scrolling. Deleting it is a
  desktop regression.
- The `@media (max-width: 820px)` and `@media (max-width: 1100px)` blocks in
  `app.css` **stay**. They are responsive-desktop breakpoints that a narrow
  window hits; they are not mobile support.

## Precondition

This plan assumes the centralized-plot-interactions PR
(`docs/superpowers/specs/2026-07-27-centralized-plot-interactions-design.md`)
has landed, so touch handling lives in `frontend/src/ui/plot-interactions.ts`
rather than `frontend/src/ui/panel.ts`.

**If that PR has not landed**, the same code sits in `panel.ts` at these
pre-refactor locations, and Task 3 applies there instead:

| symbol                 | pre-refactor location              |
| ---------------------- | ---------------------------------- |
| touch state fields     | `panel.ts:175-186`                 |
| `TOUCH` constant       | `panel.ts:79-91`                   |
| `beginTouch`           | `panel.ts:985-1025`                |
| `moveTouch`            | `panel.ts:1027-1060`               |
| `applyPinch`           | `panel.ts:1082-1109`               |
| `endTouch`             | `panel.ts:1112-1142`               |
| `clearLongPress`       | `panel.ts:1144-1149`               |
| `publishTouchCursor`   | `panel.ts:1151-1172`               |
| `pointerType` branches | `panel.ts:327, 391, 407, 410, 413` |

Verify which layout is present before starting:

```bash
ls frontend/src/ui/plot-interactions.ts 2>/dev/null \
  && echo "post-refactor" || echo "pre-refactor: use the table above"
```

## File Structure

| file                                      | change                 | responsibility after                                |
| ----------------------------------------- | ---------------------- | --------------------------------------------------- |
| `docs/adr/0021-desktop-only-input.md`     | create                 | records the posture decision and its reversal path  |
| `docs/adr/README.md`                      | modify                 | index entry 21                                      |
| `AGENTS.md`                               | modify: `:164`, `:180` | rules stop mandating mobile gestures and mobile e2e |
| `frontend/tests/e2e/touch.spec.ts`        | delete                 | —                                                   |
| `frontend/playwright.config.ts`           | modify: `projects`     | desktop project only                                |
| `scripts/ci.sh`                           | modify: `:23`          | help text stops naming the mobile project           |
| `frontend/tests/e2e/interactions.spec.ts` | modify                 | 4 `isMobile` guards removed                         |
| `frontend/tests/e2e/modes.spec.ts`        | modify                 | 10 `isMobile` guards removed                        |
| `frontend/tests/e2e/workbench.spec.ts`    | modify                 | 3 `isMobile` guards removed                         |
| `frontend/src/ui/plot-interactions.ts`    | modify                 | pointer gestures only; no touch state               |
| `frontend/src/ui/panel.ts`                | modify                 | `pinAt`/`removeAt` become private again             |
| `frontend/src/app/plot-math.ts`           | modify: `:170-215`     | pan/zoom math without pinch                         |
| `frontend/src/app/plot-math.test.ts`      | modify                 | pinch cases removed                                 |
| `frontend/src/styles/app.css`             | modify: `:728-741`     | no coarse-pointer block                             |

---

### Task 1: Record the decision

**Files:**

- Create: `docs/adr/0021-desktop-only-input.md`
- Modify: `docs/adr/README.md`
- Modify: `AGENTS.md:164`, `AGENTS.md:180`

**Interfaces:**

- Consumes: nothing.
- Produces: the ADR that Tasks 2-6 cite in their commit messages, and the
  amended `AGENTS.md` rules that make those deletions compliant rather than
  violations.

This task is first because `AGENTS.md:164` and `:180` currently _require_ what
the later tasks delete. Removing the code before amending the rules would leave
the repository self-contradicting at every intermediate commit.

- [ ] **Step 1: Read the source material so the ADR states the record accurately**

```bash
grep -n "optional mobile support\|Mobile is functional\|Mobile posture" \
  "docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/reference/prompt.md"
grep -oic "mobile" \
  "docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/SignalScope Final Spec.dc.html"
```

Expected: three hits in `prompt.md`; `0` in the Final Spec. The ADR's central
claim is that the controlling document is silent and the only mandate comes
from a prompt that deprioritized it. Confirm that before writing it down.

- [ ] **Step 2: Write the ADR**

Create `docs/adr/0021-desktop-only-input.md`. Follow ADR 0020's header style
(`# ADR NNNN: Title` with `- Status:` bullets), which is the current
convention:

```markdown
# ADR 0021: Desktop-only input

- Status: Accepted
- Date: 2026-07-27
- Supersedes: the touch gesture requirements carried into `AGENTS.md` from the
  design kickoff prompt

## Context

The frontend ships a complete touch gesture set: one-finger pan, axis-aware
pinch, tap-to-read, long-press-to-pin, and double-tap-to-fit. It costs roughly
380 lines across `plot-interactions.ts`, `plot-math.ts`, their tests, a
dedicated Playwright project, 17 `isMobile` guards, and a coarse-pointer CSS
block.

None of it is required by the controlling design documents. `SignalScope Final
Spec.dc.html` and `SignalScope Audit v2.dc.html` mention mobile, touch, tablet,
pinch, and long-press zero times. The gesture set traces to two non-controlling
sources: `reference/prompt.md`, which lists the gestures and tags them
"**(optional mobile support, deprioritize for now)**", and `kickoffprompt.md`,
which asks to keep the prototype's full desktop-plus-touch gesture set.

`reference/prompt.md` also raises the posture as open question 8 — "Mobile
posture: full tool vs. review companion — pick one and design it" — and
observes that "mobile is functional but secondary" with plots capturing all
touch so panels scroll awkwardly. The design pass never answered the question.
The Playwright project is named `mobile-review`, suggesting someone leaned
toward the review-companion reading, but no record exists.

The result is a working implementation of a product posture nobody chose. Its
coverage reflects that: one e2e test exercises one-finger pan. Pinch,
long-press, double-tap, and the three-or-more-finger rejection path have no
tests at all.

## Decision

SignalScope is a desktop instrument. Pointer, keyboard, and wheel are the
supported input modes.

- Remove the touch gesture set, the pinch range math, `touch.spec.ts`, the
  `mobile-review` Playwright project, the `isMobile` guards, and the
  `@media (hover: none)` block.
- Keep `touch-action: none` on `.overlay-canvas`. It prevents a touchscreen
  laptop's browser from claiming plot drags for page scrolling, which is
  desktop behavior, not mobile support.
- Keep the `max-width` responsive breakpoints. A narrow desktop window hits
  them.
- Amend `AGENTS.md` so the rules no longer mandate mobile gestures or
  mobile-emulation e2e.

This is a scope decision, not a judgment that the removed code was wrong. The
pinch solver in particular is correct and well-tested.

## Consequences

- `plot-interactions.ts` handles one input model. The gesture layer stops
  interleaving inspection (`publishTouchCursor`) with view control.
- The e2e suite runs each spec once instead of twice.
- Touching a SignalScope plot does nothing. On a touchscreen laptop the plot
  is inert rather than misbehaving, because `touch-action: none` still
  suppresses the browser's default.
- Reversing this decision means answering design-pass question 8 first. The
  reimplementation path is recorded in
  `docs/superpowers/plans/2026-07-27-remove-touch-support.md`, and the deleted
  code remains in git history.
```

- [ ] **Step 3: Add the index entry**

In `docs/adr/README.md`, after the line beginning `20. [Three-strip chrome`:

```markdown
21. [Desktop-only input](0021-desktop-only-input.md)
```

- [ ] **Step 4: Amend the two AGENTS.md rules**

`AGENTS.md:164-165` currently reads:

```markdown
- Preserve keyboard paths for pointer actions and the specified desktop/mobile
  gestures. Right-click must never be the only way to perform an action.
```

Replace with:

```markdown
- Preserve keyboard paths for pointer actions and the specified desktop
  gestures. Right-click must never be the only way to perform an action.
  Touch input is out of scope per ADR 0021.
```

`AGENTS.md:180-181` currently reads:

```markdown
- Playwright: desktop and mobile-emulation interactions when changing input,
  gestures, layout, or export behavior.
```

Replace with:

```markdown
- Playwright: desktop interactions when changing input, gestures, layout, or
  export behavior.
```

- [ ] **Step 5: Verify no other rule mandates touch**

Run: `grep -ni "touch\|mobile\|tablet\|pinch" AGENTS.md CLAUDE.md`

Expected: no remaining hits that require touch support. A hit inside the new
ADR reference is fine. If another mandate appears, amend it in this task
rather than leaving it for a later one.

- [ ] **Step 6: Commit**

```bash
git add docs/adr/0021-desktop-only-input.md docs/adr/README.md AGENTS.md
git commit -m "docs(adr): record desktop-only input decision

The controlling design documents never specified touch. The gesture set came
from the prototype via a kickoff prompt that tagged mobile support optional
and deprioritized, and design-pass question 8 on mobile posture was never
answered.

ADR 0021 picks desktop-only and amends the two AGENTS.md rules that mandated
mobile gestures and mobile-emulation e2e."
```

---

### Task 2: Remove the touch tests and the mobile Playwright project

**Files:**

- Delete: `frontend/tests/e2e/touch.spec.ts`
- Modify: `frontend/playwright.config.ts` (the `projects` array)
- Modify: `frontend/tests/e2e/interactions.spec.ts` (lines 11, 13, 60, 62, 93, 95, 120, 122)
- Modify: `frontend/tests/e2e/modes.spec.ts` (lines 85, 87, 110, 112, 140, 142, 187, 189, 211, 213, 253, 255, 282, 284, 314, 316, 353, 355, 388, 389)
- Modify: `frontend/tests/e2e/workbench.spec.ts` (lines 257, 259, 306, 308, 370, 371)

**Interfaces:**

- Consumes: ADR 0021 from Task 1.
- Produces: an e2e suite with a single `desktop` project and no `isMobile`
  fixture usage. Task 3 relies on `touch.spec.ts` being gone, since it is the
  only test exercising the handlers that task deletes.

Tests go before the code they cover. That is backwards for a feature and
correct for a removal: it is the only order in which every intermediate commit
is green.

- [ ] **Step 1: Confirm the current suite passes before changing anything**

Run: `./scripts/test.sh e2e`
Expected: PASS. Note the wall-clock time; Step 7 compares against it.

If this fails, stop. A pre-existing failure must not be attributed to this
plan.

- [ ] **Step 2: Delete the touch spec**

```bash
git rm frontend/tests/e2e/touch.spec.ts
```

This is the only file that asserts touch behavior. Its single test covers
one-finger pan plus a command-palette fit. Pinch, long-press, double-tap, and
the multi-finger rejection path were never covered — worth knowing when
reading the reimplementation appendix.

- [ ] **Step 3: Drop the mobile project**

In `frontend/playwright.config.ts`, replace:

```ts
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-review", use: { ...devices["Pixel 7"] } },
  ],
```

with:

```ts
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
```

- [ ] **Step 4: Remove the `isMobile` guards**

With only the desktop project left, `isMobile` is always `false`, so every
`test.skip(isMobile, ...)` is dead code. Remove both the fixture destructuring
and the skip line at each site.

In `interactions.spec.ts`, `modes.spec.ts`, and `workbench.spec.ts`, each site
looks like one of these two shapes. Multi-line:

```ts
  test("...", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
```

becomes:

```ts
  test("...", async ({ page }) => {
```

Single-line:

```ts
  test("mode help preserves the render metric", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop interaction");
```

becomes:

```ts
  test("mode help preserves the render metric", async ({ page }) => {
```

Two sites in `workbench.spec.ts` (`:259`, `:308`) skip with the reason "the
signal tree is hidden at the mobile breakpoint". Those refer to the
`max-width: 820px` CSS breakpoint, which this plan keeps — but the desktop
Playwright project never renders that narrow, so the guards are still dead.
Remove them like the others.

Some tests destructure fixtures beyond `page` (for example `isMobile` alongside
others). Remove only `isMobile`; leave the rest.

- [ ] **Step 5: Update the CI help text**

`scripts/ci.sh:23` names the project being deleted:

```text
  e2e       Playwright desktop and mobile-review smoke tests.
```

Replace with:

```text
  e2e       Playwright desktop smoke tests.
```

- [ ] **Step 6: Verify no `isMobile` or mobile-project reference survives**

```bash
grep -rn "isMobile" frontend/tests/
grep -rn "mobile" frontend/playwright.config.ts scripts/ci.sh
```

Expected: no output from either.

- [ ] **Step 7: Verify no test was accidentally deleted**

Run: `grep -rc "^\s*test(" frontend/tests/e2e/*.spec.ts`

Compare against `git stash`-ed counts if unsure. Only `touch.spec.ts`'s single
test should be gone; every other spec keeps its full test count. Removing a
guard must not remove its test.

- [ ] **Step 8: Run the suite**

Run: `./scripts/test.sh e2e`
Expected: PASS, with every previously mobile-skipped test now actually running
on desktop, and roughly half the wall-clock from Step 1.

This step has real signal. Those tests were skipped under `mobile-review`, so
they ran once, not twice. If a test now fails, it is because removing its
guard exposed a genuine desktop problem — investigate rather than
reinstating the guard.

- [ ] **Step 9: Lint**

Run: `cd frontend && pnpm lint`
Expected: PASS. Catches an unused fixture left behind in Step 4.

- [ ] **Step 10: Commit**

```bash
git add -A frontend/tests/e2e frontend/playwright.config.ts scripts/ci.sh
git commit -m "test(e2e): drop the mobile project and touch spec

Removes touch.spec.ts, the mobile-review Playwright project, and the 17
isMobile guards that existed only to partition specs between the two
projects. Every spec now runs once, on desktop.

Refs ADR 0021."
```

---

### Task 3: Remove touch handling from the interaction controller

**Files:**

- Modify: `frontend/src/ui/plot-interactions.ts`
- Modify: `frontend/src/ui/panel.ts`

**Interfaces:**

- Consumes: `PlotInteractionController` and `PlotInteractionHost` from the
  centralized-plot-interactions PR. Consumes Task 2's removal of
  `touch.spec.ts`.
- Produces: a `PlotInteractionHost` interface with `pinAt`, `removeAt`, and
  `publishTouchCursor` removed. Task 4 relies on `pinchRange` and
  `pinchScaledRange` having no remaining callers.

- [ ] **Step 1: Delete the touch methods**

From `frontend/src/ui/plot-interactions.ts`, delete `beginTouch`, `moveTouch`,
`endTouch`, `applyPinch`, `clearLongPress`, and `publishTouchCursor` in full.

Also delete the touch state fields:

```ts
private readonly touchPoints = new Map<number, { x: number; y: number }>();
private touchMode: "tap" | "pan" | "pinch" | "dead" | null = null;
private touchStart: { x: number; y: number } | null = null;
private touchStartRanges: { x: Range; y: Range } | null = null;
private pinchAnchors: { xA: number; xB: number; yA: number; yB: number } | null = null;
private longPressTimer: number | null = null;
private lastTap = { time: 0, x: 0, y: 0 };
```

And the `TOUCH` constant:

```ts
const TOUCH = {
  panSlop: 9,
  pinchSeparation: 40,
  longPressMs: 430,
  longPressRadius: 28,
  tapRemoveRadius: 16,
  tapCursorRadius: 48,
  doubleTapMs: 320,
  doubleTapRadius: 26,
} as const;
```

Keep `panFrom`. Mouse panning calls it too.

- [ ] **Step 2: Remove the `pointerType` branches**

Five sites route by pointer type. Four dispatch into deleted methods and the
listener becomes empty; one is a guard in the hover handler.

The `pointerdown` branch loses its touch arm:

```ts
if (event.pointerType === "touch") {
  this.beginTouch(event, layout);
  return;
}
```

Delete those four lines; the pointer-button logic below them is unchanged.

The `pointermove`, `pointerup`, and `pointercancel` listeners exist only to
route touch:

```ts
this.overlay.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch") this.moveTouch(event);
});
this.overlay.addEventListener("pointerup", (event) => {
  if (event.pointerType === "touch") this.endTouch(event);
});
this.overlay.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "touch") this.endTouch(event);
});
```

Delete all three registrations. Do **not** delete the `pointermove` and
`pointerup` listeners that `beginPan` and `beginBoxOrClick` add and remove
during a drag — those are separate, locally scoped, and carry mouse panning
and marquee zoom.

The hover guard in `panel.ts` currently reads:

```ts
if (event.pointerType === "touch" || this.dragging) return;
```

becomes:

```ts
if (this.interactions.isDragging()) return;
```

Adjust the `isDragging()` call to match however the landed PR named the
controller field.

- [ ] **Step 3: Shrink the host interface**

`pinAt`, `removeAt`, and `publishTouchCursor` are on `PlotInteractionHost`
only because touch called them directly — long-press pinned, tap removed, tap
published a cursor. Mouse reaches all three through `plotClick`.

Remove these three members from the `PlotInteractionHost` interface:

```ts
  pinAt(x: number, y: number, radius: number): void;
  removeAt(x: number, y: number, radius: number): boolean;
  publishTouchCursor(event: PointerEvent): void;
```

In `panel.ts`, remove them from the host object literal and restore `pinAt`
and `removeAt` to `private` methods on `PanelView`, called only from
`plotClick`. Delete `publishTouchCursor` outright — nothing calls it once
touch is gone.

`plotClick` itself is unchanged:

```ts
plotClick(offsetX: number, offsetY: number): void {
  // 2A's asymmetry: the remove radius is smaller than the pin radius so a
  // double-click cancels its own accidental pin before fitting.
  if (this.removeAt(offsetX, offsetY, 9)) return;
  this.pinAt(offsetX, offsetY, 14);
}
```

- [ ] **Step 4: Drop now-unused imports**

In `plot-interactions.ts`, remove `pinchRange` and `pinchScaledRange` from the
`plot-math` import. Check whether `Range` is still used; `touchStartRanges`
was one consumer, but `beginPan` may still need it.

Run: `cd frontend && pnpm typecheck`
Expected: PASS. TypeScript flags unused imports as errors under this config,
so this is the check that catches a missed one.

- [ ] **Step 5: Verify no touch reference survives**

Run:

```bash
grep -rn "touch\|Touch\|pinch\|Pinch\|pointerType\|longPress\|vibrate" \
  frontend/src --include="*.ts" | grep -v "\.test\."
```

Expected: hits only in `plot-math.ts` (the `pinchRange` definitions, removed in
Task 4) and false positives in `samples.ts` and `pyramid-query.ts`, which use
"coarse" and "coarser" for tile pyramid resolution and are unrelated to
pointers. No hits in `plot-interactions.ts` or `panel.ts`.

- [ ] **Step 6: Run the tests**

Run: `./scripts/test.sh frontend`
Expected: PASS.

Run: `./scripts/test.sh e2e`
Expected: PASS. `interactions.spec.ts` is the gate here — it covers wheel zoom,
both marquee drag axes, and double-click fit, so it catches a mouse path
broken while removing the touch branches.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ui/plot-interactions.ts frontend/src/ui/panel.ts
git commit -m "refactor(ui): remove touch gesture handling

Deletes the touch state machine, its five pointerType branches, and the TOUCH
tuning constants. PlotInteractionHost drops pinAt, removeAt, and
publishTouchCursor, which were on the interface only because touch reached
inspection directly instead of through plotClick.

Refs ADR 0021."
```

---

### Task 4: Remove the pinch range math

**Files:**

- Modify: `frontend/src/app/plot-math.ts:170-215`
- Modify: `frontend/src/app/plot-math.test.ts`

**Interfaces:**

- Consumes: Task 3's removal of the only production callers.
- Produces: a `plot-math` module exporting no pinch functions.

- [ ] **Step 1: Confirm there are no remaining callers**

Run: `grep -rn "pinchRange\|pinchScaledRange" frontend/src frontend/tests`

Expected: hits only in `plot-math.ts` (definitions) and `plot-math.test.ts`
(tests). If `plot-interactions.ts` still appears, Task 3 is incomplete — finish
it before continuing.

- [ ] **Step 2: Delete both functions**

From `frontend/src/app/plot-math.ts`, delete `pinchRange` (with its docblock,
starting at the `/**` above `export function pinchRange`) and
`pinchScaledRange` (with its `/** Pinch range in linear or log10 coordinates. */`
comment). Roughly lines 170-215.

Leave `panRange`, `panScaledRange`, `zoomRange`, `zoomScaledRange`,
`wheelZoomFactor`, `zoomDragMode`, and `logSpace` untouched — all are mouse
paths. `logSpace` is shared with `zoomScaledRange`, so it stays even though
`pinchScaledRange` also used it.

- [ ] **Step 3: Delete the pinch tests**

From `frontend/src/app/plot-math.test.ts`, remove `pinchRange` and
`pinchScaledRange` from the import block, then delete these two tests:

```ts
test("pins both pinch anchors under their fingers", () => {
  // Anchors 10 and 20 are held at pixels 100 and 300 inside a plot
  // spanning pixels 0…400, so the visible range becomes 5…25.
  expect(pinchRange(10, 20, 100, 300, 0, 400)).toEqual({ min: 5, max: 25 });
});

test("refuses a degenerate pinch", () => {
  expect(pinchRange(10, 10, 100, 300, 0, 400)).toBeNull();
  expect(pinchRange(10, 20, 100, 100, 0, 400)).toBeNull();
});
```

One test is shared between zoom and pinch and must be **edited, not deleted**:

```ts
test("zooms and pinches log axes in decade space", () => {
  const zoomed = zoomScaledRange({ min: 1, max: 1000 }, 0.5, 10, "log");
  expect(zoomed.min).toBeCloseTo(Math.sqrt(10));
  expect(zoomed.max).toBeCloseTo(100);
  const pinched = pinchScaledRange(10, 100, 100, 300, 0, 400, "log");
  expect(pinched).not.toBeNull();
  expect(pinched?.min ?? 0).toBeCloseTo(Math.sqrt(10));
  expect(pinched?.max ?? 0).toBeCloseTo(Math.sqrt(100_000));
});
```

Keep the `zoomScaledRange` assertions, drop the `pinchScaledRange` ones, and
rename the test so it still describes what it checks:

```ts
test("zooms log axes in decade space", () => {
  const zoomed = zoomScaledRange({ min: 1, max: 1000 }, 0.5, 10, "log");
  expect(zoomed.min).toBeCloseTo(Math.sqrt(10));
  expect(zoomed.max).toBeCloseTo(100);
});
```

Log-axis zoom is the FFT panel's x-axis behavior. Deleting this whole test
would silently drop that coverage.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Check for unused exports**

Run: `cd frontend && pnpm check:unused`
Expected: PASS. `knip` catches anything the deletion orphaned — for instance
`logSpace`, if it turned out `pinchScaledRange` was its last caller. If knip
flags a symbol, delete it in this task.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/plot-math.ts frontend/src/app/plot-math.test.ts
git commit -m "refactor(math): remove pinch range solver

pinchRange and pinchScaledRange have no callers after the touch handlers were
removed. The shared log-axis test keeps its zoomScaledRange assertions, which
cover the FFT panel's x axis.

Refs ADR 0021."
```

---

### Task 5: Remove the coarse-pointer stylesheet block

**Files:**

- Modify: `frontend/src/styles/app.css:728-741`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Delete the block**

Remove:

```css
/* Coarse pointers need larger targets; the spec's 26px header stays. */
@media (hover: none) {
  .panel-action,
  .mode-pill,
  .legend-chip-body,
  .legend-chip-caret {
    padding: 6px 9px;
  }

  .axis-chip {
    padding: 4px 10px;
  }
}
```

- [ ] **Step 2: Confirm the two keeps are intact**

Run: `grep -n "touch-action\|@media" frontend/src/styles/app.css`

Expected output — exactly these three, and nothing else:

```
725:  touch-action: none;
1379:@media (max-width: 820px) {
1409:@media (max-width: 1100px) {
```

`touch-action: none` on `.overlay-canvas` keeps a touchscreen laptop's browser
from claiming plot drags for page scrolling. The `max-width` queries are
responsive-desktop layout that a narrow window hits. Neither is mobile
support. If either is missing, restore it before committing.

- [ ] **Step 3: Verify the app still renders**

Run: `./scripts/test.sh e2e`
Expected: PASS. `workbench.spec.ts` asserts on chrome layout and would catch a
padding rule deleted past the intended block boundary.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/styles/app.css
git commit -m "style: remove the coarse-pointer target block

Keeps touch-action: none on the overlay, which prevents touchscreen laptops
from scrolling the page on a plot drag, and keeps the max-width responsive
breakpoints.

Refs ADR 0021."
```

---

### Task 6: Full gate and version bump

**Files:**

- Modify: version manifests, via `./scripts/version.sh`

**Interfaces:**

- Consumes: Tasks 1-5.
- Produces: the PR's final commit.

- [ ] **Step 1: Run the complete gate**

Run: `./scripts/ci.sh all`
Expected: PASS. This change touches `src/ui/`, `src/app/`, `src/styles/`,
`tests/e2e/`, `docs/adr/`, and `AGENTS.md`, so the narrow gates are not
sufficient.

- [ ] **Step 2: Confirm the removal is complete**

```bash
grep -rn "isMobile\|pinchRange\|pinchScaledRange\|pointerType\|hover: none" \
  frontend/src frontend/tests frontend/playwright.config.ts
grep -ni "mobile" AGENTS.md
```

Expected: no output from either command.

- [ ] **Step 3: Confirm the deliberate keeps survived**

```bash
grep -n "touch-action" frontend/src/styles/app.css
grep -n "max-width: 820px\|max-width: 1100px" frontend/src/styles/app.css
```

Expected: one hit and two hits respectively.

- [ ] **Step 4: Bump the version**

```bash
./scripts/version.sh bump minor
./scripts/version.sh check
```

Minor, not patch: this removes user-facing capability and changes the
`PlotInteractionHost` contract.

If the centralized-plot-interactions PR landed on `main` after this branch was
cut, recompute so this PR increments from the current target version, per
`AGENTS.md`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(release): bump minor for desktop-only input"
```

---

## Appendix: Reimplementing touch, better

Read this before writing any touch code. The point is not to restore what was
deleted — it is to avoid the four things that made the first implementation
hard to trust.

### Step 0: answer the product question first

`reference/prompt.md` question 8 — "Mobile posture: full tool vs. review
companion — pick one and design it" — was never answered, and the first
implementation proceeded anyway. That is the root cause, not a detail.

The two answers produce different software:

- **Review companion.** Someone opens an exported snapshot on a tablet to read
  and annotate. Needs: pan, zoom, tap-to-read, long-press-to-pin. Does not
  need: drag-to-plot, seam resizing, the formula bar, panel splitting. The
  sidebar becomes a drawer and tap-to-plot replaces drag, as
  `reference/prompt.md` sketches. Self-contained offline snapshots make this
  the plausible one.
- **Full workbench.** Everything the desktop does, under a coarse pointer.
  Much larger, and `reference/prompt.md` already flags the blocker: plots
  capture all touch, so stacked panels scroll awkwardly.

Write the answer as an ADR superseding 0021 before any code. If the answer is
"review companion", most of the deleted code is not what you want anyway — it
ported the prototype's full workbench gesture set.

### Step 1: recover, don't rewrite

The deleted code is correct and worth reading. `pinchRange` in particular
solves the affine map through both (pixel, anchor) pairs so a two-finger
gesture is pan and zoom at once, with degenerate cases handled, and it has
good tests.

Each removal commit's message ends with `Refs ADR 0021`, so the tree just
before each one is resolvable without knowing any hashes:

```bash
# the three removal commits, oldest first
git log --oneline --all --grep="Refs ADR 0021" --reverse

# read each file as it was immediately before its removal
git show "$(git log -1 --format=%H --all --grep='remove pinch range solver')^:frontend/src/app/plot-math.ts"
git show "$(git log -1 --format=%H --all --grep='remove touch gesture handling')^:frontend/src/ui/plot-interactions.ts"
git show "$(git log -1 --format=%H --all --grep='drop the mobile project')^:frontend/tests/e2e/touch.spec.ts"
```

The CDP touch-dispatch harness in `touch.spec.ts` is reusable as-is and is
non-obvious to rediscover.

### Step 2: make the state machine pure

**The original problem.** `touchMode: "tap" | "pan" | "pinch" | "dead" | null`
transitioned across `beginTouch`, `moveTouch`, and `endTouch` through a series
of early returns, with a `setTimeout` held as instance state. Every transition
required a real DOM event to reach, so nothing could be unit-tested, and the
repository has no jsdom. One e2e test covered one-finger pan; pinch,
long-press, double-tap, and the three-finger rejection path had zero coverage.

**Do instead.** Model it as a pure reducer in `app/touch-gestures.ts`. The
shape below is illustrative — `Point`, `Ranges`, and `PinchAnchors` are
whatever the recovered code called them:

```ts
type TouchState =
  | { kind: "idle" }
  | { kind: "tap"; start: Point; at: number; ranges: Ranges }
  | { kind: "pan"; start: Point; ranges: Ranges }
  | { kind: "pinch"; anchors: PinchAnchors }
  | { kind: "dead" };

type TouchEvent =
  | { kind: "down"; id: number; point: Point; at: number; layout: PlotLayout }
  | { kind: "move"; id: number; point: Point }
  | { kind: "up"; id: number; point: Point; at: number }
  | { kind: "longPressElapsed" };

type TouchAction =
  | { kind: "pan"; from: Point; to: Point }
  | { kind: "pinch"; anchors: PinchAnchors; points: [Point, Point] }
  | { kind: "pin"; point: Point; radius: number }
  | { kind: "remove"; point: Point; radius: number }
  | { kind: "cursor"; point: Point }
  | { kind: "fit" }
  | { kind: "startLongPress"; ms: number }
  | { kind: "cancelLongPress" };

export function reduce(
  state: TouchState,
  event: TouchEvent,
): [TouchState, readonly TouchAction[]];
```

Two properties matter. Time enters as `at` on the event rather than a
`performance.now()` call inside, so double-tap windows are testable without
fake timers. Timers are _requested_ via `startLongPress` and fire back in as
`longPressElapsed`, so the reducer holds no handles and every transition is
reachable from a plain function call.

This matches the pure-versus-DOM split that
`docs/superpowers/specs/2026-07-27-centralized-plot-interactions-design.md`
established for pointer gestures, and for the same reason: the repository has
no DOM test environment, and adding one would need `check:deps`, `knip`, and
the CI policy to agree.

### Step 3: re-enter through the existing seam

**The original problem.** Touch was five `pointerType === "touch"` branches
scattered through `PanelView`'s pointer handlers, so the two input models were
interleaved in one 1991-line class.

**Do instead.** `PlotInteractionController` now owns DOM wiring and delegates
decisions to pure resolvers. Touch re-enters as another resolver family behind
the same `PlotInteractionHost` — the controller feeds pointer events with
`pointerType === "touch"` into `reduce` and dispatches the returned actions.
No new branches in `PanelView`, and the host interface should not need to grow
back the three members Task 3 removed: route long-press and tap through
`plotClick` and the existing cursor callback rather than re-exposing `pinAt`,
`removeAt`, and `publishTouchCursor`.

### Step 4: gate touch through the same policy

**The original problem.** `PlotInteractionPolicy.pan` and `.zoom` were declared
per-mode but never enforced, which is exactly how histograms ended up
non-interactive while their policy claimed they were. Touch never consulted
policy at all.

**Do instead.** Route one-finger drag through `panAxes(policy)`, pinch through
the `zoom` set, and double-tap through `policy.fit` — the same resolvers mouse
gestures use. A mode that disables pan then disables touch pan for free, and
adding a plot type stays "an adapter and a policy entry."

Keep the fall-through invariant: a gated-empty gesture must not swallow the
event. A tap must still reach inspection when pan and zoom are both disabled.

### Step 5: test the transition table, not one happy path

Unit-test `reduce` exhaustively — every state × event pair, including the ones
that were never covered:

- one finger down then up inside the double-tap window → `fit`
- one finger down, `longPressElapsed` before movement → `pin`
- one finger down, movement past the 9px slop, then `longPressElapsed` →
  no `pin` (the timer must have been cancelled)
- second finger down mid-pan → `pinch`, with anchors captured in data space
- third finger down → `dead`, and no action until all fingers lift
- pinch release to one finger → `dead`, not a resumed pan
- coincident fingers or equal anchors → no action, not a degenerate range

Then keep e2e to one smoke test per gesture family, using the recovered CDP
harness. The unit tests carry correctness; e2e proves the wiring.

### Step 6: restore the supporting pieces

Re-add in the same PR, or the gesture set will look broken:

- the `mobile-review` Playwright project in `playwright.config.ts`
- the `@media (hover: none)` block in `app.css` — coarse pointers need larger
  targets
- the `AGENTS.md` rules at the lines Task 1 amended
- an ADR superseding 0021

`touch-action: none` on `.overlay-canvas` was never removed and needs nothing.

Do **not** restore the `isMobile` guard pattern wholesale. Seventeen guards
existed to partition specs across two projects; if the posture is
review-companion, most desktop specs are simply irrelevant on mobile and
belong in separate files rather than behind skips.

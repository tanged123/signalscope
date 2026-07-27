# Centralized Plot Interactions Design

**Status:** Approved direction

**Date:** 2026-07-27

## Goal

Make pan, zoom, and fit work on histogram panels, and move the gesture and
range-resolution logic that currently lives inside `PanelView` behind one
policy-driven extension point, so that adding a plot mode does not mean
re-deriving interaction behavior in the panel shell.

This continues ADR 0019's direction. That ADR promised that adding a panel
mode requires "a new adapter and an exhaustive policy entry". For inspection
capabilities that is true today. For interaction and axis ranges it is not.

## Product Decisions

- Histogram panels pan, zoom, box-zoom, and fit like every other mode.
- Histogram pan and zoom are **viewport-only**: they move the camera over the
  already-computed distribution. They do not re-bin.
- Bin edges remain a function of the visible time window, exactly as ADR 0018
  specifies. Panning the linked time window still rebins.
- Interaction gates are per-axis and declared once per mode, not inferred at
  each call site.
- A mode cannot render without honoring a stored axis range. Range resolution
  is shared, not reimplemented per mode.
- Annotation and cursor gestures are never gated by view-control policy. A
  mode with no pan and no zoom can still be inspected.

## Current Problem

### The reported defect

`renderHistogram` in `frontend/src/ui/panel.ts` hardcodes both axis ranges:

```ts
xRange: [edges[0] ?? 0, edges[edges.length - 1] ?? 1],
yRange: [0, Math.max(1, peak) * 1.06],
```

Every other mode resolves `state.x_range ?? <auto>` and
`state.y_range ?? <auto>`. The wheel, drag, and double-click handlers do fire
on histogram panels, and they do write ranges through `onXRange` / `onYRange`
into the workspace. The renderer discards them. Double-click fit clears ranges
that were never read, so it appears inert.

### The structural cause

`PlotInteractionPolicy` declares `pan: ReadonlySet<"x" | "y">` and
`zoom: ReadonlySet<"x" | "y" | "box">` per mode. The only consumer is
`interactiveMode()`, which collapses them into a single boolean:

```ts
return (
  interaction.pan.size !== 0 || interaction.zoom.size !== 0 || interaction.fit
);
```

The histogram's empty `pan` and `zoom` sets therefore gate nothing, and no mode
can express a per-axis restriction. The declaration and the behavior have
drifted apart with no test holding them together.

Separately, roughly 250 lines of gesture handling live inline in the 1991-line
`PanelView` class — the wheel, `pointerdown`, and `dblclick` listeners,
`beginPan`, `beginBoxOrClick`, `panFrom`, `applyPinch`, `beginTouch`,
`moveTouch`, `endTouch`, and their touch state fields — interleaved with DOM
wiring, drag-and-drop, legend rendering, and annotation display.

### The ADR conflict

ADR 0018 decided **"No zoom or pan"** for histograms, reasoning that "the bin
edges are a function of the visible window, so dragging the x axis would show
bins that no longer describe what is drawn."

That objection assumes the x axis controls the source window. Under
viewport-only semantics it does not: the bins are fixed by the time window and
the axis range selects which part of them is on screen. The bins always still
describe what is drawn. The remainder of ADR 0018 — bin rule, shared edges,
count semantics, step outlines, bin-local cursor, distribution-native
annotations, `window: visible t` — is unaffected.

## Architecture

Three modules change, plus one ADR amendment.

### 1. `app/plot-capabilities.ts` — the policy gains teeth

```ts
export interface PlotInteractionPolicy {
  xAxis: "linked-time" | "local";
  cursorLink: "time" | "local";
  pan: ReadonlySet<"x" | "y">;
  zoom: ReadonlySet<"x" | "y" | "box">;
  fit: boolean;
  stickyAutoY: boolean; // NEW
  windowNote: string | null;
}

export interface PreparedPlot {
  // ...existing members
  autoRanges(): {
    // NEW
    x: readonly [number, number] | null;
    y: readonly [number, number] | null;
  };
}
```

`stickyAutoY` is `true` only for `time`. It replaces the implicit
`mode === "time"` condition that currently decides whether the `YAxisPolicy`
latch applies, making the special case declarative rather than positional.

`autoRanges()` returns the fallback each `renderXxx` computes inline today.
All four adapters can compute it from data they already hold, with one
addition: `XyPlotInput` gains a `window` field so the XY adapter can call
`traceExtent`.

| adapter   | `autoRanges().x`                   | `autoRanges().y`                   |
| --------- | ---------------------------------- | ---------------------------------- |
| time      | `[window.t0, window.t1]`           | `autoYRange(bins)`                 |
| xy        | `traceExtent(traces, "x", window)` | `traceExtent(traces, "y", window)` |
| fft       | `[minFrequency, maxFrequency]`     | `[-90, 3]`                         |
| histogram | `[edges[0], edges.at(-1)]`         | `[0, max(1, peak) * 1.06]`         |

Each returns `{x: null, y: null}` when no finite data is present.

`autoYRange` moves from `render/y-axis.ts` into the time adapter, and
`YAxisPolicy.resolve` takes `() => [number, number] | null` in place of its
bins thunk. The latch stays in `PanelView` because it is per-panel state that
outlives the per-frame adapter; only the extent computation moves.

### 2. `app/plot-gestures.ts` — new, pure, no DOM

```ts
export function wheelAxes(
  policy,
  mod: { shift: boolean; alt: boolean },
): { x: boolean; y: boolean };
export function panAxes(policy): { x: boolean; y: boolean };
export function boxZoomAxes(
  policy,
  mode: ZoomDragMode,
): { x: boolean; y: boolean };
export function dragIntent(
  policy,
  button,
  mod,
): "pan" | "box" | "click" | "none";
export function allowsFit(policy): boolean;
export function resolveRanges(
  policy,
  stored,
  auto,
  window,
): { x: Range; y: Range } | null;
```

This layer holds every policy decision and nothing else. It sits beside
`plot-math.ts`, which already owns `wheelZoomFactor`, `zoomDragMode`,
`panScaledRange`, and `pinchScaledRange`.

Placing it in `app/` rather than `ui/` is a testability decision, covered under
Testing below.

`resolveRanges` is the single path from stored plus automatic ranges to what
the renderer draws:

- **x** — when `policy.xAxis === "linked-time"`, the linked window; otherwise
  `stored.x ?? auto.x`.
- **y** — when `policy.stickyAutoY`, through the panel's `YAxisPolicy` latch;
  otherwise `stored.y ?? auto.y`.
- `null` when a required range is unavailable, meaning there is nothing to
  draw.

### 3. `ui/plot-interactions.ts` — new, thin

`PlotInteractionController`, constructed with the overlay canvas and a host.
It owns all view-control gesture wiring and all touch state — `touchPoints`,
`touchMode`, `touchStart`, `touchStartRanges`, `pinchAnchors`,
`longPressTimer`, `lastTap`, `box`, `dragging` — and translates events into
host calls via the pure resolvers. It makes no decisions of its own.

```ts
interface PlotInteractionHost {
  layout(): PlotLayout | null;
  applyXRange(min: number, max: number): void;
  applyYRange(min: number, max: number): void;
  fitView(): void;
  plotClick(x: number, y: number): void;
  pinAt(x: number, y: number, radius: number): void;
  removeAt(x: number, y: number, radius: number): boolean;
  publishTouchCursor(event: PointerEvent): void;
  setGesture(hint: string | null): void;
  setBox(box: Box | null): void;
  axisEditZone(x: number, y: number): "x" | "y" | null;
  beginAxisEdit(axis: "x" | "y"): void;
}

class PlotInteractionController {
  constructor(overlay: HTMLCanvasElement, host: PlotInteractionHost);
  setPolicy(policy: PlotInteractionPolicy | null): void; // per render pass
  isDragging(): boolean; // for the hover handler
}
```

The controller imports only `PlotLayout`, `PlotInteractionPolicy`,
`plot-math`, and `plot-gestures`. It must not import `PanelState`,
`PreparedPlot`, or the renderer. That boundary is what keeps the next plot mode
from needing to touch it.

### 4. `ui/panel.ts` — supplies the host

Retains the hover readout, `pointerleave`, `contextmenu`, signal drag-and-drop,
axis-label editing, annotation display, legends, and the four `renderXxx`
methods. Calls one shared `resolveRanges` in all four render paths. Net
reduction of roughly 250 lines.

`isDragging()` replaces the direct `this.dragging` read in the hover handler,
and `setBox` replaces the direct `this.box` write feeding `drawOverlay`.

## Interaction Matrix

The gates the controller applies. Bindings themselves are unchanged from
today's desktop and touch behavior.

| gesture                            | effect                       | gated by                                                       |
| ---------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| wheel                              | zoom x and y                 | `zoom.has("x")`, `zoom.has("y")`, independently                |
| shift + wheel                      | zoom y                       | `zoom.has("y")`                                                |
| alt + wheel                        | zoom x                       | `zoom.has("x")`                                                |
| middle, right, or ctrl + left drag | pan                          | `pan.has("x")`, `pan.has("y")`                                 |
| left drag marquee                  | box zoom                     | `zoom.has("box")`, then `zoomDragMode` intersected with `zoom` |
| left click, unpromoted             | pin or remove annotation     | ungated                                                        |
| double-click inside plot           | fit                          | `policy.fit`                                                   |
| double-click on axis zone          | label edit                   | ungated                                                        |
| one-finger drag                    | pan                          | `pan`                                                          |
| pinch                              | zoom per axis                | `zoom`                                                         |
| long press                         | pin annotation               | ungated                                                        |
| tap                                | cursor, or remove annotation | ungated                                                        |
| double tap                         | fit                          | `policy.fit`                                                   |

**Fall-through invariant.** When a gated axis set resolves empty, the gesture
must become a no-op that still yields to the next interpretation. A policy
without box zoom must still deliver the click to the annotation path. This is
the easiest property to break during extraction and is tested directly.

### Policy table after this change

| mode      | pan          | zoom              | fit | stickyAutoY |
| --------- | ------------ | ----------------- | --- | ----------- |
| time      | `{x, y}`     | `{x, y, box}`     | yes | **yes**     |
| xy        | `{x, y}`     | `{x, y, box}`     | yes | no          |
| fft       | `{x, y}`     | `{x, y, box}`     | yes | no          |
| histogram | **`{x, y}`** | **`{x, y, box}`** | yes | no          |

`windowNote` and `cursorLink` are unchanged for every mode.

## Testing

### Constraint

`frontend/vitest.config.ts` sets no `environment`, and neither `jsdom` nor
`happy-dom` is in `devDependencies`. Every existing unit test is either pure
logic under `src/app/**` or uses a hand-rolled fake, as
`canvas-renderer.test.ts` does with `recordingContext()`. `src/ui/**` has no
unit tests at all and is covered only by Playwright.

Testing a DOM-bound controller against synthetic events would therefore require
adding a test environment dependency, which `check:deps`, `knip`, and the CI
policy would all have to accommodate. Splitting the decision logic into pure
`app/plot-gestures.ts` avoids that: the part worth testing exhaustively becomes
node-testable, and the thin DOM adapter is covered end-to-end like the rest of
`src/ui/**`.

### `src/app/plot-gestures.test.ts` (new)

Table-driven across all four real policies and every gesture, plus synthetic
policies covering gates no current mode exercises.

- `zoom: {y}` — plain wheel yields `{x: false, y: true}`; `zoom: {}` yields
  both false.
- `pan: {y}` — a horizontal drag leaves the x range untouched.
- `zoom: {box, y}` with drag mode `xy` — y only.
- `zoom: {x, y}` without `box` — no marquee at all.
- `pan: {}`, `zoom: {}`, `fit: true` — a left drag still resolves to `click`.
  This is the fall-through invariant.
- `allowsFit` per policy.
- Regression lock: `policyFor("histogram").pan` and `.zoom` are non-empty, so
  reverting the ADR decision fails a test rather than silently disabling the
  feature again.

`resolveRanges` cases in the same file:

- **Histogram policy with `stored.x = [2, 4]` resolves to `[2, 4]`, not the
  edge span.** This is the regression test for the reported defect.
- Stored beats automatic on both axes.
- `xAxis: "linked-time"` takes the window and ignores stored x.
- `stickyAutoY: false` re-reads the automatic range each frame.
- `stickyAutoY: true` consults the latch.
- Automatic null with stored null yields `null`.

### `src/app/plot-capabilities.test.ts` (amend)

`autoRanges()` per adapter, against the table in Architecture section 1. The
histogram case asserts `[edges[0], edges.at(-1)]` and
`[0, max(1, peak) * 1.06]` — the exact literals `renderHistogram` hardcodes
today, now asserted where they can be reused. Every adapter returns
`{x: null, y: null}` with no finite data.

### `src/render/y-axis.test.ts` (amend)

`YAxisPolicy.resolve` changes signature. Rewrite call sites; the latch
expectations — serialized range wins, series-key change resets, an empty first
frame never latches — must pass unchanged. Add one case: the thunk is not
invoked when a serialized range is present, so laziness survives the refactor.

### `src/app/plot-math.test.ts`

Untouched. If the extraction requires editing it, the boundary is wrong.

### `tests/e2e/modes.spec.ts` (new test)

Histogram x is not the time window, so `.window-readout` will not move, and
`.panel-stats` correctly should not change under a viewport zoom — statistics
describe source values, not the visible camera. Assert on the cursor readout
instead, which measures the pixel-to-value mapping directly:

1. Switch to histogram, following the command-palette pattern already at
   `modes.spec.ts:102`.
2. Hover a fixed overlay pixel; record the reported bin interval.
3. Wheel-zoom; hover the same pixel; assert the interval changed.
4. Ctrl-drag horizontally by a known pixel offset; hover the same pixel again;
   assert the reported bin interval shifted, and shifted the way the drag
   direction implies.
5. Double-click; assert the interval returns to its step 2 value.

This is invariant to canvas rendering and tests exactly what viewport-only zoom
means.

### `tests/e2e/touch.spec.ts` (new test)

Histogram one-finger drag changes the bin readout; double tap restores it.
Guards the touch state extraction.

### `tests/e2e/interactions.spec.ts`

Unchanged, and must stay unchanged. It is the regression suite for the
pure-move step, and it already covers the desktop gestures that step 2
relocates: wheel zoom (`:37`), a Y-band marquee drag (`:101-104`), an X-band
marquee drag (`:107-111`), and double-click fit (`:114`).

### Coverage and tooling

Codecov's patch target is 70%, informational. The pure gesture layer should
land near full coverage; the thin `ui/plot-interactions.ts` adapter adds
uncovered lines, consistent with the rest of `src/ui/**`.

`knip` will fail on any export from `plot-gestures.ts` consumed only by tests.
Keep resolver internals unexported.

## Implementation Sequence

Each step is one commit with its own gate.

1. **Range resolution.** Add `autoRanges()` to all four adapters, `stickyAutoY`
   to the policy, and `resolveRanges`; wire all four `renderXxx` through it.
   Histogram becomes interactive here — this is the observable fix.
   Gate: `plot-capabilities.test.ts`, `resolveRanges` cases, `y-axis.test.ts`.
2. **Extraction.** Create `app/plot-gestures.ts` and
   `ui/plot-interactions.ts`. Pure move, zero behavior change.
   Gate: `interactions.spec.ts` and `touch.spec.ts` pass untouched.
3. **Enforcement.** Apply the policy sets per-axis inside the controller.
   Gate: `plot-gestures.test.ts`.
4. **Histogram policy and ADR.** Open `pan`, `zoom`, and `box` for histogram;
   amend ADR 0018.
   Gate: the new `modes.spec.ts` and `touch.spec.ts` cases.
5. **Version.** `./scripts/version.sh bump minor` then
   `./scripts/version.sh check`, committing all resulting manifest changes.

**Gates.** `./scripts/test.sh frontend` per step, `./scripts/test.sh e2e` after
step 4, and `./scripts/ci.sh all` before handoff, since this touches `app/`,
`ui/`, `render/`, and `docs/adr/`.

**Version bump is minor, not patch.** `PreparedPlot` gains a required member
and `YAxisPolicy.resolve` changes signature — both are contract changes — and
the histogram gains user-visible behavior. The frontend is at 0.3.3.

## Risks

- **Step 2 carries the real risk.** The touch state machine — pinch anchors
  captured in data space, the long-press timer, the double-tap window — is
  subtle and has no unit coverage, only `touch.spec.ts` on the mobile
  Playwright project. Move it verbatim and gate only at the apply points.
  Resist cleanup during the move; a follow-up commit is cheaper than a
  regression that only reproduces on a touch device.
- **`stickyAutoY: false` on histogram means the count axis re-fits whenever the
  peak changes.** That is today's behavior preserved, but combined with new
  y-zoom the view will snap back each time the linked window moves and no
  `y_range` is stored. Left unchanged deliberately. If it reads as jumpy in
  use, extending the latch to histogram is a one-line policy change.
- **The `PlotInteractionHost` surface is wide** — eleven methods. It is a
  seam cut through existing code rather than a designed interface, and some
  members (`publishTouchCursor`, `removeAt`) exist only because touch handling
  interleaves inspection with view control. Worth revisiting once a fifth plot
  mode shows which members are genuinely common.

## ADR Changes

Amend `docs/adr/0018-histogram-semantics.md`. Replace the **No zoom or pan**
bullet with viewport-only semantics, and add a note recording that this bullet
alone is superseded. Bin rule, shared edges, count semantics, step outlines,
bin-local cursor inspection, distribution-native annotations and statistics,
and the `window: visible t` source rule all stand unchanged.

No new ADR. This design implements ADR 0019's stated intent for interaction and
axis ranges; it does not revise its decision.

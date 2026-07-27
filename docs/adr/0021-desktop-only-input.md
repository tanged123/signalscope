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
coverage reflects that: two e2e tests exercise one-finger pan and one also
exercises double-tap-to-fit. Pinch, long-press, and the three-or-more-finger
rejection path have no tests at all.

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

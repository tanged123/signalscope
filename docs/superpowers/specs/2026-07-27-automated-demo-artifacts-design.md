# Automated Demo Artifacts Design

**Status:** Implemented by the [automated demo artifacts plan](../plans/2026-07-30-automated-demo-artifacts.md)

**Date:** 2026-07-27

## Goal

Generate the README's demo GIF and a hosted live demo from the product's own
export path, so both track the shipping UI instead of being hand-recorded and
going stale.

## Dependency

This work starts only after the Phase 4 export MVP can bake a manifest into
the `#signalscope-baked-data` slot described by ADR 0007.

The dependency is hard. Every automatable path reads a baked snapshot, and
nothing can produce one before export exists. The two ways to start earlier
are both throwaway: driving the native shell is not runnable headlessly in
CI, and rebuilding the pyramid in JavaScript would silently diverge from the
conformance-tested Rust implementation, breaking ADR 0007's guarantee that a
snapshot returns the same envelopes the workbench would.

## Product Decisions

- The GIF and the live demo are the same artifact viewed two ways, not
  alternatives. One baked `demo.html` serves both.
- The demo bakes `examples/demo_flight.csv` unchanged.
- Artifacts regenerate on release only. Pull requests stay free of binary
  churn and gain no recording time.
- Artifacts are published to an orphan `gh-pages` branch. No binary enters
  main's history.
- The README embeds the GIF for readers who are skimming and links the live
  snapshot beside it for readers who want to zoom.

## Components

`./scripts/demo.sh` runs all three stages and is the only supported entry
point, per AGENTS.md. The release job calls it and publishes its output.

### Bake

The wrapper invokes the Phase 4 export CLI with the demo's fixed arguments,
writing `build/demo/demo.html`. It adds no baking logic; the demo uses the
product's export path, which is what makes the demo self-updating.

### Record

`frontend/tests/demo/demo.spec.ts` holds the scripted sequence: plot signals
from the tree, zoom, split a panel, switch workspace tab. It lives outside
`tests/e2e/` so the normal gate does not run it.

`playwright.config.ts` gains a `demo` project with `video: "on"`, a fixed
viewport, and `testDir` pointed at the new directory. The script anchors on
selectors the e2e suite already exercises (`.panel`, `.workspace-row`,
`.panel-split-right`).

Unlike a test, the sequence needs deliberate pauses between steps.
Test-speed interaction is unreadable as video.

### Encode

Playwright emits WebM. `ffmpeg` converts it to GIF, which requires adding
`ffmpeg` to the pinned `flake.nix`.

Target under 15 seconds and 800 px wide to keep the README GIF small.

## Testing

The demo spec polices itself. A UI change that breaks the scripted sequence
fails the release job, which is the intended signal.

A GIF size ceiling mirrors the ratcheted snapshot budget in
`frontend/scripts/check-snapshot.mjs`.

## Verified Capture

The implementation spike confirmed that Playwright 1.57 records the canvas
strokes in compositor output. Its 15-second, 800 px, 12 fps GIF measured
2,572,004 bytes; the artifact check ratchets that result with ten percent
headroom.

## Out Of Scope

- Regenerating artifacts per pull request or per merge to main.
- A denser demo dataset. `demo_flight.csv` is 201 rows at 10 Hz, so the
  demo will not exercise the export's data-budgeting path, and zoom will
  bottom out at individual samples. Revisit if the demo needs to show the
  pyramid doing visible work.
- The in-app "Export snapshot" action, which Phase 4 owns.

# ADR 0064: Axis direction

- Status: Accepted
- Date: 2026-09-10
- Amends: [ADR 0063](0063-logarithmic-axis-scales.md), axis presentation state.

## Context

Users need independent horizontal and vertical flips in Limits. Flipping must
preserve raw values, linked time, positive log domains, picking, and navigation
in live panels and offline snapshots.

## Decision

PanelState owns optional boolean `x_reversed` and `y_reversed` fields in session
schema 32. Absent/null means false. Rust and baked-session parsers reject other
types. This additive change requires no migration. The Limits editor publishes
both flags with its validated draft through axis-actions; Cancel discards edits.
Saved and queried limits remain ascending in original units.

ChartHost uses `render/axis-direction.ts` to negate the selected packed display
coordinates and reflect their ranges. X reflection happens after origin
subtraction, preserving existing float32 precision. Row order, gaps, and color
attribute correspondence remain intact. Tick formatters reverse the transform
to show original values. Scale and direction changes publish once with setOption;
pan and zoom continue through setViewRange without rebuilding feeds.

Each ChartHost owns a createDirectedFeed cache using the existing createFeedCache
primitive. It retains one reflected buffer per immutable input, keyed weakly with
the most recent direction descriptor. Separate host caches let panels share an
input with different flips without invalidating each other's buffers. Reversal
adds at most one float32 coordinate copy per retained input per host; garbage
collection releases the cache with its input or host. Unflipped inputs pass
through unchanged.

PlotLayout carries direction alongside original ranges. Shared plot-math owns
projection and inversion. Gesture and keyboard pan respect direction; box zoom
orders inverted endpoints before publication. Wheel zoom uses the original value
under the pointer. Linear axis-equal behavior remains available with either flip.
The shared presentation path supplies live, baked, and PNG views without host
detection or new transport dependencies.

Workspace default-field wiring and app-shell's delegated keyboard pan are a
limited composition exception under ADR 0054, consistent with ADR 0063. No new
state owner or navigation policy is added to those oversized modules.

## Alternatives and tradeoffs

ChartGPU has no native axis reversal option. Reflecting display coordinates keeps
the fork unchanged and shares its existing value-axis rendering. This costs one
cached coordinate copy and retains sample order for continuous colors. A future
native reversal option could remove that copy if it preserves the same semantics.

## Validation and implementation status

Implemented with tests for independent linear/log flips, original-value ticks,
projection/inversion, immutable feed reuse, pan, pointer-centered wheel zoom,
ascending box limits, atomic apply/cancel, and restore defaults. Shared parser
cases validate Rust and TypeScript. Browser coverage exercises flips with linear
axis equal, log scales, autosave, and offline export. Broad checks run on CI and
their results are reported on the PR.

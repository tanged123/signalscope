# Implementation roadmap after Phase 0

## Phase 1 — workbench fundamentals

Complete native file dialogs, persisted pyramid sidecars, progress reporting, MCAP ingest, virtualized signal search/favorites, panel lifecycle, seam resizing, drag rearrangement, and keyboard-equivalent commands.

## Phase 2 — scientific interaction

Finish linked desktop and touch gestures, gutter/inline axes, editable labels, split legend inspector, visible statistics, annotations and delta readouts, XY drop strip, color channel and colorbar, FFT, and histogram modes.

## Phase 3 — transforms and durable sessions

Ship the docked expression bar with history, full prototype-compatible expression semantics, derived signals in the tree, schema migrations, autosave/recovery, and snapshot/session round-trip coverage.

## Phase 4 — export and fidelity

Implement the export size-budget model, visible/all-loaded tile selection, PNG and visible CSV exports, renderer screenshot matrices across themes and axes, and deterministic snapshot parity checks.

## Phase 5 — performance and hardening

Benchmark cold multi-GB first plot, cache build and reuse, tile latency, 100M-point pan/zoom, NaN gaps, corrupt inputs, accessibility invariants, release bundles, and artifact-size regression thresholds.

Parquet is included when it does not delay MCAP and the core interaction path. Live streaming, layout-preset UI, Monte Carlo envelope ergonomics, 3D, and `scope-serverd` remain v2.

Phase 1 visualization foundations closed with a validated categorical palette
that reserves amber ([ADR 0011](adr/0011-series-palette-and-reserved-amber.md)),
a headless renderer harness and coherent tick pipeline, unbounded series
allocation with composite colour/dash identity, and stable per-panel y axes
resolved outside the renderer.

Phase 2 desktop interaction (2A) shipped: linked wheel/directional-drag/pan/fit
gestures with per-panel unlinked windows, both-axis pointer-centered wheel
zoom, selectable off/dot/line cursor modes (readouts are attached to line
mode), pinned annotations with delta readouts, a visible-region statistics
strip backed by envelope-bin sums
([ADR 0014](adr/0014-envelope-bin-sums.md)), gutter/inline axis styles,
in-place title and axis-name editing, a visible per-panel axis-style control,
Favorites star/drop affordances, and the split legend inspector. Series
strokes are clipped to the plot rectangle and level-zero cursor values
interpolate between rendered samples.
The categorical series order now uses MATLAB's canonical seven defaults, with
the eighth slot rolling over to dashed blue; amber remains reserved by token
and semantic role rather than by banning MATLAB yellow. Remaining Phase 2
scope (2B): XY drop strip and mode, colour channel and
colorbar, FFT and histogram modes, and touch gestures.

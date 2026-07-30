# Implementation roadmap after Phase 0

## Phase 1 — workbench fundamentals

Complete native file dialogs, persisted pyramid sidecars, progress reporting, MCAP ingest, virtualized signal search/favorites, panel lifecycle, seam resizing, drag rearrangement, and keyboard-equivalent commands.

## Phase 2 — scientific interaction

Finish linked desktop and touch gestures, gutter/inline axes, editable labels, split legend inspector, visible statistics, annotations and delta readouts, XY drop strip, color channel and colorbar, FFT, and histogram modes.

## Phase 3 — transforms and durable sessions

Ship the docked expression bar with history, full prototype-compatible expression semantics, derived signals in the tree, schema migrations, autosave/recovery, and snapshot/session round-trip coverage.

Phase 3 shipped a MATLAB-dialect expression language evaluated in
`scope-core::expr` ([ADR 0008](adr/0008-expression-evaluation-layer.md)
amendment): quoted names are signal references, functions are bare MATLAB
names, and the transforms are `gradient`/`cumtrapz`/`movmean`. Derived signals
materialize into the store under one synthetic source with an in-memory
pyramid, so every tile, sample, and panel-mode consumer is unchanged. Sessions
reached schema v10 with ordered derived definitions and source paths, and gained
autosave with resume-on-launch plus named workspace files
([ADR 0022](adr/0022-durable-session-persistence.md)). The `localStorage` theme
key is gone; the session is the only durable store.

## Phase 4 — export and fidelity

Implement the export size-budget model, visible/all-loaded tile selection, PNG and visible CSV exports, renderer screenshot matrices across themes and axes, and deterministic snapshot parity checks. The release-generated README GIF and hosted live demo now ship from the export path per the [automated demo artifacts plan](superpowers/plans/2026-07-30-automated-demo-artifacts.md).

## Phase 5 — performance and hardening

Benchmark cold multi-GB first plot, cache build and reuse, tile latency, 100M-point pan/zoom, NaN gaps, corrupt inputs, accessibility invariants, release bundles, and artifact-size regression thresholds.

Parquet is included when it does not delay MCAP and the core interaction path. Live streaming, layout-preset UI, Monte Carlo envelope ergonomics, 3D, and `scope-serverd` remain v2.

The July 2026 UI audit pass replaced the global toolbar with three permanent
strips: title, workspace tabs, and status. The hidden `≡` application menu and
the split signal/command palettes now mirror one registry. File persistence,
HTML/PNG/CSV export, and layout-preset entries remain visible planned stubs;
their backing behavior continues in Phases 3–4 rather than being implied by
inert chrome.

Phase 1 visualization foundations closed with a validated categorical palette
that reserves amber ([ADR 0011](adr/0011-series-palette-and-reserved-amber.md)),
a headless renderer harness and coherent tick pipeline, unbounded series
allocation with composite colour/dash identity, and stable per-panel y axes
resolved outside the renderer.

Phase 2 desktop interaction (2A) shipped: linked wheel/box/pan/fit gestures
with per-panel unlinked windows, aspect-ratio snapping from box zoom to
single-axis zoom, both-axis pointer-centered wheel zoom, and selectable
off/dot/line cursor modes (default off; dots track visible series; the tooltip
is attached to line mode). Pinned annotations have delta readouts, and a
visible-region statistics
strip backed by envelope-bin sums
([ADR 0014](adr/0014-envelope-bin-sums.md)), gutter/inline axis styles,
in-place title and axis-name editing, a visible per-panel axis-style control,
Favorites star/drop affordances, and the split legend inspector. Series
strokes are clipped to the plot rectangle, tile queries retain neighboring
edge bins for continuous clipped strokes, and level-zero cursor values
interpolate between rendered samples.
The categorical series order now uses MATLAB's canonical seven defaults, with
the eighth slot rolling over to dashed blue; amber remains reserved by token
and semantic role rather than by banning MATLAB yellow.

Phase 2B closed the phase: XY panels with the amber drop strip, dashed `x:`
and `c:` axis chips, window-dimmed trajectories, a trajectory cursor ring and
datatips; a `batlow` sequential colormap with a labelled colorbar
([ADR 0016](adr/0016-sequential-colormap.md)); FFT panels over the visible
window ([ADR 0017](adr/0017-spectrum-semantics.md)); histogram panels
([ADR 0018](adr/0018-histogram-semantics.md)); and the full touch gesture
set. All three modes are presentation-plane computations over a bounded
window slice served by one new protocol request
([ADR 0015](adr/0015-window-sample-requests.md)).

Two design gaps were closed by decision rather than extraction and should be
reviewed against any future design pass: histogram mode has no specification
at all, and the FFT panel has only a pixel reference. The prototype's `1:1`
equal-axis control was dropped for want of a home in the final chrome.

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

# Current state and next work

This is a compact statement of what SignalScope supports today. Historical
implementation plans are not kept in the working tree; architecture changes
are recorded in [ADRs](adr/README.md).

## Current product

- `scope-server` is the native data plane and loopback HTTP host. Electron is
  a thin distribution shell around it.
- Rust provides streaming ingest, transactional registration, out-of-core
  columns, persistent min/max pyramid caches, derived signals, and versioned
  session persistence. Supported inputs are delimited text, JSON-channel
  MCAP, HDF5/MAT v7.3, and Parquet through declarative recipes.
- The frontend consumes the versioned `DataPlane` contract. `HttpPlane` serves
  live workspaces; `BakedPlane` serves self-contained snapshots. UI and
  renderer code do not branch on host identity.
- Line2D presentation supports linked time or an explicit signal X on an exact
  shared timebase. ChartGPU is the Line2D plotter behind the SignalScope-owned
  renderer boundary, with per-panel axes, cursor/annotation interactions, derived signals,
  named sets, and a serialized legend console that owns the line-style cascade,
  visible-region statistic columns, bounded data-tip manifests, and in-place
  series focus. Legend rails persist independently on any plot edge.
- Live queries use adaptive pyramid resolution and retained overview/detail
  responses. The renderer remains deterministic from tiles, viewport, and
  design tokens. Snapshots embed selected tile data and session state without
  network access.

## Deliberate limits

- Scatter, histogram, FFT-specific UI, spectrogram, contour, and 3D
  presentation are not current capabilities. ADR 0052 defines typed
  plot-family seams; each future family needs a current data contract and an
  ADR.
- Input is desktop-only. Touch gestures and mobile-specific browser coverage
  are out of scope.
- Live streaming, remote data planes, layout-preset UI, and richer
  multi-run/Monte Carlo ergonomics are not current product capabilities.
- WebGPU-capable Chromium is required for the time-series renderer and
  exported snapshots.

## Next work

Prioritize measured, user-visible work in this order:

1. Keep the adaptive tile path within its interaction and memory budgets as
   source and series counts grow; use the benchmark suite before changing
   reduction or GPU policy.
2. Improve ingest and snapshot boundary coverage (large/corrupt inputs,
   cache reuse, session round trips, no-network and size-budget checks).
3. Keep the reusable panel shell, SignalScope-owned Line2D render model,
   ChartGPU host, presentation controller, and response cache boundaries small
   as Line2D evolves.
4. Measure the explicit-X reducer and paired transport on large and gap-heavy
   data. The live path currently reads a bounded padded window and builds its
   paired pyramid on demand; use measurements to decide whether page-native
   reduction or another bounded cache is warranted. Preserve source-row
   correspondence; do not interpolate, independently reduce X and Y columns,
   or add an unbounded X/Y-combination cache.
5. When another plot family arrives, design its typed data contract, reduction,
   interaction, and snapshot payload before implementation. Do not revive the
   withdrawn mode stack or its historical plans as an implementation shortcut.
6. Consider remote/live sources only after the local `DataPlane` contract and
   snapshot parity remain stable.

Use the smallest relevant script for local iteration, then `./scripts/ci.sh all`
for cross-layer changes. Add a new ADR for a protocol, session, or architectural
decision.

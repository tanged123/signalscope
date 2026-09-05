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
- Line2D is an XY chart with independent searchable X/Y controls. X can be
  linked time, any signal, or a bundle paired to Y members by source key.
  Each X/Y pair requires an exact shared timebase. CSV retains the time column
  and uses row index when no recognized finite time header is present.
  Recipe time datasets and MCAP log timestamps are also available as signals. ChartGPU is the Line2D plotter behind the SignalScope-owned
  renderer boundary. Family dispatch owns preparation and render-input
  construction; the two Line2D adapters share options, defaults, axes, and feed
  caching. Per-panel axes, derived signals, named sets, and a serialized legend
  console retain the line-style cascade and series focus. Legend rail geometry,
  transient annotation UI state, and visible-region statistic rendering
  primitives are independent UI components, and rails persist on any plot edge.
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
   Use the generated tagged-union schema construct for variant-specific state.
   Estimate reducer, transport, API, and snapshot work from required semantics
   and validation, not historical source-line counts.
6. Burn down the module-size violations recorded in
   [ADR 0053](adr/0053-module-boundaries-and-shared-primitives.md), starting
   with the legend console in `panel.ts` and `registerCommands` in
   `app-shell.ts`. Mount has already been staged. Land each cohesive seam
   independently and preserve its behavior tests; partial extractions do not
   exempt the remaining oversized modules (ADR 0054).
7. Consider remote/live sources only after the local `DataPlane` contract and
   snapshot parity remain stable.

## Architecture follow-through

Implemented in this PR, per [ADR 0055](adr/0055-core-policy-and-query-lifetimes.md):

- Tested ESLint import boundaries and a focused architecture test wrapper.
- Core-owned derived dependency/bundle policy, with HTTP conversion at the API.
- Off-lock sample/tile queries and reader-owned temporary spill lifetimes.
- Abortable frontend queries, scheduled-work cleanup and presentation teardown.
- Shared Rust/TypeScript runtime-parser cases and correlated X-axis validation.
- Extracted command metadata, series inspector and keyboard-accessible panel menus.

Remaining work:

- Measure complete explicit-X request cost: unequal timebase IDs, wide windows,
  gaps, concurrent panels and obsolete work. Report peak in-flight memory and
  latency/lock contention before selecting server admission or cache changes.
- Extract the remaining legend console and shell action composition using
  narrow inputs and behavior tests. Both parent modules remain above the size
  limit; partial extraction does not exempt them.
- Split interleaved styles only with preserved cascade order and corresponding
  layout tests. Continue consolidating fixtures when their consumer needs
  justify it; do not add a universal fixture framework.

The selector, cache-codec, API-handler, expression, pyramid and staged-mount
extractions already landed; do not repeat them. `workspace.ts` has no permanent
size-policy exemption. Smaller snapshot/cache seams should be extracted when
their invariant or consumer needs justify the move.

Use the smallest relevant script for local iteration, then `./scripts/ci.sh all`
for cross-layer changes. Add a new ADR for a protocol, session, or architectural
decision.

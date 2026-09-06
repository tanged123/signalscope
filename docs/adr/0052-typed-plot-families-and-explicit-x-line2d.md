# ADR 0052: Typed plot families and the explicit-X Line2D foundation

- Status: Accepted
- Date: 2026-09-03
- Amends: ADRs 0043 and 0045

Guidance clarified by [ADR 0054](0054-evidence-backed-architecture-guidance.md):
current capability/cache interfaces are reuse candidates, not mandatory
contracts for every future family. The historical implementation line count
below is context, not a required cost or scope estimate.

Bundle X bindings and independent axis selection are added by
[ADR 0056](0056-xy-axis-and-bundle-bindings.md).

## Context

ADR 0043 deliberately removed the mode stack and left SignalScope with one
time-series presentation. That simplification is still the correct current
product boundary. It does not, however, answer which seams should be kept
small when a second concrete presentation is worth building.

The common parts of a panel are lifecycle and workspace concerns. Coordinate
systems, data reduction, picking, interaction, and capture fidelity are not
common in the same way. A universal plot interface would turn those differences
into optional fields and mode switches before there is a second implementation
to justify them.

## Decision

### Panel lifecycle and rendering boundaries

Every concrete panel view composes a reusable `PanelShell`. The shell owns
workspace chrome and common lifecycle concerns:

- title, focus, layout, split, maximize, close, resize, and command routing;
- loading, empty, unavailable, error, and device-failure states; and
- slots for bindings, plot controls, legends, actions, and export.

The concrete view owns its plot semantics. The shell does not know about
signals, axes, ChartGPU options, statistics, or annotations. A common content
interface is deferred until a second concrete content type proves what that
interface must contain.

SignalScope owns typed render models at the boundary between data preparation
and a renderer. The first family is `Cartesian2D`, whose first concrete
content is `Line2D`. A future scatter or histogram may reuse Cartesian axes
and viewport mechanics while defining its own layer and interaction contract.
Raster/grid content (such as a future spectrogram or filled contour) and 3D
scene content have different renderer families; they share the panel shell and
resource/capture lifecycle, not a forced Cartesian abstraction.

ChartGPU remains an implementation detail of the current Cartesian renderer.
`ChartGpuHost` owns one ChartGPU instance, device registration, resize, capture,
and publication. It receives SignalScope render models rather than exposing
ChartGPU types to application code. Data or style identity changes use one
`setOption` publication; viewport-only changes use `setViewRange` as recorded
by ADR 0045. A future family may use another renderer without changing the
panel shell or data-plane contract.

### Explicit X for Line2D

`Line2D` models its X-axis source explicitly. A `time` source means the panel's
linked time coordinate, preserving the current behavior. A `signal` source
carries its `SeriesRef` and is valid only when X and every plotted Y signal use the same
exact timebase: equal sample length and a bit-for-bit identical timestamp
sequence. A shared source label or overlapping time range is not sufficient.
The data plane rejects a mismatched binding with a clear unavailable/error
state; it does not silently interpolate, resample, or nearest-neighbor join
the signals.

The X-axis source, X range, and X label are Line2D state. Existing sessions
migrate to the explicit `time` source, and no panel-kind discriminator is added
while Line2D is the only concrete content type.

### Paired data and typed endpoints

Time-based Line2D continues to use the existing envelope tile contract. An
arbitrary-X Line2D request uses a versioned binary sample contract with
correspondence-preserving reduction:

1. The reducer chooses one ordered source-index set for a request.
2. Every emitted X/Y row or segment uses the same source index for X and all
   associated Y values.
3. Gap and finite-value flags remain attached to those rows; an X column and a
   Y column are never reduced independently, interpolated, or joined by
   timestamp.

The same selected indices preserve correspondence across multiple Y traces.
Any envelope or bucket extension must define its paired extrema and endpoint
semantics before it is used; independent per-column extrema are not a valid
substitute for paired data.

Each data family gets a typed request/response contract and endpoint when it is
implemented. The existing `query_tiles_bin` remains the time-envelope path;
future point, histogram, raster, or compute responses must not be hidden in a
loosely typed universal `queryPlotData` payload. FFT is a compute producer
whose result can be a Line2D frequency plot, but it will need a computed
frequency coordinate/result binding rather than today's stored-signal X
binding. Spectrograms and filled contours require a raster/grid contract.

Shared transport machinery may include versioned binary framing, cancellation,
request identity, physical-pixel quality requests, bounded resource estimates,
stale-data retention, and atomic publication. Reduction invariants and
interaction semantics stay with each data family.

### Sessions, snapshots, and resource policy

Line2D persists its X binding and coordinate state. A generated tagged union
for panel content is deferred until a second real content type exists; at that
point the session schema gets a discriminated union and an explicit migration.
The schema generator nevertheless supports tagged unions now, and
`XAxisSource` uses one because time and signal-X are already two real variants
with correlated fields. Speculative panel kinds are not added.

Current line tile admission, overview/detail retention, and one-host-per-panel
behavior remain authoritative. A future family supplies its own quality-to-
resource estimate only when it is implemented; a generalized cross-family
planner is not invented in advance.

The live explicit-X reducer validates exact timebases in bounded chunks,
materializes only the padded source-time request window, and builds an
on-demand paired pyramid for that window. Before arbitrary-X is promoted for
very large or highly concurrent workloads, measurement must determine whether
page-native reduction or another bounded cache is warranted; an unbounded
cache of X/Y combinations is not acceptable. The frontend budget charges the
paired reducer's worst-case finite-extrema row expansion, while gap-heavy data
remains a measured soft-bound case.

Snapshots remain session state plus selected, self-contained presentation data:
they replace the exact injection slot, make no network requests, honor the
size budget, and escape serialized data. They contain time-envelope payloads
and deduplicated paired Line2D payloads for explicit-X panels. A future family
must define its baked payload and zoom semantics before it can appear in an
offline snapshot.

## Consequences

- The product remains one Line2D family, with linked-time and explicit signal-X
  bindings sharing one renderer path.
- The panel shell, typed Line2D render model, ChartGPU host, presentation
  controller, and response-cache policies are separate, tested boundaries.
- Explicit-X Line2D uses an exact shared-timebase check, paired binary
  reduction, local X interaction, persistent annotations, and offline snapshot
  parity.
- Scatter, histogram, spectrogram, contour, FFT-specific UI, and 3D remain
  future capabilities with family-specific contracts; this ADR does not claim
  that any of them is implemented.
- A second concrete content type is the trigger for a session union and any
  genuinely shared cross-family resource planner.

## Amendment (2026-09-04, implementation follow-up)

Line2D family dispatch is centralized: response-kind registration owns data
preparation and render-input construction. The time and signal-X adapters share
their options, default stroke, axes construction, and immutable feed-cache
mechanism. Panel code does not open-code the two adapter paths.

Common legend rail geometry, annotation interaction state, and statistic
rendering/export helpers are separate UI components rather than responsibilities
of the Line2D panel view. This keeps those surfaces reusable by another concrete
panel without copying their state machines.

The presentation seam does not make reducers or wire payloads universal.
Explicit-X Line2D added roughly two thousand lines of family-specific Rust
across reduction, binary transport, snapshots, and API integration. A future
plot family should budget comparable native work unless its reduction and
payload invariants genuinely match an existing family; the frontend adapter
boundary does not reduce that work to a small registration-only change.

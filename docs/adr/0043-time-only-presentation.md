# ADR 0043: Time-only presentation and a single plotter

- Status: Accepted
- Date: 2026-08-18
- Supersedes: ADRs 0016, 0017, 0018, 0019, and 0037
- Amends: ADRs 0005 and 0015

## Context

XY panels were slow at full resolution because the sample path never
received the binary columnar treatment the tile path got in ADR 0036:
JSON transport, a full copy to normalize gap values, one interpolation per
sample per series for the colour channel, and only then a Canvas2D stroke.
Every one of those costs was paid for three panel modes, and the uncapped
sample request had exactly one consumer — those panels.

Four modes also carried structural weight out of proportion to their use:
hand-written dispatch in the panel, four prepared-plot implementations
behind one polymorphic interface, and palette and tick resolution living
inside the Canvas2D module that the graphics-device renderer imported
across.

## Decision

SignalScope presents time-series panels only. XY, spectrum, and histogram
are removed with the code that served them alone, and ChartGPU is the
single plotter.

They are removed rather than ported because a flavor seam designed against
one implementation would be a guess. The seam is cut when the second
flavor returns and the duplication is real.

Palette resolution, series tokens, hue indexing, and tick generation move
out of the Canvas2D module into their own module. The Canvas2D drawing
stack is deleted; the overlay renderer is independent and unchanged.

Sample queries survive for comma-separated value export, which is already
bounded by its user-selected fidelity under ADR 0025. This narrows
ADR 0015 to the export path.

The session schema advances to version 22 with a single panel mode, a
single annotation domain, and no XY-only panel fields. The migration
ladder is reset: every rung is deleted and any earlier version is rejected
through the existing unsupported-version error. Sessions and snapshots
written by earlier versions stop loading. This amends ADR 0005, which
requires a rung and a test per bump, as a single deliberate break accepted
for this change.

## Consequences

The product loses three panel types until they are reintroduced. The
remaining plotter is small enough to make fast and to reason about, and
reintroduction starts from one renderer rather than four.

Reintroducing XY requires two things this change defers. The sample path
needs the binary columnar transport the tile path already has. Per-vertex
colour mapping on a two-dimensional line has no ChartGPU equivalent — the
capability exists only on its three-dimensional point cloud series, so a
scoped fork or a binned-segment approximation will be needed. Neither is
chosen here; both are recorded so the constraint is not rediscovered.

Time-series behavior is unchanged: full resolution under ADR 0041, and the
padded render feed, windowed presentation math, interleaved
single-precision vertices, and time rebase under ADR 0042.

## Amendment (2026-09-03)

ADR 0052 records the deliberate extension seam. Line2D remains the only
current presentation family, and “single plotter” describes the current
implementation rather than a requirement that every future plot family use
ChartGPU. A second concrete content type must earn its own typed render and
data contract; speculative mode fields and a universal plot API remain out of
scope.

The first extension is Line2D state with an explicit X-axis source. A `time`
source is the existing linked-time coordinate; a `signal` source carries its
`SeriesRef`. An arbitrary signal X is permitted only for Y signals on the same
exact timebase (equal length and bit-for-bit identical timestamps), with
correspondence-preserving paired reduction and binary transport. It does not
reintroduce the withdrawn XY mode stack or allow implicit interpolation and
resampling.

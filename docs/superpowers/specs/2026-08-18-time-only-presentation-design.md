# Time-only presentation and a single plotter

- Date: 2026-08-18
- Status: Approved

## Context

XY panels are slow at full resolution, and the cause is not the renderer.
The tile path received binary columnar transport in ADR 0036; the sample
path never did. Sample queries return JSON arrays of plain numbers, the
data plane copies every series once more to normalize gap values, the XY
colour channel interpolates once per sample per series, and only then does
Canvas2D stroke the result. Four costs compound, and drawing is the last of
them.

Every one of those costs is paid on behalf of three panel modes. The live
uncapped sample request has exactly one consumer: XY, FFT, and histogram
panels. Comma-separated value export, the only other caller, is already
bounded by its user-selected fidelity under ADR 0025.

Panel modes also carry structural weight out of proportion to their use.
Four modes are dispatched by hand in the panel, four prepared-plot
implementations satisfy one polymorphic interface, and the Canvas2D module
owns both a drawing stack and the palette and tick resolution that the
graphics-device renderer imports across that boundary.

## Decision

SignalScope presents time-series panels only. XY, spectrum, and histogram
modes are removed together with the code that exists solely to serve them,
and ChartGPU becomes the single plotter.

The three modes are expected to return later as flavors of one plotter.
They are removed rather than ported because a flavor seam designed against
a single implementation would be a guess. The seam is cut when the second
flavor arrives and the duplication is real.

### Removal

The XY, spectrum, and histogram modules are deleted, along with
presentation-plane colour mapping, XY hit testing, and the three
non-time prepared-plot implementations. The prepared-plot interface loses
its polymorphism: one construction serves the one remaining domain, and the
interaction policy table collapses to its time entry.

The panel loses its mode dispatch, its mode buttons, the XY drop strip, the
x-axis and colour-axis chips, the equal-aspect toggle, and colourbar
gating. The Canvas2D drawing stack is deleted entirely — its path, colour
mapped path, colourbar, grid, and axis furniture routines had no caller but
the removed modes.

Sample interpolation survives. Comma-separated value export interpolates
columns onto a shared time base and keeps that helper.

### Extraction

Palette resolution, series tokens, hue indexing, tick generation, tick
formatting, and plot fonts move out of the Canvas2D module into their own
module. The graphics-device renderer imports them today across a boundary
that exists only because they were never given a home of their own. The
overlay renderer, which draws annotations, cursors, and the selection box,
is independent and unchanged.

### Session schema

The session schema advances one version. The panel mode enumeration keeps a
single time variant, the annotation domain narrows to time, and the panel
fields that only XY consumed are removed.

Backward compatibility is deliberately abandoned. The migration ladder is
reset: every rung and every rung-specific helper is deleted, and any
session that is not the current version is rejected through the existing
unsupported-version error. Sessions written by earlier versions, including
baked snapshot manifests, stop loading. Keeping the rungs would not be
cheaper, because each one constructs panel fields that no longer exist and
would have to be rewritten to migrate toward a shape that has lost its XY
state regardless.

This overrides two standing rules and does so knowingly. ADR 0005 requires
a migration rung and a migration test for every schema bump and requires
that a session never partially restore. The repository rules require that
accepted records be amended rather than rewritten. The amendment to ADR
0005 records this as a single deliberate break accepted by the maintainer
for this change, not as a lapse. Anyone holding a session or snapshot from
an earlier version loses it.

## What does not change

Time-series rendering keeps every property established for it. Full
resolution under ADR 0041 is unchanged; the padded render feed, windowed
presentation math, interleaved single-precision vertices, and the time
rebase from ADR 0042 are unchanged; vertex order, gap vertices, and the
plot layout contract from ADR 0039 are unchanged.

The tile transport, its binary framing, and its versioning are untouched.
The sample request shape is untouched; only its uncapped live caller goes.
Export fidelity, range controls, estimates, and size handling under ADRs
0024 and 0025 are unchanged. ChartGPU is not forked and its pinned revision
does not move.

## Consequences

The product loses XY, spectrum, and histogram panels until they are
reintroduced. That is the accepted cost of sequencing the risk: the
remaining plotter is small enough to make fast and to reason about, and the
reintroduction starts from one clean renderer rather than from four
divergent ones.

The panel and prepared-plot modules shrink substantially, which is a goal
of this change rather than a side effect. Both had grown large enough that
mode dispatch obscured the single path that matters.

Reintroducing XY will require work this change deliberately defers. The
sample path needs the binary columnar treatment the tile path already has,
and per-vertex colour mapping on a two-dimensional line has no ChartGPU
equivalent — the capability exists only on its three-dimensional point
cloud series. The new record names both so the constraint is not
rediscovered. A scoped fork or a binned-segment approximation are the
candidate remedies; neither is chosen here.

Records superseded: the sequential colormap, spectrum semantics, histogram
semantics, prepared plot capabilities, and per-mode sample budgets. Records
amended: windowed sample requests, which narrows to the export path, and
session schema versioning, for the ladder reset. A new record states
time-only presentation, the single plotter, and the two named prerequisites
for reintroduction.

## Verification

Tests prove that:

- a workspace renders, pans, zooms, and exports with time panels only;
- no presentation path issues an uncapped sample request, and comma
  separated value export still honors its selected fidelity;
- palette, hue, tick, and font behavior is unchanged after extraction, and
  no module imports them from the Canvas2D module;
- a session at the current version round trips, and a session at any
  earlier version is rejected with the unsupported-version error rather
  than partially restored;
- snapshot export and its baked presentation still render time panels
  without a network.

The browser benchmark keeps both of its scenarios and both floors from ADR
0035, retargeted at the chart host now that the Canvas2D plot element is
gone. Holding the in-pad pan floor is the evidence that this change did not
regress the path ADR 0042 optimized.

The completed change runs the focused Rust and frontend suites, formatting,
the cross-layer quality gate, and the full benchmark and end-to-end gate.

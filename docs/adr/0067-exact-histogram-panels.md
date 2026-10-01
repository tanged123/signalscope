# ADR 0067: Exact histogram panels

- Status: Accepted
- Date: 2026-09-16
- Amends: [ADR 0052](0052-typed-plot-families-and-explicit-x-line2d.md),
  [ADR 0066](0066-scatter-panels-and-creation.md), and the annotation-anchor
  interpretation in [ADR 0050](0050-retire-obsolete-compatibility-seams.md).

## Context

Increment 1 of the requested 2D analysis plan adds distributions over a source
time interval. Line extrema tiles and sampled scatter rows cannot produce
exact sample counts. A histogram needs its own reduction and result contract,
while its step outlines fit the existing Cartesian line renderer.

## Decision

### Numerical and data contract

`scope-core::compute::histogram` owns a two-pass reduction over fallible paged
source columns: first determine shared extrema, then count finite values.
The source interval includes both endpoints and all duplicate timestamps at
those endpoints, without stroke-padding neighbors. Nonfinite values are
excluded and counted separately. Inputs must have exactly matching optional
unit strings; no implicit conversion is performed.

Histogram content stores a bin count, initially 32, validated in [1,256].
Edges are equal-width over all visible series, finite and strictly increasing.
Constant ranges are expanded; unrepresentable edge configurations fail
explicitly. Interior bins include their left edge and exclude their right;
the final bin includes its right edge. Counts sum to finite source cardinality.
Empty/nonfinite-only results have an explicit empty presentation. Counts are
u64 in Rust and exact decimal strings on the wire and in textual inspection;
only drawing coordinates convert to floating point.

The additive `query_histogram` endpoint returns typed `HistogramResponse`
edges, per-series counts/totals, and the exact analyzed interval. The server
captures immutable signal handles under its state lock, computes outside the
lock, and bounds concurrent histogram reductions. Scan memory is bounded by
column chunks and the returned series/bin matrix, not source-window length.
HTTP cancellation and obsolete-result rejection remain distinct from stopping
an already running reduction.

### State and publication

WorkspaceModel owns Histogram content, bin settings, source bindings, local
camera, and annotations. The application presentation controller owns requests
and immutable results, using source IDs, visible set, interval, and bin count
as identity. Definition/source changes invalidate through existing workspace
refresh paths. Each panel retains only its latest result; replacement publishes
atomically. Pending/failed replacement remains visible as such, with the old
result's interval retained. Removal/reset/disposal rejects obsolete completions
and releases responses and GPU feeds. Camera changes do not rebin.

New scheduling and histogram preparation remain cohesive modules or branches
in existing bounded owners. No universal family registry or mode stack is
introduced. This ADR permits only composition changes to oversized `panel.ts`,
`app-shell.ts`, and `workspace.ts`: delegate histogram controls, range/CSV
policy, preparation, and mutations to narrow helpers; add callback wiring and
content-specific guards. It does not permit unrelated behavior in those owners
or waive the remaining extraction work in ADR 0053.

### Interaction

Creation offers Histogram alongside Line2D and Scatter. The Plot menu owns a
keyboard-accessible bin-count control. X is source value with its unit, Y is
sample count. Histogram axes do not offer signal-X, C binding, or equal units
per pixel. Local zoom/pan and fit work on the distribution; linked-time edits
change the analyzed interval. Step picking and cursor inspection report the
selected bin interval and exact counts, never a fabricated source observation.
Each bin has vertical outline edges down to zero (one sample on logarithmic
count axes), so adjacent bins remain visually distinct.

For histogram content only, the existing annotation `anchor` is a source value
and resolves to its current bin. Optional `histogram_window` and
`histogram_bin_count` retain pin provenance. Ordinary line/scatter annotations
remain time-anchored. No annotation-domain discriminator is restored. Deltas
use value/count, not time/slope; missing current bins remain unresolved rather
than silently becoming time annotations.

### Persistence and capture

Session 34 introduces the histogram content variant; migration from 33 retains
existing content unchanged. New annotation provenance is optional. Native and
baked validators check histogram settings and reject unsupported content or
future versions before restore. Protocol 19 remains unchanged because the new
endpoint/types and optional manifest field are additive. Release classification
is major for the new session variant under the repository's schema policy.

Snapshots capture exact histogram results for each panel's effective source
interval in both visible and all-loaded export modes. All-loaded controls
captured source tiles; it does not reinterpret a displayed histogram's interval.
Captured source selection applies before reduction. Snapshot size accounting
includes counts and edges, irrespective of time-tile fidelity.

BakedPlane supplies captured results through the same typed presentation read.
Captured analysis availability is an explicit data-plane capability, not host
detection. Local inspection, camera changes, and hiding captured series remain
available. Bin changes and source-window recomputation are unavailable without
raw inputs; the panel identifies the captured interval and fixed edges. It
never computes a histogram from decimated tiles. CSV exports exact bin counts;
HTML/PNG retain labels, appearance, interval context, and annotations.

## Alternatives and tradeoffs

Client-side binning of sampled tiles is smaller but statistically incorrect.
Full raw-array transfer violates the presentation boundary and memory goals.
Automatic bin rules require additional quantile work with little benefit to
this initial explicit-bin control. Filled bars obscure overlapping series;
step outlines reuse the measured renderer. Captured results keep offline
exports small at the cost of unavailable recomputation.

## Validation

Core tests independently count edges, constants, ties, empty/nonfinite values,
duplicate-time endpoints, extreme magnitudes, and multiple series; paged and
resident results must agree. Server tests cover malformed requests, missing
IDs, unit mismatch, and exact JSON counts. Application tests cover window/bin/
visibility identity, stale completion, errors, removal, and camera-only changes.
Native/baked parser and capture tests cover session migration, invalid content,
source selection, fixed offline intervals, size, and exact counts. Browser
tests exercise creation, bins, local navigation, linked-time rebinning, keyboard
inspection, restore, and network-free export. Measure scan and result memory
on representative large windows; renderer reuse alone proves no latency bound.

## Consequences and implementation status

The exact reducer, HTTP read, step rendering, bin controls, cursor/pins, session
migration, CSV/PNG, and captured offline results are implemented. Native reducer
tests and the browser creation/rebin/local-zoom/linked-window/restore/offline test
pass. Frontend validation passes with 2,924 tests; a subsequent regression test
covers count autoscaling after an initial empty response.
The browser test verifies workflow and exact captured data. Screenshot inspection
encountered unavailable headless WebGPU, so rendered-pixel validation remains
unverified in this environment.

Dedicated keyboard bin traversal and annotation delta readouts remain pending;
the pin button currently uses the hovered bin. The large-window benchmark is
present but has not run, so no scan latency claim is established. These gaps
remain on the roadmap rather than being treated as completed acceptance. Future
density normalization, automatic bins, duration weighting, and offline
recomputation require explicit extensions.

# Interactive pan performance

- Date: 2026-08-17
- Status: Approved

## Context

The full-resolution baseline ([ADR 0041](../../adr/0041-full-resolution-presentation-baseline.md))
established native-resolution correctness and deferred the measured
optimization that follows it. The first measured target is interactive
pan and zoom on wide, shallow panels: roughly one thousand series of
roughly ten thousand level-zero bins each.

Panning already avoids input/output. `TileWindowCache` requests a padded
window and serves in-pad gestures from the cached response without a tile
query. The cost is not transport. It is that every layer below the cache
rebuilds work that is already resident on the graphics device.

A pointer move applies the new window and schedules a refresh on a fifty
millisecond debounce, so a drag runs roughly twenty refresh passes per
second. Each pass slices the cached response into fresh column objects.
Those fresh objects are correct but newly identified, and identity is what
every downstream cache keys on:

- the renderer's per-series reuse guard compares column identity, so all
  series are rebuilt;
- the vertex feed cache is keyed weakly on the column object, so every
  series is re-expanded into new arrays;
- ChartGPU sees new series data, so it repacks every series and rewrites
  the whole vertex residency to the device.

Three further per-pass costs compound this. The renderer derives its time
rebase by scanning every bin of every series. The time rebase is derived
from the sliced window, so it drifts during a drag and would defeat the
vertex feed cache even if identity were stable. The time plot preparation
computes the vertical extent of every series eagerly, and range resolution
requests it unconditionally, so a full scan happens even when the sticky
vertical range is already settled.

The result is that panning performs a complete presentation-side repack
and a full device rewrite, twenty times a second, in order to move an axis
that the renderer's range-only update has already moved correctly on its
own.

## Decision

The renderer consumes the padded response; presentation math consumes the
visible window. These are two different consumers of one cached response
and they stop sharing a sliced intermediate.

The padded response becomes the stable unit of renderer residency. It is
identified once when it is fetched and keeps that identity for every
gesture that stays inside the pad. Feeding it directly is safe because
line strokes are drawn under a plot scissor rectangle, so bins outside the
visible range are clipped by the graphics device rather than by slicing.

Presentation math keeps receiving the visible window as an explicit
argument. The vertical extent, the visible-region statistics, the cursor
readout, and nearest-segment hit testing are already parameterized by
window or already narrow their scan by binary search, so they produce
identical results from padded columns and a visible window. The slice is
therefore removed rather than replaced.

The time rebase is pinned to the padded response and recorded with the
cache entry when the response is fetched. It is derived from the first
time column entry of each series, which is ordered, instead of from a scan
of every bin. It no longer changes while a gesture stays inside the pad.

A refresh pass that hits the cache with an unchanged series set performs
no render. The only thing such a pass can change is the axis range, and
the renderer's range-only update has already applied it synchronously on
the gesture.

Vertical extent computation becomes lazy. Time plot preparation computes
extents on demand rather than eagerly, horizontal auto-range is resolved
without touching extents because it is the window itself, and the sticky
vertical axis policy returns an already-settled range without invoking the
extent computation. A pan that does not change the vertical range performs
no vertical scanning.

Series element reuse compares whether any series is emphasized, not only
whether the series in hand is. A series' opacity depends on the former, so
under stable identity a cleared hover would otherwise return the dimmed
element and leave every non-emphasized series faded. The defect exists today
and is masked only because per-gesture slicing rebuilds every element
regardless; making identity stable turns it into a visible regression, so it
is closed before the feed changes.

Nearest-vertex hit testing gains the same binary-search bracketing that
nearest-segment hit testing already uses. Today it scans every bin of
every series and relies on the slice for its bound; once it receives
padded columns that bound is gone. This is a pointer-click path rather
than a per-frame path, so it is a correctness obligation of the change
rather than a frame-rate optimization.

## Feed format

The vertex feed emits one interleaved single-precision array instead of a
pair of double-precision arrays. ChartGPU packs an interleaved
single-precision input with a zero horizontal offset by bulk typed-array
copy rather than element-by-element, so the feed hands the renderer the
layout it already wants. This halves the bytes the feed allocates and
removes a full conversion pass.

Precision is unchanged. Horizontal values are already rebased by the
per-response time reference, which is the single-precision safety
mechanism [ADR 0039](../../adr/0039-chartgpu-time-series-renderer.md)
established, and vertical values are rendered at single precision
regardless. The change stops a round trip through double precision; it
does not lower fidelity.

The bulk-copy path requires that the renderer applies no horizontal offset
of its own. It applies one only when the horizontal axis is declared as a
time axis, and this renderer declares a value axis, so the offset is zero
and the bulk copy is reached. The axis type therefore becomes load-bearing
for this decision and must not be changed casually.

## What does not change

Live presentation remains full resolution. The same bins produce the same
vertices and the same pixels; this is a caching and identity change, not a
reintroduction of level-of-detail selection, and it does not amend
[ADR 0041](../../adr/0041-full-resolution-presentation-baseline.md).

The vertex order of first, minimum, maximum, and last is preserved, as are
gap vertices, the per-response time rebase, and the plot layout contract
the renderer publishes. The protocol and session schemas are untouched.
ChartGPU is not forked and its pinned revision does not move.

The padded window policy, its two-to-four times widening, and its
corrected request density are retained as they are.

## Consequences

Feeding the pad draws two to four times the visible segments. This trades
a fixed increase in device fill for the removal of the per-gesture
presentation repack and device rewrite. The benchmark records both the
hardware and the software adapter results, because the software adapter
used in continuous integration is fill-bound where hardware is not.

The renderer's stable residency means a gesture that leaves the pad still
pays a full fetch, repack, and rewrite. That cost is unchanged by this
work and remains bounded by the padded window policy.

Visible-region statistics remain a linear scan over the padded columns
when the statistics strip is shown. This is within a small factor of its
present cost and is left as measured follow-up rather than addressed here;
a per-response block summary is the expected remedy if the benchmark shows
it matters.

The change amends the render-path portion of
[ADR 0036](../../adr/0036-binary-tile-transport-and-render-path.md), which
records that the frontend slices cached typed arrays into the render path.
The implementation adds an ADR recording that the renderer consumes the
padded response while presentation math consumes the visible window. That
record leaves the tile budget, gap bits, finite extrema, and binary
transport decisions of ADR 0036 authoritative.

## Verification

Tests prove that:

- the time rebase of a padded response is stable across every in-pad
  gesture and is derived without a full bin scan;
- vertical extents, visible-region statistics, cursor readings, and
  nearest-segment hits computed from padded columns with a visible window
  equal those computed from the previously sliced columns;
- a refresh pass that hits the cache with an unchanged series set issues
  no render;
- vertical extent computation does not run when the sticky vertical range
  is already settled;
- nearest-vertex hit testing returns the same result from padded columns
  as from sliced columns, and bounds its scan;
- the interleaved single-precision feed carries the same vertices, in the
  same order, with the same gap breaks, as the previous pair of
  double-precision arrays.

The browser benchmark gains a sustained pan scenario over a wide, shallow
panel and holds the existing thirty-three millisecond frame budget from
[ADR 0035](../../adr/0035-benchmark-harness-and-performance-floors.md).
The scenario records frame timing for an in-pad drag specifically, so the
measurement isolates the path this change addresses from the fetch that a
pad exit triggers.

The completed change runs the focused frontend suite, formatting, the
cross-layer quality gate, and the full benchmark and end-to-end gate.

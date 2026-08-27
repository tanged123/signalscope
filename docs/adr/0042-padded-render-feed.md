# ADR 0042: Padded render feed and windowed presentation math

- Status: Accepted
- Date: 2026-08-17

## Context

Panning a wide time panel served from the padded window cache rebuilt every
presentation layer and rewrote the whole vertex residency, roughly twenty
times a second, to move an axis the renderer had already moved. The cause was
identity rather than volume: slicing the cached response per gesture produced
correct but newly identified columns, and the renderer's per-series reuse
guard, the vertex feed cache, and ChartGPU's data-reference cache all key on
that identity.

## Decision

The renderer consumes the padded tile response by reference, and the response
keeps that identity for every gesture inside the pad. `TileWindowCache`
returns the stored response rather than a per-gesture slice.

Presentation math consumes the visible window as an explicit argument.
Vertical extents, visible-region statistics, cursor readings, and hit testing
are bounded by window filtering or binary search rather than by the shape of
the array they are handed. Nearest-vertex hit testing brackets its scan the
way nearest-segment hit testing already did.

Feeding padded data is sound because line strokes draw under a plot scissor
rectangle, so out-of-view bins are clipped by the graphics device.

The time rebase is derived from each series' first bin start rather than a
full scan, and is stable across an in-pad gesture. Vertical extents are
computed only when consumed; a settled sticky vertical axis does not ask for
them. A render in which every series element was reused and no axis label
moved takes the range-only path instead of rebuilding the option object. The
vertex feed is emitted as an interleaved single-precision buffer, the layout
ChartGPU bulk-copies rather than packs element by element.

Series element reuse compares whether any series is emphasized, not only
whether this series is. Opacity depends on the former, so a cleared hover
would otherwise leave non-emphasized series dimmed once identity is stable.

## Consequences

Feeding the pad draws two to four times the visible segments, trading fixed
device fill for the removal of the per-gesture repack and rewrite. A gesture
that leaves the pad still pays a full fetch, and that cost is unchanged.

Live presentation remains full resolution: the same bins produce the same
vertices and the same pixels. This record does not amend ADR 0041. Vertex
order, gap vertices, and `tRef` rebasing from ADR 0039 are unchanged, and
ChartGPU is not forked.

This amends the render-path portion of ADR 0036, which recorded that the
frontend slices cached typed arrays into the render path. Its tile budget,
gap bits, finite extrema, and binary transport decisions remain
authoritative.

Visible-region statistics remain a linear scan over the padded columns while
the statistics strip is shown. A per-response block summary is the expected
remedy if the benchmark shows it matters.

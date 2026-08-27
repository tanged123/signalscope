# Adaptive-resolution time-series rendering

- Date: 2026-08-27
- Status: Approved

## Goal

Live time-series plots use the finest pyramid level needed to make reduction
visually indistinguishable from level zero. Zooming progressively refines the
panel until a sufficiently small window renders exact source samples. The
workbench remains responsive with 3,000 resident series and does not repeat a
first-render upload when switching among resident tabs.

## Resolution contract

Resolution is defined in physical device pixels. The frontend sends the plot
width in device pixels and scales it by the ratio between the padded request
window and visible window. Each series targets two bins per visible device
pixel. The server chooses the coarsest binary pyramid level that satisfies both
conditions:

- the visible window contains more bins than device pixels; and
- no visible bin projects wider than one device pixel.

If a binary level boundary violates either condition, the next finer level is
used. Series with different sample densities may use different pyramid levels,
but every visible series follows the same pixel-density contract. When the raw
visible slice satisfies the target, the query returns level zero.

The former 250,000-bin panel split must not force a series below the visual
floor. Resource ceilings reject an operation clearly instead of silently
returning visibly coarse data.

## Query and refinement flow

The active response remains drawable while a finer response is fetched and
prepared. A cache hit requires matching signal identity, time coverage, and the
resolution contract for the new viewport. Zooming inside a padded window is
not a hit when the cached bins have become too wide.

Each refresh has a generation. Superseded responses are discarded. The
frontend prepares every series feed before publishing the response, then swaps
the complete panel on one animation frame. A panel never mixes pyramid levels
from two generations during refinement.

Panning and zooming inside the same time and resolution band preserve response
and feed identity. Crossing a resolution boundary starts one asynchronous
request; gestures coalesce behind the newest generation.

## Cache model

Each panel retains its current response and, while refinement is in flight, the
candidate replacement. Entries record the padded time range, signal identity,
physical plot width, visible-window density, and per-series pyramid level.

The cache exposes three outcomes:

- **current**: coverage and projected bin width satisfy the viewport;
- **stale**: coverage exists but a finer level is required, so it may remain on
  screen while refinement runs; or
- **miss**: the viewport is not covered and a replacement is required.

Publishing a replacement releases the stale entry unless another mounted panel
or explicit snapshot data owns it. Cache invalidation on catalog and signal-set
changes remains unchanged.

## ChartGPU feed

Envelope feeds preserve first, finite minimum, finite maximum, last, and gap
semantics. Redundant extrema equal to an already emitted endpoint or extremum
are omitted. This restores the existing geometric contract without expanding a
coarse bin into four duplicate vertices. Level-zero singleton bins remain one
vertex per source sample.

Feed preparation happens before the panel-wide swap. ChartGPU receives stable
typed-array identities for all range-only gestures inside one cache band.

## Tab residency

Changing workspace tabs detaches inactive panel DOM without disposing its
`PanelView` or `ChartHost`. Returning to a resident tab reattaches the existing
canvas and GPU buffers, then applies any viewport changes normally.

GPU residency is capped at 3,000 resolved visible series across active and
inactive tabs. The active tab has priority. When retaining it would exceed the
ceiling, least-recently-used inactive panel hosts are disposed until the total
fits. Revisiting an evicted tab mounts its panel chrome immediately and rebuilds
the host asynchronously from the cached response without another tile request.
Closing a tab always disposes its hosts and cache entries.

An active request exceeding 3,000 resolved series is rejected before tile
materialization with a clear message. Series are not hidden, sampled
unequally, or degraded to satisfy the ceiling.

## Failure handling

The shared GPU context listens for device loss and uncaptured WebGPU errors.
SignalScope stops scheduling the lost device, reports the reason, disposes its
hosts, and offers the existing reload path. It does not continue polling a dead
device or retry at lower fidelity.

Tile and feed allocation failures preserve the current drawable response when
one exists. Initial-render failures leave the panel empty and use the existing
error surface. Superseded request failures are ignored unless they belong to
the current generation.

## Architecture records

Implementation adds an ADR that amends ADR 0041. Full resolution remains the
zoomed-in endpoint, while live time presentation may consume finer pyramid
levels that satisfy the device-pixel contract. ADR 0036's fixed total-bin split
is superseded for live presentation. Export fidelity remains explicit and
unchanged.

No protocol schema change is required. `pixel_width` carries physical padded
width, `max_total_bins` remains for compatibility, and each response already
records its selected level.

## Verification

Tests cover:

- pyramid selection above one bin per device pixel, the maximum projected bin
  width, irregular timestamps, gaps, and the level-zero zoom endpoint;
- server requests selecting finer levels as the visible window narrows;
- cache current, stale, and miss outcomes, including refinement inside one
  padded range and stale-response rejection;
- M4 duplicate removal without losing extrema, order, or gap breaks;
- panel-wide publication with no mixed response generation;
- tab switches reusing resident `ChartHost` instances, LRU eviction beyond the
  3,000-series ceiling, and disposal on close;
- shared-device loss stopping the render loop and surfacing an error; and
- deterministic full-resolution versus adaptive canvas comparison where no
  more than 0.5% of plot pixels differ by over 16 in any 8-bit RGB channel and
  no connected differing feature spans more than one physical pixel.

The implementation runs focused Rust, frontend unit, server, and Playwright
tests followed by the repository's cross-layer gate. The existing `mc1000`
corpus is the automated and manual fixture. Manual acceptance loads three
1,000-series panels, checks first plot and tab return, then zooms from the full
range to level zero while watching for striation or a refinement discontinuity.
Larger dedicated stress corpora and performance floors follow only after that
visual acceptance.

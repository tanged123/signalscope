# Budgeted persistent time-series presentation

- Date: 2026-08-28
- Status: Approved
- Supersedes: the fixed 3,000-visible-series ceiling in the adaptive-resolution design and ADR 0044

## Goal

SignalScope keeps full-range overview plots immediately available after deep
zoom, accepts large visible-series sets without an arbitrary count ceiling,
and chooses one honest, uniform resolution that fits tracked CPU and GPU
presentation budgets. Zooming continues to refine toward exact level-zero
samples.

## Current limitations

Each panel currently retains one tile response and one ChartGPU data set.
Zooming replaces the full-range overview with the detailed window. A later
double-click fit therefore fetches, prepares, and uploads every overview
series again before the complete panel can appear.

The 3,000-visible-series constant is shared by active-layout admission and
inactive-tab eviction. It is unrelated to panel width, response size, prepared
feed size, device limits, or actual ChartGPU allocation capacity. Pixel-bounded
queries limit bins per series, but total work still scales with the number of
series.

## Resolution contract

The preferred density remains two envelope bins per physical device pixel per
visible series. One density applies to the complete active layout. Signals may
select different binary pyramid levels because their sampling rates differ,
but every selected level must satisfy the same projected-density target.

When the preferred density does not fit, the planner reduces the shared target
instead of rejecting a series count or degrading series unequally. The minimum
query remains one `pixel_width` unit per series, which requests at most two
bins from the server before boundary padding. If even that request cannot fit,
the operation fails clearly while preserving the current drawable banks.

For a panel with physical width `W`, padded-to-visible span ratio `P`, and
chosen density `D`, the request uses:

```text
pixel_width = ceil(W * P * D / 2)
```

The cache evaluates a response against `D`, not against the preferred density,
so a deliberately budgeted response is current rather than perpetually stale.
When series are hidden, panels shrink, banks are evicted, or a visible raw
slice becomes small enough, the planner raises density again. Level zero
remains the exact-sample endpoint.

## Presentation budgets

CPU and GPU residency have independent soft budgets. They govern only
SignalScope-managed presentation data and never claim to represent total
system RAM or total VRAM. WebGPU exposes per-resource limits but not available
VRAM.

Auto mode chooses conservative ceilings:

- CPU: `deviceMemory * 128 MiB`, clamped to 512 MiB through 2 GiB; use 512 MiB
  when `navigator.deviceMemory` is absent.
- GPU: twice `adapter.limits.maxBufferSize`, clamped to 256 MiB through 1 GiB.
- Individual allocations remain bounded by the acquired device's
  `maxBufferSize` and `maxStorageBufferBindingSize`.

Nullable `presentation_cpu_bytes` and `presentation_gpu_bytes` preferences
override Auto. Overrides are positive decimal strings at the generated
TypeScript boundary, follow the existing preferences migration rules, and do
not raise a device hard limit.

Before a query, the planner uses worst-case costs of 121 CPU bytes per bin
(73 binary column bytes plus six interleaved M4 vertices) and 96 GPU bytes per
bin (the same worst-case feed under ChartGPU's power-of-two buffer growth).
After preparation and upload, estimates are reconciled with unique response
`ArrayBuffer` sizes, prepared-feed byte lengths, and ChartGPU series-buffer
capacities. Pipeline, canvas, and driver-private memory remain outside the
ledger and are covered by the conservative soft ceiling.

Density downgrades apply immediately. Upgrades wait until the viewport and
active layout have remained stable for 250 ms, preventing oscillation around a
binary pyramid boundary.

## Persistent CPU banks

Each panel owns a byte-bounded cache of prepared view banks. A bank contains:

- role: `overview` or `detail`;
- signal identity, padded request window, visible window, selected density,
  and per-series levels;
- the decoded columnar response;
- strongly retained prepared M4 feeds; and
- exact accounted CPU bytes.

The overview is the full signal extent at the density planned for the active
layout. The current detail covers the interactive window. The active panel's
overview and selected detail are pinned. Superseded detail banks and inactive
panel banks are ordinary LRU entries.

The decoded typed-array columns are views over the binary response buffer, so
the buffer is counted once rather than once per column. Prepared feeds are
counted separately. Retaining both avoids a network request and M4 preparation
when a GPU bank must be recreated.

## Persistent GPU banks

An active panel may own two lazily created ChartGPU hosts sharing the workspace
GPU context and pipeline cache:

- the overview host retains the full-range bank; and
- the detail host retains the current-window bank.

Only the selected host is visible. A stable hidden host does not request
frames. Double-click fit selects the resident overview host before the next
animation frame; it performs no query, feed preparation, or data upload.
Detail becomes visible only after its complete response is prepared and its
host is ready. A panel never mixes series or pyramid generations.

Both hosts resize with their panel. Interaction layout, hit testing, overlay,
cursor, annotations, statistics, and PNG capture use only the selected host.
Theme and style changes update both resident hosts without changing their data
identity.

ChartGPU reports the sum of current series-buffer capacities from its data
store. SignalScope uses that value for its GPU ledger instead of the existing
zero-valued memory metric.

## Residency and eviction

Pressure is resolved in this order:

1. inactive-tab detail GPU banks, least recently used first;
2. inactive-tab overview GPU banks;
3. superseded active-tab CPU detail banks;
4. inactive-tab CPU detail banks;
5. inactive-tab CPU overview banks;
6. a lower uniform density for the active layout.

The active layout's selected bank and overview bank are not evicted. Closing a
panel or tab releases all its CPU and GPU banks. Returning to a panel with CPU
but no GPU residency rebuilds its host without querying or preparing feeds.
Returning after CPU eviction queries normally.

There is no fixed series-count admission check. A genuine capacity error names
the limiting resource and keeps the prior frame.

## Refresh and failure behavior

Every refresh retains its generation token. For each panel, the coordinator
selects the best resident bank synchronously, calculates one layout-wide
density, then requests missing overview or detail banks. Responses from an old
generation are discarded.

Preparation failure leaves both selected maps and resident hosts unchanged.
Allocation failure runs the eviction policy and retries once at the next lower
uniform density. A failed retry reports the resource and requested bytes; it
does not publish a partial panel. Shared WebGPU device loss retains the
existing explicit reload behavior.

## Status and controls

The status bar reports tracked presentation state without amber or a generic
warning fill:

- below 80% and at target density: no additional text;
- at or above 80%: `presentation 82%`;
- below target density:
  `resolution limited · 0.8/2.0 bins/px · 5,000 series`.

The tooltip explains that the value is SignalScope's presentation budget and
suggests zooming, hiding series, closing inactive tabs, or raising an advanced
budget preference. The Settings command surface cycles each override through
Auto, 256 MiB, 512 MiB, 1 GiB, and 2 GiB; GPU choices are clamped to device
hard limits.

## Protocol and host boundaries

The tile protocol does not change. `pixel_width` carries the density-planned,
padded request width and `max_total_bins` remains compatibility-only.
`HttpPlane` and `BakedPlane` use the same cache, planner, and bank coordinator.
Rust continues to own pyramid selection and returns one level per series.

Snapshot selection and explicit export fidelity do not use presentation
budgets. A reduced live overview therefore never silently changes an exported
artifact.

The preferences schema advances additively with nullable defaults. Session and
snapshot schemas do not change.

## Verification

Unit tests cover budget derivation, uniform-density planning, minimum-density
failure, hysteresis, exact CPU accounting, ChartGPU capacity accounting, bank
selection, and deterministic eviction order.

Integration tests cover:

- deep zoom followed by fit selects an already resident GPU overview without
  querying, preparing, or uploading;
- a 5,000-visible-series active layout is admitted and receives one density;
- inactive GPU and CPU banks are evicted before active density falls;
- budget reduction and recovery never mix response generations;
- a failed allocation preserves the last drawable bank; and
- tab return rebuilds from CPU residency without a tile request.

The existing adaptive-versus-level-zero pixel comparison remains authoritative
at the preferred density. A second comparison exercises a deliberately
budgeted overview and requires the same peak, gap, and one-pixel feature
preservation rules while allowing the declared lower density.

The `mc1000` corpus remains the automated and manual fixture. The browser
benchmark records fit-to-overview latency and presentation density alongside
first plot and frame timing. Manual acceptance plots all five channels across
1,000 sources, verifies the 5,000-series capacity notice, zooms to level zero,
double-clicks fit repeatedly, and switches among retained and evicted tabs.

## Non-goals

- Inferring total or free VRAM, which WebGPU does not expose.
- Publishing lines incrementally or mixing response generations.
- Changing pyramid extrema, gap semantics, export fidelity, or raw-sample
  ownership.
- Guaranteeing that every hardware/driver combination can display an
  unbounded number of series.

# WebGPU Line Renderer — Time-Series-Only Redesign

**Date:** 2026-08-07
**Status:** Approved by Edward; revised after ChartGPU source review
**Supersedes:** the density-raster direction of
`2026-08-06-unified-renderer-design.md` (phases 3–3.5), the phase-4 pyramid-XY
work, and the multi-mode registry. The useful transport, cache, and prepared
geometry work remains.

## Goal

SignalScope becomes a time-series-only plotter that keeps every visible series
individually represented at every scale and remains interactive with 10,000+
series. Viewport LOD may reduce each line's samples, but it never omits or
merges series. Zooming refines ordered, real sample representatives until level
zero reaches raw samples.

## Research boundary

`refs/ChartGPU` is an MIT-licensed architectural reference, not a production
dependency or wholesale backend replacement. SignalScope adopts its proven
WebGPU patterns: one shared device and pipeline cache, an application-owned
render loop, GPU-resident geometry, packed-x transforms, instanced segment
quads, a dense single-sample hairline pass, dirty uniform writes, and explicit
device-loss handling.

SignalScope does not adopt ChartGPU's complete chart model, default LTTB,
index-stride draw LOD, per-series renderer/draw-call model, CPU staging copy of
every resident point, CPU hit testing, axes, interactions, or DOM overlays.
Those conflict with the out-of-core data plane, 10,000-series target, fidelity
contract, and Final Spec. Any copied implementation must retain its MIT notice;
prefer a focused implementation against SignalScope's existing contracts.

## Locked decisions

1. **Every series is drawn.** No aggregate density field, ensemble replacement,
   merged band, or series-count cutoff exists. Overlap is ordinary GPU alpha
   compositing of individually submitted lines.
2. **LOD preserves identity and salient samples.** Every emitted representative
   is a real sample and appears in source order. First, last, finite extrema,
   and gaps survive every level. LOD does not claim raw-sample equivalence at a
   coarse scale; zooming increases resolution until the raw level.
3. **No generic sampling shortcuts.** LTTB and index-stride drawing are absent.
   The renderer draws every segment delivered by the selected pyramid level.
   Dense rendering may switch stroke implementation from anti-aliased quads to
   one-device-pixel hairlines, but not skip delivered segments.
4. **Series identity is invariant.** Style, pick, mute, and emphasis address the
   same stable series slot at every LOD. None requires secondary acquisition.
5. **XY, histogram, and FFT are deleted full-stack.** Remove their frontend
   modes, sample-mode acquisition, UI, tests, exports, and mode-specific session
   fields. Keep `query_with_target` for time-series pyramid LOD and keep exact
   sample queries used by CSV export. Protocol and session versions bump; old
   sessions are rejected without migration.
6. **WebGPU is the only series renderer.** No Canvas2D series fallback. Hosts
   without a suitable adapter get a clear unsupported-host screen. Baked
   snapshots inherit the WebGPU requirement. Canvas2D remains for axes, labels,
   cursors, annotations, and gesture overlays.
7. **Per-series LOD replaces the panel budget.** Each series targets viewport
   resolution independently. Delete `TILE_BIN_BUDGET` and all arithmetic that
   divides a panel budget by series count. GPU memory pressure may temporarily
   retain a coarser resident level, but never remove a visible series.

## Architecture

### Workspace GPU runtime — `frontend/src/render/gpu/`

- One adapter, device, queue, shader-module cache, and pipeline cache serve all
  panels. Panels own surfaces and render state, not devices.
- Initialization requests a high-performance adapter, validates runtime buffer
  and storage-binding limits, installs `device.lost` and uncaptured-error
  handlers, and sizes arenas from the actual limits. Geometry is split into
  bindable pages; the implementation never assumes one giant storage buffer.
- SignalScope owns one dirty-driven `requestAnimationFrame` loop. It encodes all
  dirty panels and submits one command batch per workspace frame. Pointer events
  mutate state and request a frame; they never render synchronously.
- Pipeline and bind-group identity are stable. Pan/zoom normally writes only a
  small transform uniform. Unchanged transforms, styles, and bindings skip
  queue writes.

### GPU-resident geometry and batching

- Tile point streams upload once into paged point arenas. Tile metadata records
  point range, series slot, time origin, level, source window, and gap runs.
  Transit `ArrayBuffer`s are released after upload; unlike ChartGPU, SignalScope
  keeps no capacity-sized CPU staging array per series.
- A GPU build/compaction pass runs only when residency or selected LOD changes.
  It emits segment descriptors and indirect draw arguments into panel-local
  buffers. A descriptor references two resident points and a stable series
  style slot. Gaps emit no segment.
- The render pass consumes the compact descriptor stream in batches per arena
  page, never one renderer, uniform buffer, bind group, or draw call per series.
  The acceptance bench records draw calls; they scale with arena pages and
  passes, not series count. Descriptor order is stable by series slot and source
  index so alpha blending is deterministic.
- Normal lines use six instanced vertices per segment. The vertex shader expands
  the segment into a screen-space anti-aliased quad. Color, alpha, width, dash,
  visibility, and emphasis come from a GPU series-metadata table.
- When delivered segment count or measured overdraw crosses a device-pixel
  threshold, eligible solid ordinary lines move to a post-resolve,
  `sampleCount: 1` hairline pass. It uses native one-device-pixel line segments
  and still draws every delivered segment. Focused, dashed, or explicitly
  widened lines remain anti-aliased quads above it.
- Frame graph: optional descriptor compute → 4× MSAA grid/focused-line pass →
  resolve → dense hairline load pass. Canvas2D overlays render afterward. The
  whole WebGPU graph uses one queue submission.

### Precision

- Wire timestamps remain f64. GPU points store f32 offsets from a per-tile f64
  origin represented as high/low f32 metadata. The view origin is represented
  the same way; the shader subtracts origins before applying the f32 affine.
- Precision tests compare projected pixels against the f64 CPU reference for
  epoch-scale timestamps at deep zoom. The permitted error is below 0.25 device
  pixel.

### Data plane and wire format

- Pyramid bins gain argmin and argmax sample indices. Query emission orders
  first, extrema, and last by source index, deduplicates equal indices, and
  inserts explicit gap boundaries. Every representative value comes from the
  source column.
- The sidecar cache ABI and binary tile protocol version bump. The transport is
  GPU-shaped: packed ordered point streams plus metadata sufficient for direct
  upload. It retains compact sums, squared sums, finite/sample counts, extrema,
  and gap metadata needed by visible statistics and scientific inspection; the
  point stream is a rendering companion, not a replacement for those
  invariants. Generated protocol outputs remain authoritative.
- `query_with_target` remains the core LOD primitive. The shell passes a
  per-series viewport target independent of panel cardinality. Batched requests
  are chunked so coarse tiles for all series arrive before refinement of any
  series.
- Padded-window caching remains. Pan inside resident tiles changes only the
  transform. Crossing a cache boundary requests coarse replacement tiles first,
  then progressively refines toward the target level.
- GPU residency is keyed by `(signal, level, tile index, generation)` and
  LRU-evicted under an explicit byte budget. Eviction order is non-visible,
  superseded fine tiles, then visible fine tiles. A coarse tile for every visible
  series is pinned while that series is visible.
- `TauriPlane` and `BakedPlane` return the same versioned payload. Snapshots stay
  self-contained and offline; ChartGPU is not bundled into them. The frontend
  may retain compact directories and statistical summaries, but never a second
  CPU copy of the uploaded point stream.

### Interaction and picking

- Pan and wheel/box zoom update viewport uniforms immediately. Refinement is
  asynchronous and never blocks interaction.
- Restyle, mute, and emphasis update the series-metadata buffer. They do not
  rebuild geometry or fetch tiles.
- Picking is a time-series-specific GPU compute reduction, not an ID color pass
  and not ChartGPU's CPU scan. One invocation per visible series locates the
  resident samples adjacent to the cursor time, measures pixel distance, and
  participates in a nearest-series reduction. Readback uses a small ring of
  mapped buffers and is rate-limited; gestures never wait for it.
- Click uses the most recent completed pick or awaits one explicit pick without
  blocking rendering. Hover may lag by one frame but must not trigger a plot
  redraw or tile request.
- Live streaming and ring-buffer ingest remain out of scope. The architecture
  may not prevent them, but this redesign does not implement them.

### Deletions

Delete XY/FFT/histogram production code and tests, the `ui/modes` registry,
sample-mode plotting caches and budgets, `density-raster.ts`,
`density-policy.ts`, the starved-envelope ribbon fallback, the hi-resolution
stroked-set merge and hover-emphasis acquisition, Path2D series caches, and
Canvas2D series stroking. Remove session fields that only serve removed modes,
including `mode`, `x_ref`, `color_ref`, `color_axis`, `c_label`, `x_range`, and
`axis_equal`. Retain exact sample acquisition used by CSV export and all
time-series pyramid/query functionality.

## Error handling

- No WebGPU adapter, required limits below the minimum, or surface setup failure:
  dedicated unsupported-host screen with the failed capability; no blank plot.
- Device loss: stop submission, reacquire device and pipelines, then re-request
  visible tiles from the active data plane. Overlay state remains visible during
  recovery.
- Tile failure: retain the prior resident level. A series with no resident tile
  has a visible missing-data state; the frame and other series continue.
- Memory pressure: evict by the residency policy and reduce visible series to a
  common coarser level if needed. Never evict a subset into invisibility.

## Testing and acceptance

- **Rust:** argmin/argmax propagation, ordered representative emission, duplicate
  index removal, gaps, all-NaN bins, level-zero passthrough, cache round-trip,
  and protocol encoding against raw-sample references.
- **Frontend:** arena allocation against mocked device limits, direct tile
  upload, descriptor generation, page-bounded draw batching, style-only writes,
  dirty-frame coalescing, LRU policy, picking reduction, device loss, and clear
  unsupported-host behavior.
- **GPU integration:** focused golden images on a software adapter for ordered
  extrema, gaps, overlap, quad/hairline transition, emphasis, and epoch-time
  precision. Structural tests carry most coverage because software adapters are
  slow.
- **Fidelity:** small fixtures compare WebGPU output with a raw-sample reference.
  Every visible series must contribute draw segments; GPU counters assert no
  aggregate substitution or cardinality cutoff. Hairline transitions may change
  stroke width, never geometry membership.
- **Bench matrix:** mc1000 and a deterministic 10,000-series/100M-sample corpus.
  Record cold first plot, coarse-first latency, refinement latency, upload bytes,
  resident GPU bytes, draw calls, submitted segments, main-thread task time,
  frame p50/p95/max, pick latency, and device-loss recovery.
- **Performance floor:** interaction frame p95 ≤ 33 ms and longest stall ≤ 250
  ms for both cardinalities. Target p95 is one display interval and target stall
  is ≤ 100 ms. Pan inside resident padded tiles performs zero geometry uploads.
- **Visual acceptance:** the mc1000 pressure panel shows strand texture and edge
  trajectories from all runs, with saturation only where individually rendered
  lines physically overlap. Zoom increases per-line resolution without a
  representation switch to density, bands, or merged geometry.

## Risks (accepted)

- WebGPU availability excludes some native and snapshot hosts; the unsupported
  screen is intentional.
- Ten thousand alpha-blended lines can saturate the same pixels even though all
  lines are drawn. That is physical overlap, not data aggregation.
- Runtime GPU limits vary. Paged arenas and coarse-first residency trade maximum
  detail for continuity without dropping series.
- Golden images vary across GPU implementations. Assert bounded pixel masks and
  structural counters instead of exact whole-frame hashes where necessary.

## Sequencing

Four implementation plans, each independently landable with a working time
plot and green tree:

1. **Time-only deletion:** remove XY/FFT/histogram, the mode registry, density
   tier, and mode-specific schema fields. Keep the existing per-series Canvas2D
   time renderer temporarily. Bump schemas and add the superseding ADR.
2. **Ordered representatives:** add extrema indices, cache/protocol revisions,
   per-series targets, and the GPU-shaped payload. A thin Canvas2D adapter keeps
   time plots working until the WebGPU switch.
3. **WebGPU rendering:** add the shared runtime, limit-aware arenas, descriptor
   compute, quad and hairline passes, packed-time precision, residency, recovery,
   and overlay split. Switch series rendering to WebGPU and delete the temporary
   adapter and remaining Canvas2D series code.
4. **Interaction and proof:** add compute picking, progressive refinement, the
   1,000/10,000-series benchmark matrix, GPU integration tests, and visual
   acceptance. Remove obsolete benchmark artifacts and document measured limits.

## Consequences

- A new ADR records the time-series-only product, identity-preserving LOD,
  WebGPU-only series rendering, and ChartGPU reference boundary. It supersedes
  ADR 0038 and the pyramid-XY amendment to ADR 0037.
- Future plot types begin as independent implementations. They may reuse the
  proven GPU runtime, arenas, and overlay primitives, but no generic mode
  framework is introduced until a second production plot demonstrates the
  shared contract.

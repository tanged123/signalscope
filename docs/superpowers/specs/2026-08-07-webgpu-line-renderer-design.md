# WebGPU Line Renderer — Time-Series-Only Redesign

**Date:** 2026-08-07
**Status:** Approved by Edward (brainstorm 2026-08-07)
**Supersedes:** the density-raster direction of `2026-08-06-unified-renderer-design.md`
(phases 3–3.5) and the phase-4 pyramid-XY work. The unified-pipeline phases 1–2
(mode-free rendering contracts, prepare/configKey caching discipline) remain in
spirit but the mode registry itself is deleted.

## Goal

SignalScope becomes a time-series-only plotter whose renderer draws **every
series individually at every scale** — visually equivalent to brute-force
plotting all lines — at full interactivity with 10,000+ series. This pipeline
is the stringent baseline template future plot types are rebuilt on.

## Locked decisions

1. **Brute-force-equivalent visuals.** Every series is submitted and drawn;
   overlap composites through GPU alpha blending. No aggregate, density,
   ribbon, or merged representation exists anywhere in the pipeline.
2. **Series identity is an invariant.** Every series remains individually
   addressable — style, hover, pick, mute, emphasize — at all scales, with no
   secondary acquisition path.
3. **XY, histogram, and FFT are deleted full-stack**: frontend modes and mode
   registry, host compute (`query_with_target`, FFT, histogram aggregation),
   protocol messages, and the session-schema `mode` field. Protocol and
   session versions bump. No migration; sessions referencing removed modes
   are invalid.
4. **WebGPU is the only plot renderer.** No Canvas2D fallback for series.
   Hosts without WebGPU get a clear unsupported-host error screen, never a
   degraded plot. Baked snapshots inherit the WebGPU requirement. Canvas2D
   survives only in the overlay layer (axes, labels, cursors, selection).
5. **Per-series LOD with extrema-ordered emission.** Each series independently
   selects the pyramid level where one bin ≈ one viewport pixel column; bins
   emit representative points in true sample order (first → ordered extrema →
   last), which reproduces the stroked line's pixel coverage at screen
   resolution. Level 0 reaches raw samples. The panel-wide shared bin budget
   (`TILE_BIN_BUDGET` as a cross-series allocation) is deleted.

## Architecture

### Renderer — `frontend/src/render/gpu/`

- Owns adapter/device acquisition and surface configuration. No adapter →
  error screen listing host requirements.
- Series geometry lives in GPU-resident packed vertex buffers uploaded
  verbatim from the wire format — no Path2D, no per-frame JS path
  construction, no per-series CPU drawing.
- Lines draw as instanced quads: one instance per segment, expanded to
  screen-space width in the vertex shader, alpha-blended (premultiplied) so
  overlap composites exactly as drawing each line would.
- **Precision:** timestamps are f64. Vertices store f32 offsets from a
  per-tile f64 origin split across uniforms, so deep zoom never hits f32
  quantization.
- Per-series render state (color, alpha, width, mute, emphasis) is instance
  data; restyling writes bytes, never rebuilds or re-uploads geometry.
- **Picking** is a GPU ID pass: series id rendered per pixel, async readback
  for hover/click. No CPU scan over series.
- Draw submission is batched (indirect where it wins); axes, labels, and
  interaction overlays stay on the existing Canvas2D overlay layer.

### Data acquisition and wire format

- The pyramid's bins gain **extrema indices** (the previously deferred
  extension, now core) so the host emits each bin's representative points in
  true sample order. Gap and extrema invariants are preserved and tested.
- The tile wire format becomes GPU-shaped: packed point streams the client
  uploads directly, with gap sentinels that restart the line strip.
- LOD is selected per series from the visible window and viewport width;
  requests are per (series, level, tile). No cross-series budget arithmetic.
- Client tile cache is GPU-resident, keyed (series, level, tile index),
  LRU-evicted under an explicit GPU memory budget. Refinement streams
  coarse-first; a missing finer tile means the series draws at its resident
  coarser level, never blocks the frame.
- The client keeps no CPU copy of tile payloads; on GPU device loss the
  renderer reacquires the device and re-requests resident tiles from the
  host.

### Interaction

- Pan within resident padded tiles is a uniform (transform) update — zero
  geometry work per frame.
- Zoom applies the transform to current-LOD geometry immediately, then
  refines asynchronously toward the target level; deep zoom bottoms out at
  raw samples.
- Live ingest appends tiles incrementally to resident buffers.
- Hover, emphasis, mute, and restyle never trigger re-acquisition.

### Deletions

Full-stack XY/FFT/H (decision 3) plus, from the current branch:
`density-raster.ts`, `density-policy.ts`, the starved-envelope ribbon
fallback, the hi-res stroked-set merge and hover-emphasis machinery
(`mergeTileResponses`, `withHiRes`, `onEmphasize`, `panelEmphasis`), Path2D
caches and canvas series stroking in `canvas-renderer.ts`, the shared bin
budget, and the `ui/modes` registry. `canvas-renderer.ts` shrinks to overlay
duties or is absorbed by `overlay-renderer.ts`.

### Error handling

- No WebGPU adapter/device: dedicated error screen; the app does not attempt
  a fallback plot.
- Device loss: reacquire, re-upload from host (tiles are cacheable
  host-side); the panel shows its last overlay state during recovery.
- Tile fetch failure: affected series stay at their resident LOD; missing
  data draws nothing rather than failing the frame.
- Memory budget pressure: LRU eviction of non-visible, then finest, tiles;
  the coarse level for visible series is never evicted while visible.

## Testing and acceptance

- **Rust:** extrema-index emission tests against raw-sample references —
  ordering (first → extrema → last), gap invariants, level-0 passthrough.
- **Frontend:** structural tests against a mock GPU device (buffer layout,
  instance encoding, eviction policy, device-loss recovery); a small set of
  golden-image tests on a software adapter (SwiftShader/Lavapipe) in CI.
- **Bench matrix:** 1,000 and 10,000 individually rendered lines — upload
  time, GPU memory, frame p95, refinement latency. Deltas against the
  current-branch baseline; WSL2 frame floors remain environmental.
- **Visual acceptance:** the mc1000 pressure panel (Screenshot 2026-08-06 204027) shows every run as an actual drawn line: strand texture and
  interference patterns visible, saturated core where 1,000 runs genuinely
  overlap, individual traces at the envelope edges.

## Risks (accepted)

- **WebGPU availability:** Linux WebKitGTK Tauri and older browsers (including
  ones opening baked snapshots) may lack WebGPU. Accepted; error screen.
- **Headless CI:** software adapters are slow — keep golden-image tests few,
  assert structure elsewhere.
- **GPU memory at 10k × fine LOD:** bounded by the explicit budget and
  eviction policy; measured by the bench matrix.

## Sequencing

Four implementation plans, each independently landable with a green tree:

1. **Deletion** — XY/FFT/H full stack, mode registry, density tier and its
   3.5 machinery; protocol/session version bumps; superseding ADR.
2. **Pyramid extrema indices + GPU-shaped wire format** — host emission,
   per-series LOD requests, wire tests (renderer still consumes via a thin
   CPU adapter until plan 3).
3. **WebGPU renderer core** — device lifecycle, packed buffers, instanced
   line draw, precision scheme, overlay split, error screen.
4. **Interaction, picking, and bench** — pan/zoom refinement, GPU ID pass,
   ingest streaming, eviction, the 1k/10k bench matrix, visual acceptance.

## Consequences

- A new ADR records the time-series-only scope, the WebGPU renderer, and the
  per-series LOD contract; it supersedes ADR 0038 and the pyramid-XY
  amendments to 0037.
- Future plot types are rebuilt on this template — same acquisition, cache,
  and draw contract with a different projection — rather than reviving the
  mode registry.

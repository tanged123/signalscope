# Unified renderer: brief for a future spec

Not a spec. This is the handoff note for whoever writes one, in its own PR.
It records what the 2026-08-05 post-Phase 5 pass found, deferred, and left
unverified. Verify the claims below against the code rather than trusting
them — several are one investigation deep, not two.

## What exists today

`CanvasRenderer` has two entry points, and the split is by **data model**,
not plot type:

- `render()` (`frontend/src/render/canvas-renderer.ts:227`) — pyramid
  envelope bins. Monotonic time x, per-bin first/last/min/max plus a gap bit,
  density bounded by pixel width.
- `renderPaths()` (`:340`) — vertex polylines.

XY, FFT, and histogram all already share `renderPaths` (`ui/panel.ts:1224`,
`:1275`, `:1351`). Everything mode-specific lives in `panel.ts` preparation —
`prepareXyPlot`, `spectrum()`, `histogram()` — which the renderer never sees.
Removing plot modes would therefore not simplify the renderer; that idea was
considered and rejected.

## What is already right

- **The decimation algorithm is correct.** `appendSeriesPath` (`:769`) does
  per-pixel-column min/max aggregation — snap x to `floor(px) + 0.5`,
  accumulate `first/min/max/last`, lift the pen on a gap flag. That is M4,
  and it is the same shape as uPlot's `drawAcc()`.
- **The pyramid is the right mechanism.** uPlot decimates the full array
  client-side, which caps it at a few million points in memory. The pyramid
  is the same aggregation precomputed server-side so it survives out-of-core
  data (ADR 0029). Do not replace it with a client-side scan.
- **Style bucketing works where it is applied.** `render()` groups series by
  `color\0width` into shared `Path2D`s and strokes each group once
  (`:293-323`). The 2026-08-05 pass extended the same idea to colour-mapped
  paths (bucket by ramp step, at most 65 strokes).

## Open questions the spec must answer

Ordered by how much they constrain everything else.

1. **Density policy above ~138 series.** `TILE_BIN_BUDGET = 250_000` split
   across series with a 64-bin floor (`ui/app-shell.ts:102`,
   `shell/src-tauri/src/lib.rs:877`) genuinely starves resolution below one
   bin per pixel once a panel carries more than roughly `250_000 / 1800`
   series. No renderer restructuring fixes this. Either the budget scales and
   wire cost grows, or the panel switches to a density/aggregate raster past
   a threshold. This choice drives the rest of the design. Note that
   `docs/superpowers/plans/2026-08-04-plotting-performance-overhaul.md`
   already deferred "xy-style density/aggregate textures for 1000-series
   spaghetti panels" once — this is the second deferral of the same item.

2. **Where 2D trajectory reduction runs.** Extrema preservation for an XY
   trajectory needs one shared index set across the panel's x and y signals.
   `query_samples` handles signals independently and knows nothing about
   panel structure, and paired signals may not even share a time array (hence
   `lerpSample` in `app/xy.ts`). This is a protocol question before it is a
   renderer question. ADR 0037 records why the per-signal min/max shortcut is
   wrong: it breaks the shared timebase `pairSamples` depends on, biases
   histogram tails, and violates the FFT's uniform-sampling assumption.

3. **Device pixels vs CSS pixels.** `appendSeriesPath` snaps columns to CSS
   pixels while the canvas backing store is `devicePixelRatio` times larger
   (`render/surface.ts:19-37`). On a 2x display that discards half the
   available column resolution. Cheap to fix, but it interacts with whatever
   density policy question 1 settles.

4. **Is the client-side M4 branch live at all?** `appendSeriesPath`
   aggregates only when `count > 2 * plot.width`, but the server already
   targets `2 * pixel_width` bins (`core/scope-core/src/pyramid.rs:455`) and
   `plot.width` is smaller than `pixel_width` by the axis gutters. Nobody has
   measured how often that branch fires. If it is effectively dead, all real
   aggregation happens server-side and the client path is vestigial — which
   changes what the unified primitive needs to do. **Measure this first.**

5. **The unified primitive.** Comparatively mechanical once 1–4 are settled.
   The sketch that motivated this brief: one `VertexBatch` (interleaved
   `Float32Array` in plot-pixel space, `Uint32Array` pen-lift indices, a
   resolved style, an optional ramp-bucket index), two producers
   (`binsToVertices` from today's M4 loop, `pointsToVertices` from today's
   `drawPath`), and one consumer that buckets by style and issues one
   `stroke()` per bucket. It should be _less_ code than today, because
   `render()` and `renderPaths()` stop duplicating stroke and style logic.

## Unverified — check before building on it

The 2026-08-05 pass attributed the visible "steps" in time traces to
`TileWindowCache.padWindow` widening a request 2x–4x while the request kept
the unmodified panel `pixel_width`, so the sliced visible response carried
0.5–1 bin per CSS pixel. The fix (`TileWindowCache.requestPixelWidth`) is
arithmetically sound and its tests pass, **but nobody has confirmed the
staircase is gone on a real trace.** Reproduce the artifact and confirm the
diagnosis before designing around it.

## Constraints the design inherits

- Pyramid invariants are law: parent bins preserve first/last/finite min-max/
  count/gap-OR; `has_gap` breaks a stroke and never discards extrema; query
  density is bounded by viewport width; the renderer never scans raw arrays
  for ordinary pan/zoom.
- The renderer stays deterministic from tiles + viewport + tokens, so
  snapshot and workbench output stay pixel-aligned. `TauriPlane` and
  `BakedPlane` implement the same contract; UI code never branches on host
  identity.
- Snapshots stay self-contained and offline, within the export budget. No new
  runtime dependencies in the snapshot frontend.
- An architectural change needs a new or amended ADR.

## Non-goals

Keep the four plot modes. Do not revive the client-side full-array scan. Do
not reopen the per-signal min/max reduction (ADR 0037). WebGL2/GPU rendering,
binary snapshot manifests, and an HTTP/WebSocket data plane were deferred by
the 2026-08-04 performance plan and stay deferred unless the spec argues
otherwise.

## Source material

- `docs/superpowers/plans/2026-08-05-post-phase-5-fixes.md` §"Scope
  boundaries" — the deferral list this brief expands
- `docs/adr/0037-per-mode-sample-budgets.md` — why per-signal min/max is wrong
- `docs/superpowers/plans/2026-08-04-plotting-performance-overhaul.md` — the
  prior perf pass; its root-cause list and deferrals still apply
- `docs/adr/0036-binary-tile-transport-and-render-path.md`,
  `docs/adr/0029-out-of-core-storage.md`
- `refs/uPlot` — reference checkout; see its `src/paths/linear.js` for the
  M4 path builder this codebase's `appendSeriesPath` parallels

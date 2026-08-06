# Unified renderer: brief for a future spec

Not a spec. This is the handoff note for whoever writes one, in its own PR.
It records what the 2026-08-05 post-Phase 5 pass found, deferred, and left
unverified, plus the 2026-08-06 findings that corrected it. Verify the claims
below against the code rather than trusting them — several are one
investigation deep, not two.

**Read "Corrections" first.** The first draft of this brief framed the problem
as a renderer refactor. That framing was wrong.

## Corrections to the first draft (2026-08-06)

### 1. The problem is the data pipeline, not `CanvasRenderer`

The renderer is the last stage and the smallest part. The real asymmetry is
that time has a complete pipeline and XY has almost none:

| Stage                    | Time                       | XY                             |
| ------------------------ | -------------------------- | ------------------------------ |
| Server-side reduction    | pyramid — M4, out-of-core  | none; plain integer stride     |
| Wire format              | binary columnar (ADR 0036) | JSON                           |
| Window cache             | `tileWindowCache`, padded  | one-entry sample cache         |
| Per-frame geometry cache | `pathCache` WeakMap        | none — full rebuild each frame |
| Per-frame preparation    | slice columns              | pair + lerp + flatten, O(n²)   |

Unifying `render()` and `renderPaths()` without fixing the four stages above
would move code around and change nothing a user can feel.

### 2. XY can be pyramid-backed — the shared index set already exists

The first draft said trajectory reduction "requires a 2D, panel-level
reduction over one shared index set," and ADR 0037 deferred it as hard. That
under-read the pyramid.

The pyramid does not reduce over x. It reduces over **time**, into
index-aligned power-of-two buckets: bucket `i` at level `L` covers samples
`[i·2^L, (i+1)·2^L)`. Signals decoded from one CSV **share a single time
array** — `ingest/csv.rs` builds one `Arc<[f64]>` in `finish()` and hands
every signal an `Arc::clone` of it. Same array means same sample count, same
index-to-time mapping, and the same level chosen by
`Pyramid::query_with_target` for a given window. Therefore bucket `i` of the
x signal and bucket `i` of the y signal cover exactly the same samples.

Querying the pyramid for both signals yields, per bucket,
`(x_min, x_max, x_first, x_last)` and `(y_min, y_max, y_first, y_last)` on a
shared index set. That is a 2D trajectory envelope, and it delivers for free:

- the exact shared timebase `pairSamples` needs, with no `lerpSample`
- 2D extrema preservation — the thing ADR 0037 called deferred
- out-of-core behaviour, already solved
- binary columnar transport, already built

**This needs attacking before anything is built on it.** Open sub-questions:
cross-source pairing still needs interpolation (mc1000 pairs channels within
one run, which is the designed-for case, but sources with different time bases
are not); `has_gap` semantics for a 2D envelope are undefined; and whether a
bucket draws as a box, a segment, or a hull is an unmade visual decision.

### 3. The shape is two pipelines, not one

FFT needs uniform resampling and histogram needs unbiased sampling; neither
can consume a min/max envelope (ADR 0037). Both are cheap — bounded input,
small output. So the target is **two pipelines split by reduction semantics**:

- **envelope-backed** — time and XY, on the pyramid
- **sample-backed** — FFT and histogram, on `query_samples`

rather than one finished pipeline and three modes improvising on raw samples.
Renderer unification largely falls out of that split rather than driving it.

## Why XY is unusably slow on mc1000 (2026-08-06)

Reported symptom: an XY panel plotting `response @*` against `command` over
the 1000-run Monte Carlo corpus (1000 files × 5 channels × 10,001 samples) is
unbearably slow. Root cause traced, not yet measured.

`renderData`'s dirty guard (`ui/panel.ts:955-965`) short-circuits only when
**nothing** changed, `window` included. Every pan and zoom changes the window,
so the entire pipeline re-runs even though only the viewport moved. Per frame,
for ~1000 traces over ~2001 signal ids:

- `resolveXSeries` (`ui/panel.ts:450`) does a linear `samples.series.find()`
  with two callbacks per candidate, once per trace — O(series × signals),
  roughly 4M callback invocations.
- `pairSamples` (`app/xy.ts:60`) copies three arrays of ~8192 elements per
  trace, or runs a binary-search `lerpSample` per point when timebases differ.
- `flattenTrace` runs **twice** per trace — the dimmed full trajectory and the
  lit windowed one — allocating ~2000 fresh arrays and ~32M `push` calls.
- The renderer then strokes ~2000 paths.

The structural observation that makes this cheap to fix, independent of the
larger rework: **`pairSamples` output depends only on the samples response and
the series set, never on the window**, and so does the dimmed trajectory
(`flattenTrace(trace, null)`). Only the lit windowed path varies per frame.
Caching the pairing stage on `SampleResponse` identity, and replacing
`resolveXSeries`'s `.find()` with a Map built once per response, removes both
the O(n²) term and most per-frame allocation without touching the renderer.

Note the sample budget is **not** implicated: `panelSignalIds` expands a
1000-series XY panel to ~2001-3001 ids, so `sampleCapForPanel` divides the
500k budget down to ~249 and floors it back to `SAMPLE_CAP` (8192) — exactly
the pre-2026-08-05 value. The 32768 cap only applies to panels under ~60 ids.

## Bench coverage gap

`examples/bench/mc1000.workspace.json` contains **only time panels**. No XY,
FFT, or histogram panel is benchmarked anywhere, which is why the above never
appeared in CI. Any spec should add sample-mode panels to the bench workspace
and sweep series count (1, 10, 100, 1000) before and after, or the next
regression hides the same way.

## What exists today

`CanvasRenderer` has two entry points, and the split is by **data model**, not
plot type:

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
  accumulate `first/min/max/last`, lift the pen on a gap flag. That is M4, and
  it is the same shape as uPlot's `drawAcc()`.
- **The pyramid is the right mechanism.** uPlot decimates the full array
  client-side, which caps it at a few million points in memory. The pyramid is
  the same aggregation precomputed server-side so it survives out-of-core data
  (ADR 0029). Do not replace it with a client-side scan — extend it to XY.
- **Style bucketing works where it is applied.** `render()` groups series by
  `color\0width` into shared `Path2D`s and strokes each group once
  (`:293-323`). The 2026-08-05 pass extended the same idea to colour-mapped
  paths (bucket by ramp step, at most 65 strokes).

## Open questions the spec must answer

Ordered by how much they constrain everything else.

1. **Does the pyramid-backed XY envelope hold up?** See correction 2. This is
   now the first question, and it subsumes what the first draft listed second.
   If it holds, XY joins the time pipeline and most of the rest follows. If it
   does not, the spec needs to say why.

2. **Density policy above ~138 series.** `TILE_BIN_BUDGET = 250_000` split
   across series with a 64-bin floor (`ui/app-shell.ts:102`,
   `shell/src-tauri/src/lib.rs:877`) starves resolution below one bin per pixel
   once a panel carries more than roughly `250_000 / 1800` series. Either the
   budget scales and wire cost grows, or the panel switches to a density or
   aggregate raster past a threshold. Note that
   `docs/superpowers/plans/2026-08-04-plotting-performance-overhaul.md` already
   deferred "xy-style density/aggregate textures for 1000-series spaghetti
   panels" once — this is the second deferral of the same item, and a
   pyramid-backed XY panel would hit it immediately at mc1000 scale.

3. **Device pixels vs CSS pixels.** `appendSeriesPath` snaps columns to CSS
   pixels while the canvas backing store is `devicePixelRatio` times larger
   (`render/surface.ts:19-37`). On a 2x display that discards half the
   available column resolution.

4. **Is the client-side M4 branch live at all?** `appendSeriesPath` aggregates
   only when `count > 2 * plot.width`, but the server already targets
   `2 * pixel_width` bins (`core/scope-core/src/pyramid.rs:455`) and
   `plot.width` is smaller than `pixel_width` by the axis gutters. Nobody has
   measured how often that branch fires. If it is effectively dead, all real
   aggregation happens server-side and the client path is vestigial.
   **Measure this first.**

5. **The unified primitive.** Comparatively mechanical once 1–4 are settled,
   and largely a consequence of the two-pipeline split rather than a goal in
   itself. The sketch that motivated this brief: one `VertexBatch` (interleaved
   `Float32Array` in plot-pixel space, `Uint32Array` pen-lift indices, a
   resolved style, an optional ramp-bucket index), two producers
   (`binsToVertices` from today's M4 loop, `pointsToVertices` from today's
   `drawPath`), and one consumer that buckets by style and issues one
   `stroke()` per bucket.

## Unverified — check before building on it

- **The staircase diagnosis.** The 2026-08-05 pass attributed visible "steps"
  in time traces to `TileWindowCache.padWindow` widening a request 2x–4x while
  the request kept the unmodified panel `pixel_width`, so the sliced visible
  response carried 0.5–1 bin per CSS pixel. The fix
  (`TileWindowCache.requestPixelWidth`) is arithmetically sound and its tests
  pass, but **nobody has confirmed the staircase is gone on a real trace.**
- **The mc1000 XY cost breakdown above** is derived from reading the code, not
  from a profile. Measure before optimising.

## Constraints the design inherits

- Pyramid invariants are law: parent bins preserve first/last/finite min-max/
  count/gap-OR; `has_gap` breaks a stroke and never discards extrema; query
  density is bounded by viewport width; the renderer never scans raw arrays for
  ordinary pan/zoom.
- The renderer stays deterministic from tiles + viewport + tokens, so snapshot
  and workbench output stay pixel-aligned. `TauriPlane` and `BakedPlane`
  implement the same contract; UI code never branches on host identity.
- Snapshots stay self-contained and offline, within the export budget. No new
  runtime dependencies in the snapshot frontend.
- An architectural change needs a new or amended ADR. A pyramid-backed XY
  panel would amend ADR 0037, whose "deferred, requires a 2D panel-level
  reduction" framing correction 2 supersedes.

## Non-goals

Keep the four plot modes. Do not revive the client-side full-array scan. Do not
reopen per-signal min/max reduction on `query_samples` (ADR 0037) — the
pyramid-backed route in correction 2 is a different mechanism and is not
covered by that rejection. WebGL2/GPU rendering, binary snapshot manifests, and
an HTTP/WebSocket data plane were deferred by the 2026-08-04 performance plan
and stay deferred unless the spec argues otherwise.

## Source material

- `docs/superpowers/plans/2026-08-05-post-phase-5-fixes.md` §"Scope
  boundaries" — the deferral list this brief expands
- `docs/adr/0037-per-mode-sample-budgets.md` — why per-signal min/max on
  `query_samples` is wrong; see correction 2 for what it over-deferred
- `docs/superpowers/plans/2026-08-04-plotting-performance-overhaul.md` — the
  prior perf pass; its root-cause list and deferrals still apply
- `docs/adr/0036-binary-tile-transport-and-render-path.md`,
  `docs/adr/0029-out-of-core-storage.md`
- `core/scope-core/src/ingest/csv.rs` `finish()` — the shared `Arc<[f64]>`
  time array that correction 2 depends on
- `refs/uPlot` — reference checkout; see its `src/paths/linear.js` for the M4
  path builder this codebase's `appendSeriesPath` parallels

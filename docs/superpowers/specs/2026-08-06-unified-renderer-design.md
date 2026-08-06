# Unified plotting pipeline — design

Status: approved design, pre-implementation. Supersedes the framing of
`docs/issues/unified-renderer-brief.md` and resolves its open questions.
Implementation is phased into separate plans (§Phasing); this document is the
contract they share.

## Problem

SignalScope's four plot modes each hand-roll their own path through the data
plane and renderer. Time mode has a complete pipeline (server-side M4 pyramid,
binary columnar transport, window cache, path cache); XY, FFT, and histogram
improvise on raw JSON samples with no caching and per-frame recomputation.
Consequences, all verified against code during the 2026-08-06 research pass:

- **The comb artifact** (screenshot, 2026-08-04): a 1000-series ghost panel
  renders as vertical teeth at 9 px pitch. Root-caused and measured to the
  pixel: `TILE_BIN_BUDGET = 250_000` divides to 250 bins/series, pyramid
  level quantization lands on 157 bins over a 1415 px plot = 9.01 px/bin
  predicted, 9 px measured. Every series shares one time array, so all 1000
  envelopes place teeth at identical x. Not a renderer bug — density
  starvation. The 2026-08-05 `requestPixelWidth` fix cannot reach it because
  the budget clamp discards the density correction above ~41 series.
- **XY at mc1000 scale is unusable**: `resolveXSeries` is
  O(series × signals × derived), pairing and the dimmed trajectory rebuild
  per frame despite being window-independent, the context request re-fetches
  an identical response every pan (its cache key includes the visible
  window), and the per-series cap collapses to ~124 points.
- **A fifth plot mode today touches ~9 scattered sites** across the schema,
  `app-shell.ts`, and 2,900-line `panel.ts`, and inherits none of time
  mode's performance machinery.
- **Style batching never runs where it matters**: `canBatch` requires
  `alpha === 1`; ghosts get 0.5, so the 1000-ghost panel strokes 1000
  separate `Path2D`s.
- **Device-pixel resolution is discarded two-sidedly**: both the requested
  `pixel_width` and the M4 column snap are CSS-based, so a 2× display gets
  half the available columns. Fixing either side alone changes nothing.

## Research basis

Three reference checkouts were dug end-to-end (`refs/uPlot`, `refs/ChartGPU`,
`refs/xy`) alongside a code-verified map of our own pipeline. Findings that
shaped this design:

- **All three references converge on a tiered LOD ladder that switches
  representation by density** — direct geometry at low density, decimated
  envelope in the middle, density/aggregate raster at high density.
  SignalScope has only the middle rung; when the budget binds we degrade
  resolution instead of switching representation, which is exactly the comb.
- **uPlot** (`refs/uPlot/src/paths/linear.js`): the anti-combing property of
  its `drawAcc` column primitive is the first/last continuity — each pixel
  column is a detour on one continuous polyline, entered at `first` and
  exited at `last`. Our `emitColumn` already has this shape; it was being
  fed 9 px columns. uPlot aggregates in device pixels with a half-pixel
  translate for odd stroke widths, switches to direct drawing below
  4 samples/device-pixel (a threshold placed where the two representations
  look identical, so the switch is invisible), treats gaps as clip regions,
  and keeps hover entirely off-canvas.
- **xy** (`refs/xy`, reflex-dev/xy): flat ~0.08 s from 10k to 100M points
  via the ladder above. Uniform-only pan/zoom; power-of-two-aligned padded
  windows so consecutive pans dedupe to one cache key (we already do this);
  log-u8 density encoding with the physically-correct compositing law
  `alpha = 1 − (1−a_pt)^k`. Critically, **xy has no trajectory rendering at
  all** — it argsorts x at ingest and bars scatter from decimation as
  misleading. Its gap handling (row-dropping) is behind ours.
- **ChartGPU** (`refs/ChartGPU`): GPU-resident 1024-point tile pyramid
  (min/max/argmin-idx/argmax-idx/sum/count — an M4 tile plus indices and a
  mean) maintained incrementally; decimation recomputed honestly per frame;
  the argmin/argmax _sample indices_ in its tile struct are the pattern our
  XY extension adopts. Its best ideas (bounded-work picking, content-vs-
  position label invalidation, packed-x-origin affine) are backend-
  independent.
- **Nobody solves non-monotonic (trajectory) decimation.** All three assume
  orderable x. The pyramid-index route in §XY is our own design, enabled by
  a verified premise: signals from one source share a single time array
  (`Arc<[f64]>`) across **all** ingest paths — CSV (`ingest/csv.rs`
  `finish()`), MCAP (per topic), HDF5/Parquet (per memoized timebase key) —
  so pyramid buckets align by index across a pair.
- **Brief claim #4 refuted**: the client-side M4 branch in
  `appendSeriesPath` is live, but inverted — it does real work on
  low-cardinality panels (where the pyramid over-delivers into the
  `(target/2, target]` range) and is dead on exactly the high-cardinality
  panels where per-frame cost matters.

## Decisions (locked)

1. **Canvas2D stays the renderer for this spec.** The contract boundaries
   are GPU-shaped (resident geometry + index windows + bucket counts, not
   screen commands) so a WebGL2/WebGPU backend can later replace the render
   stage alone. The 2026-08-04 GPU deferral stands.
2. **Density raster tier** above a derived bins-per-device-pixel threshold,
   replacing per-series strokes with an aggregate coverage field. This
   resolves the twice-deferred "density/aggregate textures" item and is the
   fix for the comb.
3. **XY gets both**: the verified caching fixes now, and the pyramid-backed
   pipeline with first/last bucket pairs as the baseline representation.
   The extremum-sample-index bin extension is designed here, built later.
4. **One spec, phased implementation plans** (§Phasing). Each phase lands
   independently behind the silhouette and bench gates.

## Architecture: the unified mode pipeline

Every plot mode is one module implementing a four-stage contract. The rule
that carries the whole design: **a mode declares what it needs and how to
shape it; the shell and renderer own when anything runs, all caching, and
all drawing.** Modes cannot touch request plumbing, cache keys, style
batching, or the canvas — so a naively-written mode cannot reintroduce the
per-frame failure classes this spec removes.

### Stage 1 — Acquire (shell-owned, declarative)

A mode declares:

- **Reduction semantics**: `envelope` (pyramid-backed — time, XY) or
  `samples` (stride-backed — FFT, histogram). This is the brief's
  two-pipeline split expressed as a mode property instead of the
  `panel.mode === "time"` branch in `refreshTilesPass`.
- **Window shapes**: any of `visible`, `padded`, `context` (full data
  extent). The shell owns padding, power-of-two alignment, budgets,
  device-pixel density, dedup, and cache keys. A request declared
  window-independent (`context`) is keyed without the window — the XY
  context re-fetch bug becomes structurally impossible rather than patched.

Budgets remain per-mode (ADR 0037) and centralized here.

### Stage 2 — Prepare (mode-owned, response-scoped)

Pure function: response → mode geometry. XY pairing, FFT grid construction,
histogram pooling and sorting, time-mode pass-through. The framework caches
the result on response identity; **prepare never runs during pan/zoom by
construction.** This generalizes the brief's structural insight
(`pairSamples` is window-independent) to every mode: the histogram sort and
FFT resample stop being per-frame costs without mode-specific patches.

Sample-backed modes re-run prepare when a new sample response arrives
(sample requests are window-keyed), not per animation frame; between
fetches during a drag, geometry holds.

### Stage 3 — Project (mode-owned, frame-scoped)

Pure function: geometry + viewport → render primitives. Two primitive
kinds exist, one per pipeline: sample-backed modes emit `VertexBatch`
(interleaved plot-pixel coordinates in a `Float32Array`, pen-lift indices
in a `Uint32Array`, a resolved style, an optional ramp-bucket index);
envelope-backed modes pass their bin columns through with a style, and
stage 4's M4 path consumes them directly. This is the only per-frame mode
code, and the contract keeps it cheap: window selection by binary search,
projection, nothing else.

### Stage 4 — Render (renderer-owned, mode-blind)

One consumer, two representations selected by the density policy (§Density):

- **Stroked**: style-bucketed `Path2D`s, one stroke per bucket. The bucket
  key is `color\0width\0alpha\0dash`, so uniform-alpha ghosts batch — the
  current `alpha === 1` restriction goes away. Envelope columns keep the
  existing `emitColumn` first→min→max→last continuity; the client-side
  aggregation branch keeps its role (merging when the pyramid over-delivers)
  with its threshold moved to device pixels and uPlot's 4× margin.
- **Density raster**: §Density.

Axes, gutter, layout, and hit-testing stay in the shared `beginFrame` /
`PreparedPlot` machinery. ADR 0019 already mandates this shape for
inspection; this spec extends it to geometry. The renderer never sees mode
names.

### What a fifth mode costs

One module — `declare` + `prepare` + `project` + the existing `PreparedPlot`
interaction policy — plus a `PanelMode` schema variant and its chrome
(mode button, empty state). It inherits caching, request dedup, batching,
the density tier, device-pixel correctness, and determinism. No renderer
changes, no `app-shell.ts` branches. `panel.ts`'s per-mode `renderXxx`
bodies dissolve into the mode modules.

### The GPU seam

The stage 3→4 boundary is "geometry + index window + bucket count." A
future GPU backend replaces stage 4 only: `VertexBatch` maps onto
ChartGPU's storage-buffer + instance-index line technique, and the density
raster maps onto xy's density texture. Nothing upstream changes.

## Density policy and the raster tier

**Policy variable: bins per device pixel, not series count.** Per refresh,
the panel computes its per-series allocation `max(64, budget / N)` against
`2 × device_width`. At ≥ ~1 bin per 2 device pixels, series stroke
individually. Below that — the budget-bound regime — the panel switches to
the raster. The threshold is derived from panel width, so it is not a magic
constant; hysteresis comes free because the inputs change stepwise (series
membership, resize), never per-frame.

**Mechanism (pure Canvas2D, snapshot-safe):**

1. Accumulate every series' envelope into a `Float32Array` coverage grid
   over the plot rect in device pixels. Rasterize the **connected**
   envelope — trapezoids spanning consecutive bins' `[min,max]` with
   first/last continuity — never isolated columns, so coarse bins produce a
   smooth band, not teeth. `has_gap` interrupts accumulation exactly as it
   lifts the pen.
2. Map coverage → pixels with the physically-correct compositing law
   `alpha = 1 − (1−a_pt)^k` (k = accumulated coverage), log-scaled, through
   a fixed theme-derived ramp into one `ImageData`; one `putImageData`.
3. Focused, hovered, and emphasized series stroke on top as ordinary
   `VertexBatch`es. The crowd becomes a field; the signals being inspected
   stay lines. Hit-testing continues to use per-series data, not the
   raster.

Wire cost stays capped at the existing budget: the raster consumes the same
starved-but-connected envelope tiles, and degradation becomes smooth blur.
The bench gains an explicit threshold-crossing test (no representation
flash).

## Pyramid-backed XY

### Baseline (this spec)

For a trace pair whose signals share a time array — the verified common
case — the shell queries **both** signals' pyramids at the same level
(guaranteed identical by shared sample count and the level-selection
arithmetic) and the XY module draws the trajectory through each bucket's
`(x_first, y_first) → (x_last, y_last)` in index order.

- Correspondence is exact: first/last are the same sample index in both
  signals. Min/max are _not_ used as pairs — marginal extrema give only a
  bounding box, which draws area the trajectory never visited.
- No bin-layout change, binary columnar transport for free, out-of-core
  for free.
- Gap rule: `has_gap` on either signal lifts the pen.
- Level selection targets a per-pair bucket budget analogous to time mode.
- The dimmed full-extent trajectory is a coarse-level `context` query —
  window-independent, fetched once.
- Intra-bucket excursions are bounded by one bucket's span and shrink as
  you zoom (finer levels). Whether that fidelity suffices is measured on
  the mc1000 bench before the extension below is scheduled.

Cross-source pairs (distinct time arrays) stay sample-backed with the
interpolating path, now cheap because pairing lives in cached prepare.

### Extension (designed now, built when fidelity demands)

Extend the bin layout with argmin/argmax **sample indices** (u32, the
ChartGPU tile pattern). At query time the server gathers companion values
at those indices and ships ≤6 representative `(x, y)` points per bucket in
index order, restoring intra-bucket excursions with exact correspondence.
Costs: cache-format version bump, bounded out-of-core random access
(≤6 lookups × ~2·pixel_width buckets per query). The same ADR amendment
covers baseline and extension.

### FFT and histogram

Stay sample-backed per ADR 0037 — stride sampling is what their semantics
require. They gain the prepare/project split: FFT recomputes per response,
not per frame; histogram sorts the pooled response once in prepare, and
project selects the visible range by binary search and re-bins.

## Device-pixel correctness

Fixed on both sides simultaneously (one-sided fixes are verified no-ops):

- Requests carry `pixel_width = round(clientWidth × devicePixelRatio)`.
- The M4 snap aligns columns to device pixels, with the half-pixel
  translate for odd device-pixel stroke widths (uPlot's crispness trick).
- The client-side aggregation threshold compares against device-pixel
  plot width with a 4× margin, making the aggregated/direct crossover
  invisible.

On a 2× display this doubles requested bins; the budget cap and density
policy absorb it. DPR changes (monitor moves, browser zoom) re-derive
everything through the existing resize path.

## Verified quick wins (phase 1, independent of the rework)

Measured before/after; several may move the mc1000 XY symptom on their own
(the cap collapse to ~124 pts/series already changed the baseline —
re-measure first):

- `resolveXSeries`: per-response `Map` + derived-path `Set`, killing the
  O(series × signals × derived) scan.
- XY context request keyed without the visible window.
- `pairSamples` + dimmed-trajectory cache on response identity (interim
  until pyramid XY).
- Ghost batching: style-bucket key gains alpha/dash.
- `prepareTimePlot`'s eager per-frame y-extent scan made lazy (the sticky
  y-policy latches once).
- Dirty guard: version counter instead of per-frame `JSON.stringify`.
- Bench coverage: add XY, FFT, and histogram panels to
  `examples/bench/mc1000.workspace.json`; sweep series count 1/10/100/1000.

## Determinism, testing, error handling

- Every stage is a pure function of response + viewport + tokens; the
  raster uses a fixed ramp and no ambient state. Snapshot and workbench
  output stay pixel-aligned; `TauriPlane`/`BakedPlane` stay behind one
  contract with no host branching.
- **Silhouette rule** (2026-08-04 plan) governs the migration: moving the
  four modes onto the contract must produce identical stroke silhouettes,
  enforced with column-checksum tests against the pre-migration renderer.
- Bench floors stay (tile refresh p95 ≤ 20 ms, frame p95 ≤ 33 ms, stall
  ≤ 250 ms) and extend to sample-mode panels; a density-threshold crossing
  test guards against representation flash.
- Pyramid invariants are law: parents preserve first/last/finite
  min-max/counts/gap-OR; `has_gap` never discards extrema; query density
  bounded by viewport width; no raw-array scans for ordinary pan/zoom.
- Malformed/partial responses: stages are response-scoped, so a failed
  fetch leaves the previous prepared geometry rendering; the existing
  missing-data chrome is unchanged.
- Rust: paired-query tests assert level/bucket alignment across a shared
  timebase, plus the `max_bins == 0` guard divergence noted in the research
  (TS clamps to 1, Rust does not) is fixed while in the area.

## ADR impact

- **New ADR**: unified mode pipeline + density raster tier (amends the
  rendering story of ADR 0036; the deferral list of the 2026-08-04 plan is
  partially discharged).
- **Amend ADR 0037**: pyramid-backed XY (baseline + extension). Its
  rejection of per-signal min/max on `query_samples` stands; the pyramid
  route is a different mechanism, and its "requires a 2D panel-level
  reduction" deferral is superseded by the shared-bucket-index design.
- **ADR 0019** extended (prepared-plot contract gains the geometry
  stages), not replaced. **ADR 0028** (bands removed) untouched — the
  density raster is not a band primitive. **ADR 0017** is stale (FFT cap
  4096 vs actual 16384) — amend opportunistically.

## Phasing

1. **Quick wins + DPR + bench coverage.** Fast user-visible relief and
   honest baselines for everything after.
2. **Unified mode pipeline.** Migrate all four modes onto the contract.
   Zero visual change, silhouette-tested. `panel.ts` shrinks to panel
   chrome.
3. **Density raster tier.** Fixes the comb. Lands inside the new
   architecture as a stage-4 representation.
4. **Pyramid XY baseline.** First/last pairs, ADR 0037 amendment,
   cross-source stays sampled.
5. **(Deferred until measured)** Extremum-index bin extension.

Each phase is a separate implementation plan and PR train, gated on the
affected scripts plus the broader CI gate.

## Non-goals

The four plot modes stay. No client-side full-array scans. No revival of
per-signal min/max on `query_samples`. No WebGL2/WebGPU backend, binary
snapshot manifests, or HTTP/WebSocket data plane in this spec — the GPU
seam is shaped, not filled. No band/ribbon primitive (ADR 0028).

## Source material

- `docs/issues/unified-renderer-brief.md` — the brief this design resolves
- 2026-08-06 research reports: uPlot, ChartGPU, xy digs and the
  SignalScope pipeline verification (comb artifact measured at 9 px pitch
  vs 9.01 px predicted)
- `docs/adr/0019`, `0025`, `0028`, `0029`, `0036`, `0037`
- `docs/superpowers/plans/2026-08-04-plotting-performance-overhaul.md`,
  `2026-08-05-post-phase-5-fixes.md`

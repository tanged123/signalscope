# Post-Phase 5 issue backlog

Observed after the Phase 5 merge (PR #18). Symptoms from live use; code
pointers from a first-pass investigation, not a completed diagnosis.

## 1. XY plots are slow, `c:` plots especially

`drawColorMappedPath` (`frontend/src/render/canvas-renderer.ts`) strokes one
segment per vertex pair — a `beginPath`/`moveTo`/`lineTo`/`stroke` and a ramp
interpolation per segment, thousands of canvas calls per frame. Plain XY paths
also project every vertex through per-point closure calls. Candidate fixes:
bucket segments by quantized ramp color and stroke each bucket once; reuse
`Float32Array` vertex buffers; consider `Path2D` reuse.

## 2. XY panels need `axis equal`

No aspect-ratio control exists in the renderer or panel state; XY x/y ranges
resolve independently. Add a MATLAB-style `axis equal` toggle (persisted per
panel) that pads the wider range so a unit is the same length on both axes,
maintained through zoom/pan/fit.

## 3. Panel-mode switches refetch everything

Time panels have `tileWindowCache`, but sample-mode panels (xy/fft/histogram)
have no cache: every `refreshTilesPass` re-issues `querySamples` for each
non-time panel, and XY issues two (context + detail). A mode transition calls
`afterLayoutChange`, so tabbing through plot types re-queries and re-prepares
on every switch. Add a sample cache keyed like the tile cache (ids, window,
cap) or retain per-panel responses across mode cycles.

## 4. Ctrl+N leaves ingest errors on screen

`newWorkspace()` (`frontend/src/ui/app-shell.ts`) resets the session, caches,
and selection but never touches `.ingest-progress`. `ingestPaths` deliberately
keeps that element visible when `recent_failures` is non-empty, and nothing
else ever hides it. New-workspace should clear the ingest progress/failure UI
along with everything else.

## 5. Red loading errors never expire

Same surface as issue 4: the failure banner has no dismiss affordance and no
auto-expiry; it persists until the next successful ingest hides it. Give it an
explicit dismiss control, and clear it on workspace reset/load.

## 6. Ctrl+N resets settings and theme

Theme lives in the session (ADR 0022), so a fresh session reverts it.
ADR 0023 already records migrating theme to the global preferences file as an
open follow-up — this is the forcing use case. Audit new-workspace for other
user-scoped state that should survive (appearance already in preferences is
fine; anything session-held that reads as "settings" should move or be carried
over).

## 7. CSV batch ingest headroom (26k files ≈ minutes)

`BatchOptions::worker_count` defaults to 4 (`core/scope-core/src/ingest/batch.rs`)
regardless of core count, and admission walks files serially before workers
start. Candidates: scale workers to available parallelism under the memory
budget, batch tiny files per work item to amortize per-file overhead, and
profile the CSV float-parse path (`ingest/csv.rs`).

## 8. Visible decimation on very large signals (~50M+ points)

Sample-mode panels cap requests at `SAMPLE_CAP = 8192`
(`frontend/src/ui/app-shell.ts`), and `sample_window`
(`core/scope-core/src/compute.rs`) decimates by plain integer stride — every
Nth sample, no min/max or peak preservation. At 50M points in the window the
stride is ~6k, so XY/FFT/histogram views alias and drop extrema. Time panels
are unaffected (tile pyramid). Options: raise the cap for XY, or replace
stride picking with an extrema-preserving reduction (e.g. min/max pairs or
LTTB) for sample queries.

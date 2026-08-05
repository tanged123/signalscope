# Post-Phase 5 issue backlog

The Phase 5 follow-up symptoms below are now closed or explicitly deferred.

## 1. XY plots are slow, `c:` plots especially — landed

Color-mapped paths now quantise segments into ramp buckets and stroke each
bucket once per frame. Plain XY projection is also inlined in the hot loop.
The ramp-bucket fix landed; vertex-buffer reuse and a shared renderer
primitive are not part of this pass.

## 2. XY panels need `axis equal` — landed

XY panels now persist an `axis_equal` toggle in session schema v21. The
renderer widens the finer axis until both axes use the same pixel scale, and
publishes those ranges to layout and interaction state.

## 3. Panel-mode switches refetch everything — landed

Sample-mode responses now have a one-entry-per-panel cache keyed by signal
ids, mode, window, and cap. Switching modes can reuse the response for the
same request, while signal reloads invalidate the cache.

## 4. Ctrl+N leaves ingest errors on screen — landed

Resetting or loading a workspace now clears the ingest progress and failure
surface along with the rest of the workspace state.

## 5. Red loading errors never expire — landed

Failed batches now show an explicit dismiss control. Dismissing it clears the
failure surface without changing the recorded batch result.

## 6. Ctrl+N resets settings and theme — landed

Theme moved to preferences schema v4 and is authoritative for the running
application. New or loaded workspaces inherit it, and theme changes persist
through both the global preference and the session copy needed by snapshots.

## 7. CSV batch ingest headroom (26k files ≈ minutes) — partially landed

Production already supplies `available_parallelism()`; the `4` default is
test-only and was never the production bottleneck. Batch admission now
canonicalizes paths in parallel off the registry lock, then admits them in
input order so failure indices and prefixes remain deterministic.

The characterization test passed before the change. The 1,000-file benchmark
reported 574.6 runs/s before and 345.9 runs/s after, so this run showed no
measurable improvement. The CSV parse candidate is recorded separately below.

## 8. Visible decimation on very large signals (~50M+ points) — partially landed

XY, FFT, and histogram sample requests now use a 32768-point cap under a 500k
per-panel series budget. The FFT transform cap is 16384. Plain stride
reduction remains in place: per-signal min/max is wrong because it destroys
the shared XY timebase and also biases histograms and violates FFT uniform
sampling. A trajectory-preserving 2D reduction over one shared index set is
the correct fix and is deferred to the renderer architecture spec.

## 9. CSV float-parse path — measured, no optimization

The report-only benchmark measured CSV decoding at 123.588 MB/s. That is
below the rough 200 MB/s threshold, so this measurement does not rule parsing
out as a contributor, but it does not establish it as the batch bottleneck
either. No hand-rolled parser or dependency was added on that evidence.

## 10. Tile-density staircase across the padded cache window — landed

Padded tile requests now scale `pixel_width` by the padding ratio before the
visible slice is taken, preserving the requested density instead of leaving
roughly half to one bin per CSS pixel.

## Deferred renderer architecture work

The following remain outside this pass:

- Unifying `render()` and `renderPaths()` behind one `VertexBatch` primitive.
- 2D trajectory-preserving reduction for XY over a shared index set.
- Device-pixel rather than CSS-pixel column snapping in `appendSeriesPath`.
- Density/aggregate raster rendering for panels with more than 138 series.
- Welch or core-side FFT decimation.

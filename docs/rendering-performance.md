# Rendering performance

The relevant workload is the number and geometry of retained rows and rendered
segments, in addition to source point count. A 60-million-point import is not
necessarily a 60-million-vertex draw. Compare time X, monotonic signal X,
non-monotonic signal X, and each with C enabled at equal viewport size, device
pixel ratio, series count and retained row count.

## Implemented improvements

- Line2D automatic ranges reuse finite paired extents across preparations.
  One weak entry per immutable Y column stores the current X/anchor identities,
  source-time window and four extrema. Input changes recompute it. This removes
  repeated full-row scans when panning, zooming or changing focus; it does not
  cache extra sample arrays or combinations of viewports.
- ChartHost applies domains and interaction layout immediately, and lets the
  shared frame driver draw once per animation frame. Separate X/Y updates in
  the same gesture no longer submit separate immediate frames. Capture still
  flushes explicitly.
- The ChartGPU fork uses four vertices per standard line-segment instance,
  forming the same two triangles previously emitted with six vertices.
  Segment count, source correspondence, shader interpolation, stroke width,
  antialiasing, gaps, dashes and buffer sizes are unchanged. This reduces vertex
  invocations by one third; it is not a claim of one-third faster frames.
- C-colored background traces obey the existing Dim/density policy. Focused
  traces draw above the background; hovered traces draw last with restored
  opacity. C values and scale limits remain intact.

## Measurements and reproduction

```sh
./scripts/test.sh bench line2d
./scripts/test.sh e2e line-strip.spec.ts --workers=1
./scripts/test.sh bench line-gpu
```

On 2026-09-06, the synthetic CPU benchmark of 1,000 non-monotonic lines with
6,000 retained rows each measured a mean repeated preparation/range calculation
of **45.3 ms before** extent caching and **0.013 ms after**. These are warm
immutable-data refreshes in Vitest, not first preparation, transport latency,
cursor picking, or end-to-end application frames. Different source-time
windows sharing a Y column replace its entry rather than growing a cache.

The GPU fixture compares the four-vertex shader with the previous six-vertex
corner mapping on identical buffers. Its 24 readback comparisons cover solid,
dashed and dotted lines, categorical and per-point colors, missing X/Y/C,
repeated coordinates, two view transforms, and 1x/4x MSAA. All pixels must
match exactly, and a nonempty-image assertion prevents blank renders passing.

`bench line-gpu` writes `build/bench/report/line_strip.json`. It alternates
reference/candidate order, excludes warmup, and measures median submit-through-
GPU-completion latency for 99,999 non-monotonic segments. It records the adapter
and tests plain/colored strokes with 1x/4x MSAA. This isolates stroke drawing;
it does not measure 1,000-series application overhead. The default Playwright
configuration uses SwiftShader, so hardware performance still needs measurement
on the machine used for manual testing. No timing threshold is inferred from
software-renderer results.

The initial SwiftShader run was dominated by overlapping long segments:

| MSAA | Color | Six vertices | Four vertices |
| ---- | ----- | -----------: | ------------: |
| 1x   | Plain |     929.2 ms |      921.6 ms |
| 1x   | C     |     937.5 ms |      922.4 ms |
| 4x   | Plain |     889.9 ms |      889.5 ms |
| 4x   | C     |     898.3 ms |      892.1 ms |

These small differences do not establish a material frame-time improvement in
that fill-heavy workload. The verified improvement is fewer vertex invocations
for identical output, with no extra GPU memory. Hardware and shorter-segment
workloads remain unmeasured.

## Remaining costs

- Time envelopes use prebuilt pyramids. Paired X/Y/C requests validate shared
  timebases and build a paired pyramid for the padded source-time window on
  demand. Source-matched groups are queried sequentially. Selecting or changing
  a bundle can therefore cost far more than a viewport-only draw.
- Arbitrary-X cursor and line picking currently scan retained paired rows.
  Time-envelope picking uses a binary-searched neighborhood. A future bounded
  spatial index must retain source-row identity, crossing segments and gaps;
  sorting X or independently reducing coordinates is not valid.
- Both SignalScope adapters publish `sampling: none`. ChartGPU's general
  sorted-X decimation path is not a direct explanation for differences in
  these draws. Arbitrary trajectories can traverse the viewport repeatedly,
  causing much more overdraw than time traces with equal row counts.
- C requires aligned attributes and currently stays on the full standard stroke
  path. The fork's optional dense hairline/stride path is disabled for C to
  preserve geometry/attribute alignment. Adding C also adds reduction work,
  RGBA preparation and storage. It is more than a colorbar cost.
- Style/focus changes still use `setOption`; changes in draw order can change
  the renderer's index-based resource assignment. Measure uploads and option
  resolution before designing stable resource identities or batched draws.

Keep the existing physical-pixel density planner, global CPU/GPU estimates,
overview/detail retention, stale covering data and atomic replacement. None of
these improvements raises memory limits, adds a fixed series cap, skips source
rows, or changes reduction semantics. Large-window peak memory, obsolete native
work and hardware frame timing remain open measurements in the roadmap.

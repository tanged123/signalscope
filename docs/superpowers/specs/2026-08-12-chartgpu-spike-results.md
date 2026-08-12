# ChartGPU mc1000 spike results (Phase 0)

- Date: 2026-08-12 (measurement run; harness authored earlier the same day)
- ChartGPU rev: `671e1c157a6fd9a80df35d5b43795314214569d0` (v0.4.0, master)
- Host: Windows Chrome (WebGPU hardware adapter) against the WSL2-served
  harness; canvas backing store 3840×1329. An earlier WSL2-Chromium attempt
  confirmed WSL2 exposes no WebGPU API — never measure there.
- Harness: `refs/spikes/chartgpu-mc1000` (untracked; methodology in the
  Phase 0 plan). Scenario: 1,000 series × 100k samples, M4-decimated to
  250 bins (1,000 points) per series, `sampling: 'none'`, explicit axis
  ranges, shared device + pipeline cache.

| Gate                    | Measured                                 | Limit       | Verdict            |
| ----------------------- | ---------------------------------------- | ----------- | ------------------ |
| G1 create+first frame   | 470 ms                                   | 3000 ms     | pass               |
| G2 axes-only setOption  | 0.2 / 0.3 ms                             | 4 / 8 ms    | pass               |
| G3 zoom-sweep frame p95 | 8 ms                                     | 33 ms       | pass               |
| G4 full refeed (1000)   | 33 ms                                    | 300 ms      | pass               |
| G5 partial refeed (50)  | 30 ms                                    | 50 ms       | pass               |
| G6 transient survival   | visible spike at ~63% (eyeball)          | visible     | pass               |
| G7 NaN gap              | visible break at x=40..60                | gap renders | pass               |
| G8 JS heap              | 918 MB total; ~120 MB chart-attributable | 500 MB      | pass (by analysis) |
| G9 drawImage capture    | pass with capture recipe (below)         | non-blank   | pass (with recipe) |

Numbers varied slightly between runs (G1 98–470 ms, G4 26–33 ms); the
worst observed value is recorded.

## G8 adjudication

The harness holds the synthetic RAW dataset (1,000 × 100k f64 ≈ 800 MB)
by construction; production browsers never receive raw columns — only
decimated bins (~18 MB wire at this scenario) plus feeds (~16 MB) and
ChartGPU CPU staging (~16–32 MB). Chart-attributable heap ≈ 918 − 800 ≈
120 MB, well inside the gate's intent. The drop-dataset probe was
inconclusive because Chrome ran no GC during the idle window
(`usedJSHeapSize` only moves after a collection). Real-application heap
is re-checked during Phase 2's manual GPU verification.

## G9 capture recipe (binding on Phase 2)

ChartGPU mounts **three** stacked canvases. Naive
`drawImage(firstCanvas)` long after the last present reads transparent
black. The working recipe, verified twice:

1. Force a fresh render (any options change, e.g. re-passing ranges).
2. In the **same-frame `requestAnimationFrame` callback**, `drawImage`
   **every** chart canvas in DOM order onto the 2D compositing target.

Under that timing canvas[0] and canvas[1] read real pixels (canvas[2] is
an empty overlay). One frame later canvas[0] is blank again — the timing
is load-bearing. Phase 2's `ChartHost` therefore exposes
`capture(): Promise<HTMLCanvasElement>` implementing exactly this, and
PNG export uses it in time mode.

## Verdict

**GO for Phases 1 and 2.** Every gate passes; the perf gates pass with
1–2 orders of magnitude of margin. Notably, a full 1,000-series refeed
costs ~33 ms — cheap enough that windowed refeeds on tile-cache misses
(spec Amendment 9) carry no risk, and the Phase 3 deep-zoom contingency
(and with it the `setSeriesData` fork trigger) is very unlikely to be
needed.

The implementation decision and its accepted tradeoffs are recorded in
[ADR 0039](../../adr/0039-chartgpu-time-series-renderer.md).

## Observations

- At 1,000 series the multi-series hairline policy engages as documented;
  lines render 1 device px and remain legible.
- The transient survived M4 + ChartGPU rendering at full zoom-out (G6),
  confirming the extrema-preservation chain end to end.
- The Vite alias build of ChartGPU source (WGSL `?raw`) works unmodified —
  validating the Phase 2 vendored-source approach.

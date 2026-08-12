# ChartGPU mc1000 spike results (Phase 0)

- Date: 2026-08-12
- ChartGPU rev: `671e1c157a6fd9a80df35d5b43795314214569d0`
- Host: WSL2, Chromium 150.0.7871.128, no WebGPU API or adapter exposed
- Harness: `refs/spikes/chartgpu-mc1000` (untracked; methodology in the
  Phase 0 plan)

| Gate                    | Measured                             | Limit       | Verdict |
| ----------------------- | ------------------------------------ | ----------- | ------- |
| G1 create+first frame   | not run: `navigator.gpu` unavailable | 3000 ms     | blocked |
| G2 axes-only setOption  | not run: `navigator.gpu` unavailable | 4 / 8 ms    | blocked |
| G3 zoom-sweep frame p95 | not run: `navigator.gpu` unavailable | 33 ms       | blocked |
| G4 full refeed          | not run: `navigator.gpu` unavailable | 300 ms      | blocked |
| G5 partial refeed       | not run: `navigator.gpu` unavailable | 50 ms       | blocked |
| G6 transient survival   | not run: `navigator.gpu` unavailable | visible     | blocked |
| G7 NaN gap              | not run: `navigator.gpu` unavailable | gap renders | blocked |
| G8 JS heap              | not run: `navigator.gpu` unavailable | 500 MB      | blocked |
| G9 drawImage capture    | not run: `navigator.gpu` unavailable | non-blank   | blocked |

## Verdict

BLOCKED, not a ChartGPU GO/NO-GO. The WSL2 browser exposes no WebGPU API even
with unsafe WebGPU and SwiftShader flags, so the fixed gates cannot be
measured. Run the harness from Windows Chrome or a native-Linux WebGPU host
before starting Phase 1 or Phase 2; no production changes are authorized by
this gate.

## Observations

The Vite alias resolves the pinned ChartGPU source and the production harness
build completes. The M4 conversion produced 1,000 feeds with 1,000 points per
feed for a 1,000-series, 1,000-sample local check. A 10-series sanity check
also passes; its transient is assigned to the last available series because
the documented fixture is smaller than the mc1000 gate.

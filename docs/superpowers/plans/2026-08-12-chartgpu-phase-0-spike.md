# ChartGPU Phase 0 — Spike Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **For Codex/sandboxed workers:** if your environment cannot run `git commit` (read-only `.git`), skip every commit step and report "commit deferred to supervisor" instead. Never skip test or measurement steps.

**Goal:** Prove (or refute) with hard numbers that stock ChartGPU at a pinned master rev can render 1,000 line series of windowed, M4-decimated columns with smooth pan/zoom, cheap per-frame range updates, and acceptable refeed latency — before any production code changes.

**Architecture:** A throwaway Vite harness in the untracked `refs/spikes/` directory imports ChartGPU **from source** (Vite alias into the existing `refs/ChartGPU` checkout; its WGSL shaders are `?raw` imports Vite handles natively). The harness synthesizes an mc1000-shaped dataset, feeds it as typed-array columns, and measures the exact operations Phase 2 will perform. Results are committed as a spec-adjacent results document; the harness itself stays untracked (like all of `refs/`, which is gitignored).

**Tech Stack:** Vite 7, TypeScript, ChartGPU source at pinned rev, Chromium with WebGPU.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-chartgpu-browser-renderer-design.md` (including its Amendments section — amendments 7 and 9 govern this spike).
- No production code changes in this phase. Only `refs/spikes/**` (untracked) and one committed results doc.
- **WSL2 cannot produce a WebGPU adapter in any browser.** Run the harness server with `--host 0.0.0.0` and open it from Windows Chrome (the accepted dev loop), or run on a native Linux box. Do not conclude "ChartGPU is broken" from a WSL2 browser.
- Pass/fail gates are fixed in Task 3 below **before** measurement. If a gate fails, STOP after writing the results doc and report — do not start Phase 1/2 work or attempt ChartGPU patches.
- Use `./scripts/` wrappers for anything repo-level; plain `pnpm`/`npx` is acceptable **inside** `refs/spikes/chartgpu-mc1000/` because that directory is untracked scratch, not the repo's build system.

---

### Task 1: Pin the ChartGPU rev and scaffold the harness

**Files:**

- Create: `refs/spikes/chartgpu-mc1000/package.json`
- Create: `refs/spikes/chartgpu-mc1000/vite.config.ts`
- Create: `refs/spikes/chartgpu-mc1000/index.html`
- Create: `refs/spikes/chartgpu-mc1000/PINNED_REV.txt`

**Interfaces:**

- Consumes: the existing checkout at `refs/ChartGPU` (git remote `https://github.com/ChartGPU/ChartGPU.git`).
- Produces: a dev server where `import { ChartGPU } from "@chartgpu/chartgpu"` resolves to the pinned source; the pinned rev recorded for Phase 2's vendor script.

- [ ] **Step 1: Update the checkout to latest master and record the rev**

```bash
git -C refs/ChartGPU fetch origin
git -C refs/ChartGPU checkout --detach origin/master
git -C refs/ChartGPU rev-parse HEAD
```

Write the printed rev into `refs/spikes/chartgpu-mc1000/PINNED_REV.txt` (one line, the full 40-char SHA). As of 2026-08-12 master HEAD was `671e1c157a6fd9a80df35d5b43795314214569d0` (the v0.4.0 bump); if fetch finds nothing newer, that is the pin.

- [ ] **Step 2: Write the harness scaffold**

`refs/spikes/chartgpu-mc1000/package.json`:

```json
{
  "name": "chartgpu-mc1000-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 4199"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "vite": "7.2.4"
  }
}
```

`refs/spikes/chartgpu-mc1000/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@chartgpu/chartgpu": resolve(__dirname, "../../ChartGPU/src/index.ts"),
    },
  },
  server: { strictPort: true },
});
```

`refs/spikes/chartgpu-mc1000/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ChartGPU mc1000 spike</title>
    <style>
      body {
        margin: 0;
        background: #111;
        color: #ddd;
        font: 13px monospace;
      }
      #chart {
        width: 100vw;
        height: 70vh;
      }
      #controls {
        padding: 8px;
      }
      #results {
        padding: 8px;
        white-space: pre-wrap;
      }
      button {
        margin-right: 8px;
      }
    </style>
  </head>
  <body>
    <div id="chart"></div>
    <div id="controls">
      <button id="run-all">Run all measurements</button>
      <button id="zoom-sweep">Zoom sweep</button>
      <button id="refeed">Refeed all series</button>
      <button id="transient">Toggle transient view</button>
    </div>
    <div id="results">waiting…</div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Install and verify the alias resolves**

```bash
cd refs/spikes/chartgpu-mc1000 && pnpm install && pnpm dev
```

Expected: Vite starts on port 4199. (The page 404s on `main.ts` until Task 2 — that is fine; the check here is that Vite boots and the alias path exists.)

- [ ] **Step 4: Commit** — nothing to commit (all files are under gitignored `refs/`). Verify with `git status --short` → must show no `refs/` entries.

---

### Task 2: Dataset generator and M4 column conversion

**Files:**

- Create: `refs/spikes/chartgpu-mc1000/data.ts`

**Interfaces:**

- Produces: `makeDataset(seriesCount, samplesPerSeries): Dataset` and `m4Columns(ds, windowT0, windowT1, binsPerSeries): SeriesFeed[]` — the exact decimation shape Phase 2 will feed (first/min/max/last per bin, midpoint timestamps for extrema, in the same vertex order `plot-hit.ts` walks).

- [ ] **Step 1: Write the generator**

`refs/spikes/chartgpu-mc1000/data.ts`:

```ts
export interface Dataset {
  time: Float64Array; // shared timebase, seconds, 10 Hz
  values: Float64Array[]; // one per series
  transientSeries: number; // series index carrying the 1-sample transient
  transientIndex: number; // sample index of the transient
}

export interface SeriesFeed {
  x: Float64Array; // rebased time (t - tRef)
  y: Float64Array;
}

/** mc1000-shaped: N series x M samples @ 10 Hz, smooth walks + noise,
 *  one series gets a single-sample transient spike at 10x amplitude. */
export function makeDataset(
  seriesCount: number,
  samplesPerSeries: number,
): Dataset {
  const time = new Float64Array(samplesPerSeries);
  for (let i = 0; i < samplesPerSeries; i++) time[i] = 1_700_000_000 + i / 10;
  const values: Float64Array[] = [];
  let seed = 42;
  const rand = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let s = 0; s < seriesCount; s++) {
    const v = new Float64Array(samplesPerSeries);
    let acc = rand() * 2 - 1;
    const phase = rand() * Math.PI * 2;
    for (let i = 0; i < samplesPerSeries; i++) {
      acc += (rand() - 0.5) * 0.02;
      v[i] = acc + Math.sin(i / 500 + phase) * 0.5 + (rand() - 0.5) * 0.05;
    }
    values.push(v);
  }
  const transientSeries = 17;
  const transientIndex = Math.floor(samplesPerSeries * 0.63);
  const base = values[transientSeries][transientIndex];
  values[transientSeries][transientIndex] = base + 10;
  return { time, values, transientSeries, transientIndex };
}

/** M4 decimation into ChartGPU column feeds. Emission order per bin is
 *  first -> min -> max -> last (the order SignalScope's plot-hit walks).
 *  Extrema get the bin-midpoint timestamp. tRef = window start. */
export function m4Columns(
  ds: Dataset,
  windowT0: number,
  windowT1: number,
  binsPerSeries: number,
): SeriesFeed[] {
  const tRef = windowT0;
  const feeds: SeriesFeed[] = [];
  const lo = lowerBound(ds.time, windowT0);
  const hi = lowerBound(ds.time, windowT1);
  const span = windowT1 - windowT0;
  for (const values of ds.values) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let b = 0; b < binsPerSeries; b++) {
      const bt0 = windowT0 + (span * b) / binsPerSeries;
      const bt1 = windowT0 + (span * (b + 1)) / binsPerSeries;
      const i0 = Math.max(lo, lowerBound(ds.time, bt0));
      const i1 = Math.min(hi, lowerBound(ds.time, bt1));
      if (i1 <= i0) continue;
      let mn = Infinity,
        mx = -Infinity,
        mnI = i0,
        mxI = i0;
      for (let i = i0; i < i1; i++) {
        const v = values[i];
        if (v < mn) {
          mn = v;
          mnI = i;
        }
        if (v > mx) {
          mx = v;
          mxI = i;
        }
      }
      const mid = (bt0 + bt1) / 2 - tRef;
      xs.push(ds.time[i0] - tRef, mid, mid, ds.time[i1 - 1] - tRef);
      ys.push(values[i0], mn, mx, values[i1 - 1]);
    }
    feeds.push({ x: Float64Array.from(xs), y: Float64Array.from(ys) });
  }
  return feeds;
}

function lowerBound(a: Float64Array, t: number): number {
  let lo = 0,
    hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}
```

- [ ] **Step 2: Sanity-check in Node**

```bash
cd refs/spikes/chartgpu-mc1000 && npx tsx -e "
import { makeDataset, m4Columns } from './data.ts';
const ds = makeDataset(10, 100_000);
const feeds = m4Columns(ds, ds.time[0], ds.time[ds.time.length-1], 250);
console.log(feeds.length, feeds[0].x.length);  // expect: 10 1000
"
```

Expected output: `10 1000` (250 bins × 4 points). If `tsx` is unavailable, `pnpm add -D tsx` first.

---

### Task 3: Measurement harness with fixed gates

**Files:**

- Create: `refs/spikes/chartgpu-mc1000/main.ts`

**Interfaces:**

- Consumes: `makeDataset`, `m4Columns` from Task 2; `ChartGPU`, `createPipelineCache` from `@chartgpu/chartgpu`.
- Produces: on-page + console JSON results object with every gate's measured value and pass/fail.

**The gates (fixed now, before running):**

| #   | Measurement                                                                                          | Gate                          |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| G1  | Create + first frame, 1000 series × 1000 pts (250 bins M4)                                           | ≤ 3000 ms                     |
| G2  | Axes-only `setOption` (new x/y min/max, same series array identities), mean over 300 frames          | ≤ 4 ms mean, ≤ 8 ms p95       |
| G3  | Sustained zoom sweep (G2 applied per rAF for 5 s)                                                    | ≥ 30 fps (p95 frame ≤ 33 ms)  |
| G4  | Full refeed: new data + new series element objects for all 1000 series                               | ≤ 300 ms                      |
| G5  | Partial refeed: 50 changed series (new elements), 950 identity-stable                                | ≤ 50 ms                       |
| G6  | Transient survival: the 1-sample spike visibly renders at full zoom-out                              | pass/fail screenshot judgment |
| G7  | NaN gap handling: a series fed with NaN y values renders a visible break (not a bridge, not a crash) | pass/fail                     |
| G8  | JS heap + GPU memory after G1 (`performance.memory.usedJSHeapSize` where available; note it)         | ≤ 500 MB JS heap              |
| G9  | `drawImage(chartCanvas)` onto a 2D canvas captures pixels (PNG-export path)                          | non-blank capture             |

- [ ] **Step 1: Write the harness**

`refs/spikes/chartgpu-mc1000/main.ts` — complete file:

```ts
import { ChartGPU, createPipelineCache } from "@chartgpu/chartgpu";
import { makeDataset, m4Columns, type SeriesFeed } from "./data";

const SERIES = 1000;
const SAMPLES = 100_000;
const BINS = 250;

const out = document.getElementById("results")!;
const log = (s: string) => {
  out.textContent += s + "\n";
  console.log(s);
};
const results: Record<string, unknown> = {};

function seriesConfigs(feeds: SeriesFeed[]) {
  return feeds.map((f, i) => ({
    type: "line" as const,
    name: `s${i}`,
    data: { x: f.x, y: f.y },
    sampling: "none" as const,
    lineStyle: { width: 1, opacity: 0.6 },
    color: `hsl(${(i * 137) % 360} 60% 60%)`,
  }));
}

async function main() {
  if (!navigator.gpu) {
    log("FATAL: no navigator.gpu — wrong browser/host");
    return;
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    log("FATAL: no adapter");
    return;
  }
  const device = await adapter.requestDevice();
  const pipelineCache = createPipelineCache(device);

  const ds = makeDataset(SERIES, SAMPLES);
  const t0 = ds.time[0],
    t1 = ds.time[ds.time.length - 1];
  let feeds = m4Columns(ds, t0, t1, BINS);
  const extentX: [number, number] = [0, t1 - t0];

  const baseOptions = (feeds: SeriesFeed[], xMin: number, xMax: number) => ({
    theme: "dark" as const,
    animation: false as const,
    tooltip: { show: false },
    grid: { left: 60, right: 12, top: 8, bottom: 34 },
    xAxis: { type: "value" as const, min: xMin, max: xMax },
    yAxis: { type: "value" as const, min: -4, max: 14 },
    series: seriesConfigs(feeds),
  });

  // G1: create + first frame
  const tCreate = performance.now();
  const chart = await ChartGPU.create(
    document.getElementById("chart")!,
    baseOptions(feeds, extentX[0], extentX[1]),
    { adapter, device, pipelineCache },
  );
  await new Promise(requestAnimationFrame);
  results.G1_create_first_frame_ms = Math.round(performance.now() - tCreate);
  log(
    `G1 create+first-frame: ${results.G1_create_first_frame_ms} ms (gate 3000)`,
  );

  let options = baseOptions(feeds, extentX[0], extentX[1]);

  // G2: axes-only setOption cost (series identities preserved)
  const g2: number[] = [];
  for (let i = 0; i < 300; i++) {
    const f = i / 300;
    const s = performance.now();
    options = {
      ...options,
      xAxis: {
        type: "value",
        min: extentX[1] * 0.25 * f,
        max: extentX[1] * (1 - 0.25 * f),
      },
    };
    chart.setOption(options);
    g2.push(performance.now() - s);
  }
  g2.sort((a, b) => a - b);
  results.G2_axes_setOption_mean_ms = +(
    g2.reduce((a, b) => a + b) / g2.length
  ).toFixed(2);
  results.G2_axes_setOption_p95_ms =
    +g2[Math.floor(g2.length * 0.95)].toFixed(2);
  log(
    `G2 axes-only setOption mean ${results.G2_axes_setOption_mean_ms} ms / p95 ${results.G2_axes_setOption_p95_ms} ms (gate 4 / 8)`,
  );

  // G3: sustained zoom sweep fps
  const frames: number[] = [];
  await new Promise<void>((done) => {
    const start = performance.now();
    let last = start;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      const f = ((now - start) % 2000) / 2000;
      options = {
        ...options,
        xAxis: {
          type: "value",
          min: extentX[1] * 0.4 * f,
          max: extentX[1] * (1 - 0.4 * f),
        },
      };
      chart.setOption(options);
      if (now - start < 5000) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  frames.sort((a, b) => a - b);
  results.G3_frame_p95_ms =
    +frames[Math.floor(frames.length * 0.95)].toFixed(1);
  log(`G3 zoom-sweep frame p95: ${results.G3_frame_p95_ms} ms (gate 33)`);

  // G4: full refeed (all series new element objects + new data)
  feeds = m4Columns(ds, t0 + (t1 - t0) * 0.1, t0 + (t1 - t0) * 0.9, BINS);
  const t4 = performance.now();
  options = { ...options, series: seriesConfigs(feeds) };
  chart.setOption(options);
  await new Promise(requestAnimationFrame);
  results.G4_full_refeed_ms = Math.round(performance.now() - t4);
  log(`G4 full 1000-series refeed: ${results.G4_full_refeed_ms} ms (gate 300)`);

  // G5: partial refeed (50 changed, 950 identity-stable)
  const partial = options.series.slice();
  const newFeeds = m4Columns(ds, t0, t1, BINS);
  for (let i = 0; i < 50; i++) {
    partial[i] = {
      ...partial[i],
      data: { x: newFeeds[i].x, y: newFeeds[i].y },
    };
  }
  const t5 = performance.now();
  options = { ...options, series: partial };
  chart.setOption(options);
  await new Promise(requestAnimationFrame);
  results.G5_partial_refeed_ms = Math.round(performance.now() - t5);
  log(`G5 50/1000 refeed: ${results.G5_partial_refeed_ms} ms (gate 50)`);

  // G7: NaN gap probe (separate small chart so it can't hide in 1000 lines)
  const gapHost = document.createElement("div");
  gapHost.style.cssText = "width:400px;height:150px";
  document.body.appendChild(gapHost);
  const gy = Float64Array.from({ length: 100 }, (_, i) =>
    i > 40 && i < 60 ? NaN : Math.sin(i / 5),
  );
  const gx = Float64Array.from({ length: 100 }, (_, i) => i);
  const gapChart = await ChartGPU.create(
    gapHost,
    {
      theme: "dark",
      animation: false,
      tooltip: { show: false },
      series: [{ type: "line", data: { x: gx, y: gy }, sampling: "none" }],
    },
    { adapter, device, pipelineCache },
  );
  await new Promise(requestAnimationFrame);
  log(
    "G7: inspect the small chart — MUST show a gap between x=40..60 (record pass/fail manually)",
  );

  // G8: memory
  const mem = (
    performance as unknown as { memory?: { usedJSHeapSize: number } }
  ).memory;
  results.G8_js_heap_mb = mem
    ? Math.round(mem.usedJSHeapSize / 1048576)
    : "unavailable";
  log(`G8 JS heap: ${String(results.G8_js_heap_mb)} MB (gate 500)`);

  // G9: drawImage capture
  const chartCanvas =
    document.querySelector<HTMLCanvasElement>("#chart canvas");
  if (chartCanvas) {
    const cap = document.createElement("canvas");
    cap.width = chartCanvas.width;
    cap.height = chartCanvas.height;
    const ctx = cap.getContext("2d")!;
    ctx.drawImage(chartCanvas, 0, 0);
    const px = ctx.getImageData(0, 0, cap.width, cap.height).data;
    let nonZero = 0;
    for (let i = 0; i < px.length; i += 4)
      if (px[i] + px[i + 1] + px[i + 2] > 0) nonZero++;
    results.G9_capture_nonblank = nonZero > cap.width; // more than one row of lit pixels
    log(
      `G9 drawImage capture non-blank: ${String(results.G9_capture_nonblank)} (gate true)`,
    );
  } else {
    log("G9: FAIL — no canvas found under #chart");
  }

  log("\nRESULTS JSON:\n" + JSON.stringify(results, null, 2));
  void gapChart; // kept alive for visual inspection
}

document
  .getElementById("run-all")!
  .addEventListener("click", () => void main());
// G6 helper: zoom fully out and eyeball series 17's spike near 63% of the extent.
```

- [ ] **Step 2: Run it**

```bash
cd refs/spikes/chartgpu-mc1000 && pnpm dev
```

Open `http://<wsl-or-host-ip>:4199` in Windows Chrome (or native-Linux Chromium), click **Run all measurements**. If the page reports `FATAL: no navigator.gpu`, you are in a non-WebGPU host — switch browsers/machines, do not proceed.

Expected: all gates print; copy the RESULTS JSON. Take two screenshots: full zoom-out (G6 — series 17's transient spike must be visible as a vertical hairline near 63% of the x extent) and the G7 gap chart.

---

### Task 4: Results document and verdict

**Files:**

- Create: `docs/superpowers/specs/2026-08-12-chartgpu-spike-results.md`

**Interfaces:**

- Consumes: RESULTS JSON + screenshots from Task 3.
- Produces: the committed go/no-go record Phase 2 cites; updated `PINNED_REV` for the vendor script.

- [ ] **Step 1: Write the results doc**

Structure (fill every value — no TBDs):

```markdown
# ChartGPU mc1000 spike results (Phase 0)

- Date: <run date>
- ChartGPU rev: <contents of PINNED_REV.txt>
- Host: <browser + version, OS, GPU model, adapter info if available>
- Harness: refs/spikes/chartgpu-mc1000 (untracked; methodology in the
  Phase 0 plan)

| Gate | Measured | Limit | Verdict |
| G1 create+first frame | … ms | 3000 ms | pass/fail |
| G2 axes-only setOption | … / … ms | 4 / 8 ms | pass/fail |
| G3 zoom-sweep frame p95 | … ms | 33 ms | pass/fail |
| G4 full refeed | … ms | 300 ms | pass/fail |
| G5 partial refeed | … ms | 50 ms | pass/fail |
| G6 transient survival | screenshot | visible | pass/fail |
| G7 NaN gap | screenshot | gap renders | pass/fail |
| G8 JS heap | … MB | 500 MB | pass/fail |
| G9 drawImage capture | … | non-blank | pass/fail |

## Verdict

<GO / NO-GO for Phase 2, one paragraph. If NO-GO: which gate failed and
whether the scoped fork trigger (setSeriesData only) would fix it.>

## Observations

<hairline appearance at 1000 series, anything surprising>
```

- [ ] **Step 2: Format and commit**

```bash
./scripts/format.sh
git add docs/superpowers/specs/2026-08-12-chartgpu-spike-results.md
git commit -m "docs: ChartGPU mc1000 spike results (Phase 0 gate)"
```

- [ ] **Step 3: Version bump** — none. This lands inside the Phase 1 or Phase 2 PR; docs-only intermediate commits do not bump per AGENTS.md.

- [ ] **Step 4: Report the verdict** to the supervisor. GO → Phase 1 may start. NO-GO → stop; the fork decision returns to Edward.

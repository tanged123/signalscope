# ChartGPU Time-Series Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete SignalScope's tile/pyramid plotting path in the frontend and render time-series panels with the ChartGPU library over whole in-memory sample columns, while preserving SignalScope's interaction layer, visual chrome, plotting options, and self-contained HTML export.

**Architecture:** Panels acquire full raw columns per bound signal through a new binary `query_columns_bin` IPC (native) or base64 columns baked into the snapshot (offline). A per-panel `ChartHost` drives one externally-rendered ChartGPU instance (`sampling: 'none'`, shared GPU device) positioned inside the plot rect; a slimmed Canvas2D `ChromeRenderer` keeps axes, grid, furniture, and dashed-override strokes; the existing overlay canvas and the entire gesture/hit/keyboard layer are preserved unchanged against the same `PlotLayout` contract. Snapshots bake fidelity-strided columns instead of pyramid levels.

**Tech Stack:** TypeScript 5.9, `@chartgpu/chartgpu` 0.4.0 (WebGPU, bundled from devDependencies), Canvas2D chrome/overlay, Rust 2024, Vitest, Playwright.

## Global Constraints

- **Baseline gate:** the WebGPU phase-1 plan (`2026-08-07-webgpu-line-renderer-phase-1-time-only.md`) must be fully landed and green before Task 1. Another agent is executing it; do not start while `git status` shows its uncommitted work. Verify with the phase-1 Task 7 `rg` gates and `./scripts/test.sh quick`.
- This plan **supersedes phases 2–4** of the WebGPU renderer program (`-phase-2-ordered-tiles`, `-phase-3-webgpu`, `-phase-4-interaction-proof`). They must not be executed.
- User decision on 2026-08-07 overrides the `AGENTS.md`/`CLAUDE.md` "tile-pyramid gap/extrema invariants" non-negotiable for the plotting path; ADR 0040 (Task 1) records the conflict and resolution. The two-host `DataPlane` architecture, versioned protocol/session schemas, transactional ingest, and self-contained no-network snapshots remain non-negotiable.
- `@chartgpu/chartgpu` goes in `frontend/package.json` **devDependencies only** (`check-runtime-deps.mjs` forbids `dependencies`). Exact version pin `0.4.0`.
- Snapshot template budget rises once, deliberately: `frontend/scripts/check-snapshot.mjs` ceiling `750000` → `1500000` (ChartGPU adds ~674 KB minified).
- Protocol bumps **once** to v20 (Task 2). Later schema edits in this plan (Tasks 7, 9) stay within v20 — it never ships mid-plan. Session schema stays at v22; no session field changes.
- Operating envelope (record in ADR 0040, enforce in code): total loaded columns capped by `COLUMN_POINT_BUDGET = 32_000_000` points; per-series f32 fidelity requires `(window span / sample interval) < ~10^7`. Time values handed to ChartGPU are always normalized by a workspace `tRef`; all app/session state stays in raw time.
- All commands through `./scripts/` wrappers. Never `pnpm`/`cargo` directly.
- Do not touch `refs/` (reference sources and the spike harness live there).
- `core/scope-core/src/pyramid.rs`, sidecar cache writing, and ingest pyramid stages are **out of scope** — they stay compiled and running at ingest. Their removal is a follow-up plan once this one ships (unknown sidecar ABI coupling; phase-1 churn still landing in core).
- Preserve gesture semantics exactly: wheel `Math.exp(deltaY * 0.0016)` about the cursor (shift = Y-only, alt = X-only); middle/right/ctrl-left drag = pan; plain left drag = box zoom (4 px dead zone, `zoomDragMode` axis classification); shift+click focus / alt+click mute at 6 px; double-click fit or axis edit; hover emphasis +0.4 alpha/width with 0.25 dim; Escape/Tab/Enter panel keys. These live in `plot-gestures.ts` / `plot-math.ts` / `plot-interactions.ts` / `panel.ts` and this plan must not change their behavior or their tests.

---

## Resulting File Structure

- Create: `frontend/src/app/columns.ts` — column decode, tRef normalization, window stats, value-at-time, binary search.
- Create: `frontend/src/app/column-store.ts` — bind-time column loading, timebase dedupe, byte budget, eviction.
- Create: `frontend/src/app/column-hit.ts` — nearest-series hit testing over columns (replaces bin-based `plot-hit.ts`).
- Create: `frontend/src/render/chart-host.ts` — ChartGPU lifecycle, shared device, series/style/range sync, external render, capture.
- Create: `frontend/src/render/chrome-renderer.ts` — axes/grid/furniture/gutter + dashed-override strokes, publishes `PlotLayout` (extracted from `canvas-renderer.ts`).
- Create: `protocol/src/column_binary.rs` — binary column response encoding (mirrors `tile_binary.rs` framing).
- Create: `frontend/tests/e2e/webgpu-probe.spec.ts` — hard capability gate for CI.
- Modify: `protocol/schema/scope-protocol.json` (v20), generated outputs, `core/scope-core/src/compute.rs`, `core/scope-core/src/snapshot.rs`, `shell/src-tauri/src/lib.rs`, `frontend/src/app/{data-plane,time-plot,csv-export,png-export,baked-session? (no), samples}.ts`, `frontend/src/ui/{panel,app-shell,workspace-view}.ts`, `frontend/vite.config.ts`, `frontend/playwright.config.ts`, `frontend/scripts/check-snapshot.mjs`.
- Delete: `frontend/src/render/canvas-renderer.ts`, `frontend/src/app/{pyramid-query,bin-columns,tile-binary,tile-window-cache,plot-hit}.ts` (+ their tests), `frontend/src/app/envelope.ts` tile pieces (keep envelope itself), shell `query_tiles_bin`, protocol tile messages, `core/scope-core/src/tile_wire.rs` shell usage.
- Keep: `overlay-renderer.ts`, `surface.ts`, `y-axis.ts`, `plot-math.ts`, `plot-gestures.ts`, `plot-interactions.ts`, `resolution.ts`, `samples.ts`, `envelope.ts`, `csv-export.ts` (consumer-only edits), all session machinery.

Layer stack per panel (bottom → top): `.plot-canvas` (chrome 2D) → `.chart-gpu-host` (ChartGPU-owned canvas, absolutely positioned to the plot rect, `pointer-events: none`) → `.overlay-canvas` (2D, keeps all pointer handlers).

---

### Task 1: Baseline Gate, ADR 0040, and Governance Updates

**Files:**

- Create: `docs/adr/0040-chartgpu-in-core-rendering.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/implementation-roadmap.md`
- Modify: `AGENTS.md` (pyramid non-negotiable bullet)
- Modify: `CLAUDE.md` (same bullet)

**Interfaces:**

- Consumes: approved direction from the 2026-08-07 ChartGPU spike (recorded in the ADR).
- Produces: architectural authority for Tasks 2–12; marks WebGPU phases 2–4 plans superseded.

- [ ] **Step 1: Verify phase 1 actually landed**

Run: `git status --short` (must be clean of phase-1 churn), then the phase-1 deletion gates:

```bash
! rg -n 'PanelMode|mode-pill|max_total_bins|densityMode|renderPaths' frontend/src core protocol shell
! rg -n 'xy|fft|histogram' frontend/src frontend/tests --ignore-case -g '!*.md'
./scripts/test.sh quick
```

Expected: both `rg` gates exit 0 (no matches) and `quick` passes. **If any fail, STOP — phase 1 is still in flight; do not proceed or "fix forward".**

- [ ] **Step 2: Write ADR 0040**

```markdown
# ADR 0040: In-core ChartGPU rendering for time-series panels

- Status: Accepted
- Date: 2026-08-07
- Supersedes: the renderer portions of ADR 0039 (phases 2–4 of the WebGPU
  renderer program); amends ADR 0036 (tile acquisition) for the frontend.

## Decision

Time-series panels render with the MIT-licensed `@chartgpu/chartgpu`
library over whole in-memory sample columns. The frontend no longer
queries pyramid tiles; it loads each bound signal's full raw columns once
(binary IPC natively, baked base64 columns offline) and ChartGPU keeps
them GPU-resident with `sampling: 'none'` — every raw sample is drawn.

SignalScope retains ownership of: gesture/interaction semantics, axes,
grid, furniture, legend, overlays, per-series styling (including dashed
overrides, stroked on the chrome canvas), sessions, CSV export, and the
two-host DataPlane. ChartGPU owns only the series raster inside the plot
rect, driven in external render mode from SignalScope's frame scheduler.

Time values handed to ChartGPU are normalized against a workspace tRef
(min t_min at first load) because ChartGPU rasterizes from f32; all
session and interaction state remains in raw time.

## Operating envelope (accepted product limits)

- Loaded columns are capped at 32,000,000 points per workspace; binds
  beyond the budget are refused with an explicit message.
- A series stays visually exact while window-span / sample-interval
  < ~10^7 (f32 mantissa); beyond that, deep-zoom jitter is expected.
- WebGPU is required; unsupported hosts (including opened snapshots) get
  a dedicated screen. There is no fallback series renderer.

## Conflict note

This decision overrides the AGENTS.md non-negotiable that the frontend
plotting path preserves tile-pyramid gap/extrema invariants; the user
chose in-core rendering on 2026-08-07 after a measured spike
(cold plot 3.2 s, zoom p95 145 ms at 1000×10k, 740 MB heap). Gaps remain
exact (NaN passthrough); extrema remain exact because every sample is
drawn. Pyramid construction remains at ingest; its removal is a
follow-up decision.

## Consequences

Snapshots bake fidelity-strided raw columns (smaller than today's
per-bin JSON at every fidelity), bundle ChartGPU (+674 KB template), and
require WebGPU to view. Preview-fidelity snapshot statistics are now
computed from strided samples rather than exact bin sums. Datasets past
the point budget cannot be plotted; the tile pyramid path is the
documented recovery if that becomes a real workload.
```

- [ ] **Step 3: Index and cross-reference**

Add ADR 0040 to `docs/adr/README.md`. In `docs/implementation-roadmap.md`, replace the four-phase WebGPU renderer sequence with this plan (link it) and mark phases 2–4 plan files superseded by a note at the top of each: `> Superseded by docs/superpowers/plans/2026-08-07-chartgpu-replacement.md (ADR 0040).`

In `AGENTS.md` and `CLAUDE.md`, rewrite the pyramid bullet to: "Preserve the two-host `DataPlane` architecture, versioned protocol/session schemas, transactional ingest, self-contained no-network snapshots, and the in-core column operating envelope (ADR 0040)."

- [ ] **Step 4: Format, inspect, commit**

```bash
./scripts/format.sh && git diff --check
git add docs/adr AGENTS.md CLAUDE.md docs/implementation-roadmap.md docs/superpowers/plans
git commit -m "docs(adr): adopt in-core ChartGPU rendering (ADR 0040)"
```

### Task 2: Protocol v20 — Column Request and Binary Response

**Files:**

- Modify: `protocol/schema/scope-protocol.json` (bump `protocol_version` 19 → 20; add `ColumnRequest`; keep tile messages for now — removed in Task 11)
- Create: `protocol/src/column_binary.rs`
- Modify: `protocol/src/lib.rs` (module + re-exports)
- Regenerate: all six codegen outputs via `./scripts/codegen.sh`
- Test: `protocol/src/column_binary.rs` in-file tests; `frontend/src/app/envelope.test.ts` version expectations

**Interfaces:**

- Produces (schema): `ColumnRequest { request_id: string, signal_ids: string[] }`.
- Produces (Rust): `pub fn encode_column_response(request_id: &str, series: &[ColumnSeries]) -> Vec<u8>` and `pub struct ColumnSeries<'a> { pub signal_id: u64, pub timebase_id: u64, pub signal_path: &'a str, pub unit: Option<&'a str>, pub time: &'a [f64], pub values: &'a [f64] }`.
- Wire layout (little-endian), mirroring `protocol/src/tile_binary.rs` framing conventions (magic + version guard first, length-prefixed strings):

```
[u32 magic 0x5343434C "SCCL"] [u16 protocol_version] [u32 request_id_len][utf8]
[u32 series_count]
per series:
  [u64 signal_id] [u64 timebase_id]
  [u32 path_len][utf8] [u8 has_unit][u32 unit_len][utf8 if has_unit]
  [u32 n] [f64 time[n]] [f64 values[n]]   // values NaN = gap, passthrough
```

- [ ] **Step 1: Failing Rust round-trip test**

In `protocol/src/column_binary.rs` write the tests first:

```rust
#[test]
fn encodes_header_series_and_nan_values() {
    let series = [ColumnSeries { signal_id: 7, timebase_id: 3,
        signal_path: "run_0001/temperature", unit: Some("degC"),
        time: &[0.0, 0.1, 0.2], values: &[1.0, f64::NAN, 3.0] }];
    let bytes = encode_column_response("req-1", &series);
    assert_eq!(&bytes[0..4], &0x5343434Cu32.to_le_bytes());
    assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), PROTOCOL_VERSION as u16);
    // decode helper used only by tests mirrors the TS decoder
    let decoded = decode_column_response(&bytes).unwrap();
    assert_eq!(decoded.request_id, "req-1");
    assert_eq!(decoded.series[0].time, vec![0.0, 0.1, 0.2]);
    assert!(decoded.series[0].values[1].is_nan());
}

#[test]
fn rejects_wrong_version() {
    let mut bytes = encode_column_response("r", &[]);
    bytes[4] ^= 0xFF;
    assert!(decode_column_response(&bytes).is_err());
}
```

- [ ] **Step 2: Run to verify failure**

Run: `./scripts/test.sh core column_binary` — Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement encode + test-only decode**

Implement `encode_column_response`/`decode_column_response` with explicit `to_le_bytes` writes (follow `tile_binary.rs` style; `PROTOCOL_VERSION` from the generated constants). Bump `protocol_version` to 20 in `protocol/schema/scope-protocol.json`, add `ColumnRequest` to the schema's request definitions, run `./scripts/codegen.sh`.

- [ ] **Step 4: Verify**

Run: `./scripts/test.sh core column_binary` then `./scripts/test.sh unit envelope` (update the frontend test's expected `PROTOCOL_VERSION` to 20) and `pnpm` codegen check via `./scripts/test.sh frontend`. Expected: PASS; codegen diff clean.

- [ ] **Step 5: Commit**

```bash
git add protocol core frontend/src/generated frontend/src/app/envelope.test.ts
git commit -m "feat(protocol): v20 column request and binary column response"
```

### Task 3: Native Column Query — Core Accessor and Shell Command

**Files:**

- Modify: `core/scope-core/src/compute.rs` (add `signal_columns`)
- Modify: `shell/src-tauri/src/lib.rs` (add `query_columns_bin`, registered next to the existing `query_tiles_bin` at ~:877)
- Test: `core/scope-core/src/compute.rs` in-file; shell command covered by Task 12's e2e

**Interfaces:**

- Produces (core): `pub fn signal_columns(store: &SignalStore, signal_id: u64) -> Option<(Arc<[f64]>, Arc<[f64]>, TimebaseId)>` returning `time_shared()`/`values_shared()` and the timebase. Derived signals (quick transforms in `Session.derived`) are store-resident like ingested ones and must resolve through the same lookup — add one test asserting a derived signal id returns its columns.
- Produces (shell): Tauri command `query_columns_bin(request: ColumnRequest) -> tauri::ipc::Response` — envelope-checked request, binary body via `encode_column_response`, same response mechanics as `query_tiles_bin`.

- [ ] **Step 1: Failing core test**

```rust
#[test]
fn signal_columns_returns_shared_full_columns() {
    let mut store = SignalStore::new();
    // register one source + one signal exactly as neighboring store tests do
    let id = insert_test_signal(&mut store, &[0.0, 1.0, 2.0], &[5.0, f64::NAN, 7.0]);
    let (time, values, _tb) = compute::signal_columns(&store, id).unwrap();
    assert_eq!(&*time, &[0.0, 1.0, 2.0]);
    assert!(values[1].is_nan());
    assert!(compute::signal_columns(&store, 999_999).is_none());
}
```

(Reuse the store-fixture helper pattern already present in `compute.rs` tests; if none exists, build the store the same way `sample_window` tests do.)

- [ ] **Step 2: Run to verify failure** — `./scripts/test.sh core signal_columns` → FAIL.

- [ ] **Step 3: Implement**

`signal_columns` looks up the signal (same lookup the `query_samples` shell path uses), returns `time_shared()`, `values_shared()`, `timebase_id()`. In the shell, add `query_columns_bin`: open the envelope, resolve each id, call `signal_columns`, build `ColumnSeries` entries (skip unknown ids), `encode_column_response`, return `tauri::ipc::Response::new(bytes)`. Register the command in the handler list beside `query_tiles_bin`.

- [ ] **Step 4: Verify** — `./scripts/test.sh core signal_columns` PASS, then `./scripts/test.sh shell` compiles and passes.

- [ ] **Step 5: Commit**

```bash
git add core shell
git commit -m "feat(shell): binary full-column query"
```

### Task 4: Frontend Column Model

**Files:**

- Create: `frontend/src/app/columns.ts`
- Test: `frontend/src/app/columns.test.ts`

**Interfaces:**

- Produces:

```ts
export interface SignalColumns {
  signalId: string;
  timebaseId: string;
  path: string;
  unit: string | null;
  tRef: number; // raw = time[i] + tRef
  time: Float64Array; // normalized, ascending; shared across signals of one timebase
  values: Float64Array; // NaN = gap
}
export interface RawColumnSeries {
  signalId: string;
  timebaseId: string;
  path: string;
  unit: string | null;
  time: Float64Array;
  values: Float64Array;
}
export function decodeColumnResponse(buffer: ArrayBuffer): {
  requestId: string;
  series: RawColumnSeries[];
};
export function normalizeSeries(
  raw: RawColumnSeries,
  tRef: number,
  sharedTime: Map<string, Float64Array>,
): SignalColumns;
export function lowerBound(time: Float64Array, t: number): number; // first index >= t
export function columnsWindowStats(
  c: SignalColumns,
  rawT0: number,
  rawT1: number,
): {
  min: number;
  max: number;
  mean: number;
  rms: number;
  count: number;
} | null; // finite-only
export function columnsValueAt(c: SignalColumns, rawT: number): number | null; // nearest sample, null if empty/NaN
```

- Consumes: wire layout from Task 2 (decode must reject bad magic/version with a thrown `Error` naming the expected version, like `envelope.ts` does).

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  decodeColumnResponse,
  lowerBound,
  columnsWindowStats,
  columnsValueAt,
  normalizeSeries,
} from "./columns";

function encodeFixture(): ArrayBuffer {
  /* hand-build the Task 2 layout with DataView:
  magic 0x5343434C, version 20, request "r1", one series id=7 tb=3 path "a/t" unit degC,
  time [100.0, 100.1, 100.2], values [1, NaN, 3] */
}

it("decodes series with NaN gaps intact", () => {
  const { requestId, series } = decodeColumnResponse(encodeFixture());
  expect(requestId).toBe("r1");
  expect(series[0].values[1]).toBeNaN();
});
it("rejects wrong version", () => {
  /* flip version byte, expect throw containing "20" */
});
it("shares normalized time arrays per timebase", () => {
  const shared = new Map<string, Float64Array>();
  const a = normalizeSeries(fixtureSeries("7", "3"), 100.0, shared);
  const b = normalizeSeries(fixtureSeries("8", "3"), 100.0, shared);
  expect(a.time).toBe(b.time);
  expect(a.time[0]).toBe(0);
});
it("window stats are finite-only and exact", () => {
  // time raw 100.0..100.2, values [1, NaN, 3] → over [100.0, 100.2]: count 2, min 1, max 3, mean 2
});
it("valueAt picks nearest sample and null on NaN", () => {
  /* rawT 100.09 → NaN sample → null; 100.19 → 3 */
});
it("lowerBound is a binary search", () => {
  /* boundaries: before, exact, between, after */
});
```

- [ ] **Step 2: Run to verify failure** — `./scripts/test.sh unit columns` → FAIL.
- [ ] **Step 3: Implement** — `DataView` little-endian reads; `lowerBound` classic binary search; stats single pass skipping non-finite; `columnsValueAt` via `lowerBound` then nearer neighbor. `normalizeSeries` subtracts `tRef` into a new `Float64Array` once per timebase (`sharedTime` map key = timebaseId), reusing it for subsequent signals.
- [ ] **Step 4: Verify** — `./scripts/test.sh unit columns` → PASS.
- [ ] **Step 5: Commit** — `git add frontend/src/app/columns.*` ; `git commit -m "feat(frontend): column decode, normalization, and window math"`

### Task 5: DataPlane Column Queries and the Column Store

**Files:**

- Modify: `frontend/src/app/data-plane.ts` (interface + `TauriPlane`; `BakedPlane` columns arrive in Task 9)
- Create: `frontend/src/app/column-store.ts`
- Test: `frontend/src/app/data-plane.test.ts` (extend), `frontend/src/app/column-store.test.ts`

**Interfaces:**

- Produces (DataPlane): `queryColumns(request: ColumnRequest): Promise<{ requestId: string; series: RawColumnSeries[] }>` added to the `DataPlane` interface. `TauriPlane` implements it as `decodeColumnResponse(await this.invoke<ArrayBuffer>("query_columns_bin", { request: seal(request) }))` — same shape as its `queryTiles` at `data-plane.ts:455`.
- Produces (store):

```ts
export const COLUMN_POINT_BUDGET = 32_000_000;
export class ColumnStore {
  constructor(private readonly plane: DataPlane);
  readonly tRef: number | null;                       // set on first successful load
  async ensure(signalIds: string[]): Promise<Map<string, SignalColumns>>; // loads misses, one request
  get(signalId: string): SignalColumns | null;
  release(signalIds: string[]): void;                 // refcount decrement; frees unreferenced
  loadedPoints(): number;
}
export class ColumnBudgetError extends Error { requestedPoints: number; budget: number }
```

- Budget rule: before decoding a load that would push `loadedPoints()` past `COLUMN_POINT_BUDGET`, throw `ColumnBudgetError`; the caller (Task 8) surfaces it in the panel-empty slot. tRef rule: `tRef = Math.min(t_min of first-loaded batch)`; if a later batch has `t_min < tRef`, re-normalize all cached columns to the new tRef (one pass, rare).

- [ ] **Step 1: Failing tests** — mock `DataPlane.queryColumns` with fixtures from Task 4's encoder: dedupe (two signals, one timebase → same `time` reference), refcount release, budget rejection (`COLUMN_POINT_BUDGET + 1` points → `ColumnBudgetError` with both numbers), tRef re-normalization (load t_min=100 then t_min=50 → all columns re-based, `tRef === 50`), and `TauriPlane.queryColumns` invoking `"query_columns_bin"` with a sealed envelope (same style as the existing `queryTiles` test).
- [ ] **Step 2: Run to verify failure** — `./scripts/test.sh unit column-store data-plane` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — same filter → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(frontend): DataPlane column query and budgeted column store"`

### Task 6: ChartHost — ChartGPU Runtime Behind SignalScope's Contract

**Files:**

- Create: `frontend/src/render/chart-host.ts`
- Modify: `frontend/package.json` (devDependencies: `"@chartgpu/chartgpu": "0.4.0"`), `frontend/vite.config.ts`, `frontend/scripts/check-snapshot.mjs:9`
- Test: `frontend/src/render/chart-host.test.ts` (vi.mock `@chartgpu/chartgpu`)

**Interfaces:**

- Consumes: `SignalColumns` (Task 4), `ResolvedSeries` (`resolution.ts:14` — `{hue, dash, width, opacity, visible, focused}`), `PlotLayout` plot rect (CSS px).
- Produces:

```ts
export interface ChartSeriesInput {
  columns: SignalColumns;
  style: ResolvedSeries;
  index: number;
}
export type RuntimeStatus = "ok" | "unsupported";
export async function ensureChartRuntime(): Promise<RuntimeStatus>; // one shared GPUContext + pipeline cache, module-level
export class ChartHost {
  constructor(container: HTMLElement); // container is .chart-gpu-host
  setSeries(series: ChartSeriesInput[]): void; // skips style.dash !== "solid" (chrome strokes those)
  setEmphasis(indices: number[] | null): void;
  setRanges(
    xRaw: { min: number; max: number },
    y: { min: number; max: number },
    tRef: number,
  ): void;
  layout(rect: { x: number; y: number; width: number; height: number }): void; // positions container, resizes chart
  renderFrame(): boolean; // external mode; call from the panel scheduler
  async captureInto(
    ctx: CanvasRenderingContext2D,
    dx: number,
    dy: number,
  ): Promise<void>;
  invalidateTheme(): void; // drops cached token colors; theme toggle and --font-plot/--plot-font-size preference changes call this (chrome re-layout happens on its own render)
  dispose(): void;
}
```

- ChartGPU options, fixed: `{ series, animation: false, tooltip: { show: false }, performance: { lod: "auto" }, grid: { left: 0, right: 0, top: 0, bottom: 0 } }`, per-series `{ type: "line", sampling: "none", data: { x: columns.time, y: columns.values }, lineStyle: { color, width, opacity } }`, x/y axis `{ min, max }` with ticks/labels disabled. Render mode `"external"` via `setRenderMode` immediately after create.
- Style mapping replicates `canvas-renderer.ts:365-393` exactly: `hue === null` → chrome `fg4` token color; else `SERIES_TOKENS[hueIndex(hue)]`; emphasized → `alpha + 0.4`, `width + 0.4`; any emphasis present and not emphasized and not ghost → alpha `0.25`. Colors resolve from CSS custom properties once and drop on `invalidateTheme()` (same pattern both old renderers used).
- **Transparency:** create the shared context with `alphaMode: "premultiplied"` and theme `backgroundColor: "rgba(0,0,0,0)"` so chrome grid shows through. **Fallback if ChartGPU paints opaque anyway** (verify in Step 4): set `backgroundColor` to the resolved `--panel-bg` token and move gridline drawing from chrome into ChartGPU `gridLines` config, forcing tick positions to SignalScope's computed ticks; keep axis labels on chrome either way.
- Emphasis/restyle must keep `data.x`/`data.y` array references identical so ChartGPU's data store cache skips re-upload; only `lineStyle` objects change.
- `captureInto`: `renderFrame(); await Promise.resolve(); await device.queue.onSubmittedWorkDone(); ctx.drawImage(chartCanvas, dx, dy)` — the recipe documented in ChartGPU's own `renderFrame()` docs.

- [ ] **Step 1: Failing unit tests** — `vi.mock("@chartgpu/chartgpu")` with a recording stub. Assert: create receives `sampling:"none"` per series and `animation:false`; dashed series are excluded from `setSeries` output; ghost (`hue:null`) maps to the fg4 token; emphasis produces `0.25` dim on others and keeps `data.x` reference identity; `setRanges` converts raw→normalized (`min - tRef`); `dispose` called on teardown; `ensureChartRuntime` returns `"unsupported"` when `navigator.gpu` is undefined.
- [ ] **Step 2: Run to verify failure** — `./scripts/test.sh unit chart-host` → FAIL.
- [ ] **Step 3: Implement**, plus build config: `vite.config.ts` add `build.rollupOptions.output.inlineDynamicImports: true` (single chunk stays single); `check-snapshot.mjs` ceiling → `1500000`.
- [ ] **Step 4: Verify** — unit filter PASS; `./scripts/test.sh frontend` (deps gate must accept devDependency; typecheck clean). Build the template (`pnpm` step inside `./scripts/build.sh` frontend stage or `./scripts/test.sh frontend` artifact checks) and confirm `check-snapshot.mjs` passes with the new ceiling. Manually run `./scripts/run.sh`, bind one CSV, confirm the transparency assumption and record the outcome in the commit message (primary vs fallback path).
- [ ] **Step 5: Commit** — `git commit -m "feat(render): ChartGPU chart host in external render mode"`

### Task 7: Chrome Renderer Extraction and Panel Integration

**Files:**

- Create: `frontend/src/render/chrome-renderer.ts`
- Modify: `frontend/src/ui/panel.ts`, `frontend/src/ui/workspace-view.ts`, `frontend/src/ui/app-shell.ts`, `frontend/src/app/time-plot.ts`, `frontend/src/styles/` (`.chart-gpu-host` rule)
- Create: `frontend/src/app/column-hit.ts` (+ test)
- Delete: `frontend/src/render/canvas-renderer.ts`, `frontend/src/app/{tile-window-cache,plot-hit}.ts` (+ tests)
- Test: `frontend/src/render/chrome-renderer.test.ts`, `frontend/src/app/column-hit.test.ts`, existing `panel`/gesture tests stay green unmodified

**Interfaces:**

- Produces (`ChromeRenderer`): `render(input: ChromeInput): PlotLayout`, `lastLayout(): PlotLayout | null`, `invalidateTheme()`, where `ChromeInput = { xRange, yRange, xLabel, yLabel, axisStyle, dashedSeries: ChartSeriesInput[], tRefForLabels: number }`. `PlotLayout` type moves here **unchanged** — gestures, overlay, hit, annotations keep compiling against it. Tick label formatting adds `tRef` back so displayed times stay raw. Gutter math (`gutterWidth = max(48, ceil(longest * charWidth) + 24)`) moves verbatim.
- Produces (`column-hit.ts`): `nearestSeries(series: ChartSeriesInput[], layout: PlotLayout, cssX: number, cssY: number, maxPx: number): { index: number; distancePx: number } | null` — per series: `lowerBound` on normalized cursor time, check the two adjacent samples' projected pixel distance (same 6 px semantics `panel.ts:687` uses today).
- Consumes: `ChartHost` (Task 6), `ColumnStore` (Task 5).
- Panel wiring: `panelMarkup()` gains `<div class="chart-gpu-host"></div>` between the two canvases; `.plot-canvas`/`.overlay-canvas` class names and DPR handling via `CanvasSurface` stay. `PanelView.renderData` becomes: resolve series → chrome `render()` (returns layout) → `chartHost.layout(layout.plot)` → `chartHost.setSeries(solid)` → `chartHost.setRanges(xRange, yRange, tRef)` → `chartHost.renderFrame()` → overlay. `app-shell.ts` replaces `refreshTilesPass()` tile querying with `columnStore.ensure(boundSignalIds)` per panel (columns load once per bind, not per viewport); pan/zoom no longer trigger any acquisition. `ColumnBudgetError` renders into `.panel-empty` with the budget numbers. Stats/cursor/annotation values in `time-plot.ts` switch from bin helpers to `columnsWindowStats`/`columnsValueAt`.

- [ ] **Step 1: Failing tests** — chrome-renderer: layout equals old `lastLayout` for a fixture (assert gutter width from known tick strings; axes text unchanged), dashed series stroked (spy on `ctx.setLineDash` with `[6,4]` for `"dash"`, `[2,3]` for `"dot"` — same patterns `canvas-renderer.ts` uses today; copy its constants). column-hit: exact 6 px boundary semantics, NaN gap samples never match.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the extraction** — move `beginFrame`/`drawGrid`/`drawAxisFurniture`/`drawInlineFurniture`/tick+gutter/palette code from `canvas-renderer.ts:535,840,861,1248` into `ChromeRenderer` minus all series stroking except the dashed-override path (reuse the moved `styleFor` for those strokes). Rewire `panel.ts`/`workspace-view.ts`/`app-shell.ts`; delete `canvas-renderer.ts`, `tile-window-cache.ts`, `plot-hit.ts`.

Hue-wrap parity fix (pre-existing bug, do not port it): `assignHues` (`resolution.ts:188`) assigns `(values.size % 8) + 1` while the renderer's `hueIndex` wraps `% 7` — the 8th distinct value shows `--series-7` in the legend swatch but strokes as `--series-1`. Change `assignHues` to `% 7` so hue values stay in 1..7, add a test in `resolution.test.ts` (8 distinct sources → 8th gets hue 1, matching the swatch), and have both `ChartHost` and `ChromeRenderer` share one exported `hueIndex` helper.

- [ ] **Step 4: Verify** — `./scripts/test.sh unit` full (gesture/plot-math/panel suites must pass **unmodified** — they are the requirement-A regression net), then `./scripts/test.sh frontend`. Manual `./scripts/run.sh`: bind signals, verify wheel/pan/box-zoom/hover/focus/ghost/stats/annotations behave identically, pan does zero requests (network/IPC log quiet), drag row/column seams continuously (GPU surfaces must survive rapid resize without flicker or device errors), toggle theme and change plot font size (chrome re-lays-out gutters, chart follows the new plot rect).
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): panels render columns through ChartGPU with preserved chrome"`

### Task 8: Unsupported-Host Screen

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`, `frontend/src/styles/` (screen styles)
- Test: extend `frontend/src/app/` level test for the gate function; e2e assertion in Task 10

**Interfaces:**

- Produces: at startup, `await ensureChartRuntime()`; on `"unsupported"`, replace the workspace root with `.unsupported-host` — copy: heading "This host can't display plots", body "SignalScope requires WebGPU for series rendering. Update your browser/OS or open this workspace on a WebGPU-capable host.", and the failing capability string. No blank plots, no partial shell.

- [ ] **Step 1: Failing test** — `ensureChartRuntime` returning `"unsupported"` renders the screen (jsdom, `navigator.gpu` absent) and skips panel construction.
- [ ] **Step 2–4: Implement, verify, run `./scripts/test.sh unit app-shell`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): dedicated unsupported-host screen"`

### Task 9: Snapshot Export — Baked Columns

**Files:**

- Modify: `protocol/schema/scope-protocol.json` (still v20: `SnapshotManifest.signals` becomes `BakedSignal { summary, t_ref: number, stride: number, time_b64: string, values_b64: string }`; `EnvelopeBin`/`levels` removed from the manifest), regenerate
- Modify: `core/scope-core/src/snapshot.rs` (`plan`/`bake`/`estimated_bytes`)
- Modify: `frontend/src/app/data-plane.ts` (`BakedPlane`)
- Delete: `frontend/src/app/pyramid-query.ts`, `frontend/src/app/bin-columns.ts`, `frontend/src/app/tile-binary.ts` (+ tests)
- Test: `snapshot.rs` in-file tests, `data-plane.test.ts`, `frontend/tests/e2e/snapshot-roundtrip.spec.ts`

**Interfaces:**

- Bake: per exported signal, run `compute::sample_window(time, values, range.t0, range.t1, ceiling(fidelity))` — the **same** ceilings CSV uses (512 / 2048 / 16384 / u32::MAX from `csv-export.ts:10` semantics; `snapshot.rs::ceiling` already returns them). Base64-encode the resulting f64 LE bytes into `time_b64`/`values_b64` (raw, un-normalized time; `t_ref` = 0 in the manifest — BakedPlane computes tRef like the native path). `estimated_bytes` becomes `sum(points * 16 * 4/3)`.
- `BakedPlane.queryColumns` decodes b64 → `RawColumnSeries` (timebaseId = source id; memoized). `BakedPlane.querySamples` re-implements over the decoded columns with `samples.ts` stride semantics (it currently reconstructs pseudo-samples from bins — the column version is strictly more accurate). `BakedPlane.queryTiles` is deleted with the interface change (Task 11 removes `queryTiles` everywhere; here BakedPlane just gains columns and keeps a thin `queryTiles` throw until then — one-line `throw new Error("tiles removed")`).
- Snapshot privacy/determinism tests (`bake_serializes_deterministically`, `bake_clears_sources_and_orders_signals_by_id`, `inject_*`) must stay green; level-specific tests (`baked_levels_are_positional_from_the_finest_planned_level`, clipping tests) are rewritten for stride windows (one-neighbor clip comes free from `sample_window`).

- [ ] **Step 1: Failing Rust tests** — new `bake_encodes_strided_columns_base64` (fixture signal, preview fidelity → decoded b64 matches `sample_window` output; stride recorded), update determinism/estimate tests to the new manifest.
- [ ] **Step 2: Run** — `./scripts/test.sh core snapshot` → FAIL.
- [ ] **Step 3: Implement bake + BakedPlane; delete the three frontend modules.**
- [ ] **Step 4: Verify** — `./scripts/test.sh core snapshot`, `./scripts/test.sh unit data-plane`, then re-record `snapshot-roundtrip.spec.ts` expectations (stats text now derives from strided samples at preview; window text unchanged; `networkRequests` still `[]`; keep the `schema_version:999` fail-closed case) and run `./scripts/test.sh e2e`. Bake `./scripts/export.sh` on the demo workspace and record the new size vs the old in the commit message.
- [ ] **Step 5: Commit** — `git commit -m "feat(snapshot): bake fidelity-strided raw columns"`

### Task 10: PNG Export Over WebGPU

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`buildPanelPng` ~:2295, `exportAllPanelPngs` ~:2316), `frontend/src/ui/workspace-view.ts` (`panelCanvases` → also return the chart host), `frontend/src/app/png-export.ts` (`composePanelPng` signature gains the chart layer)
- Test: `frontend/src/app/png-export.test.ts`

**Interfaces:**

- `composePanelPng(title, chrome: HTMLCanvasElement, chart: CanvasImageSource, overlay: HTMLCanvasElement, colors)` draws chrome → chart → overlay in that order. `buildPanelPng` awaits `chartHost.captureInto` semantics: force `renderFrame()`, await `onSubmittedWorkDone()`, then compose — capture happens in the same task as the render so the WebGPU canvas still holds its frame. All-panels flow (`showTabForExport` → `syncWorkspaceForExport` → capture → restore) keeps its structure; the awaited re-render replaces the old `refreshTiles()` wait.

- [ ] **Step 1: Failing test** — compose draws three layers in order (record `drawImage` calls on a stub ctx).
- [ ] **Step 2–4: Implement, verify (`./scripts/test.sh unit png-export`), manual single-panel and all-panels export via `./scripts/run.sh`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(export): PNG capture through the chart host"`

### Task 11: Delete the Tile Path Everywhere

**Files:**

- Modify: `protocol/schema/scope-protocol.json` (remove `TileRequest`/`TileResponse`/`SignalTile`/`EnvelopeBin` and the tile request message; still v20), regenerate
- Modify: `frontend/src/app/data-plane.ts` (drop `queryTiles` from the interface and both planes)
- Modify: `shell/src-tauri/src/lib.rs` (remove `query_tiles_bin`), `core/scope-core` (remove `tile_wire.rs` and `Pyramid::query*` **call sites in shell/snapshot only** — `pyramid.rs` itself stays per the global constraint)
- Delete: `protocol/testdata/pyramid-conformance.json` consumers in frontend tests (file itself stays with the core tests)

**Interfaces:** none new. This is the sweep that makes the deletion real.

- [ ] **Step 1: Delete, regenerate, fix compilation** — remove the schema messages, run `./scripts/codegen.sh`, chase compile errors (they are the checklist).
- [ ] **Step 2: Deletion gates**

```bash
! rg -n 'queryTiles|query_tiles|TileRequest|TileResponse|BinColumns|EnvelopeBin|pyramid' frontend/src
! rg -n 'query_tiles_bin|tile_wire' shell core/scope-core/src/snapshot.rs
```

Expected: both exit 0. (`pyramid` remains only under `core/scope-core/src/pyramid.rs`, ingest, and cache modules.)

- [ ] **Step 3: Full gate** — `./scripts/test.sh quick` then `./scripts/test.sh full`. Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -m "refactor: delete the frontend tile/pyramid plotting path"`

### Task 12: CI WebGPU, E2E, Bench, and Handoff

**Files:**

- Modify: `frontend/playwright.config.ts` (chromium `launchOptions.args`: `["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-webgpu-adapter=swiftshader"]` on every project)
- Create: `frontend/tests/e2e/webgpu-probe.spec.ts`
- Modify: `frontend/tests/e2e/{app,interactions}.spec.ts`, `frontend/tests/bench/bench.spec.ts`, `scripts/test.sh` bench notes, `docs/implementation-roadmap.md`
- Test: this task _is_ tests

**Interfaces:**

- Probe spec: `expect(await page.evaluate(() => !!navigator.gpu && !!(await navigator.gpu.requestAdapter())))` (async-wrapped) must pass; on failure the error message must say which flag set to check — this converts "renderer silently unsupported in CI" into one obvious failure.
- `app.spec.ts`/`interactions.spec.ts`: `.plot-canvas` visibility assertions still hold (chrome canvas keeps the class); add one assertion that `.chart-gpu-host canvas` exists and one unsupported-screen test (launch a context with WebGPU disabled via `--disable-features` and assert `.unsupported-host` text).
- Bench: rework `bench.spec.ts` to load the re-baked mc1000 artifact, record cold first plot, interaction frame p50/p95/max, longest task, and JS heap; write `build/bench/report.json` entries under new keys (`e2e_mc1000_chartgpu`). Replace floor _assertions_ with recorded values plus a regression cap against the checked-in new baseline (spike reference points: ~3.2 s first plot, ~145 ms zoom p95 at 1000×10k in a native browser; CI software adapter will be slower — the baseline is recorded on the runner, not copied from the spike).

- [ ] **Step 1: Probe + flags, run `./scripts/test.sh e2e`** — if the software adapter is genuinely unavailable on this runner, stop and surface it; do not mark tests skipped silently.
- [ ] **Step 2: Update e2e specs; re-run until green.**
- [ ] **Step 3: Re-record bench baselines** — `./scripts/test.sh bench`; commit new `build/bench` baseline JSONs the suite reads; note absolute numbers and the delta story in the handoff.
- [ ] **Step 4: Roadmap + memory** — roadmap gets the measured numbers and the operating envelope; note the pyramid-removal follow-up plan as open work.
- [ ] **Step 5: Final gate + commit**

```bash
./scripts/ci.sh   # or ./scripts/test.sh full if ci.sh is the wrong wrapper for local
git add frontend docs build/bench
git commit -m "test: WebGPU CI gates, e2e updates, ChartGPU bench baselines"
```

---

## Out of Scope (explicit)

- Removing `core/scope-core/src/pyramid.rs`, sidecar pyramid sections, and ingest pyramid stages — follow-up plan after this ships.
- Live streaming/ring ingest; additional plot types.
- Session schema changes (v22 untouched; `dash`, `ghost_mode`, overrides, annotations all keep their fields and UI).
- Any change to gesture semantics, keyboard shortcuts, legend, stats strip, or annotation UX.

## Risks Accepted

- **Transparency fallback** (Task 6) changes who draws gridlines if ChartGPU can't composite transparently; either path preserves the visual spec, the fallback just moves the grid to ChartGPU with forced tick positions.
- **Hover emphasis keeps the shipped values** (emphasized `alpha +0.4` / `width +0.4`, others dimmed to `0.25`), which diverge from the Final Spec's `.35`/`1.3` — familiarity (requirement A) wins over the spec here; noted, not changed.
- Snapshot preview stats become stride-approximate (exact at `full` fidelity).
- Zoom p95 at 1000 series measured ~145 ms in the spike — over the old 33 ms floor but subjectively better than the tile path because interaction never waits on acquisition; bench records rather than gates on the old floor.
- Datasets beyond 32 M points or span/interval > ~10^7 are refused or degrade; ADR 0040 documents the recovery path (revive the pyramid).

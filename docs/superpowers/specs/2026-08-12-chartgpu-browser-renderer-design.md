# ChartGPU render path on a browser-only shell — design

- Date: 2026-08-12
- Status: Approved (Edward, 2026-08-12)
- Branch: `better_charts_reattempt` (spawned from `main`; the
  `unified_fast_renderer` branch is reference history only)

## Problem

Canvas2D rendering on `main` is adequate up to ~hundreds of runs and
unacceptable at thousands. The render architecture is scattershot: plot
strokes, chrome, overlays, and hit-testing evolved separately. The previous
attempt (`unified_fast_renderer`) proved WebGPU delivers the needed
performance but drowned in shell/platform churn: Tauri's WebKitGTK webview
has no WebGPU at all, and the Electron replacement brought its own platform
problems (dynamic-import hangs on Windows, per-platform GPU switch sets).

## Goals and non-goals

**Acceptance target:** one panel showing 1,000 runs × ~100k samples
(~100M raw points behind LOD) with smooth interactive pan/zoom.
**Identity invariant:** every run is a real, individually pickable line at
every zoom level. LOD may reduce samples within a series; nothing may merge,
band, or drop series (carries forward the ADR 0039 stance).

**In scope:** time-series panels only; browser-only delivery; ChartGPU
adoption; deletion of the Tauri shell and the Canvas2D plot-stroke path.
**Out of scope (later work on this foundation):** XY / FFT / histogram panel
types; pyramid/ingest changes; any fork of ChartGPU (explicit trigger below).

## Decisions (locked 2026-08-12)

1. **Browser-first, shell deleted early.** SignalScope becomes a localhost
   Rust server + browser UI. This is an internal tool: the Chromium version
   and flags are dictated, so WebGPU-required is acceptable and the entire
   webview-compatibility problem space (Tauri, Electron, WebKitGTK) is
   deleted rather than solved.
2. **Engine: stock ChartGPU, pinned to an upstream master rev.** No fork.
   Built from source under nix (upstream ships no `dist/`). Pinning master
   keeps nix vendoring and builds simple.
3. **Feeding model: full-extent LOD columns (Approach B).** Each bound
   series gets one budget-derived, extrema-preserving LOD column covering
   the whole time extent, assembled by the Rust host from the existing tile
   pyramid. ChartGPU's own GPU decimation handles intra-window density;
   gestures move only its zoom range — zero data traffic while interacting.
4. **The pyramid stays** (Edward, explicitly). It bounds memory/transfer
   independent of dataset size, guarantees extrema preservation that
   ChartGPU's high-density approximation does not, and is what out-of-core
   datasets (ADR 0029) require. Its render-path role shrinks to "choose the
   column resolution"; tile residency/window machinery in the frontend goes
   away.
5. **ChartGPU owns axes and grid; the host owns gestures.** ChartGPU's axes
   cannot be disabled, so the Canvas2D chrome path is deleted instead of
   fought. The existing overlay canvas stays on top with pointer events and
   the gesture layer is preserved unchanged.

## Architecture

### Shell and transport (Phase 1)

- The Rust plane becomes `scope-server`: an Axum HTTP/WebSocket server bound
  to authenticated loopback (token handed to the page at launch), serving
  the built frontend and the versioned protocol. This reuses the
  `scope-host`/`scope-server` extraction shape from the 2026-08-09 Electron
  spec, minus Electron.
- The two-host `DataPlane` architecture is preserved. The Tauri-IPC backend
  is replaced by a WebSocket/HTTP backend speaking the same versioned
  protocol; binary framing per ADR 0036 carries over. The baked-snapshot
  backend is untouched.
- Sessions, preferences, ingest, drag-drop import (via file picker /
  host-side paths), CSV/PNG export, and snapshot writing remain host-side:
  the host owns the filesystem, so ADR 0022/0023/0024 semantics carry over.
- Self-contained no-network snapshots keep working; ChartGPU is bundled into
  the snapshot template. `check-snapshot.mjs` budget rises once,
  deliberately (750k → 1.5M, as sized in the 2026-08-07 plan).
- `shell/src-tauri` is deleted. Launch flow: `signalscope` binary starts the
  server and opens the dictated Chromium at the tokened localhost URL.

### Render path (Phase 2)

- **Column feeding.** New protocol message `query_columns_bin`: the host
  assembles one full-extent, extrema-preserving column per bound series from
  the pyramid. Resolution is budget-derived: ~8–16k points per series,
  scaled so a 1k-series panel stays ≈64–128 MB resident (under ChartGPU's
  ~16.7M-points-per-series storage cap with wide margin per series). Time
  values are normalized by the workspace `tRef` before feeding (f32 banding
  rule); all app/session state stays in raw time.
- **ChartHost.** One per panel, owning one ChartGPU instance created against
  a shared `GPUDevice` + shared pipeline cache; all charts render in external
  render mode from a single host rAF loop with the submit batcher coalescing
  queues. Series data is fed as column-shaped typed arrays with
  `sampling` enabled (ChartGPU rebuckets per frame from resident data);
  `animation: false`.
- **Gestures and picking.** ChartGPU tooltip, legend, and zoom slider are
  off. The overlay canvas keeps all pointer handlers; `plot-gestures.ts`,
  `plot-math.ts`, `plot-interactions.ts` and their tests are preserved with
  unchanged behavior. Gestures drive ChartGPU's zoom range; picking calls
  the public `hitTest(e)`. Overlay z-order sits above ChartGPU's injected
  DOM overlays; ChartGPU's canvas is the bottom (opaque) layer.
- **Chrome.** ChartGPU draws axes/grid; `tickFormatter` re-applies `tRef` so
  labels show raw time. Grid styling through its config; the Canvas2D
  chrome/plot-stroke path is deleted.
- **Ensembles.** Mean/envelope (ADR 0028) maps to ChartGPU's native `band`
  series type (`{x, y, y1}` columns).
- **Refeeds.** Changing bound series, fidelity setting, or extent triggers a
  batched `setOption` with fresh element objects only for changed series
  (reference identity skips the rest). Refeeds are occasional by design;
  they never happen inside a gesture.

### Deep-zoom refinement (Phase 3, contingent)

At ~16k resident points per 100k-sample run, zooming below ~15% of the
extent goes visibly coarse. If Phase 0/2 confirm it matters: when the view
crosses a fidelity threshold, refeed only visible series with a finer
padded-window column (hysteresis-gated, batched). This is the sole place
ChartGPU's lack of a per-series data setter bites; rarity keeps stock
ChartGPU sufficient. **Fork trigger:** if these rare refeeds still miss
budget, vendor ChartGPU and add `setSeriesData` only — nothing else.

## Phases

- **Phase 0 — spike gate (throwaway, no production code).** Stock ChartGPU
  at the pinned rev, 1k series × ~16k-point columns in one chart in the
  dictated Chromium. Pass/fail numbers written down _before_ running:
  first-frame time, sustained pan/zoom FPS, full 1k-series `setOption`
  refeed latency, GPU/CPU memory, hairline appearance (>500k total segments
  forces 1-px lines), and an extrema-fidelity check (injected 1-sample
  transient must survive zoomed-out rendering). Harness lives outside
  `frontend/src` (scratch or `refs/`-adjacent). If the spike fails on
  something stock ChartGPU cannot fix, reconvene before any production work.
- **Phase 1 — browser shell.** `scope-server`, WebSocket DataPlane backend,
  Tauri deletion, launch flow, session/preference/snapshot parity.
- **Phase 2 — ChartGPU render path.** Column protocol, ChartHost, chrome
  swap, picking, band series, deletion of the Canvas2D plot path.
- **Phase 3 — contingent refinement** (above), plus any spike-revealed
  mitigation (`performance.lod: 'strict'` etc.).
- **Phase 4 — hardening.** Bench `mc1000` tier as acceptance floor
  (ADR 0035 harness), CI WebGPU lane, dead-code sweep.

## Deletions and governance

- Delete: `shell/src-tauri`; frontend tile-assembly and Canvas2D plot-stroke
  path (`canvas-renderer.ts` stroke portion, tile window cache, bin columns,
  bin-based hit path) once Phase 2 lands. Keep compiled: Rust pyramid,
  ingest stages, protocol tile messages (follow-up cleanup owns their fate).
- New ADRs: **browser-only host** (supersedes the Tauri-shell ADRs; records
  the dictated-Chromium premise) and **ChartGPU render path** (amends the
  render half of ADR 0036; records pin-to-master, no-fork-yet, and the fork
  trigger).
- Protocol bumps once for `query_columns_bin`. Session schema unchanged.
- AGENTS.md non-negotiables survive intact: two-host DataPlane, versioned
  schemas, pyramid gap/extrema invariants, transactional ingest,
  self-contained snapshots.

## Amendments (2026-08-12, post-exploration, pre-plan)

Codebase exploration (DataPlane/protocol, build/CI, render path) corrected
six assumptions. These amendments override the corresponding text above.

1. **HTTP, not WebSocket.** The only host→frontend push channel today is
   Tauri drag-drop forwarding; ingest progress is polled. The browser
   backend is therefore a plain HTTP POST RPC plane (`fetch` per command,
   JSON envelopes; `query_tiles_bin` returns `application/octet-stream`
   whose byte 0 is the tile-binary magic, which is exactly what
   `decodeTileResponse` requires). No WebSocket, no framing, no
   request-correlation machinery.
2. **No new protocol message.** `query_tiles_bin` +
   `Pyramid::query_with_target` already return budget-scaled,
   extrema-preserving per-series columns for an arbitrary window. A
   full-extent LOD column is a tile query whose window is the full time
   extent. Phase 2 needs no protocol bump; `query_columns_bin` is dropped.
   Bins carry first/min/max/last (M4), which converts directly to line
   points in the same vertex order `plot-hit.ts` already walks.
3. **Ensemble bands do not exist.** ADR 0028 was superseded (bundled
   series highlights); the band renderer was already removed. Bundles
   plot as ordinary member strokes with emphasis. The `band`-series task
   is dropped; instead the emphasis/ghost contract (emphasis `alpha
+0.4` / `width +0.4`, non-emphasized dim to `0.25`, ghosts in `fg4`)
   must be reproduced via per-series ChartGPU `lineStyle`.
4. **XY / FFT / histogram panels stay, on Canvas2D.** They exist on
   `main`, render via the samples path (`renderPaths`), and deleting them
   would force a session-schema bump. This redo replaces only the
   **time-series stroke path**. `CanvasRenderer` survives for the other
   modes; ChartGPU owns axes/grid **for time panels only**. Mode switches
   toggle visibility between the ChartGPU host and the 2D plot canvas.
5. **Picking keeps `plot-hit.ts`.** The frontend still holds the decoded
   bin columns, and the M4 feed order matches `plot-hit`'s vertex walk,
   so the existing hit adapter stays correct. ChartGPU `hitTest` is not
   used.
6. **Window drag-drop is dropped in the browser shell.** HTML5 drop
   yields file contents, not host paths, and the entire ingest/restore
   pipeline is path-based (durable source identity, ADR 0027). Import
   flows use native dialogs opened by `scope-server` via `rfd` (the
   server runs on the user's desktop). Recorded in the browser-host ADR
   as a deliberate regression; a content-upload path can return later.
7. **ChartGPU is vendored as pinned source, not an npm/git dependency.**
   Upstream ships no `dist/` and no `prepare` script, so a pnpm git dep
   arrives unbuilt; its WGSL imports are Vite-native `?raw`. A
   `./scripts/vendor-chartgpu.sh` wrapper copies pristine `src/` at the
   pinned rev into `frontend/vendor/chartgpu/`; a Vite alias resolves the
   import; our `tsc` project excludes it (a hand-written `.d.ts` types
   the surface we use). No `package.json` dependency entry at all, so
   `check-runtime-deps.mjs` stays untouched.
8. **PlotLayout is the preserved contract.** Whoever renders a panel must
   publish a `PlotLayout` (plot rect + ranges); for time panels the
   ChartGPU host derives it deterministically from its configured `grid`
   margins. Gestures drive `setZoomRange` (X) and axes-only `setOption`
   (Y explicit min/max) — both documented O(1) hot paths.

9. **Data flow: ChartGPU replaces the stroke sink, not the tile
   pipeline.** `PanelView.renderData` already receives budget-scaled,
   padded-window, extrema-preserving tile slices from the existing
   `TileWindowCache` pipeline, and pans inside the padded window are
   cache hits. Phase 2 therefore feeds ChartGPU whatever `renderData`
   delivers (the windowed response), instead of a separate full-extent
   feed: view ranges move via explicit axes-only `setOption` every
   gesture frame (O(1)); series data refeeds only when the tile pipeline
   would have re-rendered anyway (window-cache miss / new tiles). This
   preserves today's progressive zoom refinement through pyramid levels,
   which makes Phase 3 refinement largely moot. The Phase 0 spike gates
   the refeed cost (1k series per cache miss) and the per-frame
   axes-only `setOption` cost. `sampling: 'none'`, no `dataZoom` —
   explicit `min`/`max` on both axes so panning past the data edge keeps
   working.

## Testing

- Phase 0 spike numbers become bench floors for the `mc1000` tier.
- Gesture/interaction unit tests preserved unchanged (behavioral contract).
- Playwright e2e against the served browser app with software WebGPU
  (SwiftShader switch set on Linux — known-good from the previous branch).
  WSL2 cannot validate WebGPU locally; GPU acceptance runs on native
  hardware or CI.
- Snapshot self-containment and size checks keep running.

## Risks

| Risk                                                | Mitigation                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1k-series `setOption` refeed cost                   | Refeeds are rare by design; spike measures the worst case; fork trigger scoped to `setSeriesData`                             |
| ChartGPU decimation drops narrow transients         | Columns are pyramid-extrema-preserving; spike includes an injected-transient check; `sampling` mode chosen from spike results |
| Hairline forcing above 500k segments                | Accept (reasonable at 1k series) or `performance.lod: 'strict'` after spike                                                   |
| No upstream `dist/`; building from source           | Nix derivation off the pinned master rev (also the reason for pinning master)                                                 |
| ChartGPU DOM overlays / z-order fights              | Overlay canvas above everything with pointer events; tooltip/legend/slider disabled                                           |
| Browser-only feature regressions (drag-drop, menus) | Phase 1 parity checklist against ADR 0020–0024 behaviors; host owns FS                                                        |

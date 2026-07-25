# Phase 2B — Panel Modes, Colour Channel, and Touch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 2 by giving panels the three non-time modes the Final Spec draws — XY (with the amber drop strip and the `c:` colour channel plus its colorbar), FFT, and histogram — and by restoring the prototype's full touch gesture set on top of 2A's desktop interactions.

**Architecture:** One new protocol request (`query_samples`) returns a _decimated, capped window slice_ of raw samples; everything else is presentation-plane maths over that bounded slice. XY pairing, spectra, and histograms therefore live in pure TypeScript modules that both hosts run identically — the same arrangement ADR 0014 already established for the visible-statistics strip, and the reason no UI code branches on host identity. `CanvasRenderer` grows a second entry point (`renderPaths`) that draws vertex arrays against arbitrary x ranges with optional log scaling and optional per-vertex colour, which is what XY, FFT, and histogram all need and what the bin-oriented `render()` cannot express. Session state gains a panel-local `x_range` because in every non-time mode the x axis is a value axis, never the linked time window.

**Tech Stack:** TypeScript (vanilla, Vite, Canvas 2D), Vitest, Playwright; Rust (`scope-core`, `scope-protocol`, `signalscope-shell`). No new dependencies on either side — the FFT is a dependency-free radix-2 transform in the frontend.

## Global Constraints

- Every workflow command goes through `./scripts/`. Quick red/green loops may use `./scripts/dev.sh <cmd>` (runs an arbitrary command inside the Nix shell); each task ends with the full relevant gate. Do not invoke `pnpm`, `npx`, `vitest`, or `cargo` bare.
- `frontend/src/generated/*.ts`, `protocol/src/generated.rs`, and `core/scope-core/src/session/generated.rs` are codegen outputs of `protocol/schema/*.json`. Never hand-edit them; run `./scripts/dev.sh pnpm codegen` after schema edits and keep `pnpm codegen:check` green. **`codegen:check` also runs `rustfmt --edition 2024` over the two generated `.rs` files — running bare `pnpm codegen` and committing without that rustfmt fails CI.**
- Amber (`--amber-7`, `--amber-9`, `--amber-3`, `--focus-ring`) is **interaction-only**: cursor, box-zoom band, Δ readouts, the XY drop strip, the XY cursor ring, drag targets, ƒx marks. Never a series colour, never an active-control fill. Chrome stays achromatic (`--surface-4` + `--fg-1` for active states) — the spec repeats this twice, verbatim: _"ALL chrome achromatic — active toggles and mode pills are surface-4 + fg-1, never amber."_
- The sequential colormap is **not** the categorical series palette. Per ADR 0011 it is sampled from Fabio Crameri's Scientific colour maps (`batlow`); no rainbow map and no map lacking monotone lightness is admissible.
- Dark surfaces stay near-black and flat: 1px seams, radii ≤ 4px, no glows/gradients/shadows (`--elev-*` popover shadows are the sanctioned exception for popovers/tooltips). Light mode is a token swap only.
- All values, paths, axes, readouts: `--font-mono` (JetBrains Mono) with `font-variant-numeric: tabular-nums`, values `%.4f` via `formatValue`, `—` for absent, U+2212 for minus in tick labels.
- A keyboard path must exist for every pointer action — the command palette (⌘P in this build; the spec writes ⌘K) is the sanctioned long-tail path. Right-click is never the only way to do anything, and neither is drag-and-drop: touch cannot drag, so every drop-strip action needs a palette twin.
- UI and renderer code never branch on host identity. Anything computed for a plot must work from protocol payloads so `BakedPlane` snapshots behave identically.
- Preserve: two-host `DataPlane`, versioned protocol/session schemas, tile-pyramid gap/extrema invariants, transactional ingest, self-contained no-network snapshots.
- Do not use `git add -A`. Stage only the files named in each task's commit step. Preserve unrelated worktree changes; inspect `git status` before each task. **The worktree currently contains untracked `Screenshot 2026-07-25 *.png` files — never stage them.**

### Toolchain facts this plan depends on

Verified against the tree at commit `091b8cf`; if any turn out false, stop and escalate.

- `./scripts/test.sh frontend` runs `pnpm lint && pnpm typecheck && pnpm codegen:check && pnpm test`, then snapshot artifact checks. Every "expected: PASS" step must therefore also lint and typecheck.
- `./scripts/test.sh core` runs the Rust workspace tests excluding the shell crate; `./scripts/test.sh full` adds `cargo test -p signalscope-shell` and e2e. `./scripts/test.sh e2e` runs Playwright. `./scripts/ci.sh all` is the full gate.
- `tsconfig.json` sets `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. ESLint runs `typescript-eslint` **strictTypeChecked** — no `any`, no non-null assertions. Indexing an array yields `T | undefined`; use `?? fallback`.
- Vitest runs in the **node environment — no jsdom**. Unit tests cannot touch `document`/`window`/`HTMLCanvasElement`. All new geometry, pairing, spectrum, histogram, and colormap logic must live in pure modules or be tested through the recording-canvas pattern in `frontend/src/render/overlay-renderer.test.ts` (a `Proxy` recording context + a `fakeCanvas` object + `setPalette` injection).
- Playwright has two projects: `desktop` and `mobile-review` (Pixel 7). Desktop gesture tests carry `test.skip(isMobile, "desktop interaction")`; the new touch tests invert that with `test.skip(!isMobile, "touch interaction")`.
- The dev server and all e2e tests run against `BakedPlane`'s demo manifest: two signals `rocket/velocity_body/x|y`, 1,800 points at 30 Hz, t ∈ [0, 59.9667]. `window.__TAURI_INTERNALS__` is absent, so `plane.ingest === null` and the `Open CSV / MCAP` button is hidden.
- Wire `u64` values are **strings** in TypeScript (`sample_count: "1"`). Convert with `Number(...)` before arithmetic. The codegen attaches its u64 serde adapters **by exact type-string match only** (`"u64"` and `"u64[]"`): a field typed `u64?` or `u64[]?` silently loses the adapter and desynchronizes Rust from TS. **This plan uses no optional u64 fields.** If a future task needs one, extend `protocol/scripts/generate-types.mjs` first.
- Generated object types derive `Clone, Debug, PartialEq, Deserialize, Serialize` in Rust; the schema mini-language supports `bool|f32|f64|string|u8|u32|u64`, `?`, `[]`, `[N]`, objects, enums — nothing else, and only the `object` and `enum` kinds. All types in this plan fit; no generator change is needed.
- Rust workspace lints: `unsafe_code = "forbid"`, clippy `all` + `pedantic` at warn, and CI runs `cargo clippy --workspace --all-targets -- -D warnings`. `Cargo.lock` is one of four release manifests `./scripts/version.sh check` validates, so **adding a Cargo dependency is a version-gate event** — this plan adds none.
- `frontend/package.json` has **zero runtime dependencies**. Keep it that way: the FFT is hand-written.
- `frontend/scripts/check-snapshot.mjs` enforces a **750,000-byte** ceiling on `dist/snapshot-template.html`, forbids any `src`/`href` attribute and any `http(s)://` string. New code must not add fetches or external assets.

---

## Scope: what this plan is and is not

The roadmap's Phase 2 line is: _"Finish linked desktop and touch gestures, gutter/inline axes, editable labels, split legend inspector, visible statistics, annotations and delta readouts, XY drop strip, color channel and colorbar, FFT, and histogram modes."_ Phase 2A shipped everything before "XY drop strip". **This plan is the remainder**, exactly as 2A's deferral table promised:

| In scope (2B)                                         | Tasks  |
| ----------------------------------------------------- | ------ |
| Windowed raw-sample protocol request (the data floor) | 1, 2   |
| XY mode, drop strip, cursor coupling, datatips        | 3–6    |
| `c:` colour channel + colorbar + `batlow` tokens      | 7, 8   |
| FFT mode                                              | 9, 10  |
| Histogram mode                                        | 11, 12 |
| Touch gesture set                                     | 13     |
| Toolbar Σ stats toggle, mode-aware hints, docs        | 14     |

Still out of scope, and a reviewer should reject a diff that adds them:

| Deferred                                                         | Why                                                                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Legend-inspector `smooth` / `deriv` transforms                   | ADR 0008: expression evaluation is a native protocol request that does not exist until Phase 3. No dead buttons. |
| Derived signals in the tree, formula-bar execution               | Phase 3.                                                                                                         |
| `follow` time mode, session save/load, autosave, snapshot export | Phase 3/4. The `⏸ FOLLOW` toolbar slot stays `disabled`.                                                         |
| PNG/CSV export, screenshot matrices                              | Phase 4.                                                                                                         |
| 3D / geo panels, layout-preset UI, Monte-Carlo envelopes         | v2 per the spec's build order.                                                                                   |
| The prototype's `1:1` equal-axis flag                            | See decision 9 — it has no home in the final chrome and no spec line. Not carried over.                          |

## Decisions requiring maintainer awareness

These are judgement calls the design package does not make. Each is applied in a task and recorded in an ADR; review them before execution.

1. **Compute lives in the presentation plane, not `scope-core`.** ADR 0008 puts _expression evaluation_ natively (it is user-authored code — an eval-surface question). XY pairing, spectra, and histograms are bounded derived views of what is already on screen, which is the class ADR 0014 already settled by computing the stats strip in TypeScript from displayed bins. One protocol request (`query_samples`) supplies the bounded input; the three maths modules are pure TS run identically by both hosts. This buys: no Rust↔TS algorithm duplication, no conformance fixture per mode, and no possibility of a snapshot behaving differently from the workbench. Recorded as **ADR 0015** (Task 1).
2. **`query_samples` is capped, decimated, and edge-inclusive** — `max_points` with an integer stride, plus one neighbouring sample beyond each window edge so strokes reach the border. The stride rule is the one thing both hosts must agree on, so it _is_ fixture-locked (`protocol/testdata/sample-conformance.json`), exactly like pyramid level selection.
3. **`BakedPlane` answers `query_samples` from `levels[0]`.** In the demo manifest level 0 is one degenerate bin per raw sample, so this is exact. ADR 0007 names level selection as the snapshot budgeting lever, so a future exporter that drops level 0 degrades XY/FFT/histogram to bin resolution. ADR 0015 states that requirement for the Phase 4 exporter rather than silently depending on it.
4. **Session schema v5 adds `x_range: f64[2]?`.** In XY, FFT, and histogram modes the x axis is a value axis, so it cannot borrow the linked time window and cannot reuse `time_window`. One field serves all three modes.
5. **FFT semantics** (nothing in the design package specifies any of this): input is the visible time window, resampled onto a uniform grid of the largest power of two ≤ the returned sample count, clamped to [64, 4096]; mean removed; Hann taper; one-sided magnitude from bin 1 (DC is dropped because a log axis cannot show f = 0); amplitude normalized to the peak bin so 0 dB is the peak, floored at −120 dB. Multi-series panels draw one spectrum per visible series. Recorded as **ADR 0017** (Task 9).
6. **Histogram semantics** (zero spec coverage — this is a design decision, not an extraction): counts of the visible window's samples, Freedman–Diaconis bin width with a Sturges fallback for degenerate IQR, bin count clamped to [8, 128], shared edges across series computed from the union of their ranges, drawn as step outlines in series colour rather than filled bars so overlap stays readable. Recorded as **ADR 0018** (Task 11).
7. **The colormap ramp is theme-invariant.** Categorical slots re-step per theme (ADR 0011) because their job is identity; a sequential ramp's job _is_ its monotone lightness, so re-stepping it per surface would destroy the property that makes it admissible. One 16-stop `batlow` ramp serves both themes, separated from the surface by the colorbar's 1px border. Recorded as **ADR 0016** (Task 7).
8. **The `c:` channel has no pointer affordance in the spec** — only the ⌘K row `Panel: set color signal (c:)…`. This plan ships that command plus a `c:` chip whose caret opens the same picker, and does **not** invent a second drop zone. Removing the colour signal collapses the colorbar gutter and returns every trajectory to its categorical series colour.
9. **The prototype's `1:1` equal-axis control is dropped.** It exists in no part of the final chrome (not the header, not the inspector, not the palette rows the spec enumerates) and no spec sentence mentions it. Reintroducing it would mean designing a home for it. Flagged here so the omission is a decision rather than an oversight.
10. **FFT and histogram are built even though the spec's own build order omits them from v1 and v2.** The FFT panel is one of the four panels in F2, the pixel reference, so it is clearly intended; histogram appears in no mock at all and is built to the minimum that makes the `H` pill honest. If the maintainer would rather leave `H` inert, cut Tasks 11–12 — nothing else depends on them.
11. **Mode-specific status hints are v2 per the spec**, so the status bar keeps its desktop gesture strip. Per-mode help arrives as palette rows (`Help: XY mode gestures`, and its FFT/histogram twins), which is the surface the spec itself sanctions.
12. **`T` collides**: the spec labels the Time mode pill `T` while the light-mode sheet still says "T toggles theme". This build already binds `t` to the theme toggle and the pill is click/palette-driven, so the collision is resolved in favour of the existing binding; mode switching gets palette rows, not letter keys.
13. **Out-of-coverage interpolation yields NaN, not the endpoint value.** The prototype's `lerpAt` held a signal's first/last value flat past each end, so an XY trajectory kept drawing where one of its two signals had no data. This plan returns NaN there and lifts the pen instead. A segment drawn past a signal's data is fabricated, and ADR 0003 already commits this codebase to breaking strokes rather than bridging absent data. The same rule aborts a spectrum whose window resamples onto a gap.

## File structure (created/modified across the plan)

```
protocol/schema/scope-protocol.json      v4: SampleRequest/SampleSeries/SampleResponse   (Task 1)
protocol/schema/scope-session.json       v5: PanelState += x_range                        (Task 2)
protocol/testdata/sample-conformance.json NEW: stride/edge rule fixture                   (Task 1)
core/scope-core/src/compute.rs           sample_window() + tests                          (Task 1)
core/scope-core/src/session.rs           v4→v5 migration arm + test                       (Task 2)
shell/src-tauri/src/lib.rs               query_samples command + handler registration     (Task 1)
docs/adr/0015-window-sample-requests.md  NEW                                              (Task 1)
docs/adr/0016-sequential-colormap.md     NEW                                              (Task 7)
docs/adr/0017-spectrum-semantics.md      NEW                                              (Task 9)
docs/adr/0018-histogram-semantics.md     NEW                                              (Task 11)
frontend/src/app/samples.ts              NEW: stride mirror + bin→sample extraction       (Task 1)
frontend/src/app/data-plane.ts           querySamples on the interface + both planes      (Task 1)
frontend/src/app/xy.ts                   NEW: pairing/resampling, extents, nearest point  (Task 3)
frontend/src/app/spectrum.ts             NEW: resample, Hann, radix-2 FFT, dB             (Task 9)
frontend/src/app/histogram.ts            NEW: FD/Sturges binning                          (Task 11)
frontend/src/app/colormap.ts             NEW: batlow lookup + tick domain                 (Task 7)
frontend/src/app/plot-math.ts            log-scale projection + pinch helpers             (Tasks 9, 13)
frontend/src/app/workspace.ts            setPanelXRange/clearPanelXRange/setXSignal/
                                         setColorSignal/promoteSeriesToX                  (Tasks 2–4, 8)
frontend/src/render/canvas-renderer.ts   renderPaths(): vertex paths, log x, colorbar     (Tasks 3, 8, 10, 12)
frontend/src/render/overlay-renderer.ts  XY marker ring, XY/FFT/histogram readouts        (Tasks 6, 10, 12)
frontend/src/ui/panel.ts                 mode dispatch, drop strip, x:/c: chips, touch    (Tasks 3–13)
frontend/src/ui/workspace-view.ts        renderData() carrying samples                    (Task 2)
frontend/src/ui/app-shell.ts             sample fetch, x-range routing, new commands      (Tasks 2–14)
frontend/src/styles/tokens.css           --seq-01 … --seq-16                              (Task 7)
frontend/src/styles/palette.test.ts      colormap monotonicity/CVD checks                 (Task 7)
frontend/src/styles/app.css              drop strip, chips, colorbar gutter, touch sizes  (Tasks 3–13)
frontend/tests/e2e/modes.spec.ts         NEW: grows a scenario per mode                   (Tasks 3–12)
frontend/tests/e2e/touch.spec.ts         NEW: mobile-project gestures                     (Task 13)
docs/implementation-roadmap.md           Phase 2 closed                                   (Task 14)
docs/superpowers/plans/2026-07-24-00-INDEX.md  2B row                                     (Task 14)
```

Task sequencing: **1 → 2** first (they are the data and state floor everything else stands on). Then **3 → 4 → 5 → 6** (XY), **7 → 8** (colour, needs 3), **9 → 10** (FFT), **11 → 12** (histogram). Task 9 needs Task 3 only for `lerpSample`; Task 11 needs nothing past Task 2. So after Task 3 lands, a second implementer can take 9–12 in parallel with 4–8. **13** needs 3–6 (it extends the same gesture binder and reuses the split `plotClick`). **14** last.

---

## Task 1: Windowed sample requests (protocol v4, `query_samples`, ADR 0015)

**Files:**

- Modify: `protocol/schema/scope-protocol.json`
- Modify: `core/scope-core/src/compute.rs`
- Modify: `shell/src-tauri/src/lib.rs`
- Create: `frontend/src/app/samples.ts`
- Create: `frontend/src/app/samples.test.ts`
- Modify: `frontend/src/app/data-plane.ts`
- Create: `protocol/testdata/sample-conformance.json` (generated, then committed)
- Create: `docs/adr/0015-window-sample-requests.md`

**Interfaces:**

- Produces (Rust): `scope_core::compute::SampleSlice { time: Vec<f64>, values: Vec<f64>, stride: u32 }` and `compute::sample_window(time: &[f64], values: &[f64], t0: f64, t1: f64, max_points: u32) -> SampleSlice`.
- Produces (TS): `sampleWindow(time: readonly number[], values: readonly number[], t0: number, t1: number, maxPoints: number): { time: number[]; values: number[]; stride: number }` and `binsToSamples(bins: readonly EnvelopeBin[]): { time: number[]; values: number[] }`, both from `frontend/src/app/samples.ts`.
- Produces (protocol): `SampleRequest { request_id: string; signal_ids: string[]; window: TimeWindow; max_points: number }`, `SampleSeries { signal_id: string; signal_path: string; unit: string | null; time: number[]; values: number[]; stride: number }`, `SampleResponse { request_id: string; series: SampleSeries[] }`.
- Produces (TS): `DataPlane.querySamples(request: SampleRequest): Promise<SampleResponse>`.

- [ ] **Step 1: Write the failing Rust test**

Append to the `mod tests` block at the end of `core/scope-core/src/compute.rs`:

```rust
    #[test]
    fn sample_window_includes_one_neighbour_past_each_edge() {
        let time: Vec<f64> = (0..10).map(f64::from).collect();
        let values: Vec<f64> = time.iter().map(|value| value * 2.0).collect();
        let slice = sample_window(&time, &values, 3.0, 5.0, 100);
        assert_eq!(slice.stride, 1);
        assert_eq!(slice.time, vec![2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(slice.values, vec![4.0, 6.0, 8.0, 10.0, 12.0]);
    }

    #[test]
    fn sample_window_strides_to_the_cap_and_keeps_the_last_sample() {
        let time: Vec<f64> = (0..100).map(f64::from).collect();
        let values = time.clone();
        let slice = sample_window(&time, &values, 0.0, 99.0, 10);
        assert_eq!(slice.stride, 10);
        assert_eq!(slice.time.first(), Some(&0.0));
        assert_eq!(slice.time.last(), Some(&99.0));
        assert!(slice.time.len() <= 11, "cap plus the retained last sample");
        assert_eq!(slice.time.len(), slice.values.len());
    }

    #[test]
    fn sample_window_outside_the_data_is_empty() {
        let time: Vec<f64> = (0..10).map(f64::from).collect();
        let values = time.clone();
        let slice = sample_window(&time, &values, 100.0, 200.0, 64);
        assert!(slice.time.is_empty());
        assert!(slice.values.is_empty());
        assert_eq!(slice.stride, 1);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/dev.sh cargo test -p scope-core compute::`
Expected: FAIL — `cannot find function 'sample_window' in this scope`.

- [ ] **Step 3: Implement `sample_window`**

Add to `core/scope-core/src/compute.rs`, above the `#[cfg(test)]` block:

```rust
/// A decimated slice of a signal restricted to a time window.
#[derive(Clone, Debug, PartialEq)]
pub struct SampleSlice {
    pub time: Vec<f64>,
    pub values: Vec<f64>,
    /// The index step applied while decimating; 1 when nothing was dropped.
    pub stride: u32,
}

/// Selects at most `max_points` samples inside `[t0, t1]`, plus one
/// neighbour past each edge so strokes reach the plot border.
///
/// The index arithmetic here is protocol surface: `BakedPlane` mirrors it in
/// TypeScript and `protocol/testdata/sample-conformance.json` locks the two
/// together.
///
/// # Panics
///
/// Panics when `time` and `values` have different lengths.
#[must_use]
pub fn sample_window(
    time: &[f64],
    values: &[f64],
    t0: f64,
    t1: f64,
    max_points: u32,
) -> SampleSlice {
    assert_eq!(time.len(), values.len(), "time/value lengths differ");
    let start = time.partition_point(|value| *value < t0).saturating_sub(1);
    let end = (time.partition_point(|value| *value <= t1) + 1).min(time.len());
    if start >= end {
        return SampleSlice {
            time: Vec::new(),
            values: Vec::new(),
            stride: 1,
        };
    }
    let span = end - start;
    let cap = max_points.max(1) as usize;
    let stride = span.div_ceil(cap).max(1);
    let mut picked_time = Vec::with_capacity(span / stride + 2);
    let mut picked_values = Vec::with_capacity(span / stride + 2);
    let mut index = start;
    while index < end {
        picked_time.push(time[index]);
        picked_values.push(values[index]);
        index += stride;
    }
    if picked_time.last() != Some(&time[end - 1]) {
        picked_time.push(time[end - 1]);
        picked_values.push(values[end - 1]);
    }
    SampleSlice {
        time: picked_time,
        values: picked_values,
        stride: u32::try_from(stride).unwrap_or(u32::MAX),
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/dev.sh cargo test -p scope-core compute::`
Expected: PASS (5 tests in `compute`).

- [ ] **Step 5: Add the protocol types and regenerate**

In `protocol/schema/scope-protocol.json`, change `"protocol_version": 3` to `"protocol_version": 4`, and insert these three types after `"TileResponse"`:

```json
    "SampleRequest": {
      "kind": "object",
      "fields": {
        "request_id": "string",
        "signal_ids": "u64[]",
        "window": "TimeWindow",
        "max_points": "u32"
      }
    },
    "SampleSeries": {
      "kind": "object",
      "fields": {
        "signal_id": "u64",
        "signal_path": "string",
        "unit": "string?",
        "time": "f64[]",
        "values": "f64[]",
        "stride": "u32"
      }
    },
    "SampleResponse": {
      "kind": "object",
      "fields": {
        "request_id": "string",
        "series": "SampleSeries[]"
      }
    },
```

Then run: `./scripts/dev.sh pnpm codegen:check`
Expected: FAIL with a `git diff` of the four generated files — that is the check reporting your regeneration, not an error. Inspect the diff, confirm `SampleSeries` carries `#[serde(with = "u64_string")] pub signal_id: u64` in Rust and `signal_id: string` in TypeScript, then stage the generated files so the next run is clean.

- [ ] **Step 6: Add the Tauri command**

In `shell/src-tauri/src/lib.rs`, extend the `scope_protocol` import list with `SampleRequest, SampleResponse, SampleSeries`, add `use scope_core::compute;` to the `scope_core` import, then add this command after `query_tiles`:

```rust
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn query_samples(
    request: Envelope<SampleRequest>,
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<SampleResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let data = state.lock().map_err(|error| error.to_string())?;
    let mut series = Vec::new();
    for raw_id in request.signal_ids {
        let signal = data
            .store
            .signal(SignalId(raw_id))
            .ok_or_else(|| format!("unknown signal id: {raw_id}"))?;
        let slice = compute::sample_window(
            signal.time(),
            signal.values(),
            request.window.t0,
            request.window.t1,
            request.max_points,
        );
        series.push(SampleSeries {
            signal_id: raw_id,
            signal_path: signal.path.clone(),
            unit: signal.unit.clone(),
            time: slice.time,
            values: slice.values,
            stride: slice.stride,
        });
    }

    Ok(Envelope::new(SampleResponse {
        request_id: request.request_id,
        series,
    }))
}
```

and add `query_samples` to the `tauri::generate_handler![…]` list after `query_tiles`.

- [ ] **Step 7: Write the failing TypeScript test**

Create `frontend/src/app/samples.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { binsToSamples, sampleWindow } from "./samples";
import fixtureJson from "../../../protocol/testdata/sample-conformance.json";

interface Fixture {
  time: number[];
  values: number[];
  queries: {
    t0: number;
    t1: number;
    max_points: number;
    stride: number;
    time: number[];
    values: number[];
  }[];
}

const fixture = fixtureJson as Fixture;

describe("sampleWindow", () => {
  it("matches the Rust implementation on every fixture query", () => {
    for (const query of fixture.queries) {
      expect(
        sampleWindow(
          fixture.time,
          fixture.values,
          query.t0,
          query.t1,
          query.max_points,
        ),
      ).toEqual({
        time: query.time,
        values: query.values,
        stride: query.stride,
      });
    }
  });

  it("returns nothing for a window past the data", () => {
    expect(sampleWindow([0, 1, 2], [0, 1, 2], 50, 60, 32)).toEqual({
      time: [],
      values: [],
      stride: 1,
    });
  });
});

describe("binsToSamples", () => {
  it("reads level-0 bins as raw samples and skips gaps", () => {
    const bin = (time: number, value: number | null): EnvelopeBin => ({
      t0: time,
      t1: time,
      first: value,
      last: value,
      min: value,
      max: value,
      sum: value ?? 0,
      sum_sq: value === null ? 0 : value * value,
      finite_count: value === null ? "0" : "1",
      sample_count: "1",
      has_gap: value === null,
    });
    expect(binsToSamples([bin(0, 5), bin(1, null), bin(2, 7)])).toEqual({
      time: [0, 2],
      values: [5, 7],
    });
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/app/samples.test.ts`
Expected: FAIL — cannot resolve `./samples` and cannot resolve the fixture JSON.

- [ ] **Step 9: Implement the TypeScript mirror**

Create `frontend/src/app/samples.ts`:

```typescript
import type { EnvelopeBin } from "../generated/protocol";

export interface SampleSlice {
  time: number[];
  values: number[];
  stride: number;
}

/** Index of the first entry not less than `value` in a sorted array. */
function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? 0) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Index of the first entry greater than `value` in a sorted array. */
function upperBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? 0) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Mirror of `scope_core::compute::sample_window`. The index arithmetic is
 * protocol surface: `protocol/testdata/sample-conformance.json` locks this
 * against the Rust implementation so a snapshot decimates identically.
 */
export function sampleWindow(
  time: readonly number[],
  values: readonly number[],
  t0: number,
  t1: number,
  maxPoints: number,
): SampleSlice {
  const start = Math.max(0, lowerBound(time, t0) - 1);
  const end = Math.min(time.length, upperBound(time, t1) + 1);
  if (start >= end) return { time: [], values: [], stride: 1 };
  const span = end - start;
  const cap = Math.max(1, Math.trunc(maxPoints));
  const stride = Math.max(1, Math.ceil(span / cap));
  const pickedTime: number[] = [];
  const pickedValues: number[] = [];
  for (let index = start; index < end; index += stride) {
    pickedTime.push(time[index] ?? 0);
    pickedValues.push(values[index] ?? 0);
  }
  const lastTime = time[end - 1] ?? 0;
  if (pickedTime[pickedTime.length - 1] !== lastTime) {
    pickedTime.push(lastTime);
    pickedValues.push(values[end - 1] ?? 0);
  }
  return { time: pickedTime, values: pickedValues, stride };
}

/**
 * Reads level-0 envelope bins back as raw samples. Bins are degenerate at
 * level 0 (`t0 === t1`, `first === last`), so this is exact there and a
 * bin-resolution approximation at any coarser level — the snapshot trade
 * ADR 0015 records.
 */
export function binsToSamples(bins: readonly EnvelopeBin[]): {
  time: number[];
  values: number[];
} {
  const time: number[] = [];
  const values: number[] = [];
  for (const bin of bins) {
    if (bin.first === null) continue;
    time.push((bin.t0 + bin.t1) * 0.5);
    values.push(bin.first);
  }
  return { time, values };
}
```

- [ ] **Step 10: Generate the conformance fixture**

Add to `core/scope-core/src/compute.rs`'s test module (this mirrors the pyramid fixture pattern, including the `REGENERATE_FIXTURES` escape hatch):

```rust
    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct SampleFixture {
        time: Vec<f64>,
        values: Vec<f64>,
        queries: Vec<SampleFixtureQuery>,
    }

    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct SampleFixtureQuery {
        t0: f64,
        t1: f64,
        max_points: u32,
        stride: u32,
        time: Vec<f64>,
        values: Vec<f64>,
    }

    const SAMPLE_FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/sample-conformance.json"
    );

    #[test]
    fn sample_conformance_fixture_matches_rust() {
        let time: Vec<f64> = (0..500).map(|index| f64::from(index) * 0.25).collect();
        let values: Vec<f64> = time
            .iter()
            .map(|value| (value * 1.7).sin() * 10.0 + value)
            .collect();
        let windows = [
            (0.0, 124.75, 4_096_u32),
            (0.0, 124.75, 64),
            (30.0, 40.0, 32),
            (900.0, 1_000.0, 64),
        ];
        let current = SampleFixture {
            time: time.clone(),
            values: values.clone(),
            queries: windows
                .iter()
                .map(|&(t0, t1, max_points)| {
                    let slice = sample_window(&time, &values, t0, t1, max_points);
                    SampleFixtureQuery {
                        t0,
                        t1,
                        max_points,
                        stride: slice.stride,
                        time: slice.time,
                        values: slice.values,
                    }
                })
                .collect(),
        };
        if std::env::var("REGENERATE_FIXTURES").is_ok() {
            std::fs::write(
                SAMPLE_FIXTURE_PATH,
                format!("{}\n", serde_json::to_string_pretty(&current).unwrap()),
            )
            .expect("write fixture");
            return;
        }
        let stored: SampleFixture = serde_json::from_str(
            &std::fs::read_to_string(SAMPLE_FIXTURE_PATH).expect("read fixture"),
        )
        .expect("parse fixture");
        assert_eq!(stored, current, "regenerate with REGENERATE_FIXTURES=1");
    }
```

Run: `./scripts/dev.sh env REGENERATE_FIXTURES=1 cargo test -p scope-core compute::sample_conformance`
Then run it again without the variable: `./scripts/dev.sh cargo test -p scope-core compute::`
Expected: PASS, and `protocol/testdata/sample-conformance.json` now exists.

- [ ] **Step 11: Wire `querySamples` into both planes**

In `frontend/src/app/data-plane.ts`: extend the type import with `type SampleRequest, type SampleResponse`, import `binsToSamples, sampleWindow` from `./samples`, add the method to the interface

```typescript
  queryTiles(request: TileRequest): Promise<TileResponse>;
  querySamples(request: SampleRequest): Promise<SampleResponse>;
```

add to `TauriPlane`:

```typescript
  async querySamples(request: SampleRequest): Promise<SampleResponse> {
    return open(
      await this.invoke<Envelope<SampleResponse>>("query_samples", {
        request: seal(request),
      }),
    );
  }
```

and to `BakedPlane`:

```typescript
  querySamples(request: SampleRequest): Promise<SampleResponse> {
    const requested = new Set(request.signal_ids);
    return Promise.resolve({
      request_id: request.request_id,
      series: this.payload.signals
        .filter((signal) => requested.has(signal.summary.signal_id))
        .map((signal) => {
          // ADR 0015: the finest baked level stands in for raw samples.
          const raw = binsToSamples(signal.levels[0] ?? []);
          const slice = sampleWindow(
            raw.time,
            raw.values,
            request.window.t0,
            request.window.t1,
            request.max_points,
          );
          return {
            signal_id: signal.summary.signal_id,
            signal_path: signal.summary.path,
            unit: signal.summary.unit,
            time: slice.time,
            values: slice.values,
            stride: slice.stride,
          };
        }),
    });
  }
```

- [ ] **Step 12: Run the frontend gate**

Run: `./scripts/test.sh frontend`
Expected: PASS — lint, typecheck, `codegen:check` clean, all unit tests including the two new suites.

- [ ] **Step 13: Write ADR 0015**

Create `docs/adr/0015-window-sample-requests.md`:

```markdown
# 15. Windowed sample requests and presentation-plane derived views

Status: Accepted

## Context

XY trajectories, spectra, and histograms cannot be computed from envelope
bins. A bin is a min/max extent over an interval; pairing two signals,
transforming to the frequency domain, or counting a value distribution all
need the samples themselves. Nothing in the protocol returned samples.

Two placements were available for the maths. ADR 0008 puts _expression
evaluation_ in `scope-core` because user-authored expressions are an
eval-surface question. ADR 0014 put _visible-region statistics_ in the
presentation plane because they are a bounded derived view of what is
already drawn, and because both hosts then run one implementation.

## Decision

One protocol request, `query_samples`, returns a decimated slice of a
signal inside a time window, capped at `max_points`, with one neighbouring
sample past each edge so strokes reach the plot border. The decimation is
an integer stride, and the last sample of the range is always retained.

XY pairing, spectra, and histograms are then pure presentation-plane
modules over that bounded slice. They are not host-specific and not
duplicated across hosts.

The stride and edge arithmetic is the only shared algorithm, so it is
fixture-locked by `protocol/testdata/sample-conformance.json`, generated by
the Rust implementation under `REGENERATE_FIXTURES=1` and asserted by both
suites — the mechanism ADR 0003's amendment established for level
selection.

## Consequences

- Query cost stays bounded by the requested point cap, not by source size;
  the browser holds a window slice, never a raw source column.
- A snapshot and the workbench cannot disagree about a trajectory, a
  spectrum, or a histogram, because they run the same TypeScript over the
  same payload.
- `BakedPlane` answers `query_samples` from the finest baked pyramid level.
  In the demo manifest level 0 is one degenerate bin per sample, so this is
  exact. ADR 0007 names level selection as the snapshot budgeting lever, so
  **the Phase 4 exporter must bake level 0 for any signal a non-time panel
  uses**, or those panels degrade to bin resolution inside snapshots. That
  requirement belongs to the exporter, not to this request.
- Expression evaluation is unaffected and stays native per ADR 0008. The
  distinction is authored code versus bounded derived views of what is
  already on screen.
```

- [ ] **Step 14: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add protocol/schema/scope-protocol.json protocol/src/generated.rs \
  protocol/testdata/sample-conformance.json \
  core/scope-core/src/compute.rs core/scope-core/src/session/generated.rs \
  shell/src-tauri/src/lib.rs \
  frontend/src/generated/protocol.ts frontend/src/generated/session.ts \
  frontend/src/app/samples.ts frontend/src/app/samples.test.ts \
  frontend/src/app/data-plane.ts docs/adr/0015-window-sample-requests.md
git commit -m "feat(protocol): serve decimated window samples for panel modes"
```

---

## Task 2: Panel x-ranges and mode-aware data fetching (session v5)

**Files:**

- Modify: `protocol/schema/scope-session.json`
- Modify: `core/scope-core/src/session.rs`
- Modify: `frontend/src/app/workspace.ts`
- Modify: `frontend/src/app/workspace.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/workspace-view.ts`
- Modify: `frontend/src/ui/panel.ts`

**Interfaces:**

- Consumes: `DataPlane.querySamples` and the `SampleResponse` type (Task 1).
- Produces: `PanelState.x_range: [number, number] | null`; `WorkspaceModel.setPanelXRange(id, range)` / `clearPanelXRange(id)`; `AppShell.effectiveXRange(panel)`; `WorkspaceView.renderData(tilesByPanel, samplesByPanel, windowFor)`; `PanelView.renderData(state, tiles, samples, window)`; `PanelCallbacks.onXRange(id, range)`.
- Note: `PanelView.renderTiles` is **renamed** to `renderData` with a wider signature; every call site is updated in this task.

- [ ] **Step 1: Write the failing migration test**

Add to the `mod tests` block in `core/scope-core/src/session.rs`:

```rust
    #[test]
    fn v4_sessions_gain_panel_x_ranges() {
        let json = serde_json::json!({
            "app": "signalscope",
            "schema_version": 4,
            "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 60.0, "linked": true,
                            "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1",
            "favorites": [],
            "tabs": [{
                "id": "workspace-1",
                "title": "Workspace 1",
                "focused_panel_id": "panel-1",
                "layout": [{"height": 1.0, "panels": [{"panel_id": "panel-1", "width": 1.0}]}],
                "panels": [{
                    "id": "panel-1", "title": "Panel 1", "mode": "time",
                    "axis_style": "gutter", "x_signal": null, "color_signal": null,
                    "series": [], "y_range": null, "x_label": null, "y_label": null,
                    "time_window": null, "annotations": [], "show_stats": false
                }]
            }]
        })
        .to_string();
        let session = from_json(&json).expect("v4 session migrates");
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        assert_eq!(session.tabs[0].panels[0].x_range, None);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/dev.sh cargo test -p scope-core session::`
Expected: FAIL — `no field 'x_range' on type 'PanelState'`.

- [ ] **Step 3: Bump the session schema and add the migration arm**

In `protocol/schema/scope-session.json` change `"schema_version": 4` to `5`, and add to `PanelState.fields` immediately after `"y_range": "f64[2]?"`:

```json
        "x_range": "f64[2]?",
```

Run: `./scripts/dev.sh pnpm codegen` and then `./scripts/dev.sh rustfmt --edition 2024 protocol/src/generated.rs core/scope-core/src/session/generated.rs`.

Then in `core/scope-core/src/session.rs`, insert this arm between the `3 =>` arm and `SESSION_SCHEMA_VERSION =>`:

```rust
        4 => {
            if let Some(tabs) = value
                .get_mut("tabs")
                .and_then(serde_json::Value::as_array_mut)
            {
                for tab in tabs {
                    let panels = tab
                        .get_mut("panels")
                        .and_then(serde_json::Value::as_array_mut);
                    for panel in panels.into_iter().flatten() {
                        if let Some(object) = panel.as_object_mut() {
                            object.entry("x_range").or_insert(serde_json::Value::Null);
                        }
                    }
                }
            }
            value["schema_version"] = serde_json::json!(5);
            migrate(5, value)
        }
```

Also update the `3 =>` arm's tail from `migrate(4, value)` — it already recurses into `migrate(4, …)`, which now lands on the new arm, so no change is needed there. Verify by reading the arm.

- [ ] **Step 4: Run the Rust gate**

Run: `./scripts/test.sh core`
Expected: PASS — including `v1_sessions_migrate_to_current`, which now traverses five rungs.

- [ ] **Step 5: Write the failing workspace-model test**

Add to `frontend/src/app/workspace.test.ts`:

```typescript
it("stores and clears a panel-local x range", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanelRow();
  expect(model.panel(panel.id)?.x_range).toBeNull();
  model.setPanelXRange(panel.id, [-4, 9]);
  expect(model.panel(panel.id)?.x_range).toEqual([-4, 9]);
  model.clearPanelXRange(panel.id);
  expect(model.panel(panel.id)?.x_range).toBeNull();
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/app/workspace.test.ts`
Expected: FAIL — `model.setPanelXRange is not a function`.

- [ ] **Step 7: Implement the model accessors**

In `frontend/src/app/workspace.ts`, add after `clearPanelYRange`:

```typescript
  setPanelXRange(panelId: string, range: readonly [number, number]): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.x_range = [range[0], range[1]];
  }

  clearPanelXRange(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.x_range = null;
  }
```

and add `x_range: null,` to the `createPanel()` literal, directly after `y_range: null,`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/app/workspace.test.ts`
Expected: PASS.

- [ ] **Step 9: Fetch samples for non-time panels**

In `frontend/src/ui/app-shell.ts`:

Add `type SampleResponse` to the `../generated/protocol` type import, and a field beside `tilesByPanel`:

```typescript
  private samplesByPanel = new Map<string, SampleResponse>();
```

Add this constant beside `CURSOR_STYLES` at the top of the file:

```typescript
/** Point cap for non-time panels: enough for a 4096-bin FFT plus edges. */
const SAMPLE_CAP = 8192;
```

Replace the body of `refreshTiles()` so it dispatches on mode (the `panel.mode !== "time"` early return goes away):

```typescript
  private async refreshTiles(): Promise<void> {
    const refreshToken = ++this.refreshToken;
    const width = Math.max(
      1,
      Math.round(required(this.root, ".workspace").clientWidth),
    );
    const tiles = new Map<string, TileResponse>();
    const samples = new Map<string, SampleResponse>();
    await Promise.all(
      this.workspace.panels().map(async (panel) => {
        const ids = this.panelSignalIds(panel);
        if (ids.length === 0) return;
        const panelWidth = this.workspaceView?.panelWidth(panel.id) ?? 0;
        const window = this.effectiveWindow(panel);
        try {
          if (panel.mode === "time") {
            tiles.set(
              panel.id,
              await this.plane.queryTiles({
                request_id: crypto.randomUUID(),
                signal_ids: ids,
                window,
                pixel_width: panelWidth > 0 ? Math.round(panelWidth) : width,
              }),
            );
          } else {
            samples.set(
              panel.id,
              await this.plane.querySamples({
                request_id: crypto.randomUUID(),
                signal_ids: ids,
                window,
                max_points: SAMPLE_CAP,
              }),
            );
          }
        } catch (error: unknown) {
          this.reportError(error);
        }
      }),
    );
    if (refreshToken !== this.refreshToken) return;
    this.tilesByPanel = tiles;
    this.samplesByPanel = samples;
    this.renderTiles();
  }

  /**
   * Signal ids a panel needs: its series, plus the XY x signal and the
   * colour channel, which are axes rather than plotted series.
   */
  private panelSignalIds(panel: PanelState): string[] {
    const paths = panel.series.map((series) => series.path);
    if (panel.mode === "xy") {
      if (panel.x_signal !== null) paths.unshift(panel.x_signal);
      if (panel.color_signal !== null) paths.push(panel.color_signal);
    }
    const ids = new Set<string>();
    for (const path of paths) {
      const id = this.signalsByPath.get(path)?.signal_id;
      if (id !== undefined) ids.add(id);
    }
    return [...ids];
  }
```

Update `renderTiles()` to pass both maps:

```typescript
  private renderTiles(): void {
    const state = this.time.snapshot();
    const elapsed =
      this.workspaceView?.renderData(
        this.tilesByPanel,
        this.samplesByPanel,
        (panelId) => {
          const panel = this.workspace.panel(panelId);
          return panel === undefined
            ? { t0: state.t0, t1: state.t1 }
            : this.effectiveWindow(panel);
        },
      ) ?? 0;
    required(this.root, ".render-ms").textContent = `${elapsed.toFixed(1)} ms`;
  }
```

Add the x-range router beside `applyTimeWindow`:

```typescript
  private applyXRange(panelId: string, range: readonly [number, number]): void {
    const [min, max] = range;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
    this.workspace.setPanelXRange(panelId, [min, max]);
    this.renderTiles();
  }
```

and wire it into the `WorkspaceView` callback object, next to `onYRange`:

```typescript
        onXRange: (id, range) => {
          this.applyXRange(id, range);
        },
```

- [ ] **Step 10: Thread the samples through the view layer**

In `frontend/src/ui/workspace-view.ts`, add `type SampleResponse` to the protocol type import and replace `renderTiles` with:

```typescript
  renderData(
    tilesByPanel: ReadonlyMap<string, TileResponse>,
    samplesByPanel: ReadonlyMap<string, SampleResponse>,
    windowFor: (panelId: string) => { t0: number; t1: number },
  ): number {
    const maximized = this.model.maximizedPanelId();
    let total = 0;
    for (const panel of this.model.panels()) {
      if (maximized !== null && panel.id !== maximized) continue;
      total +=
        this.views
          .get(panel.id)
          ?.renderData(
            panel,
            tilesByPanel.get(panel.id) ?? null,
            samplesByPanel.get(panel.id) ?? null,
            windowFor(panel.id),
          ) ?? 0;
    }
    return total;
  }
```

In `frontend/src/ui/panel.ts`: add `type SampleResponse` to the protocol type import, add `onXRange(id: string, range: readonly [number, number]): void;` to `PanelCallbacks` beside `onYRange`, add a `private lastSamples: SampleResponse | null = null;` field beside `lastTiles`, and rename `renderTiles` to `renderData` with the wider signature:

```typescript
  renderData(
    state: PanelState,
    tiles: TileResponse | null,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    this.lastState = state;
    this.lastTiles = tiles;
    this.lastSamples = samples;
    this.lastWindow = { ...window };
    if (state.mode !== "time") {
      this.renderStats();
      this.drawOverlay();
      return 0;
    }
    if (tiles === null || state.series.length === 0) {
      this.renderStats();
      this.drawOverlay();
      return 0;
    }
    // …unchanged time-mode body from here…
```

Update the one internal caller in `setEmphasis`:

```typescript
if (this.lastState !== null && this.lastWindow !== null) {
  this.renderData(
    this.lastState,
    this.lastTiles,
    this.lastSamples,
    this.lastWindow,
  );
}
```

- [ ] **Step 11: Run the frontend gate**

Run: `./scripts/test.sh frontend`
Expected: PASS. Non-time panels still show `"<Mode> mode is not implemented yet."` — the data is now fetched but nothing draws it. That empty-state string is replaced mode by mode in the tasks that follow.

- [ ] **Step 12: Commit**

```bash
git add protocol/schema/scope-session.json core/scope-core/src/session.rs \
  core/scope-core/src/session/generated.rs frontend/src/generated/session.ts \
  frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts \
  frontend/src/ui/app-shell.ts frontend/src/ui/workspace-view.ts \
  frontend/src/ui/panel.ts
git commit -m "feat(session): add panel x ranges and mode-aware data fetching"
```

---

## Task 3: XY pairing, the vertex-path renderer, and XY panels

**Files:**

- Create: `frontend/src/app/xy.ts`
- Create: `frontend/src/app/xy.test.ts`
- Modify: `frontend/src/app/plot-math.ts`
- Modify: `frontend/src/app/plot-math.test.ts`
- Modify: `frontend/src/render/canvas-renderer.ts`
- Modify: `frontend/src/render/canvas-renderer.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/app/workspace.ts`
- Modify: `frontend/src/styles/app.css`
- Create: `frontend/tests/e2e/modes.spec.ts`

**Interfaces:**

- Consumes: `SampleResponse`/`SampleSeries` (Task 1), `PanelState.x_range` and `renderData` (Task 2).
- Produces (`frontend/src/app/xy.ts`): `XyTrace { time: number[]; x: number[]; y: number[] }`; `pairSamples(x: SampleSeries, y: SampleSeries): XyTrace`; `traceExtent(traces: readonly XyTrace[], axis: "x" | "y", t0: number, t1: number): [number, number] | null`; `lerpSample(time: readonly number[], values: readonly number[], query: number): number` (NaN outside coverage — Tasks 8 and 9 both consume it).
- Produces (`plot-math.ts`): `PlotLayout.xScale?: "linear" | "log"`, log-aware `projectX`/`invertX`, `logTicks(min, max): number[]`.
- Produces (`canvas-renderer.ts`): `PlotPath`, `PathRenderOptions`, `CanvasRenderer.renderPaths(paths, options): number`.
- Produces (`workspace.ts`): `setXSignal(id, path)`, `promoteSeriesToX(id, path)`.

- [ ] **Step 1: Write the failing plot-math test**

Add to `frontend/src/app/plot-math.test.ts`:

```typescript
it("projects and inverts a log x axis", () => {
  const layout: PlotLayout = {
    plot: { x: 0, y: 0, width: 300, height: 100 },
    xRange: { min: 1, max: 1000 },
    yRange: { min: 0, max: 1 },
    xScale: "log",
  };
  expect(projectX(layout, 1)).toBeCloseTo(0, 6);
  expect(projectX(layout, 10)).toBeCloseTo(100, 6);
  expect(projectX(layout, 1000)).toBeCloseTo(300, 6);
  expect(invertX(layout, 200)).toBeCloseTo(100, 6);
});

it("emits decade ticks for a log range", () => {
  expect(logTicks(0.5, 1200)).toEqual([1, 10, 100, 1000]);
  expect(logTicks(0, -1)).toEqual([]);
});
```

Add `logTicks` to the import list at the top of that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/app/plot-math.test.ts`
Expected: FAIL — `logTicks` is not exported and `xScale` is not a property of `PlotLayout`.

- [ ] **Step 3: Implement log projection in plot-math**

In `frontend/src/app/plot-math.ts`, extend the layout type and the two x helpers:

```typescript
export type AxisScale = "linear" | "log";

export interface PlotLayout {
  plot: PlotRect;
  xRange: Range;
  yRange: Range;
  /** Absent means linear. Log axes clamp non-positive values to the floor. */
  xScale?: AxisScale;
}

/** Positive floor used so a log axis can survive a zero or negative bound. */
const LOG_FLOOR = 1e-12;

function logSpace(value: number): number {
  return Math.log10(Math.max(LOG_FLOOR, value));
}

export function projectX(layout: PlotLayout, value: number): number {
  const { plot, xRange } = layout;
  if (layout.xScale === "log") {
    const min = logSpace(xRange.min);
    const max = logSpace(xRange.max);
    return plot.x + ((logSpace(value) - min) / (max - min)) * plot.width;
  }
  return (
    plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width
  );
}

export function invertX(layout: PlotLayout, px: number): number {
  const { plot, xRange } = layout;
  if (layout.xScale === "log") {
    const min = logSpace(xRange.min);
    const max = logSpace(xRange.max);
    return 10 ** (min + ((px - plot.x) / plot.width) * (max - min));
  }
  return xRange.min + ((px - plot.x) / plot.width) * (xRange.max - xRange.min);
}

/** Decade ticks covering `[min, max]`, empty when the range is unusable. */
export function logTicks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return [];
  const low = Math.floor(Math.log10(Math.max(LOG_FLOOR, min)));
  const high = Math.ceil(Math.log10(max));
  const values: number[] = [];
  for (let exponent = low; exponent <= high; exponent += 1) {
    const value = 10 ** exponent;
    if (value >= min * 0.999 && value <= max * 1.001) values.push(value);
  }
  return values;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/app/plot-math.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing XY test**

Create `frontend/src/app/xy.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { SampleSeries } from "../generated/protocol";
import { pairSamples, traceExtent } from "./xy";

function series(path: string, time: number[], values: number[]): SampleSeries {
  return {
    signal_id: "1",
    signal_path: path,
    unit: null,
    time,
    values,
    stride: 1,
  };
}

describe("pairSamples", () => {
  it("keeps an identical timebase without resampling", () => {
    const x = series("x", [0, 1, 2], [10, 20, 30]);
    const y = series("y", [0, 1, 2], [1, 2, 3]);
    expect(pairSamples(x, y)).toEqual({
      time: [0, 1, 2],
      x: [10, 20, 30],
      y: [1, 2, 3],
    });
  });

  it("interpolates y onto the x timebase", () => {
    const x = series("x", [0, 1, 2], [0, 1, 2]);
    const y = series("y", [0, 2], [0, 20]);
    expect(pairSamples(x, y)).toEqual({
      time: [0, 1, 2],
      x: [0, 1, 2],
      y: [0, 10, 20],
    });
  });

  it("emits NaN where the y signal has no coverage", () => {
    const x = series("x", [0, 5], [0, 5]);
    const y = series("y", [1, 2], [1, 2]);
    const paired = pairSamples(x, y);
    expect(Number.isNaN(paired.y[0] ?? 0)).toBe(true);
    expect(Number.isNaN(paired.y[1] ?? 0)).toBe(true);
  });
});

describe("traceExtent", () => {
  it("pads a finite extent by six percent", () => {
    const trace = { time: [0, 1, 2], x: [0, 10, 20], y: [-1, 0, 1] };
    expect(traceExtent([trace], "x", 0, 2)).toEqual([-1.2, 21.2]);
  });

  it("expands a degenerate extent and ignores samples outside the window", () => {
    const trace = { time: [0, 1, 2], x: [5, 5, 999], y: [0, 0, 0] };
    expect(traceExtent([trace], "x", 0, 1)).toEqual([4, 6]);
  });

  it("returns null when nothing is finite", () => {
    const trace = { time: [0], x: [Number.NaN], y: [Number.NaN] };
    expect(traceExtent([trace], "x", 0, 1)).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/app/xy.test.ts`
Expected: FAIL — cannot resolve `./xy`.

- [ ] **Step 7: Implement the XY module**

Create `frontend/src/app/xy.ts`:

```typescript
import type { SampleSeries } from "../generated/protocol";

/** One y signal paired onto an x signal's timebase. */
export interface XyTrace {
  time: number[];
  x: number[];
  y: number[];
}

/** Fraction of the data span added to each end of an auto extent. */
const EXTENT_PADDING = 0.06;

function sameTimebase(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Linear sample of `values` at `query`, NaN outside the signal's coverage.
 *
 * The prototype held the endpoint value flat past each end. This returns NaN
 * instead so the stroke lifts: an XY trajectory drawn past a signal's data is
 * a fabricated segment, and the pyramid's gap invariants already commit this
 * codebase to breaking strokes rather than bridging absent data (decision 13).
 *
 * Exported because the spectrum module resamples the same way.
 */
export function lerpSample(
  time: readonly number[],
  values: readonly number[],
  query: number,
): number {
  const count = time.length;
  if (count === 0) return Number.NaN;
  if (query < (time[0] ?? 0) || query > (time[count - 1] ?? 0)) {
    return Number.NaN;
  }
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((time[mid] ?? 0) < query) low = mid + 1;
    else high = mid;
  }
  if ((time[low] ?? 0) === query) return values[low] ?? Number.NaN;
  const previous = Math.max(0, low - 1);
  const span = (time[low] ?? 0) - (time[previous] ?? 0);
  if (span === 0) return values[low] ?? Number.NaN;
  const alpha = (query - (time[previous] ?? 0)) / span;
  const before = values[previous] ?? Number.NaN;
  const after = values[low] ?? Number.NaN;
  return before + (after - before) * alpha;
}

/** Pairs `y` against `x` on the x signal's timebase. */
export function pairSamples(x: SampleSeries, y: SampleSeries): XyTrace {
  if (sameTimebase(x.time, y.time)) {
    return { time: [...x.time], x: [...x.values], y: [...y.values] };
  }
  return {
    time: [...x.time],
    x: [...x.values],
    y: x.time.map((time) => lerpSample(y.time, y.values, time)),
  };
}

/**
 * The padded display extent of one axis across every trace, restricted to
 * samples inside `[t0, t1]`. Null when nothing finite falls in the window.
 */
export function traceExtent(
  traces: readonly XyTrace[],
  axis: "x" | "y",
  t0: number,
  t1: number,
): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const trace of traces) {
    const column = axis === "x" ? trace.x : trace.y;
    for (let index = 0; index < trace.time.length; index += 1) {
      const time = trace.time[index] ?? Number.NaN;
      if (time < t0 || time > t1) continue;
      const value = column[index] ?? Number.NaN;
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) return [min - 1, max + 1];
  const padding = (max - min) * EXTENT_PADDING;
  return [min - padding, max + padding];
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/app/xy.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Write the failing renderer test**

Add to `frontend/src/render/canvas-renderer.test.ts`, reusing that file's existing `recordingContext()`/`fakeCanvas()` helpers (read them first — match their exact names and shapes):

```typescript
it("renders vertex paths against an explicit x range", () => {
  const { context, calls } = recordingContext();
  const renderer = new CanvasRenderer(fakeCanvas(context, 600, 300));
  renderer.setPalette(testPalette);
  const elapsed = renderer.renderPaths(
    [
      {
        points: [0, 0, 1, 1, Number.NaN, Number.NaN, 2, 2],
        colorIndex: 0,
        dash: "solid",
        width: 1.4,
      },
    ],
    {
      xLabel: "pos_east (m)",
      yLabel: "pos_north (m)",
      xRange: [0, 2],
      yRange: [0, 2],
    },
  );
  expect(elapsed).toBeGreaterThanOrEqual(0);
  // The NaN vertex lifts the pen: two moveTo calls, not one.
  expect(calls.filter((call) => call === "moveTo").length).toBeGreaterThan(1);
  expect(renderer.lastLayout()?.xRange).toEqual({ min: 0, max: 2 });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/render/canvas-renderer.test.ts`
Expected: FAIL — `renderer.renderPaths is not a function`.

- [ ] **Step 11: Implement `renderPaths`**

In `frontend/src/render/canvas-renderer.ts`:

First make the axis painters reusable. Change the last parameter of `drawAxes` and `drawInlineAxes` from `options: RenderOptions` to `labels: { xLabel: string; yLabel: string }`, add an `xTicks: readonly number[]` parameter after it, and inside each body replace the local `const xTicks = ticks(xRange.min, xRange.max, 7);` with use of the parameter and every `options.xLabel`/`options.yLabel` with `labels.xLabel`/`labels.yLabel`. Update the two existing call sites in `render()` to pass `{ xLabel: options.xLabel, yLabel: options.yLabel }` and `ticks(xRange.min, xRange.max, 7)`.

Then add the new public surface:

```typescript
export interface PlotPath {
  /** Flat vertex pairs `[x0, y0, x1, y1, …]`; a NaN vertex lifts the pen. */
  points: readonly number[];
  colorIndex: number;
  dash: DashStyle;
  width: number;
  /** Drawn in `--fg-4` at low alpha: present but outside the window. */
  dimmed?: boolean;
  /** Filled sample dots, for sparse traces. */
  markers?: boolean;
}

export interface PathRenderOptions {
  xLabel: string;
  yLabel: string;
  xRange: readonly [number, number];
  yRange: readonly [number, number];
  axisStyle?: AxisStyle;
  xScale?: AxisScale;
}

/** Sample dots appear only when vertices are sparser than this pixel gap. */
const MARKER_PIXEL_GAP = 7;
```

(add `type AxisScale` to the `../app/plot-math` type import), and this method on `CanvasRenderer`, after `render()`:

```typescript
  /**
   * Draws vertex paths against arbitrary axes. XY trajectories, spectra, and
   * histogram outlines are all vertex arrays rather than envelope bins, so
   * they share this entry point instead of `render()`.
   */
  renderPaths(
    paths: readonly PlotPath[],
    options: PathRenderOptions,
  ): number {
    const started = performance.now();
    const { context, width, height } = this.prepareCanvas();
    const colors = this.resolvePalette();
    context.fillStyle = colors.background;
    context.fillRect(0, 0, width, height);

    const xRange: Range = { min: options.xRange[0], max: options.xRange[1] };
    const yRange: Range = { min: options.yRange[0], max: options.yRange[1] };
    context.font = tickFont(colors);
    const charWidth = context.measureText("0").width;
    const gutter = gutterWidth(
      formatTicks(ticks(yRange.min, yRange.max, 6)),
      charWidth,
    );
    const inline = options.axisStyle === "inline";
    const plot: PlotRect = inline
      ? { x: 0, y: 0, width, height }
      : {
          x: gutter,
          y: 8,
          width: Math.max(1, width - gutter - 12),
          height: Math.max(1, height - 42),
        };
    const scale: AxisScale = options.xScale ?? "linear";
    this.layout = {
      plot,
      xRange: { ...xRange },
      yRange: { ...yRange },
      xScale: scale,
    };
    const layout = this.layout;
    const project: Projection = {
      toX: (value) => projectX(layout, value),
      toY: (value) => projectY(layout, value),
    };
    const xTickValues =
      scale === "log"
        ? logTicks(xRange.min, xRange.max)
        : ticks(xRange.min, xRange.max, 7);
    const labels = { xLabel: options.xLabel, yLabel: options.yLabel };
    if (inline) {
      this.drawInlineAxes(
        context,
        plot,
        project,
        xRange,
        yRange,
        colors,
        labels,
        xTickValues,
      );
    } else {
      this.drawAxes(
        context,
        plot,
        project,
        xRange,
        yRange,
        colors,
        labels,
        xTickValues,
      );
    }
    for (const path of paths) this.drawPath(context, plot, project, path, colors);
    return performance.now() - started;
  }

  private drawPath(
    context: CanvasRenderingContext2D,
    plot: PlotRect,
    project: Projection,
    path: PlotPath,
    colors: Palette,
  ): void {
    const vertices = path.points.length >> 1;
    if (vertices === 0) return;
    context.save();
    context.beginPath();
    context.rect(plot.x, plot.y, plot.width, plot.height);
    context.clip();
    context.strokeStyle =
      path.dimmed === true
        ? colors.fg3
        : (colors.series[path.colorIndex] ?? colors.fg2);
    context.lineWidth = path.dimmed === true ? 1.2 : path.width;
    context.globalAlpha = path.dimmed === true ? 0.5 : 1;
    context.setLineDash(dashPattern(path.dash));
    context.beginPath();
    let penDown = false;
    for (let index = 0; index < vertices; index += 1) {
      const x = path.points[index * 2] ?? Number.NaN;
      const y = path.points[index * 2 + 1] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        penDown = false;
        continue;
      }
      const px = project.toX(x);
      const py = project.toY(y);
      if (penDown) context.lineTo(px, py);
      else context.moveTo(px, py);
      penDown = true;
    }
    context.stroke();
    if (path.markers === true && vertices < plot.width / MARKER_PIXEL_GAP) {
      context.setLineDash([]);
      context.fillStyle = context.strokeStyle;
      context.beginPath();
      for (let index = 0; index < vertices; index += 1) {
        const x = path.points[index * 2] ?? Number.NaN;
        const y = path.points[index * 2 + 1] ?? Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const px = project.toX(x);
        const py = project.toY(y);
        context.moveTo(px + 2.4, py);
        context.arc(px, py, 2.4, 0, Math.PI * 2);
      }
      context.fill();
    }
    context.globalAlpha = 1;
    context.setLineDash([]);
    context.restore();
  }
```

Add `logTicks, projectX, projectY` to the value import from `../app/plot-math` (they are currently only type-imported).

- [ ] **Step 12: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/render/canvas-renderer.test.ts`
Expected: PASS.

- [ ] **Step 13: Give XY panels an x signal and draw them**

In `frontend/src/app/workspace.ts`, add after `setMode`:

```typescript
  setXSignal(id: string, path: string | null): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    // The outgoing x signal returns to the plotted series, and the incoming
    // one leaves them: an axis is never also a series (prototype `setX`).
    if (panel.x_signal !== null && panel.x_signal !== path) {
      const restored = panel.x_signal;
      if (!panel.series.some((series) => series.path === restored)) {
        this.addSeries(id, restored);
      }
    }
    if (path !== null) this.removeSeries(id, path);
    panel.x_signal = path;
    panel.x_range = null;
    panel.y_range = null;
    panel.annotations = [];
  }

  /** Enters XY mode, adopting the first plotted series as the x axis. */
  promoteSeriesToX(id: string): void {
    const panel = this.panel(id);
    if (panel === undefined || panel.x_signal !== null) return;
    const first = panel.series[0];
    if (first !== undefined) this.setXSignal(id, first.path);
  }

  setColorSignal(id: string, path: string | null): void {
    const panel = this.panel(id);
    if (panel !== undefined) panel.color_signal = path;
  }
```

In `frontend/src/ui/app-shell.ts`, make XY panels fetch their **whole** trajectory rather than only the visible window, so out-of-window segments can be drawn dim. Add beside `effectiveWindow`:

```typescript
  /**
   * The window a panel's samples are fetched over. XY panels fetch the full
   * data extent because the spec dims the out-of-window trajectory rather
   * than clipping it; FFT and histogram compute over the visible window.
   */
  private sampleWindow(panel: PanelState): { t0: number; t1: number } {
    if (panel.mode !== "xy") return this.effectiveWindow(panel);
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = Number.NEGATIVE_INFINITY;
    const paths = [...panel.series.map((series) => series.path)];
    if (panel.x_signal !== null) paths.push(panel.x_signal);
    for (const path of paths) {
      const summary = this.signalsByPath.get(path);
      if (summary === undefined) continue;
      t0 = Math.min(t0, summary.t_min);
      t1 = Math.max(t1, summary.t_max);
    }
    return Number.isFinite(t0) && Number.isFinite(t1)
      ? { t0, t1: t1 > t0 ? t1 : t0 + 1 }
      : this.effectiveWindow(panel);
  }
```

and in `refreshTiles`, replace `window` in the `querySamples` call with `this.sampleWindow(panel)` (leave the `queryTiles` branch using `window`).

In the `onSelectMode` callback, adopt an x signal when entering XY:

```typescript
        onSelectMode: (id, mode) => {
          this.workspace.setMode(id, mode);
          if (mode === "xy") this.workspace.promoteSeriesToX(id);
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
```

- [ ] **Step 14: Draw XY in the panel**

In `frontend/src/ui/panel.ts`, import the new helpers:

```typescript
import { pairSamples, traceExtent, type XyTrace } from "../app/xy";
import {
  type PlotPath,
  type PathRenderOptions,
} from "../render/canvas-renderer";
```

Replace the `if (state.mode !== "time")` branch of `renderData` with a dispatch:

```typescript
if (state.mode === "xy") {
  const elapsed = this.renderXy(state, samples, window);
  this.renderStats();
  this.drawOverlay();
  return elapsed;
}
if (state.mode !== "time") {
  this.renderStats();
  this.drawOverlay();
  return 0;
}
```

and add these members:

```typescript
  /** Traces from the last XY render, reused by hit-testing and overlays. */
  private xyTraces: { path: string; colorIndex: number; trace: XyTrace }[] = [];

  private renderXy(
    state: PanelState,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    this.xyTraces = [];
    if (samples === null || state.x_signal === null) return 0;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const xSeries = byPath.get(state.x_signal);
    if (xSeries === undefined) return 0;
    for (const series of state.series) {
      if (!series.visible) continue;
      const ySeries = byPath.get(series.path);
      if (ySeries === undefined) continue;
      this.xyTraces.push({
        path: series.path,
        colorIndex: resolveSeriesStyle(series.color_slot, series.dash)
          .colorIndex,
        trace: pairSamples(xSeries, ySeries),
      });
    }
    if (this.xyTraces.length === 0) return 0;
    const traces = this.xyTraces.map((entry) => entry.trace);
    const xRange =
      state.x_range ?? traceExtent(traces, "x", window.t0, window.t1);
    const yRange =
      state.y_range ?? traceExtent(traces, "y", window.t0, window.t1);
    if (xRange === null || yRange === null) return 0;
    const paths: PlotPath[] = [];
    for (const entry of this.xyTraces) {
      // Whole trajectory dimmed underneath, the windowed part lit on top.
      paths.push({
        points: flattenTrace(entry.trace, null),
        colorIndex: entry.colorIndex,
        dash: "solid",
        width: 1.2,
        dimmed: true,
      });
    }
    for (const entry of this.xyTraces) {
      const series = state.series.find((item) => item.path === entry.path);
      paths.push({
        points: flattenTrace(entry.trace, window),
        colorIndex: entry.colorIndex,
        dash: resolveSeriesStyle(
          series?.color_slot ?? 1,
          series?.dash ?? "solid",
        ).dash,
        width: (series?.width ?? 1.4) + 0.4,
        markers: true,
      });
    }
    const options: PathRenderOptions = {
      xLabel: state.x_label ?? axisName(state.x_signal, xSeries.unit),
      yLabel:
        state.y_label ??
        yLabel(
          state.series
            .filter((series) => series.visible)
            .map((series) => byPath.get(series.path)?.unit ?? null),
        ),
      xRange: [xRange[0], xRange[1]],
      yRange: [yRange[0], yRange[1]],
      axisStyle: state.axis_style,
    };
    return this.renderer.renderPaths(paths, options);
  }
```

and these module-level helpers beside `yLabel`:

```typescript
/** `path/leaf (unit)` for an axis name, matching the spec's XY gutters. */
function axisName(path: string, unit: string | null): string {
  const leaf = path.split("/").slice(-2).join("/");
  return unit === null ? leaf : `${leaf} (${unit})`;
}

/**
 * Flattens a trace to renderer vertices. A `window` restricts output to that
 * time span; vertices outside become NaN so the pen lifts rather than
 * bridging the gap.
 */
function flattenTrace(
  trace: XyTrace,
  window: { t0: number; t1: number } | null,
): number[] {
  const points: number[] = [];
  for (let index = 0; index < trace.time.length; index += 1) {
    const time = trace.time[index] ?? Number.NaN;
    const inside = window === null || (time >= window.t0 && time <= window.t1);
    points.push(
      inside ? (trace.x[index] ?? Number.NaN) : Number.NaN,
      inside ? (trace.y[index] ?? Number.NaN) : Number.NaN,
    );
  }
  return points;
}
```

Finally update the empty-state branch of `update()` so an XY panel without an x signal says something actionable rather than "not implemented":

```typescript
const empty = required<HTMLElement>(this.element, ".panel-empty");
if (state.series.length === 0) {
  empty.hidden = false;
  empty.textContent = "Empty panel — drag a signal here.";
} else if (state.mode === "xy" && state.x_signal === null) {
  empty.hidden = false;
  empty.textContent = "Drop a signal on the strip below to set the X axis.";
} else if (state.mode === "fft" || state.mode === "histogram") {
  empty.hidden = false;
  empty.textContent = `${MODE_NAMES[state.mode]} mode is not implemented yet.`;
} else {
  empty.hidden = true;
}
```

- [ ] **Step 15: Add the XY e2e scenario**

Create `frontend/tests/e2e/modes.spec.ts`:

```typescript
import { expect, test } from "./fixtures";

test.describe("panel modes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("XY mode adopts the first series as the x axis", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const panel = page.locator(".panel").first();
    await expect(panel.locator(".legend-chip")).toHaveCount(2);
    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    await expect(panel.locator(".mode-pill.active")).toHaveText("XY");
    // The promoted x signal leaves the plotted series.
    await expect(panel.locator(".legend-chip")).toHaveCount(1);
    await expect(panel.locator(".panel-empty")).toBeHidden();
  });
});
```

- [ ] **Step 16: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add frontend/src/app/xy.ts frontend/src/app/xy.test.ts \
  frontend/src/app/plot-math.ts frontend/src/app/plot-math.test.ts \
  frontend/src/app/workspace.ts \
  frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts \
  frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts \
  frontend/tests/e2e/modes.spec.ts
git commit -m "feat(xy): pair signals and render trajectories with vertex paths"
```

---

## Task 4: The XY drop strip, the `x:` chip, and keyboard parity

**Files:**

- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/modes.spec.ts`

**Interfaces:**

- Consumes: `WorkspaceModel.setXSignal` / `promoteSeriesToX` (Task 3), `PanelCallbacks.onDropSignal` (existing).
- Produces: `PanelCallbacks.onSetXSignal(id, path)`, `PanelCallbacks.onExitXy(id)`; palette commands `panel-switch-xy`, `panel-set-x-signal`, `panel-clear-x-signal`.

- [ ] **Step 1: Add the strip markup and styles**

In `panelMarkup()` in `frontend/src/ui/panel.ts`, add the strip as the last child of `.plot-wrap`, after `.panel-empty`:

```html
<div class="xy-drop-strip" hidden>
  ⇄ <span>drop here — use as X axis (switches panel to XY)</span>
</div>
```

and add an `x:` chip immediately before `.panel-legend` in the header:

```html
<button class="axis-chip x-chip" hidden></button>
```

Add to `frontend/src/styles/app.css`:

```css
/* Spec F6·4: 36px, bottom-anchored inside the plot body, amber because it is
   a drag target — one of amber's sanctioned interaction roles. */
.xy-drop-strip {
  position: absolute;
  z-index: 3;
  display: flex;
  height: 36px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--amber-3);
  border-top: 1px dashed var(--amber-7);
  color: var(--amber-7);
  font: 10.5px var(--font-mono);
  inset: auto 0 0 0;
  pointer-events: none;
}

.xy-drop-strip[hidden] {
  display: none;
}

.panel.drop-x .xy-drop-strip {
  background: var(--focus-ring);
}

/* Dashed chips mark an axis assignment rather than a plotted series. */
.axis-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 0 5px;
  border: 1px dashed var(--border-strong);
  border-radius: 2px;
  color: var(--fg-2);
  font: 10.5px var(--font-mono);
}

.axis-chip[hidden] {
  display: none;
}

.axis-chip .axis-chip-prefix {
  color: var(--fg-4);
}
```

- [ ] **Step 2: Show the strip during a signal drag and route the drop**

In `PanelView.bind()`, replace the three drag listeners on `this.element` with strip-aware versions:

```typescript
this.element.addEventListener("dragover", (event) => {
  if (!hasDragType(event, SIGNAL_DRAG_TYPE)) return;
  event.preventDefault();
  this.element.classList.add("drop-target");
  this.setDropStripVisible(true);
  this.element.classList.toggle("drop-x", this.overStrip(event));
});
this.element.addEventListener("dragleave", () => {
  this.element.classList.remove("drop-target", "drop-x");
  this.setDropStripVisible(false);
});
this.element.addEventListener("drop", (event) => {
  const asX = this.overStrip(event);
  this.element.classList.remove("drop-target", "drop-x");
  this.setDropStripVisible(false);
  const path = dragData(event, SIGNAL_DRAG_TYPE);
  if (path === null) return;
  event.preventDefault();
  event.stopPropagation();
  if (asX) this.callbacks.onSetXSignal(this.id, path);
  else this.callbacks.onDropSignal(this.id, path);
});
```

and add the two helpers:

```typescript
  private setDropStripVisible(visible: boolean): void {
    required<HTMLElement>(this.element, ".xy-drop-strip").hidden = !visible;
  }

  /** True when the pointer is inside the 36px strip at the plot's foot. */
  private overStrip(event: DragEvent): boolean {
    const strip = required<HTMLElement>(this.element, ".xy-drop-strip");
    if (strip.hidden) return false;
    const rect = strip.getBoundingClientRect();
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  }
```

Add to `PanelCallbacks`:

```typescript
  onSetXSignal(id: string, path: string): void;
  onExitXy(id: string): void;
```

- [ ] **Step 3: Render the `x:` chip**

In `PanelView.update()`, after the mode-pill loop, add:

```typescript
const xChip = required<HTMLButtonElement>(this.element, ".x-chip");
xChip.hidden = !(state.mode === "xy" && state.x_signal !== null);
if (!xChip.hidden && state.x_signal !== null) {
  xChip.replaceChildren(
    chipPrefix("x:"),
    document.createTextNode(state.x_signal.split("/").slice(-2).join("/")),
  );
  xChip.title = `X axis: ${state.x_signal} — click to return to time mode`;
}
```

Bind it once in `bind()`:

```typescript
required(this.element, ".x-chip").addEventListener("click", () => {
  this.callbacks.onExitXy(this.id);
});
```

and add the module-level helper beside `axisName`:

```typescript
function chipPrefix(text: string): HTMLElement {
  const prefix = document.createElement("span");
  prefix.className = "axis-chip-prefix";
  prefix.textContent = text;
  return prefix;
}
```

- [ ] **Step 4: Wire the callbacks and the palette commands**

In `frontend/src/ui/app-shell.ts`, add to the `WorkspaceView` callback object:

```typescript
        onSetXSignal: (id, path) => {
          this.workspace.setMode(id, "xy");
          this.workspace.setXSignal(id, path);
          this.workspace.focusPanel(id);
          this.afterLayoutChange();
        },
        onExitXy: (id) => {
          this.exitXy(id);
        },
```

and this method beside `fitPanelView`:

```typescript
  /** Returns an XY panel to time mode, restoring its x signal as a series. */
  private exitXy(panelId: string): void {
    this.workspace.setXSignal(panelId, null);
    this.workspace.setColorSignal(panelId, null);
    this.workspace.setMode(panelId, "time");
    this.workspace.clearPanelXRange(panelId);
    this.afterLayoutChange();
  }
```

Register the commands, next to the other focused-panel commands in `registerCommands()`:

```typescript
this.registerFocusedPanelCommand(
  "panel-switch-xy",
  "Panel: switch to XY mode",
  (id) => {
    this.workspace.setMode(id, "xy");
    this.workspace.promoteSeriesToX(id);
  },
);
this.registerFocusedPanelCommand(
  "panel-clear-x-signal",
  "Panel: return to time mode",
  (id) => {
    this.exitXy(id);
  },
);
```

The `Panel: set X signal…` row needs a signal argument, so it is generated per signal in `paletteEntries()` — this is also the only path a touch user has, since drag-and-drop is mouse-only. Add before the `return` there:

```typescript
const focused = this.workspace.focusedPanelId();
const xSignals =
  focused === null
    ? []
    : this.signals.map((summary) => ({
        title: `Panel: set X signal… ${summary.path}`,
        hint: "then pick from tree",
        run: () => {
          this.workspace.setMode(focused, "xy");
          this.workspace.setXSignal(focused, summary.path);
          this.afterLayoutChange();
        },
      }));
```

and include `...xSignals` in the returned array, after `...panels`.

- [ ] **Step 5: Add the inspector's `use as X` action**

In `PanelView.openInspector`, insert before the `remove` button:

```typescript
const useAsX = document.createElement("button");
useAsX.className = "inspector-action";
useAsX.textContent = "use as X";
useAsX.addEventListener("click", () => {
  this.closeInspector();
  this.callbacks.onSetXSignal(this.id, path);
});
```

and change the append to `popover.append(pathRow, slots, dashes, useAsX, remove);`. Add to `app.css`:

```css
.inspector-action {
  margin-top: 6px;
  padding: 1px 6px;
  border-radius: 2px;
  background: var(--surface-3);
  color: var(--fg-2);
  font: inherit;
}

.inspector-action:hover {
  background: var(--surface-4);
  color: var(--fg-1);
}
```

- [ ] **Step 6: Extend the e2e scenario**

Add to `frontend/tests/e2e/modes.spec.ts` inside the `panel modes` describe:

```typescript
test("the x chip and the palette both reach XY mode", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const panel = page.locator(".panel").first();
  await panel.locator(".legend-chip-caret").first().click();
  await panel.locator(".inspector-action", { hasText: "use as X" }).click();
  const chip = panel.locator(".x-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("x:");

  await chip.click();
  await expect(panel.locator(".mode-pill.active")).toHaveText("T");
  await expect(chip).toBeHidden();

  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("switch to XY");
  await page.keyboard.press("Enter");
  await expect(panel.locator(".mode-pill.active")).toHaveText("XY");
});
```

- [ ] **Step 7: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts \
  frontend/src/styles/app.css frontend/tests/e2e/modes.spec.ts
git commit -m "feat(xy): add the drop strip, x chip, and keyboard entry paths"
```

---

## Task 5: XY gestures, autoscale fit, and the linked cursor ring

**Files:**

- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/render/overlay-renderer.ts`
- Modify: `frontend/src/render/overlay-renderer.test.ts`
- Create: `frontend/src/app/xy-hit.ts`
- Create: `frontend/src/app/xy-hit.test.ts`
- Modify: `frontend/tests/e2e/modes.spec.ts`

**Interfaces:**

- Consumes: `XyTrace` (Task 3), `PlotLayout` + `insidePlot`/`invertX`/`invertY` (2A), `PanelCallbacks.onXRange` (Task 2).
- Produces: `nearestXyPoint(traces, layout, px, py, maxDistance): XyHit | null` with `XyHit { path: string; index: number; time: number; x: number; y: number }`; `OverlayState.xyMarkers: readonly XyMarker[]` with `XyMarker { x: number; y: number }`.

- [ ] **Step 1: Write the failing hit-test**

Create `frontend/src/app/xy-hit.test.ts`:

```typescript
import { expect, it } from "vitest";
import type { PlotLayout } from "./plot-math";
import { nearestXyPoint } from "./xy-hit";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: 0, max: 10 },
  yRange: { min: 0, max: 10 },
};

const traces = [
  {
    path: "a",
    trace: { time: [0, 1, 2], x: [1, 5, 9], y: [1, 5, 9] },
  },
];

it("finds the nearest vertex within the radius", () => {
  // Data (5,5) projects to pixel (50, 50).
  const hit = nearestXyPoint(traces, layout, 52, 48, 40);
  expect(hit).toEqual({ path: "a", index: 1, time: 1, x: 5, y: 5 });
});

it("returns null beyond the radius", () => {
  expect(nearestXyPoint(traces, layout, 50, 50, 1)).toBeNull();
});

it("skips non-finite vertices", () => {
  const broken = [
    {
      path: "a",
      trace: { time: [0, 1], x: [Number.NaN, 5], y: [Number.NaN, 5] },
    },
  ];
  expect(nearestXyPoint(broken, layout, 50, 50, 40)?.index).toBe(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/app/xy-hit.test.ts`
Expected: FAIL — cannot resolve `./xy-hit`.

- [ ] **Step 3: Implement the hit-test**

Create `frontend/src/app/xy-hit.ts`:

```typescript
import { projectX, projectY, type PlotLayout } from "./plot-math";
import type { XyTrace } from "./xy";

export interface XyHit {
  path: string;
  index: number;
  time: number;
  x: number;
  y: number;
}

/**
 * The trajectory vertex closest to a pixel, in pixel space, or null when
 * nothing lies within `maxDistance`. Hovering a trajectory publishes the
 * hit's *timestamp* as the global cursor, which is what couples an XY panel
 * to every time panel (ADR 0006).
 */
export function nearestXyPoint(
  traces: readonly { path: string; trace: XyTrace }[],
  layout: PlotLayout,
  px: number,
  py: number,
  maxDistance: number,
): XyHit | null {
  let best: XyHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of traces) {
    const { trace } = entry;
    for (let index = 0; index < trace.time.length; index += 1) {
      const x = trace.x[index] ?? Number.NaN;
      const y = trace.y[index] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const distance = Math.hypot(
        projectX(layout, x) - px,
        projectY(layout, y) - py,
      );
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = {
        path: entry.path,
        index,
        time: trace.time[index] ?? Number.NaN,
        x,
        y,
      };
    }
  }
  return bestDistance <= maxDistance ? best : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/app/xy-hit.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing overlay test**

Add to `frontend/src/render/overlay-renderer.test.ts`:

```typescript
test("draws XY cursor markers as hollow amber rings", () => {
  // Build the same recording proxy the first test uses, then:
  const renderer = new OverlayRenderer(canvas);
  renderer.setPalette(palette);
  renderer.draw(layout, {
    cursorT: null,
    cursorStyle: "line",
    cursorPoints: [],
    xyMarkers: [{ x: 30, y: 0 }],
    box: null,
    annotations: [],
    annotationColorIndices: [],
    showDelta: false,
  });
  expect(calls).toContain("arc");
  expect(calls).toContain("strokeStyle:#ffa226");
});
```

(Copy the proxy/canvas/layout construction from the existing test in that file; do not factor it out — the file's existing test keeps its own copy and matching that local style is the point.)

- [ ] **Step 6: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/render/overlay-renderer.test.ts`
Expected: FAIL — `xyMarkers` is not a property of `OverlayState`.

- [ ] **Step 7: Draw the marker ring**

In `frontend/src/render/overlay-renderer.ts`, add to `OverlayState`:

```typescript
  /** Data-space trajectory points marked by the global cursor (XY mode). */
  xyMarkers: readonly XyMarker[];
```

with

```typescript
export interface XyMarker {
  x: number;
  y: number;
}
```

and call a new painter from `draw()`, after `drawCursor`:

```typescript
this.drawXyMarkers(context, layout, state.xyMarkers, palette);
```

```typescript
  private drawXyMarkers(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    markers: readonly XyMarker[],
    palette: OverlayPalette,
  ): void {
    if (markers.length === 0) return;
    context.save();
    // Spec F2: r=4, surface fill, 1.6px amber stroke. Amber because the
    // marker is the cursor, not a series.
    context.lineWidth = 1.6;
    context.setLineDash([]);
    context.fillStyle = palette.surface0;
    context.strokeStyle = palette.amber;
    for (const marker of markers) {
      const x = projectX(layout, marker.x);
      const y = projectY(layout, marker.y);
      if (
        x < layout.plot.x ||
        x > layout.plot.x + layout.plot.width ||
        y < layout.plot.y ||
        y > layout.plot.y + layout.plot.height
      ) {
        continue;
      }
      context.beginPath();
      context.arc(x, y, 4, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.restore();
  }
```

Every existing `draw(...)` call site must now pass `xyMarkers`; `PanelView.drawOverlay` is the only production one.

- [ ] **Step 8: Wire XY gestures and the cursor into the panel**

In `frontend/src/ui/panel.ts`:

Add `import { nearestXyPoint } from "../app/xy-hit";` and, in `drawOverlay`, compute the markers by interpolating each trace at the cursor time:

```typescript
const xyMarkers =
  state?.mode === "xy" && cursorT !== null
    ? this.xyTraces.flatMap((entry) => {
        const point = markerAt(entry.trace, cursorT);
        return point === null ? [] : [point];
      })
    : [];
```

pass `xyMarkers` in the `draw({...})` literal, set `cursorT: state?.mode === "time" ? this.cursorT : null` unchanged (the vertical line stays a time-mode affordance), and add the helper beside `flattenTrace`:

```typescript
/** The trajectory point at a cursor time, or null outside its coverage. */
function markerAt(
  trace: XyTrace,
  cursorT: number,
): { x: number; y: number } | null {
  const count = trace.time.length;
  if (count === 0) return null;
  if (
    cursorT < (trace.time[0] ?? 0) ||
    cursorT > (trace.time[count - 1] ?? 0)
  ) {
    return null;
  }
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((trace.time[mid] ?? 0) < cursorT) low = mid + 1;
    else high = mid;
  }
  const previous = Math.max(0, low - 1);
  const span = (trace.time[low] ?? 0) - (trace.time[previous] ?? 0);
  const alpha = span === 0 ? 0 : (cursorT - (trace.time[previous] ?? 0)) / span;
  const at = (column: number[]): number => {
    const before = column[previous] ?? Number.NaN;
    const after = column[low] ?? Number.NaN;
    return before + (after - before) * alpha;
  };
  const x = at(trace.x);
  const y = at(trace.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
```

In the `pointermove` listener, publish the nearest-vertex timestamp in XY instead of the pixel's time:

```typescript
this.overlay.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch" || this.dragging) return;
  const layout = this.renderer.lastLayout();
  const inside =
    layout !== null && insidePlot(layout, event.offsetX, event.offsetY);
  let cursorT: number | null = null;
  if (layout !== null && inside) {
    cursorT =
      this.lastState?.mode === "xy"
        ? (nearestXyPoint(
            this.xyTraces,
            layout,
            event.offsetX,
            event.offsetY,
            XY_HOVER_RADIUS,
          )?.time ?? null)
        : invertX(layout, event.offsetX);
  }
  this.callbacks.onCursor(
    this.id,
    cursorT,
    cursorT === null ? null : { x: event.clientX, y: event.clientY },
  );
});
```

with `const XY_HOVER_RADIUS = 40;` beside `MODES` (the prototype's mouse-hover radius).

Now let the wheel, drag-pan, box-zoom, and double-click work on a value x axis. In each of the four handlers, replace the `this.lastState?.mode !== "time"` guard with `!this.interactiveMode()` and route x-axis results through a single sink:

```typescript
  /** Modes whose plot area accepts zoom/pan gestures. */
  private interactiveMode(): boolean {
    const mode = this.lastState?.mode;
    return mode === "time" || mode === "xy";
  }

  /**
   * Applies an x-axis range: the linked time window in time mode, a
   * panel-local value range everywhere else. ADR 0006 — an XY panel's x axis
   * is a value axis and never writes the global window.
   */
  private applyXRange(min: number, max: number): void {
    if (this.lastState?.mode === "time") {
      this.callbacks.onTimeWindow(this.id, min, max);
    } else {
      this.callbacks.onXRange(this.id, [min, max]);
    }
  }
```

Replace every `this.callbacks.onTimeWindow(this.id, a, b)` inside `bind()`'s wheel handler, `beginPan`, and `beginBoxOrClick` with `this.applyXRange(a, b)`. Leave the `onTimeWindow` call in `plotClick`-adjacent code untouched (there is none).

Guard the annotation paths so they stay time-mode-only for now: `plotClick` already early-returns unless `state.mode === "time"` — leave that as is; Task 6 widens it.

Finally, extend the double-click handler's fit branch so XY fits its own axes:

```typescript
      } else if (insidePlot(layout, event.offsetX, event.offsetY)) {
        this.callbacks.onFitView(this.id);
      }
```

is unchanged; the mode-specific behaviour lives in `AppShell.fitPanelView` (next step).

- [ ] **Step 9: Make fit mode-aware**

In `frontend/src/ui/app-shell.ts`, at the top of `fitPanelView`, add:

```typescript
if (panel.mode !== "time") {
  // Non-time panels have no time axis to fit: clearing both ranges
  // returns them to autoscale, which the renderer recomputes.
  this.workspace.clearPanelXRange(panelId);
  this.workspace.clearPanelYRange(panelId);
  this.workspaceView?.resetYAxis(panelId);
  this.renderTiles();
  return;
}
```

- [ ] **Step 10: Extend the e2e scenario**

Add to `frontend/tests/e2e/modes.spec.ts`:

```typescript
test("XY zoom stays panel-local and the cursor rings the trajectory", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const panel = page.locator(".panel").first();
  await panel.locator(".mode-pill", { hasText: "XY" }).click();
  const readout = page.locator(".window-readout");
  const before = await readout.textContent();

  const overlay = panel.locator(".overlay-canvas");
  await overlay.hover({ position: { x: 200, y: 120 } });
  await page.mouse.wheel(0, -240);
  // ADR 0006: an XY panel never writes the linked time window.
  await expect(readout).toHaveText(before ?? "");

  await page.locator(".cursor-style-toggle").click();
  await overlay.hover({ position: { x: 200, y: 120 } });
  await expect(page.locator(".cursor-readout")).not.toHaveText("t = —");
});
```

- [ ] **Step 11: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add frontend/src/app/xy-hit.ts frontend/src/app/xy-hit.test.ts \
  frontend/src/render/overlay-renderer.ts frontend/src/render/overlay-renderer.test.ts \
  frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts \
  frontend/tests/e2e/modes.spec.ts
git commit -m "feat(xy): add value-axis gestures and the amber trajectory cursor"
```

---

## Task 6: XY datatips and the Δ readout

**Files:**

- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/render/overlay-renderer.ts`
- Modify: `frontend/src/render/overlay-renderer.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/tests/e2e/modes.spec.ts`

**Interfaces:**

- Consumes: `nearestXyPoint` (Task 5), `Annotation` (session), `PanelCallbacks.onPinAnnotation`/`onRemoveAnnotation` (2A).
- Produces: `OverlayState.mode: PanelMode` and `OverlayState.annotationPoints: readonly (XyMarker | null)[]`, which place time-mode annotations at `(time, value)` and XY annotations at their trajectory coordinates.

**Why the extra array:** an `Annotation` stores `time` and `value`. In time mode those _are_ the plot coordinates. In XY the x coordinate is the x signal's value at that time, which only the panel knows, so the panel resolves each annotation to a plot point and the overlay draws points rather than re-deriving them.

- [ ] **Step 1: Write the failing overlay test**

Add to `frontend/src/render/overlay-renderer.test.ts`:

```typescript
test("places annotations at supplied plot points when given them", () => {
  // Recording proxy as in the other tests, then:
  const renderer = new OverlayRenderer(canvas);
  renderer.setPalette(palette);
  renderer.draw(layout, {
    cursorT: null,
    cursorStyle: "none",
    cursorPoints: [],
    xyMarkers: [],
    box: null,
    annotations: [
      { id: "a", series_path: "s", time: 10, value: 1, label: "" },
      { id: "b", series_path: "s", time: 20, value: 2, label: "" },
    ],
    annotationColorIndices: [0, 0],
    annotationPoints: [
      { x: 10, y: 100 },
      { x: 40, y: 150 },
    ],
    showDelta: true,
  });
  // Δx replaces the time-mode slope readout when points are supplied.
  const drawn = calls.join(" ");
  expect(drawn).toContain("fillText");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/render/overlay-renderer.test.ts`
Expected: FAIL — `annotationPoints` is not a property of `OverlayState`.

- [ ] **Step 3: Teach the overlay about plot-space annotations**

In `frontend/src/render/overlay-renderer.ts`, add to `OverlayState`:

```typescript
  /**
   * Plot-space coordinates per annotation, or null when the annotation has
   * no position in this mode. Absent (an empty array) means "use
   * `(time, value)`", which is the time-mode identity.
   */
  annotationPoints: readonly (XyMarker | null)[];
```

In `drawAnnotations`, resolve each position through the new array:

```typescript
    state.annotations.forEach((annotation, index) => {
      const supplied = state.annotationPoints[index];
      const point =
        supplied === undefined
          ? { x: annotation.time, y: annotation.value }
          : supplied;
      if (point === null) return;
      if (
        state.annotationPoints.length === 0 &&
        (annotation.time < layout.xRange.min ||
          annotation.time > layout.xRange.max)
      ) {
        return;
      }
      const x = projectX(layout, point.x);
      const y = projectY(layout, point.y);
      // …marker, label box, and text exactly as before…
```

and change `drawDelta` to take the resolved points so its readout matches the mode:

```typescript
  private drawDelta(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    annotations: readonly Annotation[],
    points: readonly (XyMarker | null)[],
    palette: OverlayPalette,
  ): void {
    const firstIndex = annotations.length - 2;
    const secondIndex = annotations.length - 1;
    const first = annotations[firstIndex];
    const second = annotations[secondIndex];
    if (first === undefined || second === undefined) return;
    const firstPoint = points[firstIndex] ?? {
      x: first.time,
      y: first.value,
    };
    const secondPoint = points[secondIndex] ?? {
      x: second.time,
      y: second.value,
    };
    if (firstPoint === null || secondPoint === null) return;
    context.save();
    context.strokeStyle = palette.fg3;
    context.globalAlpha = 0.6;
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(
      projectX(layout, firstPoint.x),
      projectY(layout, firstPoint.y),
    );
    context.lineTo(
      projectX(layout, secondPoint.x),
      projectY(layout, secondPoint.y),
    );
    context.stroke();
    context.restore();
    const deltaT = second.time - first.time;
    const deltaV = second.value - first.value;
    const parts = [`Δt ${formatValue(deltaT)} s`];
    if (points.length === 0) {
      // Time mode: Δv and the slope, which is only meaningful against time.
      const slope = deltaT === 0 ? null : deltaV / deltaT;
      parts.push(`Δv ${formatValue(deltaV)}`);
      if (slope !== null) parts.push(`slope ${formatValue(slope)}/s`);
    } else {
      parts.push(
        `Δx ${formatValue(secondPoint.x - firstPoint.x)}`,
        `Δy ${formatValue(secondPoint.y - firstPoint.y)}`,
      );
    }
    const text = parts.join(" · ");
    // …box and text drawing exactly as before…
  }
```

Update its call site to `this.drawDelta(context, layout, state.annotations, state.annotationPoints, palette);`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/render/overlay-renderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Pin and remove XY datatips**

In `frontend/src/ui/panel.ts`, widen `plotClick` to XY:

```typescript
  plotClick(offsetX: number, offsetY: number): void {
    const layout = this.renderer.lastLayout();
    const state = this.lastState;
    if (layout === null || state === null) return;
    if (state.mode === "xy") {
      const points = this.annotationPoints(state);
      const existing = state.annotations.findIndex((annotation, index) => {
        const point = points[index];
        if (point === null || point === undefined) return false;
        return (
          Math.hypot(
            projectX(layout, point.x) - offsetX,
            projectY(layout, point.y) - offsetY,
          ) <= 9
        );
      });
      if (existing !== -1) {
        const annotation = state.annotations[existing];
        if (annotation !== undefined) {
          this.callbacks.onRemoveAnnotation(this.id, annotation.id);
        }
        return;
      }
      const hit = nearestXyPoint(this.xyTraces, layout, offsetX, offsetY, 14);
      if (hit !== null) {
        // `VertexHit` carries `distance` for the time-mode caller's own
        // comparisons; the XY search has already resolved the winner.
        this.callbacks.onPinAnnotation(this.id, {
          path: hit.path,
          time: hit.time,
          value: hit.y,
          distance: 0,
        });
      }
      return;
    }
    if (state.mode !== "time") return;
    // …existing time-mode body unchanged…
  }
```

(Import `projectX`, `projectY` from `../app/plot-math`. The asymmetric 9px remove / 14px pin radii are 2A's, kept so a double-click self-cancels its accidental pin before fitting.)

Add the resolver and use it in `drawOverlay`:

```typescript
  /** Plot coordinates for each annotation in the current mode. */
  private annotationPoints(
    state: PanelState,
  ): (({ x: number; y: number }) | null)[] {
    if (state.mode !== "xy") return [];
    return state.annotations.map((annotation) => {
      const entry = this.xyTraces.find(
        (item) => item.path === annotation.series_path,
      );
      return entry === undefined ? null : markerAt(entry.trace, annotation.time);
    });
  }
```

In `drawOverlay`, change the annotations source so XY annotations survive, and pass the points:

```typescript
const annotations =
  state?.mode === "time" || state?.mode === "xy" ? state.annotations : [];
```

```typescript
      annotationPoints: state === null ? [] : this.annotationPoints(state),
```

Also widen `renderAnnotationList` the same way: change `const annotations = state.mode === "time" ? state.annotations : [];` to accept `"xy"` as well.

- [ ] **Step 6: Extend the e2e scenario**

Add to `frontend/tests/e2e/modes.spec.ts`:

```typescript
test("XY datatips pin, list, and show a delta", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop interaction");
  const panel = page.locator(".panel").first();
  await panel.locator(".mode-pill", { hasText: "XY" }).click();
  const overlay = panel.locator(".overlay-canvas");
  const box = await overlay.boundingBox();
  if (box === null) throw new Error("overlay not laid out");
  await page.mouse.click(box.x + 160, box.y + 100);
  await page.mouse.click(box.x + 260, box.y + 140);
  const list = panel.locator(".panel-annotations");
  await expect(list).toBeVisible();
  await expect(list.locator(".annotation-row")).toHaveCount(2);
});
```

(If a click lands on no vertex the row count will be lower; the demo trajectory is dense, but if this proves flaky, click along the drawn path found via `boundingBox()` centre offsets rather than widening the radii.)

- [ ] **Step 7: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts \
  frontend/src/render/overlay-renderer.ts frontend/src/render/overlay-renderer.test.ts \
  frontend/tests/e2e/modes.spec.ts
git commit -m "feat(xy): pin trajectory datatips with delta readouts"
```

---

## Task 7: The `batlow` sequential colormap (tokens, checks, ADR 0016)

**Files:**

- Modify: `frontend/src/styles/tokens.css`
- Create: `frontend/src/app/colormap.ts`
- Create: `frontend/src/app/colormap.test.ts`
- Modify: `frontend/src/styles/palette.test.ts`
- Create: `docs/adr/0016-sequential-colormap.md`

**Interfaces:**

- Produces: `SEQ_TOKENS: readonly string[]` (16 CSS custom-property names) and `sampleColormap(stops: readonly string[], t: number): string` from `frontend/src/app/colormap.ts`.

**Provenance:** the sixteen stops below are rows 1, 18, 35, …, 256 of `batlow.txt` from Crameri's Scientific colour maps (Zenodo DOI 10.5281/zenodo.1243862, MIT licensed), converted from the published 0–1 floats to 8-bit hex. Do not substitute eyeballed values — ADR 0011 requires acceptance by computed check.

- [ ] **Step 1: Add the tokens**

Append to the `:root` block in `frontend/src/styles/tokens.css` (and **only** there — per ADR 0016 the ramp is theme-invariant, so it is not repeated in `:root[data-theme="light"]`):

```css
--seq-01: #011959;
--seq-02: #0d3260;
--seq-03: #114560;
--seq-04: #185562;
--seq-05: #26635f;
--seq-06: #3c6d56;
--seq-07: #577647;
--seq-08: #737e38;
--seq-09: #91862d;
--seq-10: #b38e2f;
--seq-11: #d29343;
--seq-12: #ed9a62;
--seq-13: #fba689;
--seq-14: #fdb2af;
--seq-15: #fcbfd4;
--seq-16: #fbccfa;
```

- [ ] **Step 2: Write the failing colormap tests**

Create `frontend/src/app/colormap.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { SEQ_TOKENS, sampleColormap } from "./colormap";

const stops = ["#000000", "#808080", "#ffffff"];

describe("sampleColormap", () => {
  it("returns the endpoints and clamps beyond them", () => {
    expect(sampleColormap(stops, 0)).toBe("#000000");
    expect(sampleColormap(stops, 1)).toBe("#ffffff");
    expect(sampleColormap(stops, -5)).toBe("#000000");
    expect(sampleColormap(stops, 5)).toBe("#ffffff");
  });

  it("interpolates between adjacent stops", () => {
    expect(sampleColormap(stops, 0.25)).toBe("#404040");
  });

  it("falls back to the first stop for a non-finite position", () => {
    expect(sampleColormap(stops, Number.NaN)).toBe("#000000");
  });

  it("declares sixteen ordered tokens", () => {
    expect(SEQ_TOKENS).toHaveLength(16);
    expect(SEQ_TOKENS[0]).toBe("--seq-01");
    expect(SEQ_TOKENS[15]).toBe("--seq-16");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/app/colormap.test.ts`
Expected: FAIL — cannot resolve `./colormap`.

- [ ] **Step 4: Implement the colormap sampler**

Create `frontend/src/app/colormap.ts`:

```typescript
/**
 * Custom-property names of the sequential ramp, low to high. The ramp is
 * `batlow` (ADR 0016) and is theme-invariant: a sequential map's monotone
 * lightness is the property that makes it admissible, so re-stepping it per
 * surface the way categorical slots are re-stepped would destroy it.
 */
export const SEQ_TOKENS = [
  "--seq-01",
  "--seq-02",
  "--seq-03",
  "--seq-04",
  "--seq-05",
  "--seq-06",
  "--seq-07",
  "--seq-08",
  "--seq-09",
  "--seq-10",
  "--seq-11",
  "--seq-12",
  "--seq-13",
  "--seq-14",
  "--seq-15",
  "--seq-16",
] as const;

function channels(hex: string): [number, number, number] {
  const body = hex.trim().replace("#", "");
  const parts = [0, 2, 4].map((offset) =>
    Number.parseInt(body.slice(offset, offset + 2), 16),
  );
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function hex(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
}

/** Samples a hex ramp at `t ∈ [0, 1]`, clamping outside and on NaN. */
export function sampleColormap(stops: readonly string[], t: number): string {
  const first = stops[0] ?? "#000000";
  if (stops.length === 0) return first;
  if (!Number.isFinite(t)) return first;
  const position = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const low = Math.floor(position);
  const high = Math.min(stops.length - 1, low + 1);
  const alpha = position - low;
  const [r0, g0, b0] = channels(stops[low] ?? first);
  const [r1, g1, b1] = channels(stops[high] ?? first);
  return `#${hex(r0 + (r1 - r0) * alpha)}${hex(g0 + (g1 - g0) * alpha)}${hex(
    b0 + (b1 - b0) * alpha,
  )}`;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/app/colormap.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the computed acceptance checks**

`frontend/src/styles/palette.test.ts` already parses `tokens.css` and carries `toLinear`, `toOklab`, and the Machado CVD matrices. Add a describe block at the end using those existing helpers (read the file first and reuse its exact helper names, including however it extracts a token value from the stylesheet text):

```typescript
describe("sequential colormap", () => {
  const stops = SEQ_TOKENS.map((token) => tokenValue(TOKENS, token));

  it("declares every stop exactly once, in the default theme only", () => {
    expect(stops).toHaveLength(16);
    for (const stop of stops) expect(stop).toMatch(/^#[0-9a-f]{6}$/);
    // Theme-invariant per ADR 0016: no light-mode override exists.
    const light = TOKENS.slice(TOKENS.indexOf('[data-theme="light"]'));
    expect(light).not.toContain("--seq-");
  });

  it("rises monotonically in lightness", () => {
    const lightness = stops.map((stop) => toOklab(toLinear(stop))[0]);
    for (let index = 1; index < lightness.length; index += 1) {
      expect(lightness[index] ?? 0).toBeGreaterThan(lightness[index - 1] ?? 0);
    }
  });

  it("stays monotone under protan and deutan simulation", () => {
    for (const kind of ["protan", "deutan"] as const) {
      const lightness = stops.map(
        (stop) => toOklab(simulate(toLinear(stop), MACHADO[kind]))[0],
      );
      for (let index = 1; index < lightness.length; index += 1) {
        expect(lightness[index] ?? 0).toBeGreaterThan(
          lightness[index - 1] ?? 0,
        );
      }
    }
  });

  it("spans enough lightness to survive greyscale printing", () => {
    const lightness = stops.map((stop) => toOklab(toLinear(stop))[0]);
    const span = (lightness[15] ?? 0) - (lightness[0] ?? 0);
    expect(span).toBeGreaterThan(0.5);
  });
});
```

Import `SEQ_TOKENS` from `../app/colormap`. If `palette.test.ts` has no `tokenValue`/`simulate` helper under those names, use whatever it does have — do not add duplicates.

- [ ] **Step 7: Run the palette suite**

Run: `./scripts/dev.sh pnpm vitest run src/styles/palette.test.ts`
Expected: PASS. If a monotonicity assertion fails, **re-derive the stops from `batlow.txt` — never relax the threshold.** ADR 0011 is explicit: "A future edit that fails the test is to be answered by re-deriving the palette, never by relaxing a threshold in the test."

- [ ] **Step 8: Write ADR 0016**

Create `docs/adr/0016-sequential-colormap.md`:

```markdown
# 16. The sequential colormap is theme-invariant batlow

Status: Accepted

## Context

The Final Spec requires a labelled colorbar whenever a `c:` colour channel is
assigned, and states only that the colormap is "perceptually uniform +
colorblind-safe (viridis-class)". It supplies no stops. Its own F2 mock fills
the colorbar with a gradient built from three _categorical_ series tokens,
which the same handoff forbids ("separate from the categorical series
palette") and which is non-monotonic in lightness in the light theme.

ADR 0011 already fixed the source: Crameri's Scientific colour maps, `batlow`
for sequential magnitude, no rainbow map, no map lacking monotone lightness.
It deliberately shipped no tokens, because nothing read them yet.

## Decision

`--seq-01` … `--seq-16` are sixteen evenly spaced samples of `batlow` (rows
1, 18, 35, … 256 of the published 256-entry table), declared once in `:root`.

Unlike the categorical slots, the ramp is **theme-invariant**. A categorical
slot's job is identity, so ADR 0011 re-steps its lightness per surface. A
sequential ramp's job _is_ its monotone lightness: re-stepping it per surface
would collapse the property that makes it admissible, and the colorbar's 1px
border already separates its dark end from a near-black surface.

Acceptance is by computed check in `frontend/src/styles/palette.test.ts`:
strictly increasing OKLab lightness unsimulated and under Machado protan and
deutan simulation, and a lightness span wide enough to survive greyscale.

## Consequences

- The `c:` colorbar and the colour-mapped trajectory read identically in both
  themes, so a caption naming a colour stays true across the theme toggle —
  the same requirement that drove ADR 0011.
- Sixteen stops with linear interpolation between them is visually
  indistinguishable from the full 256-entry table at any colorbar size this
  app draws, and keeps the token sheet readable.
- A diverging ramp (`vik`/`roma` per ADR 0011) is still unshipped. Add it the
  same way, with its own computed checks, when something reads it.
```

- [ ] **Step 9: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add frontend/src/styles/tokens.css frontend/src/styles/palette.test.ts \
  frontend/src/app/colormap.ts frontend/src/app/colormap.test.ts \
  docs/adr/0016-sequential-colormap.md
git commit -m "feat(tokens): add the batlow sequential colormap with computed checks"
```

---

## Task 8: The `c:` colour channel and its colorbar

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`
- Modify: `frontend/src/render/canvas-renderer.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/modes.spec.ts`

**Interfaces:**

- Consumes: `SEQ_TOKENS`/`sampleColormap` (Task 7), `PlotPath`/`PathRenderOptions` (Task 3), `WorkspaceModel.setColorSignal` (Task 3).
- Produces: `PlotPath.colorValues?: readonly number[]`; `PathRenderOptions.colorbar?: { min: number; max: number; label: string }`; `Palette.sequential: string[]`; `PanelCallbacks.onSetColorSignal(id, path)`.

- [ ] **Step 1: Write the failing renderer test**

Add to `frontend/src/render/canvas-renderer.test.ts`:

```typescript
it("reserves a colorbar gutter and strokes per-segment colours", () => {
  const { context, calls } = recordingContext();
  const renderer = new CanvasRenderer(fakeCanvas(context, 600, 300));
  renderer.setPalette({ ...testPalette, sequential: ["#000000", "#ffffff"] });
  renderer.renderPaths(
    [
      {
        points: [0, 0, 1, 1, 2, 2],
        colorValues: [0, 0.5, 1],
        colorIndex: 0,
        dash: "solid",
        width: 1.4,
      },
    ],
    {
      xLabel: "x",
      yLabel: "y",
      xRange: [0, 2],
      yRange: [0, 2],
      colorbar: { min: 0, max: 1, label: "t (s)" },
    },
  );
  const layout = renderer.lastLayout();
  // Spec F2: 64px right gutter holds the 12px bar, its ticks, and labels.
  expect((layout?.plot.x ?? 0) + (layout?.plot.width ?? 0)).toBeLessThan(
    600 - 60,
  );
  // One stroke per segment rather than one stroke for the path.
  expect(calls.filter((call) => call === "stroke").length).toBeGreaterThan(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/render/canvas-renderer.test.ts`
Expected: FAIL — `sequential` is not a property of `Palette`, `colorValues`/`colorbar` are not properties.

- [ ] **Step 3: Implement colour-mapped paths and the colorbar**

In `frontend/src/render/canvas-renderer.ts`:

Add `sequential: string[];` to `Palette`, and resolve it in `resolvePalette()` beside `series`:

```typescript
      sequential: SEQ_TOKENS.map((token) =>
        styles.getPropertyValue(token).trim(),
      ),
```

with `import { SEQ_TOKENS, sampleColormap } from "../app/colormap";`.

Add to `PlotPath`:

```typescript
  /** Per-vertex scalar driving the sequential ramp; enables `c:` colouring. */
  colorValues?: readonly number[];
```

and to `PathRenderOptions`:

```typescript
  /** Domain and axis name of the `c:` channel; reserves the right gutter. */
  colorbar?: { min: number; max: number; label: string };
```

Add the gutter constant beside `MARKER_PIXEL_GAP`:

```typescript
/** Spec F2: 64px right gutter — 12px bar, 3px ticks, labels, and slack. */
const COLORBAR_GUTTER = 64;
```

In `renderPaths`, subtract the gutter from the plot width when a colorbar is requested, and paint it after the paths:

```typescript
const colorbarGutter =
  options.colorbar === undefined || inline ? 0 : COLORBAR_GUTTER;
const plot: PlotRect = inline
  ? { x: 0, y: 0, width, height }
  : {
      x: gutter,
      y: 8,
      width: Math.max(1, width - gutter - 12 - colorbarGutter),
      height: Math.max(1, height - 42),
    };
```

```typescript
for (const path of paths) this.drawPath(context, plot, project, path, colors);
if (options.colorbar !== undefined && colorbarGutter > 0) {
  this.drawColorbar(context, plot, width, options.colorbar, colors);
}
return performance.now() - started;
```

In `drawPath`, take the colour-mapped branch when `colorValues` is present. Insert directly after the clip is applied and before the single-colour stroke setup:

```typescript
if (path.colorValues !== undefined && path.dimmed !== true) {
  this.drawColorMappedPath(context, project, path, colors);
  context.restore();
  return;
}
```

and add the two painters:

```typescript
  /** Strokes one segment per vertex pair so each carries its own `c:` colour. */
  private drawColorMappedPath(
    context: CanvasRenderingContext2D,
    project: Projection,
    path: PlotPath,
    colors: Palette,
  ): void {
    const values = path.colorValues ?? [];
    const vertices = path.points.length >> 1;
    context.lineWidth = path.width;
    context.setLineDash(dashPattern(path.dash));
    context.lineCap = "round";
    for (let index = 1; index < vertices; index += 1) {
      const x0 = path.points[(index - 1) * 2] ?? Number.NaN;
      const y0 = path.points[(index - 1) * 2 + 1] ?? Number.NaN;
      const x1 = path.points[index * 2] ?? Number.NaN;
      const y1 = path.points[index * 2 + 1] ?? Number.NaN;
      if (
        !Number.isFinite(x0) ||
        !Number.isFinite(y0) ||
        !Number.isFinite(x1) ||
        !Number.isFinite(y1)
      ) {
        continue;
      }
      // Midpoint of the segment's two scalars keeps the ramp continuous.
      const scalar =
        ((values[index - 1] ?? 0) + (values[index] ?? 0)) * 0.5;
      context.strokeStyle = sampleColormap(colors.sequential, scalar);
      context.beginPath();
      context.moveTo(project.toX(x0), project.toY(y0));
      context.lineTo(project.toX(x1), project.toY(y1));
      context.stroke();
    }
    context.lineCap = "butt";
    context.setLineDash([]);
  }

  /**
   * The `c:` colorbar: an axis with full anatomy — 12px bar flush with the
   * plot, 3px ticks at both ends and the midpoint, tabular labels, and its
   * own name in the corner (spec F2).
   */
  private drawColorbar(
    context: CanvasRenderingContext2D,
    plot: PlotRect,
    width: number,
    colorbar: { min: number; max: number; label: string },
    colors: Palette,
  ): void {
    const barX = width - COLORBAR_GUTTER + 24;
    const barWidth = 12;
    for (let offset = 0; offset < plot.height; offset += 1) {
      // Bottom is the low end, matching the spec's bottom-to-top gradient.
      const scalar = 1 - offset / Math.max(1, plot.height - 1);
      context.fillStyle = sampleColormap(colors.sequential, scalar);
      context.fillRect(barX, plot.y + offset, barWidth, 1);
    }
    context.strokeStyle = colors.border;
    context.lineWidth = 1;
    context.strokeRect(barX + 0.5, plot.y + 0.5, barWidth, plot.height);
    context.beginPath();
    for (const fraction of [0, 0.5, 1]) {
      const y = Math.round(plot.y + plot.height * fraction) + 0.5;
      context.moveTo(barX + barWidth, y);
      context.lineTo(barX + barWidth + 3, y);
    }
    context.strokeStyle = colors.fg3;
    context.stroke();
    context.font = tickFont(colors);
    context.fillStyle = colors.fg3;
    context.textAlign = "right";
    context.textBaseline = "middle";
    const span = colorbar.max - colorbar.min;
    for (const fraction of [0, 0.5, 1]) {
      const value = colorbar.max - span * fraction;
      context.fillText(
        value.toFixed(1).replace(/^-/, "−"),
        width - 2,
        plot.y + plot.height * fraction,
      );
    }
    context.font = labelFont(colors);
    context.fillStyle = colors.fg2;
    context.textBaseline = "alphabetic";
    context.fillText(colorbar.label, width - 2, plot.y + plot.height + 27);
  }
```

Every construction of a `Palette` literal in tests must gain a `sequential` array; update `testPalette` in `canvas-renderer.test.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/render/canvas-renderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Feed the channel from the panel**

In `PanelView.renderXy`, resolve the colour scalars. The channel is either the literal string `time` (the spec's own example) or a signal path:

```typescript
const colorSeries =
  state.color_signal === null
    ? null
    : state.color_signal === "time"
      ? "time"
      : (byPath.get(state.color_signal) ?? null);
const colorFor = (trace: XyTrace): number[] | null => {
  if (colorSeries === null) return null;
  if (colorSeries === "time") return [...trace.time];
  return trace.time.map((time) =>
    lerpSample(colorSeries.time, colorSeries.values, time),
  );
};
```

with `lerpSample` imported from `../app/xy` (Task 3 exports it).

Compute the domain across every lit trace, normalize, and pass both through:

```typescript
const colorColumns = this.xyTraces.map((entry) => colorFor(entry.trace));
let colorMin = Number.POSITIVE_INFINITY;
let colorMax = Number.NEGATIVE_INFINITY;
for (const column of colorColumns) {
  for (const value of column ?? []) {
    if (!Number.isFinite(value)) continue;
    colorMin = Math.min(colorMin, value);
    colorMax = Math.max(colorMax, value);
  }
}
const hasColor =
  colorSeries !== null && Number.isFinite(colorMin) && colorMax > colorMin;
```

In the lit-path loop, add when `hasColor`:

```typescript
        ...(hasColor
          ? {
              colorValues: (colorColumns[index] ?? []).map(
                (value) => (value - colorMin) / (colorMax - colorMin),
              ),
            }
          : {}),
```

(index the loop with `forEach((entry, index) => …)` so `colorColumns[index]` lines up), and add to `options`:

```typescript
      ...(hasColor
        ? {
            colorbar: {
              min: colorMin,
              max: colorMax,
              label:
                state.color_signal === "time"
                  ? "t (s)"
                  : axisName(
                      state.color_signal ?? "",
                      colorSeries === "time" ? null : colorSeries.unit,
                    ),
            },
          }
        : {}),
```

`exactOptionalPropertyTypes` is on, so spread-conditionals are required rather than `key: undefined`.

- [ ] **Step 6: Add the `c:` chip and its picker**

In `panelMarkup()`, add after the legend overflow button:

```html
<button class="axis-chip c-chip" hidden></button>
```

In `update()`, beside the `x:` chip block:

```typescript
const cChip = required<HTMLButtonElement>(this.element, ".c-chip");
cChip.hidden = state.mode !== "xy";
if (!cChip.hidden) {
  cChip.replaceChildren(
    chipPrefix("c:"),
    document.createTextNode(
      state.color_signal === null
        ? "none"
        : state.color_signal === "time"
          ? "time"
          : state.color_signal.split("/").slice(-2).join("/"),
    ),
  );
  cChip.title =
    state.color_signal === null
      ? "Assign a colour channel (⌘P → set color signal)"
      : `Colour channel: ${state.color_signal} — click to clear`;
}
```

and bind it in `bind()` to clear the channel, which is the reversible half of the pair:

```typescript
required(this.element, ".c-chip").addEventListener("click", () => {
  this.callbacks.onSetColorSignal(this.id, null);
});
```

Add `onSetColorSignal(id: string, path: string | null): void;` to `PanelCallbacks`, and in `app-shell.ts`:

```typescript
        onSetColorSignal: (id, path) => {
          this.workspace.setColorSignal(id, path);
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
```

Assignment goes through the palette, per the spec's only affordance. In `paletteEntries()`, beside `xSignals`:

```typescript
const colorSignals =
  focused === null
    ? []
    : [
        {
          title: "Panel: set color signal (c:)… time",
          hint: "colour by time",
          run: () => {
            this.workspace.setColorSignal(focused, "time");
            this.afterLayoutChange();
          },
        },
        ...this.signals.map((summary) => ({
          title: `Panel: set color signal (c:)… ${summary.path}`,
          hint: "signal",
          run: () => {
            this.workspace.setColorSignal(focused, summary.path);
            this.afterLayoutChange();
          },
        })),
      ];
```

and include `...colorSignals` in the returned array.

- [ ] **Step 7: Extend the e2e scenario**

Add to `frontend/tests/e2e/modes.spec.ts`:

```typescript
test("the colour channel is assignable and clearable", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const panel = page.locator(".panel").first();
  await panel.locator(".mode-pill", { hasText: "XY" }).click();
  const chip = panel.locator(".c-chip");
  await expect(chip).toContainText("none");

  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("set color signal");
  await page.keyboard.press("Enter");
  await expect(chip).toContainText("time");

  await chip.click();
  await expect(chip).toContainText("none");
});
```

- [ ] **Step 8: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts \
  frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts \
  frontend/src/styles/app.css frontend/tests/e2e/modes.spec.ts
git commit -m "feat(xy): colour trajectories by a c channel with a labelled colorbar"
```

---

## Task 9: The spectrum module (ADR 0017)

**Files:**

- Create: `frontend/src/app/spectrum.ts`
- Create: `frontend/src/app/spectrum.test.ts`
- Create: `docs/adr/0017-spectrum-semantics.md`

**Interfaces:**

- Consumes: `SampleSeries` (Task 1).
- Produces: `Spectrum { frequency: number[]; amplitudeDb: number[]; sampleRate: number; size: number }` and `spectrum(series: SampleSeries, t0: number, t1: number): Spectrum | null` from `frontend/src/app/spectrum.ts`.

**Semantics being implemented** (none of this is specified by the design package; ADR 0017 records it):

| Question     | Answer                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| Input span   | The visible time window, `[t0, t1]`                                                  |
| Uniform grid | `N` = largest power of two ≤ the sample count in the window, clamped to `[64, 4096]` |
| Sample rate  | `(N − 1) / (t1 − t0)` — derived from the grid, so irregular timestamps are fine      |
| Resampling   | Linear (`lerpSample`); NaN anywhere in the grid aborts and returns null              |
| Detrend      | Subtract the mean, so DC leakage does not swamp the first bins                       |
| Taper        | Hann, `0.5 · (1 − cos(2πn / (N − 1)))`                                               |
| Output bins  | One-sided, `k = 1 … N/2`; DC is dropped because a log axis cannot show `f = 0`       |
| Amplitude    | `20 · log10(magnitude / peak)`, so the peak is 0 dB; floored at −120 dB              |
| Multi-series | One spectrum per visible series                                                      |

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/spectrum.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { SampleSeries } from "../generated/protocol";
import { spectrum } from "./spectrum";

function sampled(rate: number, seconds: number, tone: number): SampleSeries {
  const count = Math.round(rate * seconds);
  const time: number[] = [];
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const t = index / rate;
    time.push(t);
    values.push(Math.sin(2 * Math.PI * tone * t));
  }
  return {
    signal_id: "1",
    signal_path: "imu/accel_z",
    unit: "m/s^2",
    time,
    values,
    stride: 1,
  };
}

describe("spectrum", () => {
  it("peaks at the tone frequency", () => {
    const series = sampled(256, 4, 16);
    const result = spectrum(series, 0, 4 - 1 / 256);
    expect(result).not.toBeNull();
    if (result === null) return;
    const peak = result.amplitudeDb.indexOf(0);
    expect(peak).toBeGreaterThanOrEqual(0);
    expect(result.frequency[peak] ?? 0).toBeCloseTo(16, 0);
  });

  it("normalizes the peak to 0 dB and floors the noise", () => {
    const result = spectrum(sampled(256, 4, 16), 0, 4 - 1 / 256);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(Math.max(...result.amplitudeDb)).toBe(0);
    expect(Math.min(...result.amplitudeDb)).toBeGreaterThanOrEqual(-120);
  });

  it("drops DC and uses a power-of-two grid", () => {
    const result = spectrum(sampled(256, 4, 16), 0, 4 - 1 / 256);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.frequency[0] ?? 0).toBeGreaterThan(0);
    expect(result.size & (result.size - 1)).toBe(0);
    expect(result.frequency).toHaveLength(result.size / 2);
  });

  it("returns null for a window with too few samples", () => {
    const series = sampled(256, 4, 16);
    expect(spectrum(series, 0, 0.1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/app/spectrum.test.ts`
Expected: FAIL — cannot resolve `./spectrum`.

- [ ] **Step 3: Implement the spectrum module**

Create `frontend/src/app/spectrum.ts`:

```typescript
import type { SampleSeries } from "../generated/protocol";
import { lerpSample } from "./xy";

export interface Spectrum {
  /** Bin centre frequencies in Hz, one-sided and DC-free. */
  frequency: number[];
  /** Magnitude in dB relative to the peak bin, floored. */
  amplitudeDb: number[];
  /** The uniform rate the window was resampled onto. */
  sampleRate: number;
  /** Transform size (a power of two). */
  size: number;
}

const MIN_SIZE = 64;
const MAX_SIZE = 4096;
const FLOOR_DB = -120;

function largestPowerOfTwoAtMost(value: number): number {
  let size = MIN_SIZE;
  while (size * 2 <= value && size * 2 <= MAX_SIZE) size *= 2;
  return size;
}

/** In-place iterative radix-2 Cooley–Tukey transform; `real.length` is 2^k. */
function transform(real: Float64Array, imaginary: Float64Array): void {
  const count = real.length;
  for (let index = 1, mirror = 0; index < count; index += 1) {
    let bit = count >> 1;
    for (; (mirror & bit) !== 0; bit >>= 1) mirror ^= bit;
    mirror ^= bit;
    if (index < mirror) {
      const swapReal = real[index] ?? 0;
      const swapImaginary = imaginary[index] ?? 0;
      real[index] = real[mirror] ?? 0;
      imaginary[index] = imaginary[mirror] ?? 0;
      real[mirror] = swapReal;
      imaginary[mirror] = swapImaginary;
    }
  }
  for (let span = 2; span <= count; span <<= 1) {
    const angle = (-2 * Math.PI) / span;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    const half = span >> 1;
    for (let start = 0; start < count; start += span) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const low = start + offset;
        const high = low + half;
        const highReal = real[high] ?? 0;
        const highImaginary = imaginary[high] ?? 0;
        const productReal =
          highReal * twiddleReal - highImaginary * twiddleImaginary;
        const productImaginary =
          highReal * twiddleImaginary + highImaginary * twiddleReal;
        const lowReal = real[low] ?? 0;
        const lowImaginary = imaginary[low] ?? 0;
        real[low] = lowReal + productReal;
        imaginary[low] = lowImaginary + productImaginary;
        real[high] = lowReal - productReal;
        imaginary[high] = lowImaginary - productImaginary;
        const nextReal =
          twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary =
          twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

/**
 * The one-sided amplitude spectrum of a signal over `[t0, t1]`.
 *
 * Returns null when the window holds too few samples to transform, when it
 * is degenerate, or when resampling hits a gap — a spectrum computed across
 * absent data would be a fabrication, and the pyramid's gap invariants
 * commit this codebase to refusing rather than interpolating over one.
 *
 * ADR 0017 records every semantic choice here.
 */
export function spectrum(
  series: SampleSeries,
  t0: number,
  t1: number,
): Spectrum | null {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;
  let inWindow = 0;
  for (const time of series.time) {
    if (time >= t0 && time <= t1) inWindow += 1;
  }
  if (inWindow < MIN_SIZE) return null;
  const size = largestPowerOfTwoAtMost(inWindow);
  const step = (t1 - t0) / (size - 1);
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  let mean = 0;
  for (let index = 0; index < size; index += 1) {
    const value = lerpSample(series.time, series.values, t0 + step * index);
    if (!Number.isFinite(value)) return null;
    real[index] = value;
    mean += value;
  }
  mean /= size;
  for (let index = 0; index < size; index += 1) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)));
    real[index] = ((real[index] ?? 0) - mean) * hann;
  }
  transform(real, imaginary);
  const bins = size >> 1;
  const magnitude: number[] = [];
  let peak = 0;
  for (let index = 1; index <= bins; index += 1) {
    const value = Math.hypot(real[index] ?? 0, imaginary[index] ?? 0);
    magnitude.push(value);
    if (value > peak) peak = value;
  }
  const sampleRate = (size - 1) / (t1 - t0);
  const frequency = magnitude.map(
    (_, index) => ((index + 1) * sampleRate) / size,
  );
  const amplitudeDb = magnitude.map((value) => {
    if (peak <= 0 || value <= 0) return FLOOR_DB;
    return Math.max(FLOOR_DB, 20 * Math.log10(value / peak));
  });
  return { frequency, amplitudeDb, sampleRate, size };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/app/spectrum.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write ADR 0017**

Create `docs/adr/0017-spectrum-semantics.md`:

```markdown
# 17. Spectrum semantics

Status: Accepted

## Context

The Final Spec's FFT coverage is one static mock. It fixes the axes —
`frequency (Hz), log` with decade ticks from 1 to 1000, `amplitude (dB)` with
ticks at 0, −20, −40, −60, −80 — the header token `window: visible t`, and a
single 1.4px series-coloured polyline. It specifies no window function, no
transform size, no sample-rate derivation, no dB reference, no averaging, and
no interaction model. The prototype contains no FFT code at all, so there is
nothing to "match exactly" the way the expression engine could be.

Ingest guarantees only that time columns are finite and monotonically
nondecreasing (AGENTS.md). Nothing guarantees uniform sampling, and CSV files
without a time column get a synthesized index timebase.

## Decision

Every choice is made once, here, and implemented in
`frontend/src/app/spectrum.ts`:

- **Input** is the visible time window, matching the header token the spec
  draws. Panning or zooming any linked panel recomputes the spectrum.
- **Grid** is the largest power of two not exceeding the sample count inside
  the window, clamped to [64, 4096]. Below 64 the panel shows nothing rather
  than a meaningless transform; 4096 keeps a recompute inside a frame.
- **Sample rate** is derived from the grid, `(N − 1) / (t1 − t0)`, so
  irregular source timestamps need no special case: resampling defines the
  rate.
- **Resampling** is linear. A non-finite result aborts the whole spectrum;
  transforming across a gap would fabricate spectral content, and this
  codebase already refuses to bridge gaps invisibly (ADR 0003).
- **Detrend** by subtracting the mean, then apply a **Hann** taper — the
  default that costs the least explanation and has no free parameter.
- **Output** is one-sided from bin 1. DC is dropped because the spec's axis
  is logarithmic and cannot show `f = 0`.
- **Amplitude** is normalized to the peak bin, so 0 dB is the peak, floored
  at −120 dB. The mock's 0/−80 range is consistent with this; an absolute
  reference would require a unit convention the spec never states.
- **No averaging.** Welch segmenting trades resolution for variance and
  needs a segment-length control the chrome has no room for. Single
  transform over the visible window is the honest default.
- **Multi-series** panels draw one spectrum per visible series, because the
  spec renders FFT panels with ordinary legend chips rather than the dashed
  axis chips that mark a single-signal mode.

## Consequences

- The spectrum is a presentation-plane computation over a bounded window
  slice (ADR 0015), so a snapshot and the workbench cannot disagree.
- The transform is a hand-written radix-2 Cooley–Tukey. The frontend has
  zero runtime dependencies and the Rust workspace forbids `unsafe_code`;
  adding `rustfft`/`realfft` would also touch `Cargo.lock`, which
  `./scripts/version.sh check` validates as a release manifest. At N ≤ 4096
  the performance argument for a library does not arise.
- Averaging, absolute amplitude units, and alternate windows are additive
  later; each would need a control surface, which is why none ships now.
```

- [ ] **Step 6: Run the frontend gate and commit**

Run: `./scripts/test.sh frontend`
Expected: PASS.

```bash
git add frontend/src/app/spectrum.ts frontend/src/app/spectrum.test.ts \
  docs/adr/0017-spectrum-semantics.md
git commit -m "feat(spectrum): compute windowed one-sided spectra"
```

---

## Task 10: FFT panels

**Files:**

- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/modes.spec.ts`

**Interfaces:**

- Consumes: `spectrum()` (Task 9), `renderPaths` with `xScale: "log"` (Task 3), `PanelState.x_range` (Task 2).
- Produces: `.panel-mode-note` — the header slot the spec fills with `window: visible t`.

- [ ] **Step 1: Add the header note**

In `panelMarkup()` in `frontend/src/ui/panel.ts`, add immediately before `<span class="panel-actions">`:

```html
<span class="panel-mode-note" hidden></span>
```

and in `frontend/src/styles/app.css`:

```css
.panel-mode-note {
  flex: none;
  color: var(--fg-4);
  font: 10px var(--font-mono);
}

.panel-mode-note[hidden] {
  display: none;
}
```

In `update()`, populate it:

```typescript
const note = required<HTMLElement>(this.element, ".panel-mode-note");
note.hidden = state.mode !== "fft" && state.mode !== "histogram";
if (!note.hidden) note.textContent = "window: visible t";
```

- [ ] **Step 2: Render spectra**

Add the dispatch branch in `renderData`, beside the XY branch:

```typescript
if (state.mode === "fft") {
  const elapsed = this.renderSpectra(state, samples, window);
  this.renderStats();
  this.drawOverlay();
  return elapsed;
}
```

and the method, with `import { spectrum } from "../app/spectrum";`:

```typescript
  private renderSpectra(
    state: PanelState,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    if (samples === null) return 0;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const paths: PlotPath[] = [];
    let minFrequency = Number.POSITIVE_INFINITY;
    let maxFrequency = 0;
    for (const series of state.series) {
      if (!series.visible) continue;
      const source = byPath.get(series.path);
      if (source === undefined) continue;
      const result = spectrum(source, window.t0, window.t1);
      if (result === null) continue;
      const points: number[] = [];
      result.frequency.forEach((frequency, index) => {
        points.push(frequency, result.amplitudeDb[index] ?? -120);
      });
      const style = resolveSeriesStyle(series.color_slot, series.dash);
      paths.push({
        points,
        colorIndex: style.colorIndex,
        dash: style.dash,
        width: series.width,
      });
      minFrequency = Math.min(minFrequency, result.frequency[0] ?? 1);
      maxFrequency = Math.max(
        maxFrequency,
        result.frequency[result.frequency.length - 1] ?? 1,
      );
    }
    this.setModeEmpty(paths.length === 0, "Not enough samples in view.");
    if (paths.length === 0) return 0;
    const xRange = state.x_range ?? [minFrequency, maxFrequency];
    const yRange = state.y_range ?? [-90, 3];
    return this.renderer.renderPaths(paths, {
      xLabel: state.x_label ?? "frequency (Hz), log",
      yLabel: state.y_label ?? "amplitude (dB)",
      xRange: [xRange[0], xRange[1]],
      yRange: [yRange[0], yRange[1]],
      axisStyle: state.axis_style,
      xScale: "log",
    });
  }

  /**
   * Shows or clears a mode-specific empty message. Always assigns `hidden`,
   * so a panel that starts empty and then gets data does not keep a stale
   * message over its plot.
   */
  private setModeEmpty(show: boolean, message: string): void {
    const empty = required<HTMLElement>(this.element, ".panel-empty");
    empty.hidden = !show;
    if (show) empty.textContent = message;
  }
```

Remove `"fft"` from the "not implemented yet" branch in `update()` so it reads:

```typescript
    } else if (state.mode === "histogram") {
      empty.hidden = false;
      empty.textContent = "Histogram mode is not implemented yet.";
    } else if (state.mode === "fft") {
      // renderSpectra owns this panel's empty state.
      empty.hidden = true;
    } else {
```

- [ ] **Step 3: Allow FFT gestures**

Extend `interactiveMode()` to include `"fft"`. Because `applyXRange` already routes non-time modes to `onXRange`, wheel zoom, drag pan, and box zoom now operate on the frequency and dB axes without further change. The box-zoom `invertX` calls resolve through the log-aware projection added in Task 3, so a box drawn on a log axis maps back to the frequencies under it.

Add a note to the file where `interactiveMode` is defined:

```typescript
  /**
   * Modes whose plot area accepts zoom/pan gestures. Histogram is excluded:
   * its x axis is a value axis whose bin edges are recomputed from the
   * visible window, so panning it would be misleading (ADR 0018).
   */
  private interactiveMode(): boolean {
    const mode = this.lastState?.mode;
    return mode === "time" || mode === "xy" || mode === "fft";
  }
```

- [ ] **Step 4: Add the e2e scenario**

Add to `frontend/tests/e2e/modes.spec.ts`:

```typescript
test("FFT mode announces its window and zooms locally", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const panel = page.locator(".panel").first();
  await panel.locator(".mode-pill", { hasText: "FFT" }).click();
  await expect(panel.locator(".panel-mode-note")).toHaveText(
    "window: visible t",
  );
  await expect(panel.locator(".panel-empty")).toBeHidden();

  const readout = page.locator(".window-readout");
  const before = await readout.textContent();
  await panel
    .locator(".overlay-canvas")
    .hover({ position: { x: 250, y: 120 } });
  await page.mouse.wheel(0, -240);
  await expect(readout).toHaveText(before ?? "");
});
```

- [ ] **Step 5: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add frontend/src/ui/panel.ts frontend/src/styles/app.css \
  frontend/tests/e2e/modes.spec.ts
git commit -m "feat(fft): draw log-frequency spectra in FFT panels"
```

---

## Task 11: The histogram module (ADR 0018)

**Files:**

- Create: `frontend/src/app/histogram.ts`
- Create: `frontend/src/app/histogram.test.ts`
- Create: `docs/adr/0018-histogram-semantics.md`

**Interfaces:**

- Produces: `Histogram { edges: number[]; counts: number[][] }` and `histogram(columns: readonly (readonly number[])[]): Histogram | null` from `frontend/src/app/histogram.ts`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/histogram.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { histogram } from "./histogram";

describe("histogram", () => {
  it("shares edges across series and counts each separately", () => {
    const result = histogram([
      [0, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [5, 5, 5, 6, 7, 8, 9, 10, 10, 10, 10, 10, 10, 10],
    ]);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.edges[0]).toBe(0);
    expect(result.edges[result.edges.length - 1]).toBe(10);
    expect(result.counts).toHaveLength(2);
    expect(result.counts[0]).toHaveLength(result.edges.length - 1);
    const total = (result.counts[0] ?? []).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(14);
  });

  it("clamps the bin count into its bounds", () => {
    const many = Array.from({ length: 5000 }, (_, index) => index);
    const result = histogram([many]);
    expect(result).not.toBeNull();
    if (result === null) return;
    const bins = result.edges.length - 1;
    expect(bins).toBeGreaterThanOrEqual(8);
    expect(bins).toBeLessThanOrEqual(128);
  });

  it("widens a constant column so it still has a domain", () => {
    const result = histogram([[4, 4, 4, 4]]);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.edges[0]).toBeLessThan(4);
    expect(result.edges[result.edges.length - 1]).toBeGreaterThan(4);
  });

  it("ignores non-finite values and returns null when nothing is left", () => {
    expect(histogram([[Number.NaN, Number.POSITIVE_INFINITY]])).toBeNull();
    const mixed = histogram([[1, Number.NaN, 3]]);
    expect(mixed).not.toBeNull();
    expect((mixed?.counts[0] ?? []).reduce((sum, n) => sum + n, 0)).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/app/histogram.test.ts`
Expected: FAIL — cannot resolve `./histogram`.

- [ ] **Step 3: Implement the histogram module**

Create `frontend/src/app/histogram.ts`:

```typescript
export interface Histogram {
  /** `bins + 1` shared edges, ascending. */
  edges: number[];
  /** One count array per input column, each `edges.length - 1` long. */
  counts: number[][];
}

const MIN_BINS = 8;
const MAX_BINS = 128;

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.min(sorted.length - 1, low + 1);
  const alpha = position - low;
  return (
    (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * alpha
  );
}

/**
 * Freedman–Diaconis bin count, falling back to Sturges when the
 * interquartile range collapses (heavily tied data), clamped to a range
 * that stays legible in a panel. ADR 0018.
 */
function binCount(sorted: readonly number[], min: number, max: number): number {
  const count = sorted.length;
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const width = iqr > 0 ? (2 * iqr) / Math.cbrt(count) : 0;
  const bins =
    width > 0
      ? Math.ceil((max - min) / width)
      : Math.ceil(Math.log2(Math.max(2, count))) + 1;
  return Math.min(MAX_BINS, Math.max(MIN_BINS, bins));
}

/**
 * Counts each column into shared bins spanning the union of their finite
 * values. Null when no column holds a finite value.
 */
export function histogram(
  columns: readonly (readonly number[])[],
): Histogram | null {
  const finite = columns.map((column) =>
    [...column].filter((value) => Number.isFinite(value)),
  );
  const pooled = finite.flat().sort((left, right) => left - right);
  if (pooled.length === 0) return null;
  let min = pooled[0] ?? 0;
  let max = pooled[pooled.length - 1] ?? 0;
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }
  const bins = binCount(pooled, min, max);
  const step = (max - min) / bins;
  const edges = Array.from(
    { length: bins + 1 },
    (_, index) => min + step * index,
  );
  const counts = finite.map((column) => {
    const row = new Array<number>(bins).fill(0);
    for (const value of column) {
      const slot = Math.min(bins - 1, Math.floor((value - min) / step));
      if (slot >= 0) row[slot] = (row[slot] ?? 0) + 1;
    }
    return row;
  });
  return { edges, counts };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/app/histogram.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write ADR 0018**

Create `docs/adr/0018-histogram-semantics.md`:

```markdown
# 18. Histogram semantics

Status: Accepted

## Context

The design package's entire treatment of histogram mode is the letter `H` in
the mode-pill group. It appears in no mock — not in the pixel reference, not
in the light-mode sheet, not in any empty-state card — and the spec's own
build order lists neither histogram nor FFT computation in v1 or v2. The
prototype's mode enum has two values (`time`, `xy`); there is no third branch
to extend. Bin rule, orientation, source window, normalization, multi-series
treatment, axis names, and interaction model are all undefined.

The one real requirement the package does state is indirect: the empty-panel
card says modes are "pickable before data arrives", so an `H` panel must
render a complete, empty axis frame with no signals plotted.

This is therefore a design decision, not an extraction.

## Decision

- **Source** is the visible time window, matching the FFT panel's
  `window: visible t` header token. Panning any linked panel rebins.
- **Bin count** is Freedman–Diaconis (`2 · IQR / n^(1/3)`), which adapts to
  spread rather than to sample count alone, falling back to Sturges when the
  interquartile range collapses on heavily tied data. Clamped to [8, 128] so
  a panel is never a solid block or a comb.
- **Edges are shared** across every visible series, computed from the union
  of their finite values, so overlaid distributions are directly comparable.
- **Counts, not densities.** A count is what a reader can check against the
  status bar's point total; a density needs a units caption the chrome has
  no room for.
- **Step outlines in series colour**, not filled bars. Filled bars occlude
  each other, and this app's identity channel is already colour-plus-text.
  Outlines let two distributions overlap and stay readable.
- **Axes** are `value (<unit>)` on x and `count` on y.
- **No zoom or pan.** The bin edges are a function of the visible window, so
  dragging the x axis would show bins that no longer describe what is drawn.
  Double-click fit and the linked time window remain the controls.

## Consequences

- The `H` pill becomes honest without inventing chrome the spec never drew.
- Anything the spec later specifies — density normalization, orientation,
  cumulative mode, a bin-count control — is additive and would arrive with
  its own control surface.
- If the maintainer would rather leave `H` inert until the design pass
  covers it, this ADR and its two implementation tasks can be dropped with
  no other consequence; nothing else in Phase 2B depends on them.
```

- [ ] **Step 6: Run the frontend gate and commit**

Run: `./scripts/test.sh frontend`
Expected: PASS.

```bash
git add frontend/src/app/histogram.ts frontend/src/app/histogram.test.ts \
  docs/adr/0018-histogram-semantics.md
git commit -m "feat(histogram): bin visible-window values with shared edges"
```

---

## Task 12: Histogram panels

**Files:**

- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/tests/e2e/modes.spec.ts`

**Interfaces:**

- Consumes: `histogram()` (Task 11), `renderPaths` (Task 3).

- [ ] **Step 1: Render histograms**

In `frontend/src/ui/panel.ts`, add `import { histogram } from "../app/histogram";` and the dispatch branch beside the FFT one:

```typescript
if (state.mode === "histogram") {
  const elapsed = this.renderHistogram(state, samples, window);
  this.renderStats();
  this.drawOverlay();
  return elapsed;
}
```

and the method:

```typescript
  private renderHistogram(
    state: PanelState,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    if (samples === null) return 0;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const visible = state.series.filter((series) => series.visible);
    const columns = visible.map((series) => {
      const source = byPath.get(series.path);
      if (source === undefined) return [];
      const values: number[] = [];
      source.time.forEach((time, index) => {
        if (time < window.t0 || time > window.t1) return;
        values.push(source.values[index] ?? Number.NaN);
      });
      return values;
    });
    const binned = histogram(columns);
    this.setModeEmpty(binned === null, "No values in view.");
    if (binned === null) return 0;
    const edges = binned.edges;
    let peak = 0;
    const paths: PlotPath[] = binned.counts.map((counts, index) => {
      const points: number[] = [];
      // A staircase outline: rise at each edge, run across each bin, and
      // close down to zero at both ends so the shape reads as a
      // distribution rather than a line chart.
      points.push(edges[0] ?? 0, 0);
      counts.forEach((count, bin) => {
        peak = Math.max(peak, count);
        points.push(edges[bin] ?? 0, count, edges[bin + 1] ?? 0, count);
      });
      points.push(edges[edges.length - 1] ?? 0, 0);
      const series = visible[index];
      const style = resolveSeriesStyle(
        series?.color_slot ?? 1,
        series?.dash ?? "solid",
      );
      return {
        points,
        colorIndex: style.colorIndex,
        dash: style.dash,
        width: series?.width ?? 1.4,
      };
    });
    const units = visible.map(
      (series) => byPath.get(series.path)?.unit ?? null,
    );
    return this.renderer.renderPaths(paths, {
      xLabel: state.x_label ?? yLabel(units),
      yLabel: state.y_label ?? "count",
      xRange: [edges[0] ?? 0, edges[edges.length - 1] ?? 1],
      yRange: [0, Math.max(1, peak) * 1.06],
      axisStyle: state.axis_style,
    });
  }
```

Remove the histogram arm from the "not implemented yet" branch in `update()`:

```typescript
    } else if (state.mode === "fft" || state.mode === "histogram") {
      // renderSpectra / renderHistogram own these panels' empty states.
      empty.hidden = true;
    } else {
```

(This replaces the two-arm form Task 10 introduced; after this edit no mode reports "not implemented".)

- [ ] **Step 2: Add the e2e scenario**

Add to `frontend/tests/e2e/modes.spec.ts`:

```typescript
test("histogram mode draws a distribution of the visible window", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const panel = page.locator(".panel").first();
  await panel.locator(".mode-pill", { hasText: "H" }).click();
  await expect(panel.locator(".mode-pill.active")).toHaveText("H");
  await expect(panel.locator(".panel-empty")).toBeHidden();
  await expect(panel.locator(".panel-mode-note")).toHaveText(
    "window: visible t",
  );
  await expect(page.locator(".render-ms")).not.toHaveText("— ms");
});
```

- [ ] **Step 3: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add frontend/src/ui/panel.ts frontend/tests/e2e/modes.spec.ts
git commit -m "feat(histogram): draw distribution outlines in histogram panels"
```

---

## Task 13: The touch gesture set

**Files:**

- Modify: `frontend/src/app/plot-math.ts`
- Modify: `frontend/src/app/plot-math.test.ts`
- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/styles/app.css`
- Create: `frontend/tests/e2e/touch.spec.ts`

**Interfaces:**

- Consumes: `PlotLayout`, `applyXRange` / `onYRange` (Tasks 2, 5).
- Produces: `pinchRange(anchorA: number, anchorB: number, pixelA: number, pixelB: number, edgeLow: number, edgeHigh: number): Range | null` in `plot-math.ts`.

**The gesture set, from the prototype's help table and its `bindInteractions`:**

| Gesture          | Behaviour                                                                       | Constants                     |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| One-finger drag  | Pan both axes                                                                   | promotes past 9px of movement |
| Two-finger pinch | Zoom+pan, per axis independently; each axis zooms only if its fingers are apart | 40px separation per axis      |
| Three or more    | Ignored                                                                         | —                             |
| Tap              | Read values at a point (publishes the cursor)                                   | XY search radius 48px         |
| Tap on a datatip | Remove it                                                                       | 16px                          |
| Long press       | Pin a datatip                                                                   | 430ms, 28px, `vibrate(8)`     |
| Double tap       | Fit the panel                                                                   | within 320ms and 26px         |

Pinch anchors are captured in **data** coordinates at touch-down, so both anchors stay under both fingers — zoom and pan are one continuous motion with no separate mode.

- [ ] **Step 1: Write the failing pinch test**

Add to `frontend/src/app/plot-math.test.ts`:

```typescript
it("pins both pinch anchors under their fingers", () => {
  // Anchors 10 and 20 are held at pixels 100 and 300 inside a plot
  // spanning pixels 0…400, so the visible range becomes 5…30.
  expect(pinchRange(10, 20, 100, 300, 0, 400)).toEqual({ min: 5, max: 30 });
});

it("refuses a degenerate pinch", () => {
  expect(pinchRange(10, 10, 100, 300, 0, 400)).toBeNull();
  expect(pinchRange(10, 20, 100, 100, 0, 400)).toBeNull();
});
```

Add `pinchRange` to that file's import list.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/dev.sh pnpm vitest run src/app/plot-math.test.ts`
Expected: FAIL — `pinchRange` is not exported.

- [ ] **Step 3: Implement `pinchRange`**

Append to `frontend/src/app/plot-math.ts`:

```typescript
/**
 * The axis range that keeps two data anchors under two fingers.
 *
 * Solves the affine map `data = slope · pixel + intercept` through both
 * (pixel, anchor) pairs and evaluates it at the plot's edges, so a pinch is
 * zoom and pan in one continuous gesture. Null when the pinch is degenerate
 * (equal anchors, coincident fingers, or an inverted result).
 */
export function pinchRange(
  anchorA: number,
  anchorB: number,
  pixelA: number,
  pixelB: number,
  edgeLow: number,
  edgeHigh: number,
): Range | null {
  if (anchorA === anchorB || pixelA === pixelB) return null;
  const slope = (anchorB - anchorA) / (pixelB - pixelA);
  const intercept = anchorA - slope * pixelA;
  const first = slope * edgeLow + intercept;
  const second = slope * edgeHigh + intercept;
  const min = Math.min(first, second);
  const max = Math.max(first, second);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }
  return { min, max };
}
```

Unlike `zoomRange`/`panRange` this takes no current range: the two anchors and their pixels fully determine the new one, and `noUnusedParameters` would reject a decorative parameter.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/dev.sh pnpm vitest run src/app/plot-math.test.ts`
Expected: PASS.

- [ ] **Step 5: Bind the touch gestures**

In `frontend/src/ui/panel.ts`, add the constants beside `XY_HOVER_RADIUS`:

```typescript
const TOUCH = {
  /** Movement that promotes a tap to a pan. */
  panSlop: 9,
  /** Finger separation below which an axis pans instead of zooming. */
  pinchSeparation: 40,
  longPressMs: 430,
  longPressRadius: 28,
  tapRemoveRadius: 16,
  tapCursorRadius: 48,
  doubleTapMs: 320,
  doubleTapRadius: 26,
} as const;
```

Add the pointer bookkeeping fields:

```typescript
  private readonly touchPoints = new Map<number, { x: number; y: number }>();
  private touchMode: "tap" | "pan" | "pinch" | "dead" | null = null;
  private touchStart: { x: number; y: number } | null = null;
  private touchStartRanges: { x: Range; y: Range } | null = null;
  private pinchAnchors: { xA: number; xB: number; yA: number; yB: number } | null =
    null;
  private longPressTimer: number | null = null;
  private lastTap = { time: 0, x: 0, y: 0 };
```

(`pinchRange` and the `Range` type both come from `../app/plot-math`; add them to that import.)

In `bind()`, add the touch branch at the top of the existing `pointerdown` handler, before the mouse branch:

```typescript
    this.overlay.addEventListener("pointerdown", (event) => {
      const layout = this.renderer.lastLayout();
      if (layout === null || !this.interactiveMode()) return;
      if (event.pointerType === "touch") {
        this.beginTouch(event, layout);
        return;
      }
      const isPan = /* …unchanged… */;
```

and register the rest of the touch lifecycle on the overlay:

```typescript
this.overlay.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch") this.moveTouch(event);
});
this.overlay.addEventListener("pointerup", (event) => {
  if (event.pointerType === "touch") this.endTouch(event);
});
this.overlay.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "touch") this.endTouch(event);
});
```

Add the three handlers:

```typescript
  private beginTouch(event: PointerEvent, layout: PlotLayout): void {
    this.overlay.setPointerCapture(event.pointerId);
    this.touchPoints.set(event.pointerId, {
      x: event.offsetX,
      y: event.offsetY,
    });
    if (this.touchPoints.size === 2) {
      this.clearLongPress();
      this.box = null;
      this.drawOverlay();
      const [first, second] = [...this.touchPoints.values()];
      if (first === undefined || second === undefined) return;
      // Anchors are captured in data space so both stay under their finger.
      this.pinchAnchors = {
        xA: invertX(layout, first.x),
        xB: invertX(layout, second.x),
        yA: invertY(layout, first.y),
        yB: invertY(layout, second.y),
      };
      this.touchMode = "pinch";
      return;
    }
    if (this.touchPoints.size > 2) {
      this.touchMode = "dead";
      return;
    }
    this.touchStart = { x: event.offsetX, y: event.offsetY };
    this.touchStartRanges = {
      x: { ...layout.xRange },
      y: { ...layout.yRange },
    };
    this.touchMode = "tap";
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      if (this.touchMode !== "tap" || this.touchStart === null) return;
      this.pinAt(this.touchStart.x, this.touchStart.y, TOUCH.longPressRadius);
      navigator.vibrate?.(8);
      this.touchMode = "dead";
    }, TOUCH.longPressMs);
  }

  private moveTouch(event: PointerEvent): void {
    const layout = this.renderer.lastLayout();
    if (layout === null || this.touchMode === null || this.touchMode === "dead") {
      return;
    }
    const point = this.touchPoints.get(event.pointerId);
    if (point === undefined) return;
    point.x = event.offsetX;
    point.y = event.offsetY;
    if (this.touchMode === "pinch") {
      this.applyPinch(layout);
      return;
    }
    const start = this.touchStart;
    const ranges = this.touchStartRanges;
    if (start === null || ranges === null) return;
    if (
      this.touchMode === "tap" &&
      Math.hypot(event.offsetX - start.x, event.offsetY - start.y) >
        TOUCH.panSlop
    ) {
      this.clearLongPress();
      this.touchMode = "pan";
    }
    if (this.touchMode !== "pan") return;
    const dt =
      ((start.x - event.offsetX) / layout.plot.width) *
      (ranges.x.max - ranges.x.min);
    const dv =
      ((event.offsetY - start.y) / layout.plot.height) *
      (ranges.y.max - ranges.y.min);
    this.applyXRange(ranges.x.min + dt, ranges.x.max + dt);
    this.callbacks.onYRange(this.id, [ranges.y.min + dv, ranges.y.max + dv]);
  }

  private applyPinch(layout: PlotLayout): void {
    const anchors = this.pinchAnchors;
    const [first, second] = [...this.touchPoints.values()];
    if (anchors === null || first === undefined || second === undefined) return;
    const { plot } = layout;
    if (Math.abs(first.x - second.x) > TOUCH.pinchSeparation) {
      const next = pinchRange(
        anchors.xA,
        anchors.xB,
        first.x,
        second.x,
        plot.x,
        plot.x + plot.width,
      );
      if (next !== null) this.applyXRange(next.min, next.max);
    }
    if (Math.abs(first.y - second.y) > TOUCH.pinchSeparation) {
      const next = pinchRange(
        anchors.yA,
        anchors.yB,
        first.y,
        second.y,
        plot.y,
        plot.y + plot.height,
      );
      if (next !== null) this.callbacks.onYRange(this.id, [next.min, next.max]);
    }
  }

  private endTouch(event: PointerEvent): void {
    this.touchPoints.delete(event.pointerId);
    if (this.touchMode === "pinch" && this.touchPoints.size < 2) {
      this.touchMode = this.touchPoints.size === 0 ? null : "dead";
      this.pinchAnchors = null;
      return;
    }
    if (this.touchMode !== "tap") {
      if (this.touchPoints.size === 0) this.touchMode = null;
      return;
    }
    this.clearLongPress();
    this.touchMode = null;
    const now = performance.now();
    if (
      now - this.lastTap.time < TOUCH.doubleTapMs &&
      Math.hypot(event.offsetX - this.lastTap.x, event.offsetY - this.lastTap.y) <
        TOUCH.doubleTapRadius
    ) {
      this.lastTap = { time: 0, x: 0, y: 0 };
      this.callbacks.onFitView(this.id);
      return;
    }
    this.lastTap = { time: now, x: event.offsetX, y: event.offsetY };
    if (this.removeAt(event.offsetX, event.offsetY, TOUCH.tapRemoveRadius)) {
      return;
    }
    this.publishTouchCursor(event);
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }
```

`pinAt` and `removeAt` are the two halves of `plotClick`, which this task factors out so mouse and touch share one implementation with different radii. **Replace** the whole `plotClick` method (as Task 6 left it) with these three:

```typescript
  plotClick(offsetX: number, offsetY: number): void {
    // 2A's asymmetry: the remove radius is smaller than the pin radius so a
    // double-click cancels its own accidental pin before fitting.
    if (this.removeAt(offsetX, offsetY, 9)) return;
    this.pinAt(offsetX, offsetY, 14);
  }

  /** Removes the annotation under the pixel; true when one was removed. */
  private removeAt(
    offsetX: number,
    offsetY: number,
    radius: number,
  ): boolean {
    const layout = this.renderer.lastLayout();
    const state = this.lastState;
    if (layout === null || state === null) return false;
    if (state.mode === "xy") {
      const points = this.annotationPoints(state);
      const index = state.annotations.findIndex((_, position) => {
        const point = points[position];
        if (point === null || point === undefined) return false;
        return (
          Math.hypot(
            projectX(layout, point.x) - offsetX,
            projectY(layout, point.y) - offsetY,
          ) <= radius
        );
      });
      const annotation = index === -1 ? undefined : state.annotations[index];
      if (annotation === undefined) return false;
      this.callbacks.onRemoveAnnotation(this.id, annotation.id);
      return true;
    }
    if (state.mode !== "time") return false;
    const existing = nearestAnnotation(
      state.annotations,
      layout,
      offsetX,
      offsetY,
      radius,
    );
    if (existing === null) return false;
    this.callbacks.onRemoveAnnotation(this.id, existing);
    return true;
  }

  /** Pins the nearest plotted vertex under the pixel, when one is in range. */
  private pinAt(offsetX: number, offsetY: number, radius: number): void {
    const layout = this.renderer.lastLayout();
    const state = this.lastState;
    if (layout === null || state === null) return;
    if (state.mode === "xy") {
      const hit = nearestXyPoint(
        this.xyTraces,
        layout,
        offsetX,
        offsetY,
        radius,
      );
      if (hit !== null) {
        this.callbacks.onPinAnnotation(this.id, {
          path: hit.path,
          time: hit.time,
          value: hit.y,
          distance: 0,
        });
      }
      return;
    }
    if (state.mode !== "time") return;
    const tiles = this.lastTiles;
    if (tiles === null) return;
    const visible = new Set(
      state.series
        .filter((series) => series.visible)
        .map((series) => series.path),
    );
    const hit = nearestVertex(
      tiles.series
        .filter((tile) => visible.has(tile.signal_path))
        .map((tile) => ({ path: tile.signal_path, bins: tile.bins })),
      layout,
      offsetX,
      offsetY,
      radius,
    );
    if (hit !== null) this.callbacks.onPinAnnotation(this.id, hit);
  }
```

Publish the touch cursor with the wider XY radius, and route the tooltip to a docked position:

```typescript
  private publishTouchCursor(event: PointerEvent): void {
    const layout = this.renderer.lastLayout();
    if (layout === null) return;
    if (!insidePlot(layout, event.offsetX, event.offsetY)) {
      this.callbacks.onCursor(this.id, null, null);
      return;
    }
    const cursorT =
      this.lastState?.mode === "xy"
        ? (nearestXyPoint(
            this.xyTraces,
            layout,
            event.offsetX,
            event.offsetY,
            TOUCH.tapCursorRadius,
          )?.time ?? null)
        : invertX(layout, event.offsetX);
    const rect = this.element.getBoundingClientRect();
    this.callbacks.onCursor(
      this.id,
      cursorT,
      // Dock at the panel's top edge so the finger does not cover the
      // readout (prototype behaviour).
      cursorT === null ? null : { x: rect.left + rect.width / 2, y: rect.top },
    );
  }
```

- [ ] **Step 6: Make the plot surface touch-capable**

Add to `frontend/src/styles/app.css`:

```css
.overlay-canvas {
  /* Without this the browser claims every drag for scrolling and no
     gesture ever reaches the handlers. */
  touch-action: none;
}

/* Coarse pointers need larger targets; the spec's 26px header stays. */
@media (hover: none) {
  .panel-action,
  .mode-pill,
  .legend-chip-body,
  .legend-chip-caret {
    padding: 6px 9px;
  }

  .axis-chip {
    padding: 4px 10px;
  }
}
```

- [ ] **Step 7: Add the mobile e2e**

Create `frontend/tests/e2e/touch.spec.ts`:

```typescript
import { expect, test } from "./fixtures";

test.describe("touch gestures", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("a one-finger drag pans and a double tap fits", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "touch interaction");
    const overlay = page.locator(".overlay-canvas").first();
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("overlay not laid out");
    const readout = page.locator(".window-readout");
    const fitted = await readout.textContent();

    const client = await page.context().newCDPSession(page);
    const at = (x: number, y: number) => [{ x: box.x + x, y: box.y + y }];
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: at(200, 120),
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: at(120, 120),
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(readout).not.toHaveText(fitted ?? "");

    await overlay.dblclick({ position: { x: 200, y: 120 } });
    await expect(readout).toHaveText(fitted ?? "");
  });
});
```

If the Pixel 7 project's touch emulation refuses `Input.dispatchTouchEvent`, fall back to `page.touchscreen.tap()` for the tap assertions and cover pan/pinch with a unit test over `pinchRange` plus a `page.evaluate` that dispatches synthetic `PointerEvent`s — but try CDP first; `kickoffprompt.md` names "pinch via CDP" as the intended mechanism.

- [ ] **Step 8: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS — both Playwright projects.

```bash
git add frontend/src/app/plot-math.ts frontend/src/app/plot-math.test.ts \
  frontend/src/ui/panel.ts frontend/src/styles/app.css \
  frontend/tests/e2e/touch.spec.ts
git commit -m "feat(touch): restore pinch, pan, tap, and long-press gestures"
```

---

## Task 14: Toolbar statistics, per-mode help, and the close-out

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/modes.spec.ts`
- Modify: `docs/implementation-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-24-00-INDEX.md`
- Modify: `docs/adr/README.md`

- [ ] **Step 1: Add the all-panels statistics toggle**

2A deferred the toolbar `Σ Stats` control and shipped only the per-panel button. Add it beside the cursor toggle in `shellMarkup()`:

```html
<button class="tool-button stats-toggle" title="Show statistics on every panel">
  Σ Stats
</button>
```

bind it in `bindControls()`:

```typescript
required(this.root, ".stats-toggle").addEventListener("click", () => {
  this.commands.run("toggle-all-stats");
});
```

and register the command in `registerCommands()`:

```typescript
this.commands.register({
  id: "toggle-all-stats",
  title: "Toggle statistics on every panel",
  run: () => {
    // Any panel still hiding stats turns them all on; otherwise all off.
    const target = this.workspace.panels().some((panel) => !panel.show_stats);
    for (const panel of this.workspace.panels()) {
      if (panel.show_stats !== target) this.workspace.toggleStats(panel.id);
    }
    required(this.root, ".stats-toggle").classList.toggle("active", target);
    this.workspaceView?.refreshPanelStates();
    this.renderTiles();
  },
});
```

- [ ] **Step 2: Add the per-mode help rows**

The spec sanctions `Help: XY mode gestures` as the surface for mode-specific guidance (context-sensitive status hints are v2, so the status strip keeps its desktop gesture list). Register three rows in `registerCommands()`:

```typescript
for (const [mode, text] of [
  [
    "XY",
    "XY: drag box-zoom · wheel zoom · right-drag pan · dbl-click fit · click datatip · drop on the amber strip to set X",
  ],
  [
    "FFT",
    "FFT: computed over the visible time window · wheel/box zoom the frequency and dB axes · dbl-click fit",
  ],
  [
    "histogram",
    "Histogram: counts of the visible time window · bins rebin as the window moves · dbl-click fit",
  ],
] as const) {
  this.commands.register({
    id: `help-${mode.toLowerCase()}-gestures`,
    title: `Help: ${mode} mode gestures`,
    run: () => {
      required(this.root, ".render-ms").textContent = text;
    },
  });
}
```

- [ ] **Step 3: Add the e2e assertion**

Add to `frontend/tests/e2e/modes.spec.ts`:

```typescript
test("the toolbar stats toggle reaches every panel", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  await page.locator(".stats-toggle").click();
  await expect(page.locator(".panel-stats").first()).toBeVisible();
  await page.locator(".stats-toggle").click();
  await expect(page.locator(".panel-stats").first()).toBeHidden();
});
```

- [ ] **Step 4: Update the docs**

In `docs/implementation-roadmap.md`, replace the trailing paragraph that begins "Phase 2 desktop interaction (2A) shipped" — keep it, and append:

```markdown
Phase 2B closed the phase: XY panels with the amber drop strip, dashed `x:`
and `c:` axis chips, window-dimmed trajectories, a trajectory cursor ring and
datatips; a `batlow` sequential colormap with a labelled colorbar
([ADR 0016](adr/0016-sequential-colormap.md)); FFT panels over the visible
window ([ADR 0017](adr/0017-spectrum-semantics.md)); histogram panels
([ADR 0018](adr/0018-histogram-semantics.md)); and the full touch gesture
set. All three modes are presentation-plane computations over a bounded
window slice served by one new protocol request
([ADR 0015](adr/0015-window-sample-requests.md)).

Two design gaps were closed by decision rather than extraction and should be
reviewed against any future design pass: histogram mode has no specification
at all, and the FFT panel has only a pixel reference. The prototype's `1:1`
equal-axis control was dropped for want of a home in the final chrome.
```

In `docs/superpowers/plans/2026-07-24-00-INDEX.md`, replace the sentence "Phase 2B (XY/color channels, FFT/histogram modes, and touch gestures) remains unwritten." with a table row under the Phase 2 heading:

```markdown
| 2B | [Panel modes, colour channel, touch](2026-07-25-phase2b-panel-modes.md) | XY + drop strip, `c:` colorbar, FFT, histogram, touch gestures, toolbar stats | 2A merged |
```

In `docs/adr/README.md`, add index rows for ADRs 0015–0018 following that file's existing format.

- [ ] **Step 5: Run the full gate and commit**

Run: `./scripts/ci.sh all`
Expected: PASS.

```bash
git add frontend/src/ui/app-shell.ts frontend/src/styles/app.css \
  frontend/tests/e2e/modes.spec.ts docs/implementation-roadmap.md \
  docs/superpowers/plans/2026-07-24-00-INDEX.md docs/adr/README.md
git commit -m "feat(ui): add toolbar statistics, per-mode help, and close phase 2"
```

---

## Final verification checklist (for the executing agent)

Before handoff, confirm each of these by inspection, not by assumption:

- `./scripts/ci.sh all` passes from a clean tree.
- `pnpm codegen:check` is clean — the generated files match the schemas and are rustfmt-formatted.
- `protocol/testdata/sample-conformance.json` is committed and both suites assert against it. Re-running the Rust test **without** `REGENERATE_FIXTURES` passes.
- No new dependency appears in `Cargo.toml`, `Cargo.lock`, or `frontend/package.json`.
- `frontend/dist/snapshot-template.html` still passes `pnpm check:artifacts` — under 750,000 bytes, no external `src`/`href`, no `http(s)://`.
- Amber appears only on the drop strip, the cursor line, the XY cursor ring, the box-zoom band, the Δ readout box, and existing 2A roles. Mode pills, the toolbar `Σ Stats` button, and every other active control are `--surface-4` + `--fg-1`.
- The `--seq-*` ramp is declared once, in `:root` only, and `palette.test.ts` asserts its monotonicity unsimulated and under both CVD simulations. No threshold in that file was relaxed.
- Every pointer-only action has a keyboard twin: setting the X signal, setting and clearing the colour signal, switching modes, fitting, zooming, panning, toggling statistics.
- No panel mode writes the linked time window except `time` — grep for `onTimeWindow` and confirm `applyXRange` is the only caller path from XY/FFT gestures.
- No `smooth`/`deriv` buttons, no `1:1` control, no session save/load, no export, no follow mode were added.
- The untracked `Screenshot 2026-07-25 *.png` files are still untracked and unstaged.

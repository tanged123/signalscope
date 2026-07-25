# Phase 2A — Desktop Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every time-series panel the Final Spec's desktop interaction set — wheel/drag/box zoom, pan, double-click fit, a linked amber cursor with readouts, pinned annotations with delta readouts, a visible-statistics strip, gutter/inline axis styles, editable labels, and a split legend inspector.

**Architecture:** All interaction state flows through the existing controller spine: gestures are detected in `PanelView` (which owns hit-testing because it holds the last rendered tiles and plot layout), translated into semantic callbacks, and applied by `AppShell` to `LinkedTimeModel` / `WorkspaceModel`, which re-render immediately from cached tiles and refetch density-bounded tiles behind a debounce. A second per-panel overlay canvas draws all transient amber interaction ink (cursor, rubber band, markers, deltas) without repainting series. Two schema changes underpin the features: envelope bins gain finite sums (protocol v3, cache v2) so mean/RMS of the visible region are computable from displayed bins on both hosts, and the session schema gains axis labels plus per-panel local time windows (v4).

**Tech Stack:** TypeScript (vanilla, Vite, Canvas 2D), Vitest, Playwright; Rust (`scope-core`, `scope-protocol`) for the bin-sum and session-migration tasks. No new dependencies on either side.

## Global Constraints

- Every workflow command goes through `./scripts/`. Quick red/green loops may use `./scripts/dev.sh <cmd>` (runs an arbitrary command inside the Nix shell); each task ends with the full relevant gate. Do not invoke `pnpm`, `npx`, `vitest`, or `cargo` bare.
- `frontend/src/generated/*.ts`, `protocol/src/generated.rs`, and `core/scope-core/src/session/generated.rs` are codegen outputs of `protocol/schema/*.json`. Never hand-edit them; run `./scripts/dev.sh pnpm codegen` after schema edits and keep `pnpm codegen:check` green.
- Amber (`--amber-7`, `--amber-9`, `--amber-3`, `--focus-ring`) is **interaction-only**: cursor, box-zoom band, Δ readouts, drag targets, ƒx marks. Never a series colour, never an active-control fill. Chrome stays achromatic (`--surface-4` + `--fg-1` for active states).
- Dark surfaces stay near-black and flat: 1px seams, radii ≤ 4px, no glows/gradients/shadows (the spec's `--elev-*` popover shadows are the sanctioned exception for popovers/tooltips). Light mode is a token swap only.
- All values, paths, axes, readouts: `--font-mono` (JetBrains Mono) with `font-variant-numeric: tabular-nums`, values `%.4f`, `—` for absent, U+2212 for minus in tick labels.
- A keyboard path must exist for every pointer action — the command palette (⌘K) is the sanctioned long-tail path. Right-click is never the only way to do anything.
- UI and renderer code never branch on host identity. Anything computed for the plot must work from protocol bins so `BakedPlane` snapshots behave identically (this is why stats come from bin sums, not raw arrays).
- Preserve: two-host `DataPlane`, versioned protocol/session schemas, tile-pyramid gap/extrema invariants, transactional ingest, self-contained no-network snapshots.
- Do not use `git add -A`. Stage only the files named in each task's commit step. Preserve unrelated worktree changes; inspect `git status` before each task.

### Toolchain facts this plan depends on

Verified against the tree; if any turn out false, stop and escalate.

- `./scripts/test.sh frontend` runs `pnpm lint && pnpm typecheck && pnpm codegen:check && pnpm test`, then snapshot artifact checks. Every "expected: PASS" step must therefore also lint and typecheck.
- `./scripts/test.sh core` runs the Rust workspace tests excluding the shell crate. `./scripts/test.sh e2e` runs Playwright. `./scripts/ci.sh all` is the full gate.
- `tsconfig.json` sets `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. ESLint runs `typescript-eslint` **strictTypeChecked** — no `any`, no non-null assertions.
- Vitest runs in the **node environment — no jsdom**. Unit tests cannot touch `document`/`window`/`HTMLCanvasElement`. All new geometry, hit-testing, stats, and overlay-draw logic must live in pure modules or be tested through the existing recording-canvas pattern (`canvas-renderer.test.ts`'s `recordingContext()`/`fakeCanvas()` and `setPalette` injection).
- Playwright has two projects: `desktop` and `mobile-review` (Pixel 7). New gesture tests are desktop-only: `test.skip(isMobile, "desktop interaction")`.
- The dev server and all e2e tests run against `BakedPlane`'s demo manifest: two signals `rocket/velocity_body/x|y`, 1,800 points at 30 Hz, t ∈ [0, 59.9667]. `window.__TAURI_INTERNALS__` is absent, so `plane.ingest === null`.
- Wire `u64` values are **strings** in TypeScript (`sample_count: "1"`). The new `finite_count` field is also a string; convert with `Number(...)` before arithmetic.
- Generated object types derive `Clone, Debug, PartialEq, Deserialize, Serialize` in Rust; the schema mini-language supports `bool|f32|f64|string|u8|u32|u64`, `?`, `[]`, `[N]`, objects, enums — nothing else. All fields in this plan fit the existing language; no generator changes are needed.

---

## Scope: what this plan is and is not

The roadmap's Phase 2 line is: _"Finish linked desktop and touch gestures, gutter/inline axes, editable labels, split legend inspector, visible statistics, annotations and delta readouts, XY drop strip, color channel and colorbar, FFT, and histogram modes."_

Per the maintainer's direction, **this plan (2A) is the desktop-interaction core**. A follow-on **Phase 2B plan** owns the non-time panel modes, because each needs a new native compute surface and at least one open design decision:

| Deferred to Phase 2B (do not implement here)                 | Why                                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Touch gestures (pinch, long-press, tap readout)              | Explicitly deprioritized by the maintainer; the prototype's touch layer is reference material for later.                         |
| XY mode + the amber "use as X" drop strip                    | Needs an XY pairing/resample query (raw-sample work, new protocol request, BakedPlane story per ADR 0007's size budget).         |
| `c:` color channel + colorbar                                | Colormap must be chosen and recorded (viridis-class, ADR 0011 fixes the source to Crameri's maps); assignment UX has a spec gap. |
| FFT mode                                                     | Needs `scope-core::compute` FFT + its first protocol request (ADR 0008 precedent); window/averaging semantics unspecified.       |
| Histogram mode                                               | Zero spec coverage — needs a design decision/ADR, not an extraction.                                                             |
| Quick transforms in the legend inspector (`smooth`, `deriv`) | ADR 0008: expression evaluation is a native protocol request that does not exist until Phase 3. No dead buttons.                 |
| `follow` time mode, session save/load, snapshot export       | Phase 3/4 per the roadmap.                                                                                                       |
| Toolbar all-panels `Σ Stats` toggle                          | Kept minimal: per-panel `Σ` + `s` key + palette command satisfy the keyboard invariant; revisit with 2B.                         |

A reviewer should reject a diff that adds any of these.

## Decisions requiring maintainer awareness (made explicit here, applied in tasks)

1. **Bins gain `sum`, `sum_sq`, `finite_count`** (protocol v2→v3, sidecar cache v1→v2, 64→88-byte bin records). This is the only way to get exact mean/RMS of the visible region in O(bins) on _both_ hosts without raw scans in the renderer. Old sidecars become graceful cache misses; no persisted snapshots or sessions exist yet, so the protocol bump orphans nothing. Recorded as ADR 0014 (Task 1).
2. **Visible statistics are computed from the displayed bins**, so window edges are bin-granular at coarse zoom and exact at level 0. The strip reflects what is drawn — documented in the ADR.
3. **Session schema v4** adds `x_label`, `y_label` (editable axis names — the Final Spec requires them editable and serialized but its state model omitted them) and `time_window` (ADR 0006's per-panel local window for unlinked panels).
4. **Datatips snap to rendered bin vertices** ((t₀, first)/(t₁, last) of each bin), which are true samples at level 0 and envelope representatives at coarse zoom — MATLAB-style snapping to what is actually drawn.
5. **The delta readout pairs the last two annotations on the panel** (prototype semantics; the spec's `Δ① → ②` shows the same), and the remove-radius (9px) < pin-radius (14px) asymmetry is kept so a double-click self-cancels its accidental pin before fitting.
6. **The axis-style toggle has no specified UI surface** (genuine spec gap). Minimal compliant answer: a palette command `Panel: toggle axis style` plus the spec's `axes: inline` header indicator. Escalate before adding menus.
7. **`alt+wheel` is kept as the undocumented second y-zoom modifier** (prototype behavior); `ctrl/⌘+left-drag` are kept as pan aliases. The advertised bindings are the spec's status-bar string.
8. The prototype's XY `1:1` equal-axis flag, epoch time formatting, and `n` in the stats strip are **not** carried over (spec omits all three).

## File structure (created/modified across the plan)

```
protocol/schema/scope-protocol.json        v3: EnvelopeBin += sum, sum_sq, finite_count   (Task 1)
protocol/schema/scope-session.json         v4: PanelState += x_label, y_label, time_window (Task 2)
core/scope-core/src/pyramid.rs             sum-carrying sample/merge bins + tests          (Task 1)
core/scope-core/src/cache.rs               88-byte bin records, CACHE_VERSION 2            (Task 1)
core/scope-core/src/session.rs             v3→v4 migration arm + tests                     (Task 2)
docs/adr/0014-envelope-bin-sums.md         new ADR                                         (Task 1)
frontend/src/app/plot-math.ts              NEW: pure ranges/projection/zoom/pan/value/format(Task 3)
frontend/src/app/plot-hit.ts               NEW: pure datatip vertex hit-testing            (Task 6)
frontend/src/app/stats.ts                  NEW: pure visible-region stats from bin sums    (Task 8)
frontend/src/app/linked-time.ts            setCursor                                        (Task 4)
frontend/src/app/workspace.ts              renamePanel/setAxisLabel/setPanelTimeWindow/
                                           annotation ops/toggleStats/toggleAxisStyle/
                                           setSeriesStyle/removeSeries                     (Tasks 2,6,8,9,11)
frontend/src/render/canvas-renderer.ts     lastLayout(), inline axes, widths/emphasis, −    (Tasks 3,9,11)
frontend/src/render/overlay-renderer.ts    NEW: cursor/box/markers/delta ink (recording-testable) (Task 4)
frontend/src/ui/panel.ts                   overlay canvas, gesture binding, stats strip,
                                           annotations list, editors, inspector popover    (Tasks 4–11)
frontend/src/ui/workspace-view.ts          per-panel windows, cursor fan-out               (Tasks 4,5)
frontend/src/ui/app-shell.ts               cursor/tooltip/status, window routing, debounce,
                                           new commands, tooltip markup                    (Tasks 4–10)
frontend/src/ui/signal-tree.ts             live cursor values                              (Task 4)
frontend/src/styles/app.css                overlay, tooltip, strips, editors, popover CSS  (Tasks 4–11)
frontend/tests/e2e/interactions.spec.ts    NEW: grows a scenario per task                  (Tasks 4–11)
```

Task sequencing: 1 and 2 are independent of everything and of each other (land first, they touch codegen). 3 → 4 → 5 → 6 → 7 in order. 8 needs 1+5. 9, 10, 11 need 3–5 and are mutually independent (10 needs 2). 12 last.

---

## Task 1: Envelope bins carry finite sums (protocol v3, cache v2, ADR 0014)

Mean and RMS of the visible region cannot be derived from `min/max/count` bins. Add `sum` (Σ finite values), `sum_sq` (Σ v²), and `finite_count` to `EnvelopeBin`, preserved by the merge invariant exactly like the existing extrema, so any zoom level yields exact μ/rms in O(bins) on both hosts.

**Files:**

- Modify: `protocol/schema/scope-protocol.json:2` (version), `:26-38` (EnvelopeBin)
- Regenerate: `protocol/src/generated.rs`, `frontend/src/generated/protocol.ts` (via codegen, never by hand)
- Modify: `core/scope-core/src/pyramid.rs:10-35` (sample_bin/merge_bins), `:397-406` (fixture assertions)
- Modify: `core/scope-core/src/cache.rs:19-21` (doc), `:44` (CACHE_VERSION), `:47` (BIN_RECORD_LEN), `:399-440` (encode/decode)
- Modify: `frontend/src/app/data-plane.ts:156-243` (demo bins + merge)
- Modify: `frontend/src/render/canvas-renderer.test.ts` (EnvelopeBin literals — typecheck enumerates them)
- Regenerate: `protocol/testdata/pyramid-conformance.json`
- Create: `docs/adr/0014-envelope-bin-sums.md`; Modify: `docs/adr/README.md` (append to list)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `EnvelopeBin.sum: f64`, `sum_sq: f64` (numbers in TS), `finite_count: u64` (string in TS). All-NaN bins carry `0.0/0.0/0`. Task 8's `visibleStats` relies on exactly these names and the finite-only-sum semantics.

- [ ] **Step 1: Write the failing Rust test**

Append to the `tests` module of `core/scope-core/src/pyramid.rs`:

```rust
    #[test]
    fn bins_accumulate_finite_sums() {
        let pyramid = Pyramid::from_samples(&[0.0, 1.0, 2.0, 3.0], &[1.0, f64::NAN, 2.0, 3.0]);
        let top = pyramid.level(2).unwrap()[0].clone();
        assert_eq!(top.sample_count, 4);
        assert_eq!(top.finite_count, 3);
        assert!((top.sum - 6.0).abs() < 1e-12);
        assert!((top.sum_sq - 14.0).abs() < 1e-12);

        let raw = pyramid.level(0).unwrap();
        assert_eq!(raw[1].finite_count, 0);
        assert!((raw[1].sum).abs() < f64::EPSILON);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/dev.sh cargo test -p scope-core bins_accumulate_finite_sums`
Expected: FAIL to compile — `EnvelopeBin` has no field `sum`.

- [ ] **Step 3: Extend the schema and regenerate**

In `protocol/schema/scope-protocol.json`, set `"protocol_version": 3` and insert the three fields after `"max"`:

```json
    "EnvelopeBin": {
      "kind": "object",
      "fields": {
        "t0": "f64",
        "t1": "f64",
        "first": "f64?",
        "last": "f64?",
        "min": "f64?",
        "max": "f64?",
        "sum": "f64",
        "sum_sq": "f64",
        "finite_count": "u64",
        "sample_count": "u64",
        "has_gap": "bool"
      }
    },
```

Run: `./scripts/dev.sh pnpm codegen`
Expected: `protocol/src/generated.rs` and `frontend/src/generated/protocol.ts` change; `PROTOCOL_VERSION` becomes 3 in both.

- [ ] **Step 4: Update `sample_bin` and `merge_bins`**

In `core/scope-core/src/pyramid.rs` replace the two functions:

```rust
fn sample_bin(time: f64, value: f64) -> EnvelopeBin {
    let finite = value.is_finite().then_some(value);
    EnvelopeBin {
        t0: time,
        t1: time,
        first: finite,
        last: finite,
        min: finite,
        max: finite,
        sum: finite.unwrap_or(0.0),
        sum_sq: finite.map_or(0.0, |value| value * value),
        finite_count: u64::from(value.is_finite()),
        sample_count: 1,
        has_gap: !value.is_finite(),
    }
}

fn merge_bins(left: &EnvelopeBin, right: &EnvelopeBin) -> EnvelopeBin {
    EnvelopeBin {
        t0: left.t0,
        t1: right.t1,
        first: left.first.or(right.first),
        last: right.last.or(left.last),
        min: min_option(left.min, right.min),
        max: max_option(left.max, right.max),
        sum: left.sum + right.sum,
        sum_sq: left.sum_sq + right.sum_sq,
        finite_count: left.finite_count + right.finite_count,
        sample_count: left.sample_count + right.sample_count,
        has_gap: left.has_gap || right.has_gap,
    }
}
```

Also extend `assert_bin_matches` (pyramid.rs tests) with:

```rust
        assert_close(current.sum, stored.sum);
        assert_close(current.sum_sq, stored.sum_sq);
        assert_eq!(current.finite_count, stored.finite_count);
```

Note on `assert_close`: it computes a relative tolerance, and `sum` can be `0.0` exactly for all-NaN bins — that is fine because its tolerance floor is `max(...,1.0) * 1e-12`.

- [ ] **Step 5: Run the new test to verify it passes**

Run: `./scripts/dev.sh cargo test -p scope-core bins_accumulate_finite_sums`
Expected: PASS. (`conformance_fixture_matches_rust_query` now FAILS — fixture is stale; next steps fix that. `cache` tests fail to compile until Step 6.)

- [ ] **Step 6: Extend the sidecar record to 88 bytes and bump the cache version**

In `core/scope-core/src/cache.rs`:

- Doc comment: change "arrays of 64-byte bin records" to "arrays of 88-byte bin records".
- `pub const CACHE_VERSION: u32 = 2;`
- `const BIN_RECORD_LEN: usize = 88;`
- In `encode_bins`, after the four optional values and before `sample_count`:

```rust
        out.extend_from_slice(&bin.sum.to_le_bytes());
        out.extend_from_slice(&bin.sum_sq.to_le_bytes());
        out.extend_from_slice(&bin.sample_count.to_le_bytes());
        out.extend_from_slice(&bin.finite_count.to_le_bytes());
        out.push(u8::from(bin.has_gap));
        out.extend_from_slice(&[0_u8; 7]);
```

(the `sample_count`/`has_gap`/padding lines replace the existing ones; final layout is 6×f64 optionals-included at 0–47, `sum` 48, `sum_sq` 56, `sample_count` 64, `finite_count` 72, `has_gap` 80, pad to 88).

- In `decode_bins`:

```rust
                sum: field(chunk, 48),
                sum_sq: field(chunk, 56),
                sample_count: u64::from_le_bytes(chunk[64..72].try_into().expect("8-byte field")),
                finite_count: u64::from_le_bytes(chunk[72..80].try_into().expect("8-byte field")),
                has_gap: chunk[80] != 0,
```

`sum`/`sum_sq` use the plain `field` reader, not `optional` — they are totals, and `0.0` is meaningful.

- [ ] **Step 7: Run the Rust suite; regenerate the conformance fixture**

Run: `./scripts/dev.sh cargo test -p scope-core`
Expected: everything passes except `conformance_fixture_matches_rust_query`.

Run: `./scripts/dev.sh sh -c 'REGENERATE_FIXTURES=1 cargo test -p scope-core conformance_fixture_matches_rust_query'`
then: `./scripts/test.sh core`
Expected: PASS, including the cache round-trip tests (old-version sidecars are covered by the existing `corrupt_payload_and_truncation_are_misses` test, which already writes version 2 — update its forged version to `3_u32` so it still tests a _mismatched_ version).

- [ ] **Step 8: Update the TypeScript demo manifest and test literals**

In `frontend/src/app/data-plane.ts` — `makeBins` bins gain:

```ts
        sum: Number.isFinite(value) ? value : 0,
        sum_sq: Number.isFinite(value) ? value * value : 0,
        finite_count: Number.isFinite(value) ? "1" : "0",
```

and `mergeDemoBins` gains:

```ts
    sum: left.sum + right.sum,
    sum_sq: left.sum_sq + right.sum_sq,
    finite_count: String(Number(left.finite_count) + Number(right.finite_count)),
```

Run: `./scripts/dev.sh pnpm --dir frontend exec tsc --noEmit`
Expected: the remaining errors enumerate every `EnvelopeBin` literal in tests (`canvas-renderer.test.ts` and any helper builders). Add the three fields to each (`sum: 0, sum_sq: 0, finite_count: "0"` is fine where values are irrelevant).

- [ ] **Step 9: Write ADR 0014 and index it**

Create `docs/adr/0014-envelope-bin-sums.md`:

```markdown
# 14. Envelope bins carry finite sums for visible statistics

Status: Accepted

Amends [ADR 0003](0003-min-max-tile-pyramid.md).

## Context

Phase 2 shows per-series min/max/μ/rms of the visible region. Bins carried
first/last/min/max/sample_count/has_gap; mean and RMS were not derivable at
any zoom level, and scanning raw arrays per stats refresh would break the
pyramid's bounded-cost premise — and be impossible in the snapshot host,
which holds only bins.

## Decision

`EnvelopeBin` gains `sum` (Σ of finite values), `sum_sq` (Σ v²), and
`finite_count`. Leaves derive them from the sample; parents add them, like
the other merge invariants. All-NaN bins carry `0.0 / 0.0 / 0`, not null.
Statistics are computed in the presentation plane from the bins actually
displayed: exact at level 0, bin-granular at window edges when zoomed out.
The strip therefore always describes what is drawn.

Protocol version moves to 3; sidecar bin records grow to 88 bytes under
`CACHE_VERSION` 2, so existing sidecars degrade to cache misses and rebuild.

## Consequences

μ/rms are exact for any fully covered bin range in O(bins) on both hosts.
Sidecar files grow ~37% per level. No raw-array scan enters the renderer.
```

Append to `docs/adr/README.md` list: `- [ADR 0014: Envelope bins carry finite sums](0014-envelope-bin-sums.md)` (match the file's existing list format).

- [ ] **Step 10: Full gates**

Run: `./scripts/test.sh core` then `./scripts/test.sh frontend`
Expected: PASS (frontend gate includes `codegen:check`, proving generated outputs are committed and in sync).

- [ ] **Step 11: Commit**

```bash
git add protocol/schema/scope-protocol.json protocol/src/generated.rs \
  frontend/src/generated/protocol.ts core/scope-core/src/pyramid.rs \
  core/scope-core/src/cache.rs protocol/testdata/pyramid-conformance.json \
  frontend/src/app/data-plane.ts frontend/src/render/canvas-renderer.test.ts \
  docs/adr/0014-envelope-bin-sums.md docs/adr/README.md
git commit -m "feat(protocol): carry finite sums in envelope bins for visible stats"
```

---

## Task 2: Session schema v4 — axis labels and local time windows

Adds the three serialized fields the interaction features need: editable `x_label`/`y_label` (Final Spec: axis names are editable in place and serialize) and `time_window` (ADR 0006: unlinked panels retain a local time window). Also adds the `WorkspaceModel` accessors that later tasks call.

**Files:**

- Modify: `protocol/schema/scope-session.json:2` (version), `:51-65` (PanelState)
- Regenerate: `core/scope-core/src/session/generated.rs`, `frontend/src/generated/session.ts`
- Modify: `core/scope-core/src/session.rs:74-138` (migration arm), `:162-178` (test literal), new migration test
- Modify: `frontend/src/app/workspace.ts` (panel factory literal + new accessors)
- Modify: `frontend/src/app/workspace.test.ts` (literals + new accessor tests)
- Modify: `frontend/tests/e2e/workbench.spec.ts` (the legend harness's hand-built `PanelState`)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `PanelState.x_label: string | null`, `y_label: string | null`, `time_window: [number, number] | null` and model methods `renamePanel(id: string, title: string): void`, `setAxisLabel(id: string, axis: "x" | "y", label: string | null): void`, `setPanelTimeWindow(id: string, window: readonly [number, number] | null): void`. Task 5 consumes `setPanelTimeWindow`/`time_window`; Task 10 consumes the label methods.

- [ ] **Step 1: Write the failing Rust migration test**

Append to `core/scope-core/src/session.rs` tests:

```rust
    #[test]
    fn v3_sessions_gain_axis_labels_and_local_windows() {
        let json = r#"{
            "app": "signalscope",
            "schema_version": 3,
            "theme": "dark",
            "linked_time": {"t0":0.0,"t1":1.0,"linked":true,"paused":false,"cursorT":null,"mode":"fixed"},
            "active_tab_id": "workspace-1",
            "tabs": [{"id":"workspace-1","title":"Workspace 1","focused_panel_id":null,
                "panels":[{"id":"panel-a","title":"A","mode":"time","axis_style":"gutter","x_signal":null,"color_signal":null,"series":[],"y_range":null,"annotations":[],"show_stats":false}],
                "layout":[{"height":1.0,"panels":[{"panel_id":"panel-a","width":1.0}]}]}],
            "favorites": []
        }"#;
        let session = from_json(json).unwrap();
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        let panel = &session.tabs[0].panels[0];
        assert_eq!(panel.x_label, None);
        assert_eq!(panel.y_label, None);
        assert_eq!(panel.time_window, None);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/dev.sh cargo test -p scope-core v3_sessions_gain`
Expected: FAIL to compile — no field `x_label`.

- [ ] **Step 3: Extend the schema, regenerate, add the migration arm**

`protocol/schema/scope-session.json`: `"schema_version": 4`, and in `PanelState.fields` insert after `"y_range": "f64[2]?"`:

```json
        "x_label": "string?",
        "y_label": "string?",
        "time_window": "f64[2]?",
```

Run: `./scripts/dev.sh pnpm codegen`

In `core/scope-core/src/session.rs`, add an arm to `migrate` between the `2 =>` arm and the `SESSION_SCHEMA_VERSION` arm:

```rust
        3 => {
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
                            object.entry("x_label").or_insert(serde_json::Value::Null);
                            object.entry("y_label").or_insert(serde_json::Value::Null);
                            object
                                .entry("time_window")
                                .or_insert(serde_json::Value::Null);
                        }
                    }
                }
            }
            value["schema_version"] = serde_json::json!(4);
            migrate(4, value)
        }
```

Fix the `current_session_round_trips` test literal by adding `x_label: None, y_label: None, time_window: None` to its `PanelState`.

- [ ] **Step 4: Run the Rust session tests**

Run: `./scripts/dev.sh cargo test -p scope-core session`
Expected: PASS, including the existing v1/v2 ladder tests (they now migrate through the new arm).

- [ ] **Step 5: Write failing model tests for the new accessors**

In `frontend/src/app/workspace.test.ts`:

```ts
test("renamePanel, setAxisLabel and setPanelTimeWindow write panel state", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanelRow();
  model.renamePanel(panel.id, "Body velocity");
  model.setAxisLabel(panel.id, "y", "velocity (m/s)");
  model.setAxisLabel(panel.id, "x", null);
  model.setPanelTimeWindow(panel.id, [2, 8]);
  const state = model.panel(panel.id);
  expect(state?.title).toBe("Body velocity");
  expect(state?.y_label).toBe("velocity (m/s)");
  expect(state?.x_label).toBeNull();
  expect(state?.time_window).toEqual([2, 8]);
  model.setPanelTimeWindow(panel.id, null);
  expect(model.panel(panel.id)?.time_window).toBeNull();
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `./scripts/dev.sh pnpm --dir frontend exec vitest run src/app/workspace.test.ts`
Expected: FAIL — `renamePanel` is not a function (plus typecheck errors for the missing literal fields when the full gate runs).

- [ ] **Step 7: Implement**

In `frontend/src/app/workspace.ts`, add `x_label: null, y_label: null, time_window: null` to the panel-factory `PanelState` literal (the one that already sets `axis_style: "gutter"`), and add alongside `setPanelYRange`:

```ts
  renamePanel(id: string, title: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) panel.title = title;
  }

  setAxisLabel(id: string, axis: "x" | "y", label: string | null): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    if (axis === "x") panel.x_label = label;
    else panel.y_label = label;
  }

  setPanelTimeWindow(
    id: string,
    window: readonly [number, number] | null,
  ): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    panel.time_window = window === null ? null : [window[0], window[1]];
  }
```

(Match the file's existing mutation style — it mutates the session panels in place; mirror how `setPanelYRange` locates the panel.)

Then run `./scripts/dev.sh pnpm --dir frontend exec tsc --noEmit` and add the three fields to every remaining `PanelState` literal it reports (`workspace.test.ts` fixtures, the `workbench.spec.ts` legend-harness state).

- [ ] **Step 8: Run the gates**

Run: `./scripts/test.sh core` then `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add protocol/schema/scope-session.json core/scope-core/src/session/generated.rs \
  frontend/src/generated/session.ts core/scope-core/src/session.rs \
  frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts \
  frontend/tests/e2e/workbench.spec.ts
git commit -m "feat(session): schema v4 with axis labels and per-panel time windows"
```

---

## Task 3: Plot math module and renderer layout exposure

Every gesture needs the pixel↔data mapping the renderer already computes privately. Expose the last render's layout, and build the pure math (zoom, pan, inversion, value-at-time, value formatting) in a node-testable module.

**Files:**

- Create: `frontend/src/app/plot-math.ts`
- Create: `frontend/src/app/plot-math.test.ts`
- Modify: `frontend/src/render/canvas-renderer.ts:93-155` (store/expose layout)
- Modify: `frontend/src/render/canvas-renderer.test.ts` (layout exposure test)

**Interfaces:**

- Consumes: `EnvelopeBin` from `../generated/protocol`.
- Produces (all consumed by Tasks 4–10):

```ts
export interface Range {
  min: number;
  max: number;
}
export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PlotLayout {
  plot: PlotRect;
  xRange: Range;
  yRange: Range;
}
export function projectX(layout: PlotLayout, value: number): number;
export function projectY(layout: PlotLayout, value: number): number;
export function invertX(layout: PlotLayout, px: number): number;
export function invertY(layout: PlotLayout, py: number): number;
export function insidePlot(layout: PlotLayout, px: number, py: number): boolean;
export function clamp(value: number, min: number, max: number): number;
export function wheelZoomFactor(deltaY: number): number; // Math.exp(deltaY * 0.0016)
export function zoomRange(range: Range, factor: number, pivot: number): Range;
export function panRange(range: Range, delta: number): Range; // delta in data units
export function valueAtTime(
  bins: readonly EnvelopeBin[],
  time: number,
): number | null;
export function formatValue(value: number | null): string; // %.4f, exp(3) extremes, "—", U+2212
export function formatCursorTime(time: number): string; // `${time.toFixed(4)} s`, U+2212
```

and `CanvasRenderer.lastLayout(): PlotLayout | null`.

- [ ] **Step 1: Write the failing math tests**

Create `frontend/src/app/plot-math.test.ts`:

```ts
import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import {
  formatValue,
  invertX,
  invertY,
  panRange,
  projectX,
  valueAtTime,
  wheelZoomFactor,
  zoomRange,
  type PlotLayout,
} from "./plot-math";

const layout: PlotLayout = {
  plot: { x: 52, y: 8, width: 500, height: 300 },
  xRange: { min: 10, max: 60 },
  yRange: { min: -100, max: 100 },
};

test("invertX is the inverse of projectX inside the plot", () => {
  for (const t of [10, 25, 59.5]) {
    expect(invertX(layout, projectX(layout, t))).toBeCloseTo(t, 9);
  }
  expect(invertX(layout, 52)).toBeCloseTo(10, 9);
  expect(invertY(layout, 8)).toBeCloseTo(100, 9);
  expect(invertY(layout, 308)).toBeCloseTo(-100, 9);
});

test("zoomRange contracts around the pivot and refuses degenerate spans", () => {
  const zoomed = zoomRange({ min: 0, max: 100 }, 0.5, 50);
  expect(zoomed).toEqual({ min: 25, max: 75 });
  const pinned = zoomRange({ min: 0, max: 100 }, 0.5, 0);
  expect(pinned.min).toBe(0);
  expect(pinned.max).toBe(50);
  // collapse guard: factor so small the span underflows keeps the range
  const tiny = zoomRange({ min: 0, max: 1e-13 }, 1e-9, 0);
  expect(tiny).toEqual({ min: 0, max: 1e-13 });
});

test("panRange shifts both edges", () => {
  expect(panRange({ min: 5, max: 15 }, -2)).toEqual({ min: 3, max: 13 });
});

test("wheel deltas map to exp zoom factors", () => {
  expect(wheelZoomFactor(0)).toBe(1);
  expect(wheelZoomFactor(-240)).toBeLessThan(1);
  expect(wheelZoomFactor(240)).toBeGreaterThan(1);
});

function bin(
  t0: number,
  t1: number,
  first: number | null,
  last: number | null,
  gap = false,
): EnvelopeBin {
  return {
    t0,
    t1,
    first,
    last,
    min: first === null ? last : first,
    max: last === null ? first : last,
    sum: 0,
    sum_sq: 0,
    finite_count: "0",
    sample_count: "1",
    has_gap: gap,
  };
}

test("valueAtTime lerps inside a bin and returns null in gaps", () => {
  const bins = [
    bin(0, 1, 0, 10),
    bin(1, 2, 10, 20),
    bin(2, 3, null, null, true),
    bin(3, 4, 30, 40),
  ];
  expect(valueAtTime(bins, 0.5)).toBeCloseTo(5, 9);
  expect(valueAtTime(bins, 1.25)).toBeCloseTo(12.5, 9);
  expect(valueAtTime(bins, 2.5)).toBeNull();
  expect(valueAtTime(bins, -1)).toBeNull();
  expect(valueAtTime(bins, 9)).toBeNull();
});

test("formatValue uses 4 decimals, exponent extremes, U+2212 and em dash", () => {
  expect(formatValue(null)).toBe("—");
  expect(formatValue(223.456789)).toBe("223.4568");
  expect(formatValue(-149.281)).toBe("−149.2810");
  expect(formatValue(1_234_567)).toBe("1.235e+6");
  expect(formatValue(0.0000042)).toBe("4.200e-6");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/dev.sh pnpm --dir frontend exec vitest run src/app/plot-math.test.ts`
Expected: FAIL — module `./plot-math` not found.

- [ ] **Step 3: Implement `plot-math.ts`**

```ts
import type { EnvelopeBin } from "../generated/protocol";

export interface Range {
  min: number;
  max: number;
}

export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The last render's pixel geometry and data ranges, for gesture inversion. */
export interface PlotLayout {
  plot: PlotRect;
  xRange: Range;
  yRange: Range;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function projectX(layout: PlotLayout, value: number): number {
  const { plot, xRange } = layout;
  return (
    plot.x + ((value - xRange.min) / (xRange.max - xRange.min)) * plot.width
  );
}

export function projectY(layout: PlotLayout, value: number): number {
  const { plot, yRange } = layout;
  return (
    plot.y +
    plot.height -
    ((value - yRange.min) / (yRange.max - yRange.min)) * plot.height
  );
}

export function invertX(layout: PlotLayout, px: number): number {
  const { plot, xRange } = layout;
  return xRange.min + ((px - plot.x) / plot.width) * (xRange.max - xRange.min);
}

export function invertY(layout: PlotLayout, py: number): number {
  const { plot, yRange } = layout;
  return (
    yRange.min +
    ((plot.y + plot.height - py) / plot.height) * (yRange.max - yRange.min)
  );
}

export function insidePlot(
  layout: PlotLayout,
  px: number,
  py: number,
): boolean {
  const { plot } = layout;
  return (
    px >= plot.x &&
    px <= plot.x + plot.width &&
    py >= plot.y &&
    py <= plot.y + plot.height
  );
}

/** Prototype-calibrated wheel response: exp(deltaY * 0.0016). */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(deltaY * 0.0016);
}

/** Scales `range` about `pivot`; a non-finite or collapsed result is refused. */
export function zoomRange(range: Range, factor: number, pivot: number): Range {
  const min = pivot + (range.min - pivot) * factor;
  const max = pivot + (range.max - pivot) * factor;
  const floor = Math.max(Math.abs(min), Math.abs(max), 1) * Number.EPSILON * 4;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min <= floor) {
    return { min: range.min, max: range.max };
  }
  return { min, max };
}

export function panRange(range: Range, delta: number): Range {
  return { min: range.min + delta, max: range.max + delta };
}

/**
 * The drawn value at `time`, interpolated between each bin's rendered
 * (t0, first) → (t1, last) segment. Bins with null endpoints (all-NaN) and
 * positions outside the covered span yield null, matching the broken stroke.
 */
export function valueAtTime(
  bins: readonly EnvelopeBin[],
  time: number,
): number | null {
  if (bins.length === 0) return null;
  let low = 0;
  let high = bins.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((bins[mid]?.t1 ?? Number.NEGATIVE_INFINITY) < time) low = mid + 1;
    else high = mid;
  }
  const hit = bins[low];
  if (hit === undefined || time < hit.t0 || time > hit.t1) return null;
  if (hit.first === null || hit.last === null) return null;
  if (hit.t1 === hit.t0) return hit.last;
  const alpha = (time - hit.t0) / (hit.t1 - hit.t0);
  return hit.first + (hit.last - hit.first) * alpha;
}

const MINUS = "−";

export function formatValue(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  const magnitude = Math.abs(value);
  const text =
    magnitude >= 1e6 || (magnitude > 0 && magnitude < 1e-3)
      ? value.toExponential(3)
      : value.toFixed(4);
  return text.replace("-", MINUS).replace(`e${MINUS}`, "e-");
}

export function formatCursorTime(time: number): string {
  return `${time.toFixed(4).replace("-", MINUS)} s`;
}
```

Note the exponent sign is restored to ASCII (`e-6`) — only the mantissa sign uses U+2212, matching the test.

- [ ] **Step 4: Run to verify it passes**

Run: `./scripts/dev.sh pnpm --dir frontend exec vitest run src/app/plot-math.test.ts`
Expected: PASS.

- [ ] **Step 5: Expose the renderer's layout**

In `frontend/src/render/canvas-renderer.ts`:

- Import the types: `import type { PlotLayout } from "../app/plot-math";` and delete the file-local `PlotRect`/`Range` interface declarations in favor of importing them from `plot-math` (they are structurally identical; keep the local `Projection` type).
- Add a field and getter to `CanvasRenderer`:

```ts
  private layout: PlotLayout | null = null;

  /** Geometry of the most recent render, for gesture inversion. Null before the first frame. */
  lastLayout(): PlotLayout | null {
    return this.layout;
  }
```

- In `render(...)`, after `plot` is computed, record it:

```ts
this.layout = { plot, xRange: { ...xRange }, yRange: { ...yRange } };
```

- [ ] **Step 6: Add the renderer test**

In `frontend/src/render/canvas-renderer.test.ts`, using the existing `fakeCanvas`/`recordingContext`/`TEST_PALETTE` helpers and an existing rendered fixture:

```ts
test("render records its plot layout for gesture inversion", () => {
  const { canvas } = fakeCanvas(640, 360, recordingContext());
  const renderer = new CanvasRenderer(canvas);
  renderer.setPalette(TEST_PALETTE);
  expect(renderer.lastLayout()).toBeNull();
  renderer.render(response, { min: 0, max: 10 }, options);
  const layout = renderer.lastLayout();
  expect(layout?.xRange).toEqual({ min: 0, max: 10 });
  expect(layout?.plot.x).toBeGreaterThanOrEqual(52);
});
```

(Adapt `fakeCanvas` destructuring, `response`, and `options` to the file's existing local helpers — reuse the fixtures the neighbouring tests already define rather than inventing new ones.)

- [ ] **Step 7: Run the frontend gate**

Run: `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/plot-math.ts frontend/src/app/plot-math.test.ts \
  frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts
git commit -m "feat(ui): pure plot math and renderer layout exposure"
```

---

## Task 4: Overlay canvas, linked amber cursor, readout tooltip, live values

One global cursor time: hovering any time panel draws an amber dashed line in **every** time panel, updates the status bar, shows a floating per-series readout tooltip on the hovered panel, and fills the signal tree's `.signal-value` slots. All transient ink goes on a new per-panel overlay canvas so series pixels never repaint on pointermove.

**Files:**

- Create: `frontend/src/render/overlay-renderer.ts`
- Create: `frontend/src/render/overlay-renderer.test.ts`
- Modify: `frontend/src/app/linked-time.ts` (setCursor)
- Modify: `frontend/src/app/linked-time.test.ts`
- Modify: `frontend/src/ui/panel.ts` (overlay canvas, pointer handlers, caches, `onCursor` callback)
- Modify: `frontend/src/ui/workspace-view.ts` (`setCursor` fan-out)
- Modify: `frontend/src/ui/app-shell.ts` (cursor routing, tooltip, status, tree values, markup)
- Modify: `frontend/src/ui/signal-tree.ts` (`setLiveValues`)
- Modify: `frontend/src/styles/app.css` (overlay, tooltip)
- Create: `frontend/tests/e2e/interactions.spec.ts`

**Interfaces:**

- Consumes: `PlotLayout`, `projectX/projectY/insidePlot/invertX/valueAtTime/formatValue/formatCursorTime` (Task 3).
- Produces:
  - `LinkedTimeModel.setCursor(cursorT: number | null): void`
  - `OverlayState { cursorT: number | null; box: { x0: number; y0: number; x1: number; y1: number } | null; annotations: readonly Annotation[]; annotationColorIndices: readonly number[]; showDelta: boolean }` — colour **indices** (0-based into the palette's series list), not CSS strings: canvas cannot resolve `var(...)`.
  - `OverlayRenderer { setPalette(palette: OverlayPalette): void; invalidateTheme(): void; draw(layout: PlotLayout | null, state: OverlayState): void }` with `OverlayPalette { amber: string; amberFill: string; fg1: string; fg2: string; fg3: string; surface0: string; surface2: string; fontMono: string; series: string[] }` (series resolved from `SERIES_TOKENS`, exactly like `CanvasRenderer.resolvePalette`)
  - `PanelCallbacks.onCursor(id: string, cursorT: number | null, client: { x: number; y: number } | null): void`
  - `PanelView.setCursor(cursorT: number | null): void`, `WorkspaceView.setCursor(cursorT: number | null): void`
  - `SignalTreeView.setLiveValues(values: ReadonlyMap<string, string>): void`
  - `PanelView` caches `lastState/lastTiles/lastWindow` (private) — Tasks 5–8, 11 rely on these existing.
- Task 6 supplies real annotations; in this task `annotations` is always `[]` and `box` always null.

- [ ] **Step 1: Write the failing overlay-renderer test**

Create `frontend/src/render/overlay-renderer.test.ts`, reusing the recording-canvas pattern from `canvas-renderer.test.ts` (copy its `recordingContext`/`fakeCanvas` helpers if they are file-local; if so, extract them to `frontend/src/render/test-canvas.ts` first and update the old test's imports — one shared helper, no duplication):

```ts
import { expect, test } from "vitest";
import { fakeCanvas, recordingContext } from "./test-canvas";
import { OverlayRenderer, type OverlayPalette } from "./overlay-renderer";
import type { PlotLayout } from "../app/plot-math";

const PALETTE: OverlayPalette = {
  amber: "#ffa226",
  amberFill: "rgba(255,162,38,.16)",
  fg1: "#e8eaee",
  fg2: "#a7aebb",
  fg3: "#7a8290",
  surface0: "#0b0d10",
  surface2: "#16191e",
  fontMono: "monospace",
  series: [
    "#407fd0",
    "#c98a2b",
    "#3aa981",
    "#9a6fd0",
    "#d06a86",
    "#4f9a5e",
    "#c06848",
    "#5aa4c9",
  ],
};

const layout: PlotLayout = {
  plot: { x: 52, y: 8, width: 500, height: 300 },
  xRange: { min: 0, max: 60 },
  yRange: { min: -200, max: 200 },
};

function draw(state: Partial<Parameters<OverlayRenderer["draw"]>[1]>) {
  const recording = recordingContext();
  const { canvas } = fakeCanvas(640, 360, recording);
  const renderer = new OverlayRenderer(canvas);
  renderer.setPalette(PALETTE);
  renderer.draw(layout, {
    cursorT: null,
    box: null,
    annotations: [],
    annotationColorIndices: [],
    showDelta: false,
    ...state,
  });
  return recording.calls;
}

test("cursor draws one amber dashed vertical line at the projected time", () => {
  const calls = draw({ cursorT: 30 });
  const strokes = calls.filter(
    (call) => call.op === "strokeStyle" && call.value === PALETTE.amber,
  );
  expect(strokes.length).toBeGreaterThan(0);
  const move = calls.find(
    (call) => call.op === "moveTo" && Math.abs(call.x - 302) < 1,
  );
  expect(move).toBeDefined(); // projectX(layout, 30) = 52 + 250
});

test("cursor outside the x-range draws nothing", () => {
  const calls = draw({ cursorT: 999 });
  expect(calls.some((call) => call.op === "moveTo")).toBe(false);
});

test("box zoom draws the amber rubber band with fill", () => {
  const calls = draw({ box: { x0: 100, y0: 50, x1: 200, y1: 150 } });
  expect(
    calls.some(
      (call) => call.op === "fillStyle" && call.value === PALETTE.amberFill,
    ),
  ).toBe(true);
  expect(calls.some((call) => call.op === "setLineDash")).toBe(true);
});
```

(Adjust the recorded-call field names to whatever `recordingContext` produces — mirror the assertions style of `canvas-renderer.test.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/dev.sh pnpm --dir frontend exec vitest run src/render/overlay-renderer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `overlay-renderer.ts`**

```ts
import type { Annotation } from "../generated/session";
import {
  formatValue,
  projectX,
  projectY,
  type PlotLayout,
} from "../app/plot-math";
import { SERIES_TOKENS } from "./canvas-renderer";

export interface OverlayPalette {
  amber: string;
  amberFill: string;
  fg1: string;
  fg2: string;
  fg3: string;
  surface0: string;
  surface2: string;
  fontMono: string;
  series: string[];
}

export interface OverlayState {
  cursorT: number | null;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  annotations: readonly Annotation[];
  /** 0-based palette series index per annotation, parallel to `annotations`. */
  annotationColorIndices: readonly number[];
  showDelta: boolean;
}

/** Transient interaction ink: cursor, rubber band, datatips, Δ readout. */
export class OverlayRenderer {
  private palette: OverlayPalette | null = null;
  private renderedWidth = 0;
  private renderedHeight = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  setPalette(palette: OverlayPalette): void {
    this.palette = palette;
  }

  invalidateTheme(): void {
    this.palette = null;
  }

  draw(layout: PlotLayout | null, state: OverlayState): void {
    const { context, width, height } = this.prepareCanvas();
    context.clearRect(0, 0, width, height);
    if (layout === null) return;
    const palette = this.resolvePalette();
    this.drawCursor(context, layout, state.cursorT, palette);
    this.drawAnnotations(context, layout, state, palette);
    if (state.box !== null) this.drawBox(context, state.box, palette);
  }

  private drawCursor(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    cursorT: number | null,
    palette: OverlayPalette,
  ): void {
    if (
      cursorT === null ||
      cursorT < layout.xRange.min ||
      cursorT > layout.xRange.max
    )
      return;
    const x = Math.round(projectX(layout, cursorT)) + 0.5;
    context.save();
    context.strokeStyle = palette.amber;
    context.globalAlpha = 0.7;
    context.lineWidth = 1;
    context.setLineDash([2, 2]);
    context.beginPath();
    context.moveTo(x, layout.plot.y);
    context.lineTo(x, layout.plot.y + layout.plot.height);
    context.stroke();
    context.restore();
  }

  private drawBox(
    context: CanvasRenderingContext2D,
    box: { x0: number; y0: number; x1: number; y1: number },
    palette: OverlayPalette,
  ): void {
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const width = Math.abs(box.x1 - box.x0);
    const height = Math.abs(box.y1 - box.y0);
    context.save();
    context.fillStyle = palette.amberFill;
    context.fillRect(x, y, width, height);
    context.strokeStyle = palette.amber;
    context.lineWidth = 1;
    context.setLineDash([5, 4]);
    context.strokeRect(x + 0.5, y + 0.5, width, height);
    context.restore();
  }

  private drawAnnotations(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    state: OverlayState,
    palette: OverlayPalette,
  ): void {
    context.save();
    context.font = `10px ${palette.fontMono}`;
    state.annotations.forEach((annotation, index) => {
      if (
        annotation.time < layout.xRange.min ||
        annotation.time > layout.xRange.max
      )
        return;
      const x = projectX(layout, annotation.time);
      const y = projectY(layout, annotation.value);
      context.beginPath();
      context.fillStyle = palette.surface0;
      context.strokeStyle =
        palette.series[state.annotationColorIndices[index] ?? -1] ??
        palette.fg2;
      context.lineWidth = 1.6;
      context.setLineDash([]);
      context.arc(x, y, 3.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      const label = annotation.label === "" ? "" : ` ${annotation.label}`;
      const text = `${marker(index)}${label} ${formatValue(annotation.value)} @ ${annotation.time.toFixed(3)}`;
      const textWidth = context.measureText(text).width;
      context.fillStyle = palette.surface2;
      context.fillRect(x + 7, y - 20, textWidth + 14, 16);
      context.fillStyle = palette.fg1;
      context.fillText(text, x + 14, y - 8);
    });
    if (state.showDelta && state.annotations.length >= 2) {
      this.drawDelta(context, layout, state.annotations, palette);
    }
    context.restore();
  }

  private drawDelta(
    context: CanvasRenderingContext2D,
    layout: PlotLayout,
    annotations: readonly Annotation[],
    palette: OverlayPalette,
  ): void {
    const first = annotations[annotations.length - 2];
    const second = annotations[annotations.length - 1];
    if (first === undefined || second === undefined) return;
    context.save();
    context.strokeStyle = palette.fg3;
    context.globalAlpha = 0.6;
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(projectX(layout, first.time), projectY(layout, first.value));
    context.lineTo(
      projectX(layout, second.time),
      projectY(layout, second.value),
    );
    context.stroke();
    context.restore();

    const deltaT = second.time - first.time;
    const deltaV = second.value - first.value;
    const slope = deltaT === 0 ? null : deltaV / deltaT;
    const parts = [`Δt ${formatValue(deltaT)} s`, `Δv ${formatValue(deltaV)}`];
    if (slope !== null) parts.push(`slope ${formatValue(slope)}/s`);
    const text = parts.join(" · ");
    context.save();
    context.font = `10px ${palette.fontMono}`;
    const textWidth = context.measureText(text).width;
    const x = layout.plot.x + layout.plot.width - textWidth - 24;
    const y = layout.plot.y + 6;
    context.fillStyle = palette.surface2;
    context.fillRect(x, y, textWidth + 16, 18);
    context.strokeStyle = palette.amber;
    context.globalAlpha = 0.4;
    context.lineWidth = 1;
    context.setLineDash([]);
    context.strokeRect(x + 0.5, y + 0.5, textWidth + 15, 17);
    context.globalAlpha = 1;
    context.fillStyle = palette.amber;
    context.fillText(text, x + 8, y + 13);
    context.restore();
  }

  private prepareCanvas(): {
    context: CanvasRenderingContext2D;
    width: number;
    height: number;
  } {
    const ratio = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const backingWidth = Math.round(width * ratio);
    const backingHeight = Math.round(height * ratio);
    if (
      backingWidth !== this.renderedWidth ||
      backingHeight !== this.renderedHeight
    ) {
      this.canvas.width = backingWidth;
      this.canvas.height = backingHeight;
      this.renderedWidth = backingWidth;
      this.renderedHeight = backingHeight;
    }
    const context = this.canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D context is unavailable");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width, height };
  }

  private resolvePalette(): OverlayPalette {
    if (this.palette !== null) return this.palette;
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string): string =>
      styles.getPropertyValue(name).trim();
    this.palette = {
      amber: token("--amber-7"),
      amberFill: token("--amber-3"),
      fg1: token("--fg-1"),
      fg2: token("--fg-2"),
      fg3: token("--fg-3"),
      surface0: token("--surface-0"),
      surface2: token("--surface-2"),
      fontMono: token("--font-mono") || '"JetBrains Mono", monospace',
      series: SERIES_TOKENS.map((name) => token(name)),
    };
    return this.palette;
  }
}

function marker(index: number): string {
  return index < 20
    ? String.fromCodePoint(0x2460 + index)
    : `(${String(index + 1)})`;
}
```

The delta drawing is exercised in Task 6's tests; it ships here so the overlay contract is complete and `annotations`/`showDelta` are not dead parameters for long.

- [ ] **Step 4: Run to verify the overlay tests pass**

Run: `./scripts/dev.sh pnpm --dir frontend exec vitest run src/render`
Expected: PASS (both renderer test files, including the extracted `test-canvas.ts` refactor).

- [ ] **Step 5: Add `setCursor` to the linked-time model (failing test first)**

In `frontend/src/app/linked-time.test.ts`:

```ts
test("setCursor stores finite times and clears with null", () => {
  const model = new LinkedTimeModel();
  model.setCursor(12.5);
  expect(model.snapshot().cursorT).toBe(12.5);
  model.setCursor(null);
  expect(model.snapshot().cursorT).toBeNull();
  model.setCursor(Number.NaN);
  expect(model.snapshot().cursorT).toBeNull();
});
```

Run: `./scripts/dev.sh pnpm --dir frontend exec vitest run src/app/linked-time.test.ts` — FAIL.

Implement in `frontend/src/app/linked-time.ts`:

```ts
  setCursor(cursorT: number | null): void {
    this.state = {
      ...this.state,
      cursorT: cursorT !== null && Number.isFinite(cursorT) ? cursorT : null,
    };
  }
```

Re-run — PASS.

- [ ] **Step 6: Wire the overlay canvas and cursor events into `PanelView`**

In `frontend/src/ui/panel.ts`:

- Markup: inside `.plot-wrap`, after the plot canvas, add
  `<canvas class="overlay-canvas" aria-hidden="true"></canvas>` (before `.panel-empty`).
- Fields:

```ts
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayRenderer: OverlayRenderer;
  private lastState: PanelState | null = null;
  private lastTiles: TileResponse | null = null;
  private lastWindow: { t0: number; t1: number } | null = null;
  private cursorT: number | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
```

Initialize both in the constructor (`this.overlay = required<HTMLCanvasElement>(this.element, ".overlay-canvas"); this.overlayRenderer = new OverlayRenderer(this.overlay);`).

- Extend `PanelCallbacks` with `onCursor(id: string, cursorT: number | null, client: { x: number; y: number } | null): void;`
- New private method and public API:

```ts
  private drawOverlay(): void {
    this.overlayRenderer.draw(this.renderer.lastLayout(), {
      cursorT: this.lastState?.mode === "time" ? this.cursorT : null,
      box: this.box,
      annotations: [],
      annotationColorIndices: [],
      showDelta: false,
    });
  }

  setCursor(cursorT: number | null): void {
    this.cursorT = cursorT;
    this.drawOverlay();
  }
```

- In `renderTiles(...)`, first record `this.lastState = state; this.lastTiles = tiles; this.lastWindow = { ...window };`, and call `this.drawOverlay()` just before returning the elapsed time (also when returning the early-out 0, so mode switches clear stale ink).
- In `invalidateTheme()`, also call `this.overlayRenderer.invalidateTheme()`.
- In `bind()`, add cursor tracking on the overlay:

```ts
this.overlay.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch") return;
  const layout = this.renderer.lastLayout();
  const inside =
    layout !== null && insidePlot(layout, event.offsetX, event.offsetY);
  this.callbacks.onCursor(
    this.id,
    inside && layout !== null ? invertX(layout, event.offsetX) : null,
    inside ? { x: event.clientX, y: event.clientY } : null,
  );
});
this.overlay.addEventListener("pointerleave", () => {
  this.callbacks.onCursor(this.id, null, null);
});
```

- CSS (`app.css`): `.plot-wrap { position: relative; }` (verify — it likely already is, for `.panel-empty`); add

```css
.overlay-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}
```

and move the existing `cursor: crosshair` off `.plot-canvas` if present.

- [ ] **Step 7: Fan out and consume in the shell**

- `frontend/src/ui/workspace-view.ts`:

```ts
  setCursor(cursorT: number | null): void {
    for (const view of this.views.values()) view.setCursor(cursorT);
  }
```

- `frontend/src/ui/signal-tree.ts`: add

```ts
  private liveValues: ReadonlyMap<string, string> = new Map();

  setLiveValues(values: ReadonlyMap<string, string>): void {
    this.liveValues = values;
    this.renderRows();
    this.renderFavorites();
  }
```

and in `leafElement(...)` change the value span to `value.textContent = this.liveValues.get(path) ?? "—";`.

- `frontend/src/ui/app-shell.ts`:
  - Markup: append `<div class="plot-tip" hidden></div>` inside the workbench (after `.formula-bar`), and give the status cursor span a class: `<span>cursor <span class="status-value cursor-readout">t = —</span></span>`.
  - `WorkspaceView` callbacks gain:

```ts
        onCursor: (id, cursorT, client) => {
          this.setCursor(id, cursorT, client);
        },
```

- Implement (new methods on `AppShell`):

```ts
  private setCursor(
    panelId: string,
    cursorT: number | null,
    client: { x: number; y: number } | null,
  ): void {
    this.time.setCursor(cursorT);
    const state = this.time.snapshot();
    this.workspaceView?.setCursor(state.cursorT);
    required(this.root, ".cursor-readout").textContent =
      state.cursorT === null ? "t = —" : `t = ${formatCursorTime(state.cursorT)}`;
    this.renderTooltip(panelId, state.cursorT, client);
    this.scheduleLiveValues(state.cursorT);
  }

  private renderTooltip(
    panelId: string,
    cursorT: number | null,
    client: { x: number; y: number } | null,
  ): void {
    const tip = required<HTMLElement>(this.root, ".plot-tip");
    const panel = this.workspace.panel(panelId);
    const tiles = this.tilesByPanel.get(panelId);
    if (cursorT === null || client === null || panel === undefined || tiles === undefined) {
      tip.hidden = true;
      return;
    }
    const visible = new Set(
      panel.series.filter((series) => series.visible).map((series) => series.path),
    );
    tip.replaceChildren(
      tooltipHeader(formatCursorTime(cursorT)),
      ...tiles.series
        .filter((tile) => visible.has(tile.signal_path))
        .map((tile) => {
          const series = panel.series.find((entry) => entry.path === tile.signal_path);
          const style = resolveSeriesStyle(series?.color_slot ?? 1, series?.dash ?? "solid");
          return tooltipRow(
            `var(--series-${String(style.colorIndex + 1)})`,
            tile.signal_path.split("/").slice(-2).join("/"),
            formatValue(valueAtTime(tile.bins, cursorT)),
          );
        }),
    );
    tip.hidden = false;
    const rect = tip.getBoundingClientRect();
    const x = client.x + 16 + rect.width > window.innerWidth - 8
      ? client.x - 16 - rect.width
      : client.x + 16;
    const y = client.y + 14 + rect.height > window.innerHeight - 8
      ? client.y - 14 - rect.height
      : client.y + 14;
    tip.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
  }

  /** Coalesces live-value tree updates to one per frame. */
  private scheduleLiveValues(cursorT: number | null): void {
    this.pendingCursorT = cursorT;
    if (this.liveValuesScheduled) return;
    this.liveValuesScheduled = true;
    requestAnimationFrame(() => {
      this.liveValuesScheduled = false;
      const values = new Map<string, string>();
      if (this.pendingCursorT !== null) {
        for (const [panelId] of this.tilesByPanel) {
          const tiles = this.tilesByPanel.get(panelId);
          for (const tile of tiles?.series ?? []) {
            if (!values.has(tile.signal_path)) {
              values.set(
                tile.signal_path,
                formatValue(valueAtTime(tile.bins, this.pendingCursorT)),
              );
            }
          }
        }
      }
      this.tree?.setLiveValues(values);
    });
  }
```

with fields `private liveValuesScheduled = false; private pendingCursorT: number | null = null;` and module-level helpers:

```ts
function tooltipHeader(text: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "plot-tip-header";
  header.textContent = text;
  return header;
}

function tooltipRow(color: string, name: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "plot-tip-row";
  const swatch = document.createElement("span");
  swatch.className = "plot-tip-swatch";
  swatch.style.background = color;
  const label = document.createElement("span");
  label.className = "signal-path";
  label.textContent = name;
  const reading = document.createElement("span");
  reading.className = "plot-tip-value";
  reading.textContent = value;
  row.append(swatch, label, reading);
  return row;
}
```

- CSS: `.plot-tip` fixed at top-left with `transform` positioning, `background: var(--surface-2)`, `border: 1px solid var(--border)`, `border-radius: 2px`, `padding: 5px 8px`, `font: 10.5px var(--font-mono)`, `font-variant-numeric: tabular-nums`, `pointer-events: none`, `z-index` above panels; `.plot-tip-header { color: var(--fg-2); margin-bottom: 3px; }`; `.plot-tip-row { display: flex; gap: 6px; align-items: center; }`; `.plot-tip-swatch { width: 9px; height: 2px; }`; `.plot-tip-value { margin-left: auto; color: var(--fg-1); }`.

- [ ] **Step 8: Write the e2e test**

Create `frontend/tests/e2e/interactions.spec.ts`:

```ts
import { expect, test } from "./fixtures";

test.describe("desktop plot interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("hovering a plot shows the amber cursor readouts everywhere", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const overlay = page.locator(".overlay-canvas").first();
    await overlay.hover({ position: { x: 300, y: 120 } });
    await expect(page.locator(".cursor-readout")).toContainText("t = ");
    await expect(page.locator(".cursor-readout")).not.toContainText("t = —");
    await expect(page.locator(".plot-tip")).toBeVisible();
    await expect(page.locator(".plot-tip-row")).toHaveCount(2);
    // live values appear in the signal tree
    await expect(
      page.locator(".tree-leaf .signal-value").first(),
    ).not.toHaveText("—");
    // leaving the plot clears everything
    await page.locator(".tool-bar").hover();
    await expect(page.locator(".cursor-readout")).toHaveText("t = —");
    await expect(page.locator(".plot-tip")).toBeHidden();
  });
});
```

- [ ] **Step 9: Run the gates**

Run: `./scripts/test.sh frontend` then `./scripts/test.sh e2e`
Expected: PASS (existing e2e specs must stay green — the overlay sits above the plot canvas, so any old test clicking `.plot-canvas` may need its locator switched to `.overlay-canvas`; check `workbench.spec.ts`/`app.spec.ts` for such clicks).

- [ ] **Step 10: Commit**

```bash
git add frontend/src/render/overlay-renderer.ts frontend/src/render/overlay-renderer.test.ts \
  frontend/src/render/test-canvas.ts frontend/src/render/canvas-renderer.test.ts \
  frontend/src/app/linked-time.ts frontend/src/app/linked-time.test.ts \
  frontend/src/ui/panel.ts frontend/src/ui/workspace-view.ts frontend/src/ui/app-shell.ts \
  frontend/src/ui/signal-tree.ts frontend/src/styles/app.css \
  frontend/tests/e2e/interactions.spec.ts
git commit -m "feat(ui): overlay canvas with linked amber cursor, tooltip and live values"
```

---

## Task 5: Wheel zoom, drag pan, per-panel windows, debounced refetch

Wheel zooms time about the pointer; ⇧/alt+wheel zooms y; right-/middle-/ctrl-left-drag pans both axes against the pointer-down snapshot. Linked time panels route through the global window (every panel follows); unlinked panels keep their own `time_window`. Every gesture re-renders immediately from cached tiles and refetches density-bounded tiles behind a 150 ms debounce.

**Files:**

- Modify: `frontend/src/ui/panel.ts` (wheel + pan handlers, `onTimeWindow`/`onYRange` callbacks)
- Modify: `frontend/src/ui/app-shell.ts` (window routing, debounce, unlink copy, per-panel windows, palette commands)
- Modify: `frontend/src/ui/workspace-view.ts` (`renderTiles` takes `windowFor`)
- Modify: `frontend/src/app/workspace.test.ts` only if needed; new logic is view/controller side
- Modify: `frontend/tests/e2e/interactions.spec.ts`

**Interfaces:**

- Consumes: Task 2 (`time_window`, `setPanelTimeWindow`), Task 3 (math), Task 4 (overlay/caches).
- Produces:
  - `PanelCallbacks.onTimeWindow(id: string, t0: number, t1: number): void`
  - `PanelCallbacks.onYRange(id: string, range: readonly [number, number]): void`
  - `WorkspaceView.renderTiles(tilesByPanel, windowFor: (panelId: string) => { t0: number; t1: number }): number`
  - `AppShell.applyTimeWindow(panelId, t0, t1)`, `AppShell.effectiveWindow(panel): { t0; t1 }`, `AppShell.scheduleRefresh(delay?)` (private; Tasks 6–7 reuse them)
  - `PanelView.dragging: boolean` (private guard Task 4's cursor handler checks — add the check there now: `if (this.dragging) return;` at the top of the pointermove cursor handler).

- [ ] **Step 1: Bind wheel and pan in `PanelView`**

In `bind()` (panel.ts), after the cursor handlers:

```ts
this.overlay.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});
this.overlay.addEventListener(
  "wheel",
  (event) => {
    const layout = this.renderer.lastLayout();
    if (layout === null || this.lastState?.mode !== "time") return;
    event.preventDefault();
    const factor = wheelZoomFactor(event.deltaY);
    if (event.shiftKey || event.altKey) {
      const pivot = invertY(
        layout,
        clamp(event.offsetY, layout.plot.y, layout.plot.y + layout.plot.height),
      );
      const next = zoomRange(layout.yRange, factor, pivot);
      this.callbacks.onYRange(this.id, [next.min, next.max]);
    } else {
      const pivot = invertX(
        layout,
        clamp(event.offsetX, layout.plot.x, layout.plot.x + layout.plot.width),
      );
      const next = zoomRange(layout.xRange, factor, pivot);
      this.callbacks.onTimeWindow(this.id, next.min, next.max);
    }
  },
  { passive: false },
);
this.overlay.addEventListener("pointerdown", (event) => {
  const layout = this.renderer.lastLayout();
  if (layout === null || this.lastState?.mode !== "time") return;
  const isPan =
    event.button === 1 ||
    event.button === 2 ||
    (event.button === 0 && (event.ctrlKey || event.metaKey));
  if (!isPan) return; // Task 7 adds the left-button box/click machine
  event.preventDefault();
  this.beginPan(event, layout);
});
```

and the private drag scaffold:

```ts
  private dragging = false;

  private beginPan(down: PointerEvent, layout: PlotLayout): void {
    this.dragging = true;
    this.overlay.setPointerCapture(down.pointerId);
    const startX = { ...layout.xRange };
    const startY = { ...layout.yRange };
    const move = (event: PointerEvent): void => {
      const dt = ((down.offsetX - event.offsetX) / layout.plot.width) * (startX.max - startX.min);
      const dv = ((event.offsetY - down.offsetY) / layout.plot.height) * (startY.max - startY.min);
      this.callbacks.onTimeWindow(this.id, startX.min + dt, startX.max + dt);
      this.callbacks.onYRange(this.id, [startY.min + dv, startY.max + dv]);
    };
    const finish = (): void => {
      this.overlay.removeEventListener("pointermove", move);
      this.overlay.removeEventListener("pointerup", finish);
      this.overlay.removeEventListener("pointercancel", finish);
      this.dragging = false;
    };
    this.overlay.addEventListener("pointermove", move);
    this.overlay.addEventListener("pointerup", finish);
    this.overlay.addEventListener("pointercancel", finish);
  }
```

Also add `if (this.dragging) return;` as the first line of Task 4's cursor `pointermove` handler.

- [ ] **Step 2: Route windows in `AppShell`**

- Fields: `private refreshTimer: number | null = null;`
- Callbacks passed to `WorkspaceView` gain:

```ts
        onTimeWindow: (id, t0, t1) => {
          this.applyTimeWindow(id, t0, t1);
        },
        onYRange: (id, range) => {
          this.workspace.setPanelYRange(id, [range[0], range[1]]);
          this.scheduleRender();
        },
```

- New private methods:

```ts
  private applyTimeWindow(panelId: string, t0: number, t1: number): void {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return;
    const panel = this.workspace.panel(panelId);
    if (panel === undefined) return;
    if (this.time.snapshot().linked && panel.mode === "time") {
      this.time.setWindow(t0, t1);
      this.renderWindowReadout();
    } else {
      this.workspace.setPanelTimeWindow(panelId, [t0, t1]);
    }
    this.renderTiles();
    this.scheduleRefresh();
  }

  /** Trailing-edge debounce for density refetches during gestures. */
  private scheduleRefresh(delay = 150): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshTiles();
    }, delay);
  }

  private effectiveWindow(panel: { mode: string; time_window: readonly [number, number] | null }): {
    t0: number;
    t1: number;
  } {
    const state = this.time.snapshot();
    if (state.linked && panel.mode === "time") return { t0: state.t0, t1: state.t1 };
    const local = panel.time_window;
    return local === null ? { t0: state.t0, t1: state.t1 } : { t0: local[0], t1: local[1] };
  }
```

(Type the parameter as `PanelState` — imported from `../generated/session` — rather than the structural type if the import is already present.)

- `refreshTiles()`: replace the single `state`-window request with `const window = this.effectiveWindow(panel);` inside the per-panel map and pass `window` in the `queryTiles` call.
- `renderTiles()`: pass a lookup instead of one window:

```ts
  private renderTiles(): void {
    const elapsed =
      this.workspaceView?.renderTiles(this.tilesByPanel, (panelId) => {
        const panel = this.workspace.panel(panelId);
        const state = this.time.snapshot();
        return panel === undefined
          ? { t0: state.t0, t1: state.t1 }
          : this.effectiveWindow(panel);
      }) ?? 0;
    required(this.root, ".render-ms").textContent = `${elapsed.toFixed(1)} ms`;
  }
```

- `workspace-view.ts` — change `renderTiles` to accept `windowFor: (panelId: string) => { t0: number; t1: number }` and call `view.renderTiles(panel, tiles, windowFor(panel.id))`.
- `toggleLinked()` — when unlinking, freeze each time panel at the current global window so nothing jumps:

```ts
  private toggleLinked(): void {
    const state = this.time.snapshot();
    const linked = !state.linked;
    if (!linked) {
      for (const panel of this.workspace.panels()) {
        if (panel.mode === "time") {
          this.workspace.setPanelTimeWindow(panel.id, [state.t0, state.t1]);
        }
      }
    }
    this.time.setLinked(linked);
    required(this.root, ".linked-toggle").classList.toggle("active", linked);
    void this.refreshTiles();
  }
```

- [ ] **Step 3: Register the keyboard-path commands**

In `registerCommands()` (palette-only, no key bindings — `t`/`s`/`l` etc. are taken):

```ts
const zoomFocusedPanel = (factor: number): void => {
  const id = this.workspace.focusedPanelId();
  const panel = id === null ? undefined : this.workspace.panel(id);
  if (id === null || panel === undefined) return;
  const window = this.effectiveWindow(panel);
  const pivot = (window.t0 + window.t1) / 2;
  const next = zoomRange({ min: window.t0, max: window.t1 }, factor, pivot);
  this.applyTimeWindow(id, next.min, next.max);
};
const panFocusedPanel = (direction: -1 | 1): void => {
  const id = this.workspace.focusedPanelId();
  const panel = id === null ? undefined : this.workspace.panel(id);
  if (id === null || panel === undefined) return;
  const window = this.effectiveWindow(panel);
  const delta = (window.t1 - window.t0) * 0.1 * direction;
  this.applyTimeWindow(id, window.t0 + delta, window.t1 + delta);
};
this.registerFocusedPanelCommand(
  "zoom-in-time",
  "Panel: zoom in (time)",
  () => {
    zoomFocusedPanel(0.8);
  },
);
this.registerFocusedPanelCommand(
  "zoom-out-time",
  "Panel: zoom out (time)",
  () => {
    zoomFocusedPanel(1.25);
  },
);
this.registerFocusedPanelCommand("pan-left", "Panel: pan left", () => {
  panFocusedPanel(-1);
});
this.registerFocusedPanelCommand("pan-right", "Panel: pan right", () => {
  panFocusedPanel(1);
});
```

Note `registerFocusedPanelCommand` already calls `afterLayoutChange()` after acting — that refetch is harmless here (the debounce collapses it).

- [ ] **Step 4: Extend the e2e spec**

Append to `interactions.spec.ts`:

```ts
test("wheel zooms the linked window and every panel follows", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const readout = page.locator(".window-readout");
  const before = await readout.textContent();
  const overlay = page.locator(".overlay-canvas").first();
  await overlay.hover({ position: { x: 300, y: 120 } });
  await page.mouse.wheel(0, -240);
  await expect(readout).not.toHaveText(before ?? "");
});

test("right-drag pans without opening a context menu", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const readout = page.locator(".window-readout");
  const before = await readout.textContent();
  const overlay = page.locator(".overlay-canvas").first();
  const box = await overlay.boundingBox();
  if (box === null) throw new Error("overlay not laid out");
  await page.mouse.move(box.x + 300, box.y + 120);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + 380, box.y + 120, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await expect(readout).not.toHaveText(before ?? "");
});

test("shift+wheel rescales y locally, not the time window", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const readout = page.locator(".window-readout");
  const before = await readout.textContent();
  const overlay = page.locator(".overlay-canvas").first();
  await overlay.hover({ position: { x: 300, y: 120 } });
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Shift");
  await expect(readout).toHaveText(before ?? "");
});
```

- [ ] **Step 5: Run the gates**

Run: `./scripts/test.sh frontend` then `./scripts/test.sh e2e`
Expected: PASS. Manual sanity (optional but recommended): `./scripts/run.sh web`, confirm wheel zoom is anchored under the pointer, both demo panels track each other while linked, unlink (`l`) then wheel affects only the hovered panel, and the readout shows the global window only.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts \
  frontend/src/ui/workspace-view.ts frontend/tests/e2e/interactions.spec.ts
git commit -m "feat(ui): wheel zoom, drag pan and per-panel time windows"
```

---

## Task 6: Datatips — pin/remove clicks, markers, per-panel list, delta readout

Click near a line pins a numbered annotation snapped to the nearest rendered vertex; clicking an existing marker (9 px) removes it. Markers are hollow rings in the series colour; a per-panel list below the plot shows `① t … · v … "label"` rows with edit/delete affordances; the last two pins get a gray dashed connector and an amber `Δt · Δv · slope` box. Annotations already serialize (`PanelState.annotations`).

**Files:**

- Create: `frontend/src/app/plot-hit.ts`
- Create: `frontend/src/app/plot-hit.test.ts`
- Modify: `frontend/src/app/workspace.ts` + `workspace.test.ts` (annotation ops)
- Modify: `frontend/src/ui/panel.ts` (click gesture, list DOM, overlay wiring)
- Modify: `frontend/src/ui/app-shell.ts` (callbacks, clear command)
- Modify: `frontend/src/styles/app.css` (annotations list)
- Modify: `frontend/tests/e2e/interactions.spec.ts`

**Interfaces:**

- Consumes: Tasks 3–5 (`PlotLayout`, caches, overlay, `dragging`).
- Produces:
  - `plot-hit.ts`:

```ts
export interface HitSeries {
  path: string;
  bins: readonly EnvelopeBin[];
}
export interface VertexHit {
  path: string;
  time: number;
  value: number;
  distance: number;
}
export function nearestVertex(
  series: readonly HitSeries[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): VertexHit | null;
export function nearestAnnotation(
  annotations: readonly Annotation[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): string | null; // annotation id
```

- Model ops: `addAnnotation(panelId: string, annotation: Annotation): void`, `removeAnnotation(panelId: string, annotationId: string): void`, `setAnnotationLabel(panelId: string, annotationId: string, label: string): void` (and `removeSeries` in Task 11 prunes by `series_path`).
- `PanelCallbacks`: `onPinAnnotation(id: string, hit: VertexHit): void`, `onRemoveAnnotation(id: string, annotationId: string): void`, `onEditAnnotationLabel(id: string, annotationId: string, label: string): void`
- `PanelView.plotClick(offsetX: number, offsetY: number): void` — Task 7's state machine calls this for non-promoted left clicks.
- Thresholds: remove 9 px, pin 14 px — the asymmetry makes an accidental double-click pin self-cancel before the fit runs (Task 7 depends on this).

- [ ] **Step 1: Write the failing hit-test tests**

`frontend/src/app/plot-hit.test.ts`:

```ts
import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import type { Annotation } from "../generated/session";
import type { PlotLayout } from "./plot-math";
import { nearestAnnotation, nearestVertex } from "./plot-hit";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: 0, max: 10 },
  yRange: { min: 0, max: 10 },
};

function bin(t0: number, t1: number, first: number, last: number): EnvelopeBin {
  return {
    t0,
    t1,
    first,
    last,
    min: Math.min(first, last),
    max: Math.max(first, last),
    sum: 0,
    sum_sq: 0,
    finite_count: "2",
    sample_count: "2",
    has_gap: false,
  };
}

test("nearestVertex snaps to the closest rendered endpoint within threshold", () => {
  const series = [{ path: "a/b", bins: [bin(0, 1, 5, 6), bin(1, 2, 6, 2)] }];
  // vertex (t1=2, last=2) sits at px (20, 80)
  const hit = nearestVertex(series, layout, 22, 78, 14);
  expect(hit?.path).toBe("a/b");
  expect(hit?.time).toBe(2);
  expect(hit?.value).toBe(2);
  expect(nearestVertex(series, layout, 60, 60, 14)).toBeNull();
});

test("nearestVertex prefers the globally closest series", () => {
  const series = [
    { path: "far", bins: [bin(0, 4, 9, 9)] },
    { path: "near", bins: [bin(0, 4, 5, 5)] },
  ];
  expect(nearestVertex(series, layout, 40, 52, 14)?.path).toBe("near");
});

test("nearestAnnotation returns the id within its tighter radius", () => {
  const annotations: Annotation[] = [
    { id: "ann-1", series_path: "a/b", time: 5, value: 5, label: "" },
  ];
  expect(nearestAnnotation(annotations, layout, 52, 52, 9)).toBe("ann-1");
  expect(nearestAnnotation(annotations, layout, 65, 52, 9)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/dev.sh pnpm --dir frontend exec vitest run src/app/plot-hit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `plot-hit.ts`**

```ts
import type { EnvelopeBin } from "../generated/protocol";
import type { Annotation } from "../generated/session";
import { projectX, projectY, type PlotLayout } from "./plot-math";

export interface HitSeries {
  path: string;
  bins: readonly EnvelopeBin[];
}

export interface VertexHit {
  path: string;
  time: number;
  value: number;
  distance: number;
}

/**
 * The rendered vertex ((t0, first) or (t1, last) of a bin) nearest to the
 * pointer, across all series. At level 0 these are true samples; when
 * zoomed out they are the envelope representatives actually drawn.
 */
export function nearestVertex(
  series: readonly HitSeries[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): VertexHit | null {
  let best: VertexHit | null = null;
  for (const entry of series) {
    for (const bin of entry.bins) {
      for (const [time, value] of [
        [bin.t0, bin.first],
        [bin.t1, bin.last],
      ] as const) {
        if (value === null) continue;
        const distance = Math.hypot(
          projectX(layout, time) - px,
          projectY(layout, value) - py,
        );
        if (
          distance <= threshold &&
          (best === null || distance < best.distance)
        ) {
          best = { path: entry.path, time, value, distance };
        }
      }
    }
  }
  return best;
}

export function nearestAnnotation(
  annotations: readonly Annotation[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): string | null {
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const annotation of annotations) {
    const distance = Math.hypot(
      projectX(layout, annotation.time) - px,
      projectY(layout, annotation.value) - py,
    );
    if (distance <= threshold && distance < bestDistance) {
      bestId = annotation.id;
      bestDistance = distance;
    }
  }
  return bestId;
}
```

Run the test again — PASS.

- [ ] **Step 4: Model annotation ops (failing test, then implement)**

`workspace.test.ts`:

```ts
test("annotation ops add, relabel and remove", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanelRow();
  model.addAnnotation(panel.id, {
    id: "ann-1",
    series_path: "a/b",
    time: 2,
    value: 5,
    label: "",
  });
  model.setAnnotationLabel(panel.id, "ann-1", "peak");
  expect(model.panel(panel.id)?.annotations).toEqual([
    { id: "ann-1", series_path: "a/b", time: 2, value: 5, label: "peak" },
  ]);
  model.removeAnnotation(panel.id, "ann-1");
  expect(model.panel(panel.id)?.annotations).toEqual([]);
});
```

Run (FAIL), then implement in `workspace.ts`:

```ts
  addAnnotation(panelId: string, annotation: Annotation): void {
    this.panel(panelId)?.annotations.push({ ...annotation });
  }

  removeAnnotation(panelId: string, annotationId: string): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.annotations = panel.annotations.filter(
      (annotation) => annotation.id !== annotationId,
    );
  }

  setAnnotationLabel(panelId: string, annotationId: string, label: string): void {
    const annotation = this.panel(panelId)?.annotations.find(
      (entry) => entry.id === annotationId,
    );
    if (annotation !== undefined) annotation.label = label;
  }
```

(import `Annotation` from `../generated/session`). Run — PASS.

- [ ] **Step 5: Wire the click gesture and overlay state in `PanelView`**

- Extend `PanelCallbacks` with the three methods from the interface block.
- Public click entry (Task 7 re-routes to it) plus a plain handler for now:

```ts
  /** Left-click routing: remove a nearby datatip, else pin a new one. */
  plotClick(offsetX: number, offsetY: number): void {
    const layout = this.renderer.lastLayout();
    const state = this.lastState;
    const tiles = this.lastTiles;
    if (layout === null || state === null || state.mode !== "time") return;
    const existing = nearestAnnotation(state.annotations, layout, offsetX, offsetY, 9);
    if (existing !== null) {
      this.callbacks.onRemoveAnnotation(this.id, existing);
      return;
    }
    if (tiles === null) return;
    const visible = new Set(
      state.series.filter((series) => series.visible).map((series) => series.path),
    );
    const hit = nearestVertex(
      tiles.series
        .filter((tile) => visible.has(tile.signal_path))
        .map((tile) => ({ path: tile.signal_path, bins: tile.bins })),
      layout,
      offsetX,
      offsetY,
      14,
    );
    if (hit !== null) this.callbacks.onPinAnnotation(this.id, hit);
  }
```

In `bind()`, add an interim left-click detector (Task 7 replaces it with the box state machine — it is functional on its own):

```ts
this.overlay.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
  const start = { x: event.offsetX, y: event.offsetY };
  const up = (upEvent: PointerEvent): void => {
    this.overlay.removeEventListener("pointerup", up);
    if (Math.hypot(upEvent.offsetX - start.x, upEvent.offsetY - start.y) <= 4) {
      this.plotClick(upEvent.offsetX, upEvent.offsetY);
    }
  };
  this.overlay.addEventListener("pointerup", up);
});
```

- `drawOverlay()` now feeds real annotations:

```ts
  private drawOverlay(): void {
    const state = this.lastState;
    const annotations = state?.mode === "time" ? state.annotations : [];
    const bySeries = new Map(
      (state?.series ?? []).map((series) => [series.path, series]),
    );
    this.overlayRenderer.draw(this.renderer.lastLayout(), {
      cursorT: state?.mode === "time" ? this.cursorT : null,
      box: this.box,
      annotations,
      annotationColorIndices: annotations.map((annotation) => {
        const series = bySeries.get(annotation.series_path);
        return resolveSeriesStyle(series?.color_slot ?? 1, series?.dash ?? "solid")
          .colorIndex;
      }),
      showDelta: annotations.length >= 2,
    });
  }
```

(The overlay contract takes palette **indices** — Task 4 fixed that shape; `resolveSeriesStyle(...).colorIndex` is already 0-based.)

- `update(state, maximized)`: call `this.renderAnnotationList(state);` and after any state change also `this.drawOverlay()` (annotations may have changed without a tile refetch).
- The list DOM — add to `panelMarkup()` after `.plot-wrap`:

```html
<div class="panel-annotations" hidden></div>
```

and:

```ts
  private renderAnnotationList(state: PanelState): void {
    const list = required<HTMLElement>(this.element, ".panel-annotations");
    const annotations = state.mode === "time" ? state.annotations : [];
    list.hidden = annotations.length === 0;
    if (annotations.length === 0) {
      list.replaceChildren();
      return;
    }
    const heading = document.createElement("div");
    heading.className = "annotations-heading";
    heading.textContent = `ANNOTATIONS — ${state.title.toUpperCase()}`;
    const rows = annotations.map((annotation, index) => {
      const row = document.createElement("div");
      row.className = "annotation-row";
      const text = document.createElement("span");
      text.className = "annotation-text";
      text.textContent =
        `${index < 20 ? String.fromCodePoint(0x2460 + index) : `(${String(index + 1)})`}` +
        ` t ${annotation.time.toFixed(3)} · v ${formatValue(annotation.value)}` +
        (annotation.label === "" ? "" : ` "${annotation.label}"`);
      const edit = document.createElement("button");
      edit.className = "annotation-action";
      edit.textContent = "✎";
      edit.title = "Edit label";
      edit.addEventListener("click", () => {
        this.openAnnotationLabelEditor(row, annotation.id, annotation.label);
      });
      const remove = document.createElement("button");
      remove.className = "annotation-action";
      remove.textContent = "✕";
      remove.title = "Delete annotation";
      remove.addEventListener("click", () => {
        this.callbacks.onRemoveAnnotation(this.id, annotation.id);
      });
      row.append(text, edit, remove);
      return row;
    });
    list.replaceChildren(heading, ...rows);
  }

  private openAnnotationLabelEditor(row: HTMLElement, annotationId: string, current: string): void {
    const input = document.createElement("input");
    input.className = "annotation-label-input";
    input.value = current;
    input.setAttribute("aria-label", "Annotation label");
    const commit = (): void => {
      this.callbacks.onEditAnnotationLabel(this.id, annotationId, input.value.trim());
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        input.value = current;
        input.blur();
      }
      event.stopPropagation();
    });
    input.addEventListener("blur", commit);
    row.append(input);
    input.focus();
    input.select();
  }
```

- [ ] **Step 6: Consume in `AppShell` and add the palette command**

Callbacks:

```ts
        onPinAnnotation: (id, hit) => {
          this.workspace.addAnnotation(id, {
            id: crypto.randomUUID(),
            series_path: hit.path,
            time: hit.time,
            value: hit.value,
            label: "",
          });
          this.workspaceView?.refreshPanelStates();
        },
        onRemoveAnnotation: (id, annotationId) => {
          this.workspace.removeAnnotation(id, annotationId);
          this.workspaceView?.refreshPanelStates();
        },
        onEditAnnotationLabel: (id, annotationId, label) => {
          this.workspace.setAnnotationLabel(id, annotationId, label);
          this.workspaceView?.refreshPanelStates();
        },
```

Command (keyboard path for bulk removal; individual ✕ buttons are keyboard-reachable already):

```ts
this.registerFocusedPanelCommand(
  "clear-annotations",
  "Panel: clear annotations",
  (id) => {
    const panel = this.workspace.panel(id);
    for (const annotation of [...(panel?.annotations ?? [])]) {
      this.workspace.removeAnnotation(id, annotation.id);
    }
  },
);
```

CSS: `.panel-annotations { border-top: 1px solid var(--border); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; padding: 6px 10px; color: var(--fg-2); }`, `.annotations-heading { font-size: 9px; color: var(--fg-4); letter-spacing: .08em; margin-bottom: 3px; }`, `.annotation-row { display: flex; gap: 6px; align-items: center; }`, `.annotation-action { margin-left: auto; color: var(--fg-4); background: none; border: none; cursor: pointer; } .annotation-action + .annotation-action { margin-left: 0; }`, `.annotation-label-input { font: inherit; background: var(--surface-2); color: var(--fg-1); border: 1px solid var(--border-strong); border-radius: 2px; }`.

- [ ] **Step 7: Extend the e2e spec**

```ts
test("clicking near the line pins a datatip; two pins show an amber delta; clicking a pin removes it", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const overlay = page.locator(".overlay-canvas").first();
  const box = await overlay.boundingBox();
  if (box === null) throw new Error("overlay not laid out");
  const rows = page.locator(".panel").first().locator(".annotation-row");

  const clickNearSeries = async (x: number): Promise<void> => {
    const before = await rows.count();
    for (let y = 20; y < box.height - 40; y += 8) {
      await overlay.click({ position: { x, y } });
      if ((await rows.count()) > before) return;
    }
    throw new Error("no series vertex found in the sampled column");
  };

  await clickNearSeries(180);
  await expect(rows).toHaveCount(1);
  await clickNearSeries(420);
  await expect(rows).toHaveCount(2);
  await expect(
    page.locator(".panel").first().locator(".annotations-heading"),
  ).toBeVisible();
});
```

(The column sweep is deterministic: clicks in empty space are no-ops, and the demo series crosses every sampled column.)

- [ ] **Step 8: Run the gates**

Run: `./scripts/test.sh frontend` then `./scripts/test.sh e2e`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/app/plot-hit.ts frontend/src/app/plot-hit.test.ts \
  frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts \
  frontend/src/render/overlay-renderer.ts frontend/src/render/overlay-renderer.test.ts \
  frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts frontend/src/styles/app.css \
  frontend/tests/e2e/interactions.spec.ts
git commit -m "feat(ui): pinned datatips with per-panel list and amber delta readout"
```

---

## Task 7: Box zoom and double-click fit

Left-drag rubber-bands an amber box; on release (both edges > 6 px) the panel zooms to it — time via the linked router, y via the serialized range. A left press that never moves more than 4 px stays a click and routes to Task 6's `plotClick` on pointerup (so the 9 px-remove / 14 px-pin double-click self-cancel is preserved). Double-click inside the plot fits: clears the y override, re-fits the y latch, and — when linked — refits the global window to the panel's data extent (every panel follows, prototype semantics).

**Files:**

- Modify: `frontend/src/ui/panel.ts` (left-button state machine replaces Task 6's interim click detector; dblclick)
- Modify: `frontend/src/ui/app-shell.ts` (`onFitView`, fit command)
- Modify: `frontend/tests/e2e/interactions.spec.ts`

**Interfaces:**

- Consumes: Tasks 3–6 (`zoomRange` not needed here; `invertX/invertY`, overlay `box`, `plotClick`, `applyTimeWindow` router, `onTimeWindow`/`onYRange`).
- Produces: `PanelCallbacks.onFitView(id: string): void`; `PanelView.resetYAxis(): void` (clears the `YAxisPolicy` latch so fit recomputes it).

- [ ] **Step 1: Replace the interim click detector with the box state machine**

In `panel.ts` `bind()`, delete Task 6's interim left-button `pointerdown` listener and extend Task 5's `pointerdown` handler:

```ts
this.overlay.addEventListener("pointerdown", (event) => {
  const layout = this.renderer.lastLayout();
  if (layout === null || this.lastState?.mode !== "time") return;
  const isPan =
    event.button === 1 ||
    event.button === 2 ||
    (event.button === 0 && (event.ctrlKey || event.metaKey));
  if (isPan) {
    event.preventDefault();
    this.beginPan(event, layout);
    return;
  }
  if (event.button === 0) this.beginBoxOrClick(event, layout);
});
```

with:

```ts
  private beginBoxOrClick(down: PointerEvent, layout: PlotLayout): void {
    const start = { x: down.offsetX, y: down.offsetY };
    let promoted = false;
    const clampX = (value: number): number =>
      clamp(value, layout.plot.x, layout.plot.x + layout.plot.width);
    const clampY = (value: number): number =>
      clamp(value, layout.plot.y, layout.plot.y + layout.plot.height);
    const move = (event: PointerEvent): void => {
      if (!promoted && Math.hypot(event.offsetX - start.x, event.offsetY - start.y) <= 4) {
        return;
      }
      if (!promoted) {
        promoted = true;
        this.dragging = true;
        this.overlay.setPointerCapture(down.pointerId);
      }
      this.box = {
        x0: clampX(start.x),
        y0: clampY(start.y),
        x1: clampX(event.offsetX),
        y1: clampY(event.offsetY),
      };
      this.drawOverlay();
    };
    const finish = (event: PointerEvent): void => {
      this.overlay.removeEventListener("pointermove", move);
      this.overlay.removeEventListener("pointerup", finish);
      this.overlay.removeEventListener("pointercancel", cancel);
      this.dragging = false;
      const box = this.box;
      this.box = null;
      this.drawOverlay();
      if (!promoted) {
        this.plotClick(event.offsetX, event.offsetY);
        return;
      }
      if (box === null || Math.abs(box.x1 - box.x0) <= 6 || Math.abs(box.y1 - box.y0) <= 6) {
        return; // too small: discard, and it is not a click either
      }
      const t0 = invertX(layout, Math.min(box.x0, box.x1));
      const t1 = invertX(layout, Math.max(box.x0, box.x1));
      const yLow = invertY(layout, Math.max(box.y0, box.y1));
      const yHigh = invertY(layout, Math.min(box.y0, box.y1));
      this.callbacks.onYRange(this.id, [yLow, yHigh]);
      this.callbacks.onTimeWindow(this.id, t0, t1);
    };
    const cancel = (): void => {
      this.overlay.removeEventListener("pointermove", move);
      this.overlay.removeEventListener("pointerup", finish);
      this.overlay.removeEventListener("pointercancel", cancel);
      this.dragging = false;
      this.box = null;
      this.drawOverlay();
    };
    this.overlay.addEventListener("pointermove", move);
    this.overlay.addEventListener("pointerup", finish);
    this.overlay.addEventListener("pointercancel", cancel);
  }
```

- [ ] **Step 2: Double-click fit and the y-latch reset**

In `panel.ts`:

```ts
  /** Clears the sticky autoscale latch so the next render re-fits y. */
  resetYAxis(): void {
    this.yAxis.reset();
  }
```

and in `bind()`:

```ts
this.overlay.addEventListener("dblclick", (event) => {
  const layout = this.renderer.lastLayout();
  if (layout === null || this.lastState?.mode !== "time") return;
  if (insidePlot(layout, event.offsetX, event.offsetY)) {
    this.callbacks.onFitView(this.id);
  }
  // Task 10 extends this handler with the axis-label edit zones.
});
```

In `app-shell.ts` callbacks + command:

```ts
        onFitView: (id) => {
          this.fitPanelView(id);
        },
```

```ts
  /** Double-click fit: full data extent for the panel, autoscaled y. */
  private fitPanelView(panelId: string): void {
    const panel = this.workspace.panel(panelId);
    if (panel === undefined) return;
    this.workspace.clearPanelYRange(panelId);
    this.workspaceView?.resetYAxis(panelId);
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = Number.NEGATIVE_INFINITY;
    for (const series of panel.series) {
      const summary = this.signalsByPath.get(series.path);
      if (summary !== undefined) {
        t0 = Math.min(t0, summary.t_min);
        t1 = Math.max(t1, summary.t_max);
      }
    }
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      this.applyTimeWindow(panelId, t0, t1 > t0 ? t1 : t0 + 1);
    } else {
      this.renderTiles();
      this.scheduleRefresh();
    }
  }
```

```ts
this.registerFocusedPanelCommand("fit-panel-view", "Panel: fit view", (id) => {
  this.fitPanelView(id);
});
```

`workspace-view.ts` gains the pass-through:

```ts
  resetYAxis(id: string): void {
    this.views.get(id)?.resetYAxis();
  }
```

- [ ] **Step 3: Extend the e2e spec**

```ts
test("box zoom narrows both axes and double-click fit restores the window", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const readout = page.locator(".window-readout");
  const fitted = await readout.textContent();
  const overlay = page.locator(".overlay-canvas").first();
  const box = await overlay.boundingBox();
  if (box === null) throw new Error("overlay not laid out");
  await page.mouse.move(box.x + 150, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect(readout).not.toHaveText(fitted ?? "");
  await overlay.dblclick({ position: { x: 300, y: 120 } });
  await expect(readout).toHaveText(fitted ?? "");
});
```

(The fitted window equals the demo signals' full extent, which is exactly what `mount()` established, so the readout text round-trips.)

- [ ] **Step 4: Run the gates**

Run: `./scripts/test.sh frontend` then `./scripts/test.sh e2e`
Expected: PASS, including Task 6's datatip test (clicks still route through the non-promoted branch).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts \
  frontend/src/ui/workspace-view.ts frontend/tests/e2e/interactions.spec.ts
git commit -m "feat(ui): amber box zoom and double-click fit"
```

---

## Task 8: Visible statistics strip

Per-series `min · max · μ · rms` of the visible region, computed exactly from Task 1's bin sums, in a strip under the plot. Toggled per panel by the `Σ` header button, the `s` key, or the palette; persists via the existing `show_stats` field; updates live on pan/zoom because it recomputes on every render.

**Files:**

- Create: `frontend/src/app/stats.ts`
- Create: `frontend/src/app/stats.test.ts`
- Modify: `frontend/src/app/workspace.ts` + `workspace.test.ts` (`toggleStats`)
- Modify: `frontend/src/ui/panel.ts` (strip DOM, `Σ` button, recompute in `renderTiles`)
- Modify: `frontend/src/ui/app-shell.ts` (`onToggleStats`, `s` command)
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/interactions.spec.ts`

**Interfaces:**

- Consumes: Task 1 (`sum`/`sum_sq`/`finite_count`), Task 4 (caches), Task 5 (per-panel windows already flow into `renderTiles`).
- Produces:

```ts
export interface SeriesStats {
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
}
export function visibleStats(
  bins: readonly EnvelopeBin[],
  t0: number,
  t1: number,
): SeriesStats;
```

`WorkspaceModel.toggleStats(id: string): void`; `PanelCallbacks.onToggleStats(id: string): void`.

- [ ] **Step 1: Write the failing stats tests**

`frontend/src/app/stats.test.ts`:

```ts
import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { visibleStats } from "./stats";

function bin(t0: number, t1: number, values: number[]): EnvelopeBin {
  const finite = values.filter(Number.isFinite);
  return {
    t0,
    t1,
    first: finite[0] ?? null,
    last: finite[finite.length - 1] ?? null,
    min: finite.length === 0 ? null : Math.min(...finite),
    max: finite.length === 0 ? null : Math.max(...finite),
    sum: finite.reduce((total, value) => total + value, 0),
    sum_sq: finite.reduce((total, value) => total + value * value, 0),
    finite_count: String(finite.length),
    sample_count: String(values.length),
    has_gap: finite.length !== values.length,
  };
}

test("visibleStats aggregates only bins overlapping the window", () => {
  const bins = [bin(0, 1, [1, 3]), bin(1, 2, [5, 7]), bin(2, 3, [100, 100])];
  const stats = visibleStats(bins, 0, 1.5);
  expect(stats.min).toBe(1);
  expect(stats.max).toBe(7);
  expect(stats.mean).toBeCloseTo(4, 12); // (1+3+5+7)/4
  expect(stats.rms).toBeCloseTo(Math.sqrt(84 / 4), 12);
});

test("visibleStats ignores non-finite samples and empty windows", () => {
  const stats = visibleStats([bin(0, 1, [2, Number.NaN])], 0, 1);
  expect(stats.mean).toBe(2);
  const empty = visibleStats([bin(0, 1, [2])], 5, 6);
  expect(empty).toEqual({ min: null, max: null, mean: null, rms: null });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/dev.sh pnpm --dir frontend exec vitest run src/app/stats.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `stats.ts`**

```ts
import type { EnvelopeBin } from "../generated/protocol";

export interface SeriesStats {
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
}

/**
 * Exact finite-sample statistics of every bin overlapping [t0, t1] —
 * bin-granular at the window edges, exact at raw zoom (ADR 0014).
 */
export function visibleStats(
  bins: readonly EnvelopeBin[],
  t0: number,
  t1: number,
): SeriesStats {
  let min: number | null = null;
  let max: number | null = null;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (const bin of bins) {
    if (bin.t1 < t0 || bin.t0 > t1) continue;
    if (bin.min !== null) min = min === null ? bin.min : Math.min(min, bin.min);
    if (bin.max !== null) max = max === null ? bin.max : Math.max(max, bin.max);
    sum += bin.sum;
    sumSq += bin.sum_sq;
    count += Number(bin.finite_count);
  }
  return {
    min,
    max,
    mean: count > 0 ? sum / count : null,
    rms: count > 0 ? Math.sqrt(sumSq / count) : null,
  };
}
```

Run — PASS.

- [ ] **Step 4: Model toggle (failing test, implement)**

`workspace.test.ts`:

```ts
test("toggleStats flips the serialized flag", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanelRow();
  expect(model.panel(panel.id)?.show_stats).toBe(false);
  model.toggleStats(panel.id);
  expect(model.panel(panel.id)?.show_stats).toBe(true);
});
```

Implement:

```ts
  toggleStats(id: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) panel.show_stats = !panel.show_stats;
  }
```

- [ ] **Step 5: Strip DOM and the `Σ` button in `PanelView`**

- Markup: add `<div class="panel-stats" hidden></div>` after `.plot-wrap` (before `.panel-annotations`), and a header button before the split group inside `.panel-actions`:
  `<button class="panel-action panel-stats-toggle" title="Toggle statistics (S)" aria-pressed="false">Σ</button>`
- `bind()`:

```ts
required(this.element, ".panel-stats-toggle").addEventListener("click", () => {
  this.callbacks.onToggleStats(this.id);
});
```

- `update()`: reflect state — `required<HTMLButtonElement>(this.element, ".panel-stats-toggle").setAttribute("aria-pressed", String(state.show_stats));` and call `this.renderStats();`
- Recompute at the end of `renderTiles(...)` (after caching) and in `renderStats()`:

```ts
  private renderStats(): void {
    const strip = required<HTMLElement>(this.element, ".panel-stats");
    const state = this.lastState;
    const tiles = this.lastTiles;
    const window = this.lastWindow;
    const show =
      state !== null && state.mode === "time" && state.show_stats &&
      tiles !== null && window !== null;
    strip.hidden = !show;
    if (!show) {
      strip.replaceChildren();
      return;
    }
    const visible = new Set(
      state.series.filter((series) => series.visible).map((series) => series.path),
    );
    const rows = tiles.series
      .filter((tile) => visible.has(tile.signal_path))
      .map((tile) => {
        const stats = visibleStats(tile.bins, window.t0, window.t1);
        const row = document.createElement("span");
        row.className = "stats-series";
        row.append(
          statsName(tile.signal_path.split("/").slice(-2).join("/")),
          statsItem("min", stats.min),
          statsItem("max", stats.max),
          statsItem("μ", stats.mean),
          statsItem("rms", stats.rms),
        );
        return row;
      });
    const hint = document.createElement("span");
    hint.className = "stats-hint";
    hint.textContent = "visible region · S toggles";
    strip.replaceChildren(...rows, hint);
  }
```

with module helpers:

```ts
function statsName(text: string): HTMLElement {
  const name = document.createElement("span");
  name.className = "stats-name";
  name.textContent = text;
  return name;
}

function statsItem(label: string, value: number | null): HTMLElement {
  const item = document.createElement("span");
  item.className = "stats-item";
  const key = document.createElement("span");
  key.textContent = label;
  const reading = document.createElement("b");
  reading.textContent = formatValue(value);
  item.append(key, reading);
  return item;
}
```

CSS: `.panel-stats { display: flex; flex-wrap: wrap; gap: 14px; padding: 3px 10px; border-top: 1px solid var(--border-faint); font: 10px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fg-2); background: var(--surface-0); } .stats-name { color: var(--fg-3); margin-right: 4px; } .stats-item { display: inline-flex; gap: 4px; } .stats-item b { color: var(--fg-1); font-weight: 500; } .stats-hint { margin-left: auto; color: var(--fg-4); }`.

- [ ] **Step 6: Shell command + callback**

```ts
        onToggleStats: (id) => {
          this.workspace.toggleStats(id);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
```

The `s` key must reach it, and `registerFocusedPanelCommand` does not take keys — extend it with an optional `keys` parameter:

```ts
  private registerFocusedPanelCommand(
    id: string,
    title: string,
    act: (panelId: string) => void,
    keys?: string,
  ): void {
    this.commands.register({
      id,
      title,
      ...(keys === undefined ? {} : { keys }),
      enabled: () => this.workspace.focusedPanelId() !== null,
      run: () => {
        const panelId = this.workspace.focusedPanelId();
        if (panelId !== null) {
          act(panelId);
          this.afterLayoutChange();
        }
      },
    });
  }
```

and register:

```ts
this.registerFocusedPanelCommand(
  "toggle-stats",
  "Panel: toggle statistics",
  (id) => {
    this.workspace.toggleStats(id);
  },
  "s",
);
```

(The conditional spread keeps `exactOptionalPropertyTypes` happy.)

- [ ] **Step 7: Extend the e2e spec**

```ts
test("the stats strip shows visible-region values and follows zoom", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const panel = page.locator(".panel").first();
  await panel.locator(".panel-header").click(); // focus routing without plot side effects
  await page.keyboard.press("s");
  const strip = panel.locator(".panel-stats");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("μ");
  await expect(strip).toContainText("visible region · S toggles");
  const before = await strip.textContent();
  const overlay = panel.locator(".overlay-canvas");
  await overlay.hover({ position: { x: 300, y: 120 } });
  await page.mouse.wheel(0, -480);
  await expect(strip).not.toHaveText(before ?? "");
  await page.keyboard.press("s");
  await expect(strip).toBeHidden();
});
```

- [ ] **Step 8: Run the gates**

Run: `./scripts/test.sh frontend` then `./scripts/test.sh e2e`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/app/stats.ts frontend/src/app/stats.test.ts \
  frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts \
  frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts frontend/src/styles/app.css \
  frontend/tests/e2e/interactions.spec.ts
git commit -m "feat(ui): visible-region statistics strip from bin sums"
```

---

## Task 9: Inline axis style and the U+2212 tick minus

Per-panel `axes: gutter | inline` (already serialized as `axis_style`, never read). Inline: no gutters — the plot spans the full body, tick labels ride the gridlines inside on a translucent `surface-0` backing, axis names become corner tags (y top-left, x bottom-right), no spine/tick marks. The header shows an `axes: inline` indicator. Toggled by palette command (spec gap — see decision 6). Tick labels switch to the typographic minus in both styles.

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts` (axisStyle option, inline branch, `formatTicks` minus)
- Modify: `frontend/src/render/canvas-renderer.test.ts`
- Modify: `frontend/src/app/workspace.ts` + `workspace.test.ts` (`toggleAxisStyle`)
- Modify: `frontend/src/ui/panel.ts` (pass `axisStyle`, header indicator)
- Modify: `frontend/src/ui/app-shell.ts` (command)
- Modify: `frontend/src/styles/app.css` (indicator)
- Modify: `frontend/tests/e2e/interactions.spec.ts`

**Interfaces:**

- Consumes: Task 3 layout (inline changes the plot rect, so gestures keep working unmodified — they read `lastLayout()`).
- Produces: `RenderOptions.axisStyle?: AxisStyle` (default `"gutter"`); `WorkspaceModel.toggleAxisStyle(id: string): void`. Task 10's edit zones read `options.axisStyle` via `PanelState.axis_style`.

- [ ] **Step 1: Failing renderer tests**

In `canvas-renderer.test.ts`:

```ts
test("formatTicks renders negatives with U+2212", () => {
  expect(formatTicks([-150, 0, 150])).toEqual(["−150", "0", "150"]);
});

test("inline axis style uses the full body and skips the spine", () => {
  const recording = recordingContext();
  const { canvas } = fakeCanvas(640, 360, recording);
  const renderer = new CanvasRenderer(canvas);
  renderer.setPalette(TEST_PALETTE);
  renderer.render(
    response,
    { min: 0, max: 10 },
    { ...options, axisStyle: "inline" },
  );
  const layout = renderer.lastLayout();
  expect(layout?.plot).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  // no outward tick marks: no stroke in the spine colour
  expect(
    recording.calls.some(
      (call) => call.op === "strokeStyle" && call.value === TEST_PALETTE.fg3,
    ),
  ).toBe(false);
});
```

(The zero-datum line also uses `fg3` — the fixture range in `options` must not straddle zero for this assertion, or assert on the absence of the 4.5px tick-mark segments instead; adapt to the file's fixtures.) Update any existing `formatTicks` expectations from `"-…"` to `"−…"`.

- [ ] **Step 2: Run to verify failure**

Run: `./scripts/dev.sh pnpm --dir frontend exec vitest run src/render/canvas-renderer.test.ts`
Expected: FAIL — hyphen-minus labels; unknown `axisStyle` option.

- [ ] **Step 3: Implement**

In `canvas-renderer.ts`:

- `formatTicks`: wrap both return paths' final map with `.map((label) => label.replace("-", "−"))` (exponent minus stays ASCII: only replace a leading minus — `label.replace(/^-/, "−")`).
- `RenderOptions` gains `axisStyle?: AxisStyle;` (import the type from `../generated/session`).
- In `render(...)`:

```ts
const inline = options.axisStyle === "inline";
const plot: PlotRect = inline
  ? { x: 0, y: 0, width, height }
  : {
      x: gutter,
      y: 8,
      width: Math.max(1, width - gutter - 12),
      height: Math.max(1, height - 42),
    };
```

and dispatch `inline ? this.drawInlineAxes(...) : this.drawAxes(...)`.

- New private `drawInlineAxes(context, plot, project, xRange, yRange, colors, options)`:
  - Grid lines + zero datum exactly as `drawAxes` (same ticks, same colours).
  - No spine, no outward tick marks.
  - Tick labels inside with backing:

```ts
const backed = (
  text: string,
  x: number,
  y: number,
  align: CanvasTextAlign,
): void => {
  context.textAlign = align;
  const width = context.measureText(text).width;
  const left =
    align === "left" ? x : align === "right" ? x - width : x - width / 2;
  context.save();
  context.globalAlpha = 0.8;
  context.fillStyle = colors.background;
  context.fillRect(left - 3, y - 6, width + 6, 12);
  context.restore();
  context.fillText(text, x, y);
};
```

y labels: `backed(label, 4, tickY, "left")` skipping ticks within 14 px of the top/bottom edges; x labels: `backed(label, tickX, plot.height - 8, "center")` skipping the outer 30 px.

- Corner tags in `labelFont`/`fg2`: y name `backed(options.yLabel, 4, 12, "left")`, x name `backed(options.xLabel, plot.width - 4, plot.height - 8, "right")` (no rotation inline).

In `panel.ts`:

- `renderTiles` options gain `axisStyle: state.axis_style,`.
- Header indicator — add `<span class="axis-style-indicator" hidden>axes: inline</span>` to `panelMarkup()` between the legend and `.panel-actions`, and in `update()`:
  `required<HTMLElement>(this.element, ".axis-style-indicator").hidden = state.axis_style !== "inline";`

Model + shell:

```ts
  toggleAxisStyle(id: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) {
      panel.axis_style = panel.axis_style === "gutter" ? "inline" : "gutter";
    }
  }
```

(model test mirroring `toggleStats`), and:

```ts
this.registerFocusedPanelCommand(
  "toggle-axis-style",
  "Panel: toggle axis style (gutter/inline)",
  (id) => {
    this.workspace.toggleAxisStyle(id);
  },
);
```

CSS: `.axis-style-indicator { font-size: 10px; color: var(--fg-4); white-space: nowrap; }`.

- [ ] **Step 4: e2e**

```ts
test("axis style toggles to inline via the command palette", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  await page.locator(".panel").first().click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("axis style");
  await page.keyboard.press("Enter");
  await expect(page.locator(".axis-style-indicator").first()).toBeVisible();
});
```

(Match how the existing `workbench.spec.ts` palette tests open and drive ⌘K — reuse their idiom verbatim.)

- [ ] **Step 5: Gates and commit**

Run: `./scripts/test.sh frontend` then `./scripts/test.sh e2e` — PASS.

```bash
git add frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts \
  frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts \
  frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts frontend/src/styles/app.css \
  frontend/tests/e2e/interactions.spec.ts
git commit -m "feat(render): inline axis style and typographic tick minus"
```

---

## Task 10: Editable panel title and axis names

Double-click the title to edit in place (Enter commits, Escape reverts, blur commits); double-click the y-gutter or x-gutter zone to edit the axis name in a positioned input (same keys). Labels persist in the v4 `x_label`/`y_label` fields and default to the derived values (`time (s)`, unit-based y label) when null.

**Files:**

- Modify: `frontend/src/ui/panel.ts` (title editor, axis editors, dblclick zones, label plumbing)
- Modify: `frontend/src/ui/app-shell.ts` (callbacks)
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/interactions.spec.ts`

**Interfaces:**

- Consumes: Task 2 (`x_label`/`y_label`, `renamePanel`, `setAxisLabel`), Task 7 (the dblclick handler this task extends), Task 9 (`axis_style` for zone geometry).
- Produces: `PanelCallbacks.onRenameTitle(id: string, title: string): void`, `PanelCallbacks.onEditAxisLabel(id: string, axis: "x" | "y", label: string | null): void`.

- [ ] **Step 1: Feed the serialized labels into the renderer**

In `panel.ts` `renderTiles`, replace the hardcoded labels:

```ts
      xLabel: state.x_label ?? "time (s)",
      yLabel: state.y_label ?? yLabel(response.series.map((tile) => tile.unit)),
```

- [ ] **Step 2: Title editing**

In `bind()`:

```ts
const title = required<HTMLElement>(this.element, ".panel-title");
title.addEventListener("dblclick", () => {
  this.beginTitleEdit();
});
```

and:

```ts
  private beginTitleEdit(): void {
    const header = required<HTMLElement>(this.element, ".panel-header");
    const title = required<HTMLElement>(this.element, ".panel-title");
    const previous = title.textContent;
    header.draggable = false;
    try {
      title.contentEditable = "plaintext-only";
    } catch {
      title.contentEditable = "true";
    }
    const finish = (commit: boolean): void => {
      title.removeEventListener("keydown", onKey);
      title.removeEventListener("blur", onBlur);
      title.contentEditable = "false";
      header.draggable = true;
      if (commit) {
        this.callbacks.onRenameTitle(this.id, (title.textContent ?? "").trim());
      } else {
        title.textContent = previous;
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };
    const onBlur = (): void => {
      finish(true);
    };
    title.addEventListener("keydown", onKey);
    title.addEventListener("blur", onBlur);
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
```

Guard against `finish` running twice (blur fires after Enter's blurless removal): removing the listeners before mutating, as above, is sufficient because `finish` detaches `onBlur` first. Note the global keydown handler in `app-shell.ts:363` currently bails only for inputs/textareas — extend its guard with `|| (target instanceof HTMLElement && target.isContentEditable)` so typing `s`/`t`/`l` into a title doesn't run commands.

CSS: `.panel-title[contenteditable]:not([contenteditable="false"]) { background: var(--surface-2); color: var(--fg-1); outline: 1px solid var(--border-strong); border-radius: 2px; padding: 0 3px; }` and `.panel-title:empty::before { content: "untitled"; color: var(--fg-4); }`.

- [ ] **Step 3: Axis-name editing zones and the positioned input**

Extend Task 7's `dblclick` handler:

```ts
this.overlay.addEventListener("dblclick", (event) => {
  const layout = this.renderer.lastLayout();
  const state = this.lastState;
  if (layout === null || state === null || state.mode !== "time") return;
  const zone = axisEditZone(
    layout,
    state.axis_style,
    event.offsetX,
    event.offsetY,
  );
  if (zone !== null) {
    this.beginAxisEdit(zone);
    return;
  }
  if (insidePlot(layout, event.offsetX, event.offsetY)) {
    this.callbacks.onFitView(this.id);
  }
});
```

Module-level, exported for unit tests:

```ts
/** Which axis name a double-click at (px, py) targets, or null. */
export function axisEditZone(
  layout: PlotLayout,
  axisStyle: AxisStyle,
  px: number,
  py: number,
): "x" | "y" | null {
  const { plot } = layout;
  if (axisStyle === "inline") {
    if (px <= plot.x + 90 && py <= plot.y + 18) return "y";
    if (px >= plot.x + plot.width - 90 && py >= plot.y + plot.height - 18)
      return "x";
    return null;
  }
  if (px < plot.x - 20) return "y";
  if (py > plot.y + plot.height + 14) return "x";
  return null;
}
```

and:

```ts
  private beginAxisEdit(axis: "x" | "y"): void {
    const wrap = required<HTMLElement>(this.element, ".plot-wrap");
    if (wrap.querySelector(".axis-label-editor") !== null) return;
    const state = this.lastState;
    const input = document.createElement("input");
    input.className = `axis-label-editor axis-label-editor-${axis}`;
    input.setAttribute("aria-label", axis === "x" ? "X axis name" : "Y axis name");
    input.value = (axis === "x" ? state?.x_label : state?.y_label) ?? "";
    input.placeholder = axis === "x" ? "time (s)" : "value";
    let cancelled = false;
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        cancelled = true;
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      const value = input.value.trim();
      input.remove();
      if (!cancelled) {
        this.callbacks.onEditAxisLabel(this.id, axis, value === "" ? null : value);
      }
    });
    wrap.append(input);
    input.focus();
    input.select();
  }
```

CSS:

```css
.axis-label-editor {
  position: absolute;
  font: 9.5px var(--font-mono);
  background: var(--surface-2);
  color: var(--fg-1);
  border: 1px solid var(--border-strong);
  border-radius: 2px;
  padding: 1px 4px;
  width: 130px;
  z-index: 3;
}
.axis-label-editor-y {
  left: 4px;
  top: 45%;
}
.axis-label-editor-x {
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
}
```

Unit test (`panel.test.ts` is DOM-bound — instead test the exported pure zone function in a new small block inside `plot-math.test.ts`-style file or colocate in `plot-hit.test.ts`): assert gutter-style y/x/null zones and inline corner zones for a fixed layout.

- [ ] **Step 4: Shell callbacks**

```ts
        onRenameTitle: (id, title) => {
          this.workspace.renamePanel(id, title);
          this.afterLayoutChange();
        },
        onEditAxisLabel: (id, axis, label) => {
          this.workspace.setAxisLabel(id, axis, label);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
```

(`afterLayoutChange` for the rename because tab bars and the maximized bar show titles.)

- [ ] **Step 5: e2e**

```ts
test("double-click renames the panel title in place", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const title = page.locator(".panel-title").first();
  await title.dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Body velocity");
  await page.keyboard.press("Enter");
  await expect(title).toHaveText("Body velocity");
  // Escape reverts
  await title.dblclick();
  await page.keyboard.type("scratch");
  await page.keyboard.press("Escape");
  await expect(title).toHaveText("Body velocity");
});

test("double-click in the left gutter edits the y-axis name", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const overlay = page.locator(".overlay-canvas").first();
  await overlay.dblclick({ position: { x: 10, y: 120 } });
  const editor = page.locator(".axis-label-editor");
  await expect(editor).toBeVisible();
  await page.keyboard.type("velocity (m/s)");
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);
});
```

- [ ] **Step 6: Gates and commit**

Run: `./scripts/test.sh frontend` then `./scripts/test.sh e2e` — PASS.

```bash
git add frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts \
  frontend/src/app/plot-hit.test.ts frontend/src/styles/app.css \
  frontend/tests/e2e/interactions.spec.ts
git commit -m "feat(ui): in-place editing for panel titles and axis names"
```

---

## Task 11: Split legend inspector

Each legend chip splits into two targets: the body still toggles visibility; a `▾` caret (or right-click anywhere on the chip — expert shortcut, never the only path) opens the one inspector popover: full path, 8 colour slots, `solid | dash | dot`, a width slider, and remove. Hovering a chip emphasizes that series (others dim to 35%). The renderer starts honouring `SeriesState.width`.

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts` (`widths`, `emphasisIndex`)
- Modify: `frontend/src/render/canvas-renderer.test.ts`
- Modify: `frontend/src/app/workspace.ts` + `workspace.test.ts` (`setSeriesStyle`, `removeSeries`)
- Modify: `frontend/src/ui/panel.ts` (chip restructure, popover, hover emphasis)
- Modify: `frontend/src/ui/app-shell.ts` (callbacks)
- Modify: `frontend/src/styles/app.css`
- Modify: `frontend/tests/e2e/workbench.spec.ts` (legend-harness expectations if chip DOM assertions exist)
- Modify: `frontend/tests/e2e/interactions.spec.ts`

**Interfaces:**

- Consumes: Tasks 4 (`rerender` via caches), 6 (`removeAnnotation` pruning pattern).
- Produces:
  - `RenderOptions.widths?: readonly number[]`, `RenderOptions.emphasisIndex?: number`
  - `WorkspaceModel.setSeriesStyle(panelId: string, path: string, style: { color_slot: number; dash: DashStyle; width: number }): void`
  - `WorkspaceModel.removeSeries(panelId: string, path: string): void` — also prunes that series' annotations
  - `PanelCallbacks.onSetSeriesStyle(id: string, path: string, style: { color_slot: number; dash: DashStyle; width: number }): void`, `PanelCallbacks.onRemoveSeries(id: string, path: string): void`

- [ ] **Step 1: Failing renderer tests (width + emphasis)**

```ts
test("series stroke width follows options and emphasis dims the rest", () => {
  const recording = recordingContext();
  const { canvas } = fakeCanvas(640, 360, recording);
  const renderer = new CanvasRenderer(canvas);
  renderer.setPalette(TEST_PALETTE);
  renderer.render(
    twoSeriesResponse,
    { min: 0, max: 10 },
    {
      ...options,
      widths: [2.5, 1.4],
      emphasisIndex: 0,
    },
  );
  expect(
    recording.calls.some(
      (call) => call.op === "lineWidth" && call.value === 2.9,
    ),
  ).toBe(true); // 2.5 + 0.4 emphasis
  expect(
    recording.calls.some(
      (call) => call.op === "globalAlpha" && call.value === 0.35,
    ),
  ).toBe(true);
});
```

(Adapt fixture names; record `lineWidth`/`globalAlpha` assignments in `test-canvas.ts` if not already recorded.)

- [ ] **Step 2: Implement renderer support**

`RenderOptions` gains the two optional fields. In `render(...)`'s series loop pass index context, and in `drawSeries` add parameters `width: number` and `dimmed: boolean`:

```ts
const emphasized = options.emphasisIndex === index;
const dimmed = options.emphasisIndex !== undefined && !emphasized;
this.drawSeries(
  context,
  project,
  series,
  colors.series[style.colorIndex] ?? colors.fg2,
  style.dash,
  (options.widths?.[index] ?? 1.4) + (emphasized ? 0.4 : 0),
  dimmed,
);
```

and in `drawSeries` set `context.lineWidth = width;` and wrap the stroke with `context.globalAlpha = dimmed ? 0.35 : 1;` (restore to 1 after `stroke()`).

Run the renderer tests — PASS.

- [ ] **Step 3: Model ops (failing test, implement)**

`workspace.test.ts`:

```ts
test("setSeriesStyle and removeSeries update series and prune annotations", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanelRow();
  model.addSeries(panel.id, "a/b");
  model.addSeries(panel.id, "a/c");
  model.setSeriesStyle(panel.id, "a/b", {
    color_slot: 5,
    dash: "dot",
    width: 2.5,
  });
  const styled = model
    .panel(panel.id)
    ?.series.find((series) => series.path === "a/b");
  expect(styled).toMatchObject({ color_slot: 5, dash: "dot", width: 2.5 });
  model.addAnnotation(panel.id, {
    id: "ann-1",
    series_path: "a/b",
    time: 0,
    value: 0,
    label: "",
  });
  model.addAnnotation(panel.id, {
    id: "ann-2",
    series_path: "a/c",
    time: 0,
    value: 0,
    label: "",
  });
  model.removeSeries(panel.id, "a/b");
  expect(model.panel(panel.id)?.series.map((series) => series.path)).toEqual([
    "a/c",
  ]);
  expect(
    model.panel(panel.id)?.annotations.map((annotation) => annotation.id),
  ).toEqual(["ann-2"]);
});
```

Implement:

```ts
  setSeriesStyle(
    panelId: string,
    path: string,
    style: { color_slot: number; dash: DashStyle; width: number },
  ): void {
    const series = this.panel(panelId)?.series.find((entry) => entry.path === path);
    if (series === undefined) return;
    series.color_slot = style.color_slot;
    series.dash = style.dash;
    series.width = style.width;
  }

  removeSeries(panelId: string, path: string): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.series = panel.series.filter((series) => series.path !== path);
    panel.annotations = panel.annotations.filter(
      (annotation) => annotation.series_path !== path,
    );
  }
```

- [ ] **Step 4: Split chips and the inspector popover in `PanelView`**

- Restructure `legendChip` to a `<span class="legend-chip">` wrapper containing two buttons (nesting buttons is invalid HTML — the wrapper is a span):

```ts
  private legendChip(series: PanelState["series"][number]): HTMLElement {
    const chip = document.createElement("span");
    chip.className = `legend-chip ${series.visible ? "" : "muted"}`;
    const body = document.createElement("button");
    body.className = "legend-chip-body";
    body.title = `${series.path} — click to toggle visibility`;
    const line = document.createElement("span");
    const style = resolveSeriesStyle(series.color_slot, series.dash);
    line.className = `legend-line dash-${style.dash}`;
    line.setAttribute("aria-hidden", "true");
    line.style.color = `var(--series-${String(style.colorIndex + 1)})`;
    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = series.path.split("/").slice(-2).join("/");
    body.append(line, name);
    body.addEventListener("click", () => {
      this.callbacks.onToggleSeries(this.id, series.path);
    });
    body.addEventListener("mouseenter", () => {
      this.setEmphasis(series.path);
    });
    body.addEventListener("mouseleave", () => {
      this.setEmphasis(null);
    });
    const caret = document.createElement("button");
    caret.className = "legend-chip-caret";
    caret.textContent = "▾";
    caret.title = `${series.path} — series inspector`;
    caret.setAttribute("aria-haspopup", "true");
    caret.addEventListener("click", (event) => {
      this.openInspector(series.path, event.clientX, event.clientY);
    });
    chip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openInspector(series.path, event.clientX, event.clientY);
    });
    chip.append(body, caret);
    return chip;
  }
```

Change `legendChips` to `HTMLElement[]` and verify `layoutLegend`'s width math still reads `chip.offsetWidth` (it does — the type widens).

- Emphasis re-render from caches:

```ts
  private emphasizePath: string | null = null;

  private setEmphasis(path: string | null): void {
    if (this.emphasizePath === path) return;
    this.emphasizePath = path;
    if (this.lastState !== null && this.lastWindow !== null) {
      this.renderTiles(this.lastState, this.lastTiles, this.lastWindow);
    }
  }
```

and in `renderTiles`, derive `emphasisIndex` against the **shown** tile order:

```ts
      widths: shown.map((tile) => bySeries.get(tile.signal_path)?.width ?? 1.4),
      ...(this.emphasizePath !== null &&
      shown.some((tile) => tile.signal_path === this.emphasizePath)
        ? { emphasisIndex: shown.findIndex((tile) => tile.signal_path === this.emphasizePath) }
        : {}),
```

- The popover (one lazily created `.series-inspector` per panel, absolutely positioned in `this.element`):

```ts
  private openInspector(path: string, clientX: number, clientY: number): void {
    this.closeInspector();
    const state = this.lastState;
    const series = state?.series.find((entry) => entry.path === path);
    if (state === undefined || state === null || series === undefined) return;
    const popover = document.createElement("div");
    popover.className = "series-inspector";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", `${path} series inspector`);

    const pathRow = document.createElement("div");
    pathRow.className = "inspector-path";
    pathRow.textContent = path;

    const slots = document.createElement("div");
    slots.className = "inspector-slots";
    for (let slot = 1; slot <= COLOR_SLOTS; slot += 1) {
      const swatch = document.createElement("button");
      swatch.className = "inspector-slot";
      swatch.style.background = `var(--series-${String(slot)})`;
      swatch.setAttribute("aria-label", `Colour slot ${String(slot)}`);
      swatch.classList.toggle(
        "active",
        resolveSeriesStyle(series.color_slot, "solid").colorIndex + 1 === slot,
      );
      swatch.addEventListener("click", () => {
        this.callbacks.onSetSeriesStyle(this.id, path, {
          color_slot: slot,
          dash: series.dash,
          width: series.width,
        });
        this.closeInspector();
      });
      slots.append(swatch);
    }

    const dashes = document.createElement("div");
    dashes.className = "inspector-dashes";
    for (const dash of ["solid", "dash", "dot"] as const) {
      const button = document.createElement("button");
      button.className = "inspector-dash";
      button.textContent = dash;
      button.classList.toggle("active", series.dash === dash);
      button.addEventListener("click", () => {
        this.callbacks.onSetSeriesStyle(this.id, path, {
          color_slot: series.color_slot,
          dash,
          width: series.width,
        });
        this.closeInspector();
      });
      dashes.append(button);
    }
    const width = document.createElement("input");
    width.type = "range";
    width.min = "0.5";
    width.max = "4";
    width.step = "0.25";
    width.value = String(series.width);
    width.setAttribute("aria-label", "Line width");
    width.addEventListener("change", () => {
      this.callbacks.onSetSeriesStyle(this.id, path, {
        color_slot: series.color_slot,
        dash: series.dash,
        width: Number(width.value),
      });
    });
    dashes.append(width);

    const actions = document.createElement("div");
    actions.className = "inspector-actions";
    const remove = document.createElement("button");
    remove.className = "inspector-remove";
    remove.textContent = "remove";
    remove.addEventListener("click", () => {
      this.closeInspector();
      this.callbacks.onRemoveSeries(this.id, path);
    });
    actions.append(remove);

    popover.append(pathRow, slots, dashes, actions);
    this.element.append(popover);
    const panelRect = this.element.getBoundingClientRect();
    popover.style.left = `${String(
      clamp(clientX - panelRect.left - 8, 4, Math.max(4, panelRect.width - 204)),
    )}px`;
    popover.style.top = `${String(clamp(clientY - panelRect.top + 8, 4, Math.max(4, panelRect.height - 40)))}px`;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && popover.contains(event.target)) return;
      this.closeInspector();
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") this.closeInspector();
    };
    document.addEventListener("pointerdown", dismiss, { capture: true });
    document.addEventListener("keydown", onEscape);
    this.inspectorCleanup = () => {
      document.removeEventListener("pointerdown", dismiss, { capture: true });
      document.removeEventListener("keydown", onEscape);
    };
  }

  private inspectorCleanup: (() => void) | null = null;

  private closeInspector(): void {
    this.inspectorCleanup?.();
    this.inspectorCleanup = null;
    this.element.querySelector(".series-inspector")?.remove();
  }
```

Also call `this.closeInspector()` in `update()` when the series no longer exists, and note the deferred transforms: **do not** add `smooth`/`deriv`/`use as X` buttons (Phase 3 / 2B).

- [ ] **Step 5: Shell callbacks**

```ts
        onSetSeriesStyle: (id, path, style) => {
          this.workspace.setSeriesStyle(id, path, style);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onRemoveSeries: (id, path) => {
          this.workspace.removeSeries(id, path);
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
```

- [ ] **Step 6: CSS**

```css
.legend-chip {
  display: inline-flex;
  align-items: center;
}
.legend-chip-body {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  background: none;
  border: none;
  color: var(--fg-2);
  font: 10.5px var(--font-ui);
  cursor: pointer;
  padding: 1px 2px 1px 6px;
}
.legend-chip.muted .legend-chip-body {
  color: var(--fg-4);
  text-decoration: line-through;
}
.legend-chip.muted .legend-line {
  opacity: 0.4;
}
.legend-chip-caret {
  background: none;
  border: none;
  color: var(--fg-4);
  cursor: pointer;
  padding: 1px 4px 1px 0;
}
.series-inspector {
  position: absolute;
  width: 196px;
  background: var(--surface-2);
  box-shadow: var(--elev-2, 0 4px 16px rgba(0, 0, 0, 0.4));
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 8px;
  font-size: 10.5px;
  z-index: 5;
}
.inspector-path {
  color: var(--fg-1);
  font-family: var(--font-mono);
  margin-bottom: 6px;
  overflow-wrap: anywhere;
}
.inspector-slots {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 3px;
  margin-bottom: 6px;
}
.inspector-slot {
  height: 12px;
  border: none;
  border-radius: 1px;
  cursor: pointer;
}
.inspector-slot.active {
  box-shadow: 0 0 0 1px var(--fg-1);
}
.inspector-dashes {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-bottom: 6px;
}
.inspector-dash {
  background: var(--surface-3);
  border: none;
  border-radius: 2px;
  color: var(--fg-3);
  padding: 1px 6px;
  cursor: pointer;
}
.inspector-dash.active {
  background: var(--surface-4);
  color: var(--fg-1);
}
.inspector-dashes input[type="range"] {
  flex: 1;
  min-width: 0;
}
.inspector-remove {
  background: var(--surface-3);
  border: none;
  border-radius: 2px;
  color: var(--status-error, #e5484d);
  padding: 1px 8px;
  cursor: pointer;
}
```

(Reuse the existing status-error token name from `tokens.css` — check its exact name and drop the fallback.) Adjust the existing `.legend-chip` button rules that assumed the chip itself was a `<button>`.

- [ ] **Step 7: Reconcile the legend e2e harness**

`workbench.spec.ts`'s legend overflow test builds chips through `PanelView` — its width-measurement expectations survive, but any selector like `button.legend-chip` must become `.legend-chip` / `.legend-chip-body`. Update selectors only; the counts and `+N` behaviour are unchanged.

- [ ] **Step 8: e2e**

```ts
test("the legend caret opens the inspector; remove drops the series", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop interaction");
  const panel = page.locator(".panel").first();
  await expect(panel.locator(".legend-chip")).toHaveCount(2);
  await panel.locator(".legend-chip-caret").first().click();
  const inspector = page.locator(".series-inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector.locator(".inspector-slot")).toHaveCount(8);
  await inspector.locator(".inspector-dash", { hasText: "dot" }).click();
  await expect(inspector).toBeHidden();
  await panel.locator(".legend-chip-caret").first().click();
  await page.locator(".series-inspector .inspector-remove").click();
  await expect(panel.locator(".legend-chip")).toHaveCount(1);
  // right-click is a shortcut, not the only path — caret already proved the primary path
});
```

- [ ] **Step 9: Gates and commit**

Run: `./scripts/test.sh frontend` then `./scripts/test.sh e2e` — PASS.

```bash
git add frontend/src/render/canvas-renderer.ts frontend/src/render/canvas-renderer.test.ts \
  frontend/src/render/test-canvas.ts \
  frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts \
  frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts frontend/src/styles/app.css \
  frontend/tests/e2e/workbench.spec.ts frontend/tests/e2e/interactions.spec.ts
git commit -m "feat(ui): split legend inspector with colour, dash, width and remove"
```

---

## Task 12: Gesture discoverability, docs, and the full gate

Advertise the bindings in the status bar exactly as the spec's hint strip, record what shipped, and run the complete CI gate.

**Files:**

- Modify: `frontend/src/ui/app-shell.ts:728` (gesture hint)
- Modify: `frontend/tests/e2e/app.spec.ts` (if it asserts the old hint text)
- Modify: `docs/implementation-roadmap.md` (Phase 2 progress note)
- Modify: `docs/superpowers/plans/2026-07-24-00-INDEX.md` (add this plan to the table)

**Interfaces:** none — documentation and copy only.

- [ ] **Step 1: Replace the status-bar hint**

In `shellMarkup()`:

```html
<span class="gesture-hint"
  >drag box-zoom · wheel t · ⇧wheel y · right-drag pan · dbl-click fit · click
  datatip</span
>
```

Check `app.spec.ts`/`workbench.spec.ts` for assertions on the old hint text and update them.

- [ ] **Step 2: Roadmap note**

Append to `docs/implementation-roadmap.md` after the Phase 1 closing paragraph:

```markdown
Phase 2 desktop interaction (2A) shipped: linked wheel/box/pan/fit gestures
with per-panel unlinked windows, the global amber cursor with readouts and
live tree values, pinned annotations with delta readouts, a visible-region
statistics strip backed by envelope-bin sums
([ADR 0014](adr/0014-envelope-bin-sums.md)), gutter/inline axis styles,
in-place title and axis-name editing, and the split legend inspector.
Remaining Phase 2 scope (2B): XY drop strip and mode, colour channel and
colorbar, FFT and histogram modes, and touch gestures.
```

- [ ] **Step 3: Index the plan**

Add a Phase 2 section row to `docs/superpowers/plans/2026-07-24-00-INDEX.md` referencing `2026-07-25-phase2a-desktop-interactions.md` (scope: desktop interaction core; depends on Phase 1 complete) and noting 2B is unwritten.

- [ ] **Step 4: Full gate**

Run: `./scripts/ci.sh all`
Expected: PASS — format, clippy + Rust tests, frontend gate, artifact checks, e2e. Fix anything it surfaces before committing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/app-shell.ts frontend/tests/e2e/app.spec.ts \
  docs/implementation-roadmap.md docs/superpowers/plans/2026-07-24-00-INDEX.md
git commit -m "docs: advertise desktop gesture set and record phase 2a scope"
```

---

## Final verification checklist (for the executing agent)

- `./scripts/ci.sh all` green at HEAD.
- Manual pass in `./scripts/run.sh web`: hint-strip gestures all work as advertised; amber appears **only** as cursor, rubber band, Δ readout and drag targets; unlink (`l`) isolates panel windows; `s` toggles stats on the focused panel; every pointer action has a palette path (`⌘K` → zoom/pan/fit/axis style/stats/clear annotations).
- Manual pass in `./scripts/run.sh native` if the platform allows; otherwise state that the native host was not exercised.
- No `x_signal`/`color_signal` consumers were added, no FFT/histogram/XY code paths, no touch handlers — those belong to Phase 2B.

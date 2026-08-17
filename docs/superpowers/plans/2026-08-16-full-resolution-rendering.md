# Full-Resolution Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every live panel consume full-resolution source samples without pyramid LOD or stride sampling while preserving explicit export fidelity controls.

**Architecture:** Keep the current tile and sample protocol shapes for this baseline, but make their live-rendering reduction controls inert: time queries always return logical pyramid level zero and sample queries always return contiguous stride-one windows. Keep pyramid construction temporarily and collapse singleton level-zero bins to one ChartGPU vertex. Snapshot and CSV fidelity remain separate, explicit user choices.

**Tech Stack:** Rust (`scope-core`, `scope-server`), TypeScript/Vitest, ChartGPU/WebGPU, Playwright, generated SignalScope protocol types.

## Global Constraints

- No live-rendering operation may silently fall back to reduced data after allocation, transport, rendering, or transform failure.
- `HttpPlane` must return full-resolution live windows. `BakedPlane` must add no further reduction beyond the user's exported fidelity and must match `HttpPlane` for full-fidelity snapshots.
- Keep protocol schema fields stable in this baseline. Live `pixel_width` and `max_total_bins` are inert, and live sample requests use `max_points: 0`; positive `max_points` remains the explicit CSV export cap.
- Preserve preview, standard, high, and full fidelity for explicit HTML and CSV exports; export fidelity must not affect live rendering.
- Histogram aggregation remains intrinsic plot computation; FFT consumes the full fetched window and has no artificial 16,384-sample ceiling.
- Keep the pyramid and coarse cache levels temporarily; no live workbench presentation path may consume a coarse level. Reduced-fidelity snapshots may consume only their explicitly exported level.
- Use repository scripts for formatting, tests, builds, benchmarks, and versioning.
- Add an accepted ADR because this supersedes accepted LOD decisions.
- Do not run GUI/e2e until all implementation tasks are complete.

---

### Task 1: Raw native time-tile queries

**Files:**

- Modify: `core/scope-core/src/pyramid.rs`
- Modify: `server/scope-server/src/api.rs`

**Interfaces:**

- Produces: `Pyramid::query_raw(&self, t0: f64, t1: f64) -> PyramidQuery`.
- Guarantees: every successful time-tile response reports `level == 0`; viewport width and total-bin budget are compatibility inputs only.

- [ ] **Step 1: Write failing core and server tests**

Add this core test beside `query_is_bounded_by_display_density`:

```rust
#[test]
fn raw_query_returns_every_window_sample_at_level_zero() {
    let time = (0..10_000).map(f64::from).collect::<Vec<_>>();
    let pyramid = Pyramid::from_samples(&time, &time);
    let query = pyramid.query_raw(2_000.0, 7_999.0);

    assert_eq!(query.level, 0);
    assert_eq!(query.bins.len(), 6_002); // one neighbour on each edge
    assert!(
        query
            .bins
            .to_wire_vec()
            .iter()
            .all(|bin| bin.sample_count == 1)
    );
}
```

Extend the existing `query_tiles_bin` server test to decode the response and assert that a request with `pixel_width: 1` and `max_total_bins: Some(1)` still returns level zero and all in-window samples.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
./scripts/test.sh core raw_query_returns_every_window_sample_at_level_zero
./scripts/test.sh server query_tiles_bin
```

Expected: the core test does not compile because `query_raw` is absent; after adding only its signature, the server assertion fails because `query_with_target` selects a coarse level.

- [ ] **Step 3: Implement the raw query**

Add a `query_raw` method that preserves the existing out-of-range behavior and returns:

```rust
PyramidQuery {
    level: 0,
    bins: self
        .level_window(0, Some((t0, t1)))
        .unwrap_or_default(),
}
```

In `query_tiles_bin`, remove per-series budget calculation and call `pyramid.query_raw(request.window.t0, request.window.t1)`. Continue parsing the compatibility request fields without using them.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
./scripts/test.sh core raw_query_returns_every_window_sample_at_level_zero
./scripts/test.sh server query_tiles_bin
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/pyramid.rs server/scope-server/src/api.rs
git commit -m "feat(data): return raw time tiles"
```

### Task 2: Raw baked time tiles and singleton ChartGPU feeds

**Files:**

- Modify: `frontend/src/app/pyramid-query.ts`
- Modify: `frontend/src/app/pyramid-query.test.ts`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `frontend/src/render/m4-feed.ts`
- Modify: `frontend/src/render/m4-feed.test.ts`
- Modify: `frontend/src/render/chart-host.test.ts`

**Interfaces:**

- Produces: `queryRawPyramidRange(levels, t0, t1) -> PyramidRange` selecting only baked level zero.
- Produces: `m4Feed` output with one `(x, y)` vertex for a finite singleton bin and one NaN vertex for a missing singleton.

- [ ] **Step 1: Write failing baked-plane and feed tests**

Add a pyramid-query test whose level zero contains 100 bins and whose coarse levels fit a one-bin request; assert `queryRawPyramidRange(levels, 20, 79)` returns level zero and the exact neighbour-inclusive range.

Add a `BakedPlane.queryTiles` test using `pixel_width: 1` and `max_total_bins: 1`; assert `level === 0` and every level-zero bin in the requested window is returned.

Add these feed assertions:

```ts
it("emits one point for each singleton raw bin", () => {
  const feed = m4Feed(
    columns([
      { t0: 10, t1: 10, first: 2, min: 2, max: 2, last: 2 },
      { t0: 11, t1: 11, first: 3, min: 3, max: 3, last: 3 },
    ]),
    10,
  );
  expect([...feed.x]).toEqual([0, 1]);
  expect([...feed.y]).toEqual([2, 3]);
});
```

Update the ChartHost expectation from four duplicate M4 positions for its singleton fixture to one position.

- [ ] **Step 2: Run focused frontend tests and verify RED**

Run:

```bash
./scripts/test.sh unit pyramid-query data-plane m4-feed chart-host
```

Expected: FAIL because the raw range helper is missing and singleton bins expand to four points.

- [ ] **Step 3: Implement baked raw selection and singleton feeds**

Implement `queryRawPyramidRange` by applying the existing binary-search window helpers to `levels[0]`, retaining one neighbouring bin on each side, and always returning `level: 0`.

Change `BakedPlane.queryTiles` to use `queryRawPyramidRange`; delete its per-series budget calculation.

In `m4Feed`, before the M4 extrema branch, recognize `sampleCount[index] === 1` and `t0[index] === t1[index]`. Emit `first` once when finite; emit one NaN when missing. Preserve the existing gap behavior for aggregate bins.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
./scripts/test.sh unit pyramid-query data-plane m4-feed chart-host
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/pyramid-query.ts frontend/src/app/pyramid-query.test.ts \
  frontend/src/app/data-plane.ts frontend/src/app/data-plane.test.ts \
  frontend/src/render/m4-feed.ts frontend/src/render/m4-feed.test.ts \
  frontend/src/render/chart-host.test.ts
git commit -m "feat(render): feed raw time samples"
```

### Task 3: Uncapped sample panels and FFT input

**Files:**

- Modify: `core/scope-core/src/compute.rs`
- Modify: `server/scope-server/src/api.rs`
- Modify: `frontend/src/app/samples.ts`
- Modify: `frontend/src/app/samples.test.ts`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `frontend/src/app/sample-window-cache.ts`
- Modify: `frontend/src/app/sample-window-cache.test.ts`
- Modify: `frontend/src/app/spectrum.ts`
- Modify: `frontend/src/app/spectrum.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Produces: `compute::sample_window_full(time, values, t0, t1) -> SampleSlice` with `stride == 1`.
- Produces: `sampleWindowFull(time, values, t0, t1) -> SampleSlice` mirroring Rust.
- Guarantees: XY issues one full-extent request; FFT and histogram issue one full visible-window request; `max_points: 0` selects uncapped output in both hosts.

- [ ] **Step 1: Write failing full-window tests**

Add Rust and TypeScript tests with 100 samples and window `20..79`; assert the full-window helper returns 62 neighbour-inclusive samples with `stride == 1`.

Change `BakedPlane.querySamples` coverage to assert that `max_points: 0` does not reduce the response.

Replace the sample-cap tests in `app-shell.test.ts` with a refresh request test asserting:

```ts
expect(plane.querySamples).toHaveBeenCalledWith(
  expect.objectContaining({ max_points: 0 }),
);
```

For XY, assert exactly one full-extent query rather than merged context/detail queries.

Add a spectrum test with 32,768 in-window samples and assert `result?.size === 32_768`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
./scripts/test.sh core sample_window_full
./scripts/test.sh server query_samples
./scripts/test.sh unit samples data-plane sample-window-cache spectrum app-shell
```

Expected: FAIL because full-window helpers are absent, both planes stride to the cap, XY makes two requests, and FFT stops at 16,384.

- [ ] **Step 3: Implement contiguous sample windows**

Extract the shared neighbour-inclusive `start..end` calculation in Rust, then implement `sample_window_full` by copying `time[start..end]` and `values[start..end]` with `stride: 1`. Make `query_samples` call it when `request.max_points == 0`; retain `sample_window` for positive explicit export caps.

Mirror this as `sampleWindowFull` in TypeScript and make `BakedPlane.querySamples` call it for `max_points == 0`; retain `sampleWindow` for positive explicit export caps.

Remove `SAMPLE_CAP`, `SAMPLE_MODE_CAP`, `SAMPLE_POINT_BUDGET`, `sampleCapFor`, and `sampleCapForPanel`. Panel requests send `max_points: 0` as the retained compatibility value. Remove `cap` from `SampleWindowCache.key` because it no longer changes response identity. XY requests only `sampleWindow(panel)` once and no longer calls `mergeSampleResponses` in the refresh path.

Remove `MAX_SIZE` from `spectrum.ts`; let the existing power-of-two selection grow to the largest transform supported by the full input window.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
./scripts/test.sh core sample_window
./scripts/test.sh server query_samples
./scripts/test.sh unit samples data-plane sample-window-cache spectrum app-shell
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/compute.rs server/scope-server/src/api.rs \
  frontend/src/app/samples.ts frontend/src/app/samples.test.ts \
  frontend/src/app/data-plane.ts frontend/src/app/data-plane.test.ts \
  frontend/src/app/sample-window-cache.ts frontend/src/app/sample-window-cache.test.ts \
  frontend/src/app/spectrum.ts frontend/src/app/spectrum.test.ts \
  frontend/src/ui/app-shell.ts frontend/src/ui/app-shell.test.ts
git commit -m "feat(panels): consume uncapped samples"
```

### Task 4: Preserve explicit export fidelity

**Files:**

- Verify: `core/scope-core/src/snapshot.rs`
- Verify: `core/scope-core/src/bin/scope-bake.rs`
- Verify: `frontend/src/ui/export-dialog.ts`
- Verify: `frontend/src/ui/export-dialog.test.ts`
- Verify: `scripts/export.sh`

**Interfaces:**

- Guarantees: explicit HTML and CSV exports retain preview, standard, high, and full fidelity.
- Guarantees: `ExportFidelity::Full` selects logical level zero while reduced choices remain user initiated.
- Guarantees: export fidelity does not alter live panel requests.

- [ ] **Step 1: Run focused export regression tests**

Run:

```bash
./scripts/test.sh core snapshot
./scripts/test.sh core export_controls
./scripts/test.sh unit export-dialog app-shell csv-export
```

Expected: PASS. Confirm the existing tests cover all four named fidelities,
full level-zero planning, reduced export planning, CSV stride reporting, and
the four export-dialog buttons. Do not change production or test files when
these contracts already pass.

- [ ] **Step 2: Check live/export separation**

Run:

```bash
rg -n "csvMaxPoints|ExportFidelity|data-fidelity|max_points" \
  frontend/src/ui/app-shell.ts frontend/src/ui/export-dialog.ts \
  core/scope-core/src/snapshot.rs
```

Expected: fidelity and CSV point ceilings occur only in explicit export code;
the live refresh path added in Task 3 sends `max_points: 0`.

Assert in both hosts that `max_points: 0` is uncapped while a positive value
retains the existing bounded CSV export response.

- [ ] **Step 3: Record the no-change verification**

Append Task 4's commands and evidence to the SDD report. This task
intentionally creates no source commit because existing export behavior is the
requirement.

### Task 5: Architecture record and product documentation

**Files:**

- Create: `docs/adr/0041-full-resolution-presentation-baseline.md`
- Modify: `docs/adr/README.md`
- Modify: `README.md`
- Modify: `docs/implementation-roadmap.md`

**Interfaces:**

- Records: ADR 0041 supersedes the live-rendering reduction portions of ADRs 0036, 0037, and 0039 without rewriting accepted history; ADRs 0024 and 0025 remain authoritative for explicit export fidelity.

- [ ] **Step 1: Write ADR 0041**

Record the following decisions and consequences:

```markdown
# ADR 0041: Full-resolution presentation baseline

- Status: Accepted
- Date: 2026-08-16
- Supersedes: live presentation reduction decisions in ADRs 0036, 0037, and 0039

Every live presentation query returns source-resolution samples. Time tiles
use logical level zero and sample queries use stride one. Live tile reduction
controls remain compatibility fields but are inert; live sample requests use
zero as the uncapped sentinel. Positive sample caps remain reserved for
explicit CSV export fidelity under ADRs 0024 and 0025. Explicit HTML and CSV
export fidelity remains user selected.
Resource exhaustion during live rendering is an error, never a trigger for
automatic reduction. Pyramid construction remains temporarily for a measured
follow-up cleanup.
```

Include consequences: larger live transfers, potentially failed raw benchmark scenarios, exact host parity, and unchanged explicit export fidelity UI.

- [ ] **Step 2: Update adjacent documentation**

Add ADR 0041 to the ADR index. Update README live-rendering descriptions to say full resolution while retaining its export-fidelity documentation. Add a roadmap entry linking this baseline to the approved design spec and noting that compact raw binary transport/pyramid removal are measured follow-ups.

- [ ] **Step 3: Check documentation and commit**

Run:

```bash
./scripts/format.sh
./scripts/format.sh --check
```

Expected: PASS.

Commit:

```bash
git add docs/adr/0041-full-resolution-presentation-baseline.md docs/adr/README.md \
  README.md docs/implementation-roadmap.md
git commit -m "docs: record full-resolution presentation"
```

### Task 6: Cross-layer verification and release version

**Files:**

- Modify: release manifests selected by `./scripts/version.sh bump minor`

**Interfaces:**

- Produces: a formatted, tested, synchronized minor release increment for the completed user-facing behavior change.

- [ ] **Step 1: Run focused and broad non-GUI verification**

Run:

```bash
./scripts/format.sh
./scripts/test.sh core
./scripts/test.sh server
./scripts/test.sh frontend
./scripts/ci.sh quality
```

Expected: PASS with no reduction-aware assertion remaining on presentation paths.

- [ ] **Step 2: Run the finished-plan GUI and benchmark gates**

Run:

```bash
./scripts/ci.sh e2e
./scripts/test.sh bench
```

Expected: e2e must pass. Record benchmark completion, resource exhaustion, or performance-floor failures exactly; do not introduce reduction to make the benchmark pass.

- [ ] **Step 3: Bump and validate the release version**

Run:

```bash
./scripts/version.sh bump minor
./scripts/version.sh check
./scripts/format.sh
```

Expected: synchronized manifests and a clean format check.

- [ ] **Step 4: Run the complete quality gate after the version bump**

Run:

```bash
./scripts/ci.sh all
```

Expected: PASS. If platform WebGPU or raw benchmark resource limits prevent a gate, report the exact command and failure without claiming it passed.

- [ ] **Step 5: Commit the final version change**

```bash
git add Cargo.lock Cargo.toml frontend/package.json protocol/schema/scope-protocol.json
git commit -m "chore: bump version for full-resolution rendering"
```

Stage only files actually changed by `version.sh`; do not use `git add -A`.

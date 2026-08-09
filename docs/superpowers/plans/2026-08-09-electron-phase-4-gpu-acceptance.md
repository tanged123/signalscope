# Electron Migration Phase 4: GPU Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make software WebGPU authoritative for correctness, Electron
hardware WebGPU authoritative for performance, and complete the breaking
desktop migration at version 2.0.0.

**Architecture:** Small deterministic fixtures run under SwiftShader in CI.
Full `mc1000`/`dense10k` benchmarks launch the packaged Electron host with a
real adapter and refuse software devices. Renderer milestones and GPU work
counters, not synthetic RAF loops, determine acceptance.

**Tech Stack:** Electron 43.2.0/Chromium 150, WebGPU, Playwright Electron,
SwiftShader, existing benchmark corpus and metrics.

## Global Constraints

- Complete Phases 1–3 first.
- SwiftShader, llvmpipe, Lavapipe, WARP, and other fallback adapters cannot pass performance gates.
- Hardware absence is an explicit unsupported result, never a skipped passing benchmark.
- `test.sh gpu` remains deterministic and small enough for ordinary CI.
- Full native benchmarks ingest through Rust; they do not use a baked snapshot substitute.
- Do not loosen renderer fidelity, visible-series cardinality, or interaction floors to make a benchmark pass.
- Version 2.0.0 is the final change after every available gate passes.

---

### Task 1: Separate software correctness from performance projects

**Files:**

- Modify: `frontend/playwright.config.ts`
- Modify: `frontend/tests/gpu/`
- Modify: `frontend/tests/bench/`
- Modify: `scripts/test.sh`
- Modify: `scripts/ci.sh`
- Modify: `.github/workflows/bench.yml`

**Interfaces:**

- Produces:

```text
test.sh gpu             SwiftShader correctness, bounded fixtures
test.sh bench core      Rust performance
test.sh bench software  bounded browser responsiveness smoke
test.sh bench e2e       Electron hardware performance, fail if software
```

- [ ] **Step 1: Add a regression test for project flags**

Parse Playwright configuration and assert only `gpu` and the bounded software
smoke receive SwiftShader flags. Assert no hardware benchmark project contains
`swiftshader`, `use-webgpu-adapter`, or `enable-unsafe-webgpu`.

- [ ] **Step 2: Run and preserve current failure**

Run: `./scripts/test.sh unit frontend/tests/config/gpu-projects.test.ts`

Expected: FAIL because the current shared launch options force SwiftShader on
the benchmark project.

- [ ] **Step 3: Split project launch options**

Keep exact software flags only for the GPU project. Browser snapshot/e2e uses
normal Chromium defaults unless a test specifically belongs to the bounded
software project. Remove the four-minute `mc1000` software performance test;
replace it with a small fixture that proves interactions complete without
deadlock and makes no frame-rate claim.

- [ ] **Step 4: Change scheduled CI semantics**

The ordinary GitHub-hosted benchmark job runs core benchmarks plus bounded
software correctness and labels the report accordingly. It does not publish
hardware frame floors. `bench e2e` remains available for a GPU-equipped runner
or manual machine and fails explicitly when no hardware adapter exists.

- [ ] **Step 5: Verify and commit**

Run: `./scripts/test.sh gpu`

Run: `./scripts/test.sh bench software`

Expected: both PASS quickly; no 240-second timeout.

```bash
git add frontend/playwright.config.ts frontend/tests scripts/test.sh scripts/ci.sh .github/workflows/bench.yml
git commit -m "test(gpu): separate software correctness from performance"
```

### Task 2: Make adapter identity and renderer evidence mandatory

**Files:**

- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/types.ts`
- Modify: `desktop/src/preload.ts`
- Modify: `frontend/src/app/desktop-bridge.ts`
- Modify: `frontend/src/render/gpu/runtime.ts`
- Modify: `frontend/src/render/gpu/metrics.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Create: `frontend/src/render/gpu/adapter-info.ts`
- Create: `frontend/src/render/gpu/adapter-info.test.ts`

**Interfaces:**

- Produces:

```ts
export interface GpuEvidence {
  readonly electronVersion: string;
  readonly chromiumVersion: string;
  readonly adapterVendor: string;
  readonly adapterArchitecture: string;
  readonly adapterDevice: string;
  readonly adapterDescription: string;
  readonly softwareRendering: boolean;
  readonly fallbackReason: string | null;
  readonly limits: Record<string, number>;
}
```

- [ ] **Step 1: Write fallback-classification tests**

Classify as software when Electron reports software rendering or adapter/GPU
descriptions contain case-insensitive `SwiftShader`, `llvmpipe`, `lavapipe`,
`WARP`, or `software rasterizer`. Conflicting evidence resolves to software.
Empty evidence is unsupported, not hardware.

- [ ] **Step 2: Run and preserve failure**

Run: `./scripts/test.sh unit frontend/src/render/gpu/adapter-info.test.ts`

Expected: FAIL because the classifier is absent.

- [ ] **Step 3: Collect evidence from both process layers**

Electron provides versions, feature status, complete GPU info, and selected
test mode. The renderer adds `GPUAdapter.info`, actual required limits, shader
compilation status, and runtime counters. Normalize into `GpuEvidence` after
device creation; never infer hardware from `navigator.gpu` alone.

- [ ] **Step 4: Display the active backend**

Add a compact status entry: hardware adapter description, `Software WebGPU`,
or unsupported reason. Do not use amber as generic status color. Include full
evidence in benchmark JSON and diagnostic copy text.

- [ ] **Step 5: Verify and commit**

Run: `./scripts/test.sh unit frontend/src/render/gpu/adapter-info.test.ts`

Run: `./scripts/test.sh gpu`

Run: `./scripts/test.sh native-e2e`

Expected: software E2E identifies itself as software and still proves pixels.

```bash
git add desktop/src frontend/src
git commit -m "feat(gpu): report authoritative adapter evidence"
```

### Task 3: Implement the real native hardware benchmark

**Files:**

- Create: `frontend/tests/bench/electron-hardware.spec.ts`
- Create: `frontend/tests/bench/native-measure.ts`
- Modify: `frontend/tests/bench/measure.ts`
- Modify: `frontend/tests/bench/report.ts`
- Modify: `desktop/src/main.ts`
- Modify: `scripts/test.sh`
- Modify: `scripts/collect-bench-report.mjs`

**Interfaces:**

- Produces report `build/bench/report/electron-hardware.json` with adapter
  evidence, corpus identity, selected/drawable series, renderer milestones,
  interaction latency, GPU counters, and pass/fail reasons.

- [ ] **Step 1: Add a supported folder-open CLI**

Parse `--open <path>` and `--open-folder <path>` in Electron main, validate
absolute paths, and feed them through the same renderer open/drop event. Keep
ordinary OS argv handling. This avoids 1,000 file arguments and is useful
outside tests.

- [ ] **Step 2: Write a benchmark that fails on software before timing**

Launch Electron without GPU override against the generated benchmark corpus.
Await `GpuEvidence`; if unsupported or software, write a failed report with
the exact evidence and stop before frame thresholds. The command exits nonzero.

- [ ] **Step 3: Ingest the full native corpus**

For `mc1000`, pass its generated directory through `--open-folder` and await
Rust batch completion plus 1,000 selected series. For `dense10k`, use the
deterministic native corpus defined by the existing benchmark generator and
await 10,000 selected series. Never load a baked HTML substitute.

- [ ] **Step 4: Measure real milestones**

Record navigation, host ready, ingest complete, coarse complete, first
successful nonblank GPU frame, fine complete, and stable residency. Perform:

```text
10 resident-window pans
10 padded-boundary pans
10 wheel zoom-ins and 10 zoom-outs
30 hover picks and 10 explicit picks
one device-loss recovery to a restored nonblank frame
```

Await each operation. Empty samples, missing events, zero descriptors, blank
pixels, validation errors, or cardinality mismatches fail immediately.

- [ ] **Step 5: Enforce performance and no-work invariants**

Require existing floors: frame p95 ≤ 33 ms and no interaction stall > 250 ms.
Resident pans require zero upload bytes and descriptor rebuilds. Draw calls
scale with pages/passes, not series. Picking and recovery require measured
completion samples. Keep per-stage timings separate; do not sum unrelated p95s.

- [ ] **Step 6: Verify on available hosts**

Run: `./scripts/test.sh bench e2e`

Expected on hardware: PASS for both corpora and produce the report.

Expected on this WSL host if Chromium has no hardware adapter: FAIL early with
adapter diagnostics, not timeout and not a skipped pass. In that case run the
same command on native Windows or a Vulkan-capable Linux host before claiming
performance acceptance.

- [ ] **Step 7: Commit**

```bash
git add desktop/src frontend/tests/bench scripts/test.sh scripts/collect-bench-report.mjs
git commit -m "perf(gpu): benchmark native data on hardware Electron"
```

### Task 4: Make Electron the native acceptance authority

**Files:**

- Modify: `docs/adr/0035-benchmark-harness-and-performance-floors.md` only by a new superseding ADR reference if policy requires; do not rewrite history
- Modify: `docs/adr/0040-electron-rust-desktop-host.md`
- Modify: `docs/implementation-roadmap.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/bench.yml`

**Interfaces:**

- Produces truthful test-authority documentation and optional GPU-runner job.

- [ ] **Step 1: Document the authority matrix**

State that SwiftShader proves correctness, Electron software E2E proves shell
integration, and only Electron hardware proves performance. Remove every live
claim that browser SwiftShader or a Tauri smoke run is performance authority.

- [ ] **Step 2: Add an optional hardware-runner workflow path**

If repository labels include a GPU-equipped self-hosted runner, add a manual
job invoking only `./scripts/test.sh bench e2e` and uploading its report. If no
such runner exists, keep the command manual and document that fact; do not run
it on `ubuntu-latest` and reinterpret software output.

- [ ] **Step 3: Verify live terminology**

Run the Phase 3 live-tree deletion gate and search current docs for obsolete
benchmark authority. Historical ADRs/plans remain excluded.

- [ ] **Step 4: Commit**

```bash
git add docs README.md AGENTS.md .github/workflows
git commit -m "docs(gpu): make hardware Electron the performance authority"
```

### Task 5: Run final gates and bump to 2.0.0

**Files:**

- Modify: all synchronized version manifests through `scripts/version.sh`
- Modify only defects directly exposed by final verification.

- [ ] **Step 1: Run deterministic gates from a clean process state**

```text
./scripts/format.sh
./scripts/format.sh --check
./scripts/test.sh quick
./scripts/test.sh host
./scripts/test.sh desktop
./scripts/test.sh frontend
./scripts/test.sh gpu
./scripts/test.sh native-e2e
./scripts/test.sh e2e
./scripts/test.sh bench core
./scripts/test.sh bench software
./scripts/build.sh web
./scripts/build.sh native --dir
./scripts/ci.sh all
```

Expected: all PASS.

- [ ] **Step 2: Run hardware acceptance where available**

Run: `./scripts/test.sh bench e2e`

Record PASS only from a non-software adapter. If the current machine reports
unsupported/software, retain the failed diagnostic report and run on native
Windows or a supported Linux GPU before declaring the performance objective
complete.

- [ ] **Step 3: Confirm package matrix**

Require successful CI artifacts for Linux x64, Windows x64, macOS x64, and
macOS arm64. Inspect each artifact list for one matching Rust host and no Tauri
or WebKitGTK payload.

- [ ] **Step 4: Bump the breaking version last**

Run: `./scripts/version.sh bump major`

Expected: version `2.0.0` from `1.0.2`.

Run: `./scripts/version.sh check`

Run: `./scripts/format.sh`

Run: `./scripts/format.sh --check`

- [ ] **Step 5: Review and commit only synchronized manifests**

Review staged and unstaged diffs separately. Preserve the user's unrelated
untracked corrective plan.

```bash
git add Cargo.toml Cargo.lock package.json pnpm-lock.yaml frontend/package.json desktop/package.json README.md
git commit -m "chore(release): bump Electron desktop release to 2.0.0"
```

## Final acceptance gate

- The focused software GPU proof passes with nonblank pixels.
- Electron native E2E passes through the real Rust host.
- Hardware benchmark reports a real adapter or fails honestly before timing.
- Full `mc1000` and `dense10k` performance claims come only from hardware.
- All four package targets exist and contain the matching Rust host.
- No live Tauri/system-webview implementation remains.
- Offline snapshots still pass no-network and renderer-fidelity checks.
- Version is synchronized at 2.0.0 only after completion.

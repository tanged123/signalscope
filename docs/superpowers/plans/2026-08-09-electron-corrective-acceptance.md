# Electron Corrective Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the merged Electron desktop dependable on NixOS and every
packaged OS, then make scripts, native tests, package smoke tests, benchmarks,
and CI prove the runtime users actually receive.

**Architecture:** Keep Electron, the authenticated Rust loopback host,
`NativePlane`, `BakedPlane`, and the WebGPU renderer. Repair the public script
API around single process ownership, run production acceptance against the
unpacked package, stream large export bodies directly into atomic files, and
delete obsolete Tauri-era live guidance and test bypasses.

**Tech Stack:** Bash, Node.js 22, Electron 43.2.0, TypeScript, Vitest,
Playwright Electron, Rust 2024, Axum 0.8, Tokio, electron-builder, Nix, GitHub
Actions.

## Global Constraints

- The accepted design is
  `docs/superpowers/specs/2026-08-09-electron-corrective-acceptance-design.md`.
- Do not revert the Electron migration or add Tauri compatibility.
- `scripts/` remains the only public developer and CI command surface.
- One process owns every Vite server. Existing port 4173 listeners fail; they
  are never silently reused by native tests or benchmarks.
- Use Electron 43.2.0 everywhere. Version drift is a gate failure.
- Native integration tests must traverse Electron, the workbench UI,
  `NativePlane`, authenticated HTTP, and the real Rust host.
- A successful-frame counter is not pixel evidence. Native, package, and
  hardware acceptance must measure non-background plot pixels.
- SwiftShader proves correctness and shell integration only. It cannot pass a
  hardware performance gate.
- `mc1000` means exactly 1,000 selected, visible, drawable series;
  `dense10k` means exactly 10,000.
- Do not lower renderer fidelity, cardinality, interaction, draw-call,
  residency, picking, or recovery floors.
- JSON routes remain bounded at 16 MiB. Only `/v1/export/file` may receive a
  payload up to 1 GiB, and it must not materialize that payload in server
  memory.
- Package tests launch the unpacked package executable. They may not inject an
  alternate Electron, host binary, application archive, or resource root.
- Historical ADRs and plans may retain Tauri history. Live instructions,
  source, scripts, workflows, the roadmap, and the design handoff may not.
- Add behavior tests before each fix. Preserve the failing result in the task
  notes or commit message; do not weaken a test to turn it green.
- Use repository wrappers for verification. Defer complete GUI, package,
  cross-platform, and E2E gates until Task 11.
- Preserve unrelated work and stage explicit files only.
- The final change is a synchronized patch bump from 2.0.0 to 2.0.1. Do not
  bump earlier.

## Resulting Command Contract

| Command                             | Runtime under test                            | Owner of Vite       |
| ----------------------------------- | --------------------------------------------- | ------------------- |
| `./scripts/run.sh web`              | Browser development frontend                  | command             |
| `./scripts/run.sh native`           | Electron + debug Rust host + dev frontend     | native supervisor   |
| `./scripts/test.sh desktop`         | Electron helper/unit tests                    | none                |
| `./scripts/test.sh native-e2e`      | Electron + real Rust host + SwiftShader       | Playwright          |
| `./scripts/test.sh desktop package` | Unpacked production package                   | none                |
| `./scripts/test.sh gpu`             | Browser renderer correctness, SwiftShader     | Playwright          |
| `./scripts/test.sh bench software`  | Bounded software responsiveness               | none                |
| `./scripts/test.sh bench e2e`       | Unpacked production package, hardware GPU     | none                |
| `./scripts/test.sh full`            | Rust, frontend, desktop, browser, GPU, native | command composition |
| `./scripts/ci.sh build`             | Current-OS package plus package smoke         | none                |

`SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER` has exactly two values:

```text
managed  Playwright starts and stops `pnpm dev` (default)
none     the project uses app:// or file:// and needs no Vite server
```

No test may infer server ownership from `CI`, `SIGNALSCOPE_BENCH`,
`SIGNALSCOPE_DEMO`, or package identity.

---

### Task 1: Fix the Electron application path and lock the runtime version

**Files:**

- Create: `desktop/src/launcher.ts`
- Create: `desktop/tests/launcher.test.ts`
- Modify: `desktop/scripts/start.mjs`
- Create: `scripts/check-electron-version.mjs`
- Modify: `scripts/ci-policy.test.sh`
- Modify: `scripts/lib.sh`
- Modify: `flake.lock`

**Interfaces:**

```ts
export function desktopApplicationRoot(importMetaUrl: string): string;
export function normalizeElectronArguments(
  arguments_: readonly string[],
): readonly string[];
```

```text
node scripts/check-electron-version.mjs
  compares desktop/package.json, pnpm-lock.yaml, and
  $SIGNALSCOPE_ELECTRON_BIN --version
```

- [ ] **Step 1: Add launcher regression tests**

In `desktop/tests/launcher.test.ts`, use the real
`desktop/scripts/start.mjs` URL as input. Assert that
`desktopApplicationRoot()` returns the absolute `desktop/` directory, not the
repository root. Assert that `normalizeElectronArguments(["--", "--open",
path])` removes only the leading package-manager separator and preserves the
Electron arguments.

Also assert that a normal first argument such as `--open` is not removed.

- [ ] **Step 2: Add version-policy failures**

Make `scripts/check-electron-version.mjs` export pure parsing helpers and
accept its binary through `SIGNALSCOPE_ELECTRON_BIN`. Add policy fixtures that
cover:

```text
desktop package 43.2.0 + binary v43.2.0 -> pass
desktop package 43.2.0 + binary v43.1.0 -> fail
missing or relative binary                 -> fail
nonzero `electron --version`               -> fail
```

The real quality invocation must also confirm that the Electron package in
`pnpm-lock.yaml` resolves to 43.2.0 rather than merely trusting
`desktop/package.json`.

- [ ] **Step 3: Run the narrow tests and preserve failure**

Run: `./scripts/test.sh desktop launcher`

Run: `./scripts/test.sh policy`

Run: `./scripts/ci.sh quality`

Expected: FAIL because `../../` in `desktop/scripts/start.mjs` resolves to the
repository root and the locked Nix Electron currently differs from 43.2.0.

- [ ] **Step 4: Make the launcher use an absolute application path**

`desktop/scripts/start.mjs` must:

1. Resolve the application directory through `desktopApplicationRoot()`.
2. Use an absolute `SIGNALSCOPE_ELECTRON_BIN` when supplied.
3. Dynamically import the npm `electron` package only when no override exists;
   do not initialize or download npm Electron on the Nix path.
4. Spawn `executable` with `[desktopRoot, ...normalizedArguments]` and
   `cwd: desktopRoot`.
5. Await the child exit and propagate a nonzero code or signal failure.

This directly fixes the reported `Cannot find module
'/home/tanged/sources/signalscope'` failure.

- [ ] **Step 5: Synchronize the locked Nix package**

Advance only the locked `nixpkgs` input to a revision whose `electron_43`
reports 43.2.0. Do not loosen `desktop/package.json` to a range and do not use
the ambient channel as evidence. `flake.lock` remains the source used by
`./scripts/dev.sh`.

Call `check-electron-version.mjs` from `quality_checks()` after shell policy so
every Nix quality run proves the version.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh desktop launcher`

Run: `./scripts/test.sh policy`

Run: `./scripts/ci.sh quality`

Expected: all PASS and the check reports Electron 43.2.0 from all three
sources.

```bash
git add desktop/src/launcher.ts desktop/tests/launcher.test.ts desktop/scripts/start.mjs scripts/check-electron-version.mjs scripts/ci-policy.test.sh scripts/lib.sh flake.lock
git commit -m "fix(desktop): launch the absolute Electron application"
```

### Task 2: Give native development one process supervisor

**Files:**

- Create: `scripts/process-supervisor.mjs`
- Create: `scripts/process-supervisor.test.mjs`
- Create: `scripts/native-dev.mjs`
- Modify: `scripts/run.sh`
- Modify: `scripts/ci-policy.test.sh`

**Interfaces:**

```js
export async function supervise({
  server,
  foreground,
  host,
  port,
  logPath,
}): Promise<number>;
```

`scripts/native-dev.mjs` is the only production caller. It starts:

```text
server:     pnpm --filter @signalscope/frontend dev
foreground: pnpm --filter @signalscope/desktop start -- <Electron args>
host/port:  127.0.0.1:4173
log:        build/vite.log
```

- [ ] **Step 1: Add process lifecycle tests**

Use Node child fixtures in `scripts/process-supervisor.test.mjs`; do not need a
real GUI. Test these cases:

1. A pre-existing listener on port 4173 rejects startup before the server or
   foreground command is spawned.
2. A fake server opens the requested port, a fake foreground process exits
   zero, and the port is closed before `supervise()` resolves.
3. A nonzero foreground exit is propagated and still closes the server.
4. A server that exits before opening the port fails with the server status
   and includes its log path.
5. `SIGINT`/`SIGTERM` sent to the supervisor terminates both process trees.

Invoke this Node test file from `./scripts/test.sh policy` so it is part of the
existing deterministic script gate.

- [ ] **Step 2: Run and preserve failure**

Run: `./scripts/test.sh policy`

Expected: FAIL because `run.sh` uses `exec` after installing a cleanup trap,
so its shell and trap disappear while Vite remains independently owned.

- [ ] **Step 3: Implement cross-platform process-tree cleanup**

On POSIX, create a process group and terminate the group with `SIGTERM`, then
`SIGKILL` after a short bounded grace period. On Windows, use `taskkill /T /F`
for a spawned tree. Always await exit and ignore only an already-exited child.
Never kill by process name or port.

The readiness loop must check both the TCP port and whether the server child
is still alive. Keep output quiet; on failure print the command and log path.

- [ ] **Step 4: Reduce `run.sh native` to orchestration**

Keep its existing host and web builds because the host needs the debug binary
and the Rust export path needs `snapshot-template.html`. Replace manual Vite,
trap, exports, and `exec pnpm` with one foreground call to
`node scripts/native-dev.mjs`.

Forward `--software-gpu`, `--`, and subsequent Electron arguments unchanged.
`native-dev.mjs` sets only:

```text
NODE_ENV=development
SIGNALSCOPE_HOST_BIN=<repo>/target/debug/signalscope-host
SIGNALSCOPE_GPU_MODE=software  # only when explicitly requested
```

- [ ] **Step 5: Verify the reported developer path**

Run: `./scripts/run.sh native --software-gpu`

Expected on NixOS with a display: Electron opens the `desktop` application,
connects to the debug Rust host, and uses SwiftShader.

Close Electron, then run: `./scripts/run.sh web`

Expected: port 4173 is immediately available, proving native cleanup. If this
machine has no display, report the GUI run as untested; the lifecycle tests
must still pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/process-supervisor.mjs scripts/process-supervisor.test.mjs scripts/native-dev.mjs scripts/run.sh scripts/ci-policy.test.sh
git commit -m "fix(scripts): supervise native development processes"
```

### Task 3: Make Playwright the sole test-server authority

**Files:**

- Modify: `frontend/playwright.config.ts`
- Modify: `frontend/tests/config/gpu-projects.test.ts`
- Modify: `scripts/test.sh`
- Modify: `scripts/ci.sh`
- Modify: `scripts/ci-policy.test.sh`
- Modify: `flake.nix`
- Modify: `flake.lock` only if the selected Xvfb package changes the lock

**Interfaces:**

```ts
type PlaywrightServerMode = "managed" | "none";
```

```bash
run_gui_command command [arguments...]
```

- [ ] **Step 1: Add configuration and static-ownership tests**

Extend `frontend/tests/config/gpu-projects.test.ts` to assert:

- `managed` produces exactly one Playwright `webServer`.
- `none` omits `webServer`.
- any other value throws during config load.
- `CI`, benchmark, demo, and package flags do not change ownership.

Extend `scripts/ci-policy.test.sh` to reject manual frontend-dev startup in
`test_native_e2e` and to reject `reuseExistingServer: true`. A stale listener
must fail, not become test input.

- [ ] **Step 2: Reproduce the CI failure**

Run: `CI=1 ./scripts/test.sh native-e2e`

Expected before the fix: FAIL with port 4173 already in use because
`test.sh` starts Vite and Playwright attempts to start a second server.

- [ ] **Step 3: Replace implicit environment heuristics**

In `playwright.config.ts`, default
`SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER` to `managed`. Set
`reuseExistingServer: false` in every environment. Remove the conditional on
`SIGNALSCOPE_DEMO`, `SIGNALSCOPE_BENCH`, and
`SIGNALSCOPE_PACKAGE_SMOKE`.

Every file/app based wrapper explicitly sets
`SIGNALSCOPE_PLAYWRIGHT_WEB_SERVER=none`. Browser and native development E2E
leave it managed.

- [ ] **Step 4: Delete duplicate Vite ownership**

From `test_native_e2e`, delete the Vite spawn, PID, trap, log, and
`wait_for_port`. Build the debug host, production frontend resources, and
desktop code, then invoke only the `electron-native` Playwright project.

Add `run_gui_command` to `scripts/lib.sh`. On Linux CI without `DISPLAY`, it
executes the supplied command under `xvfb-run -a`; otherwise it executes the
command directly. Add the locked Xvfb provider to `flake.nix`. Do not apply
Xvfb to browser-only headless tests.

- [ ] **Step 5: Make suite composition truthful**

Refactor repeated calls into the existing `test_*` functions so:

```text
test.sh e2e   = browser E2E only
test.sh full  = quick + desktop + browser E2E + GPU + native E2E
ci.sh e2e     = browser E2E + native E2E
ci.sh all     = format + quality + Rust + frontend + browser + GPU + native
```

Keep hardware and package tests explicit. Ensure `show_help()` says exactly
what each mode now does.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh unit frontend/tests/config/gpu-projects.test.ts`

Run: `CI=1 ./scripts/test.sh native-e2e`

Expected: no port collision; Playwright starts one Vite child and closes it.

Run: `./scripts/test.sh policy`

```bash
git add frontend/playwright.config.ts frontend/tests/config/gpu-projects.test.ts scripts/test.sh scripts/ci.sh scripts/ci-policy.test.sh scripts/lib.sh flake.nix flake.lock
git commit -m "fix(test): assign one owner to each Playwright server"
```

### Task 4: Make GPU classification and pixel evidence authoritative

**Files:**

- Create: `desktop/src/gpu.ts`
- Create: `desktop/tests/gpu.test.ts`
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/types.ts`
- Modify: `desktop/src/preload.ts`
- Modify: `frontend/src/app/desktop-bridge.ts`
- Modify: `frontend/src/render/gpu/adapter-info.ts`
- Modify: `frontend/src/render/gpu/adapter-info.test.ts`
- Modify: `frontend/tests/bench/measure.ts`
- Create: `frontend/tests/bench/measure.test.ts`

**Interfaces:**

```ts
export interface ElectronGpuClassification {
  readonly softwareRendering: boolean;
  readonly webGpuStatus: string;
  readonly fallbackReason: string | null;
}

export function classifyElectronGpu(
  featureStatus: Readonly<Record<string, string>>,
  activeDevice: GpuDeviceInfo | undefined,
  explicitSoftwareMode: boolean,
): ElectronGpuClassification;
```

```ts
export interface PlotPixelEvidence {
  readonly totalPixels: number;
  readonly nonBackgroundPixels: number;
}

export async function plotPixelEvidence(page: Page): Promise<PlotPixelEvidence>;
```

- [ ] **Step 1: Add the false-positive classifier tests**

Test that an NVIDIA/AMD/Intel active device with `webgpu: "enabled"` remains
hardware when unrelated Electron features are `disabled` or `unavailable`.
Test software classification for explicit software mode and active-device or
WebGPU-specific strings containing `SwiftShader`, `llvmpipe`, `lavapipe`,
`WARP`, or `software rasterizer`.

Test `webgpu: "disabled"` and `webgpu: "unavailable"` as unsupported through
`fallbackReason`, not software. Missing adapter identity remains unsupported.

- [ ] **Step 2: Add deterministic pixel-analyzer tests**

Factor the color comparison into a pure helper. A uniform background image
must return zero non-background pixels; a synthetic colored trajectory must
return its exact pixel count. The threshold must tolerate antialiasing but not
count the known plot background as line content.

`plotPixelEvidence(page)` obtains the first panel's WebGPU plot canvas,
composes it into a temporary 2D canvas using the same path as PNG export, reads
the pixels, and compares them with `--surface-0`/`--surface-1`. It does not
count axes, overlays, text, or cursor marks.

- [ ] **Step 3: Run and preserve failure**

Run: `./scripts/test.sh desktop gpu`

Run: `./scripts/test.sh unit frontend/src/render/gpu/adapter-info.test.ts frontend/tests/bench/measure.test.ts`

Expected: FAIL because `desktop/src/main.ts` treats every disabled Chromium
feature as software and no workbench pixel evidence exists.

- [ ] **Step 4: Classify only selected-adapter and WebGPU evidence**

Move classification out of `desktop/src/main.ts`. Select the active GPU device
first. Inspect only:

```text
explicit SIGNALSCOPE_GPU_MODE=software
active adapter vendor/driver/description
featureStatus.webgpu
```

Expose `webGpuStatus` and `fallbackReason` through `DesktopGpuInfo` and the
preload bridge. Update `gpuEvidenceFromNative()` to preserve unsupported
WebGPU status. The renderer's `GPUAdapter.info` remains the strongest selected
adapter evidence once device creation succeeds.

- [ ] **Step 5: Verify and commit**

Run: `./scripts/test.sh desktop gpu`

Run: `./scripts/test.sh unit frontend/src/render/gpu/adapter-info.test.ts frontend/tests/bench/measure.test.ts`

Run: `./scripts/test.sh gpu`

Expected: SwiftShader remains software; unrelated disabled Electron features
cannot disqualify a real adapter; the existing software pixel proof remains
green.

```bash
git add desktop/src/gpu.ts desktop/tests/gpu.test.ts desktop/src/main.ts desktop/src/types.ts desktop/src/preload.ts frontend/src/app/desktop-bridge.ts frontend/src/render/gpu/adapter-info.ts frontend/src/render/gpu/adapter-info.test.ts frontend/tests/bench/measure.ts frontend/tests/bench/measure.test.ts
git commit -m "fix(gpu): classify the selected WebGPU adapter"
```

### Task 5: Turn native E2E into a real UI and pixel test

**Files:**

- Create: `frontend/tests/e2e/native-session.ts`
- Modify: `frontend/tests/e2e/electron-native.spec.ts`
- Modify: `frontend/tests/e2e/electron-native-export.spec.ts`
- Modify: `scripts/test.sh`

**Interfaces:**

```ts
export async function installNativeSession(
  userData: string,
  selector: string,
): Promise<void>;
```

The helper writes `<userData>/session.autosave.json` with one focused panel,
one query binding, one full-width layout cell, no source records, and the
current generated session schema version.

- [ ] **Step 1: Replace the launch-only assertion with end-to-end behavior**

Copy `frontend/tests/e2e/fixtures/roundtrip.csv` into a temporary directory.
Install a one-panel session selecting `alpha @*`, then launch Electron with:

```text
<absolute desktop directory>
--user-data-dir=<temporary user data>
--open=<temporary roundtrip.csv>
```

The environment uses the debug Rust host and `SIGNALSCOPE_GPU_MODE=software`.

Assert through visible workbench state that:

1. `app://` is not used in this development test and the sandbox has no Node.
2. The source and `alpha` signal appear after ingest.
3. One time-series panel exists and its query resolves one selected series.
4. GPU metrics report one visible and drawable series, descriptors, and zero
   validation errors.
5. `plotPixelEvidence()` reports non-background plot pixels.
6. A wheel zoom and drag pan each cause another successful frame and leave
   non-background pixels.

- [ ] **Step 2: Keep capability parity, but stop using it as UI evidence**

Retain `electron-native-export.spec.ts` for the complete native operation
matrix. Reuse common launch/session setup where useful, but do not count its
direct `NativePlane` calls as renderer acceptance.

Add a native PNG export assertion that the file is larger than a PNG header
and that the source panel had non-background pixels before export.

- [ ] **Step 3: Run and preserve failure**

Run: `./scripts/test.sh native-e2e`

Expected before implementation: the launch test can pass without ingesting or
drawing native data; the new cardinality and pixel assertions fail.

- [ ] **Step 4: Verify and commit**

Run: `./scripts/test.sh native-e2e`

Expected: PASS under SwiftShader with a real Rust host, one UI-resolved series,
and measured pixels. If the current machine has no GUI, run under the scripted
Xvfb path and do not claim an interactive manual check.

```bash
git add frontend/tests/e2e/native-session.ts frontend/tests/e2e/electron-native.spec.ts frontend/tests/e2e/electron-native-export.spec.ts scripts/test.sh
git commit -m "test(desktop): prove native workbench pixels"
```

### Task 6: Launch and inspect the actual unpacked package

**Files:**

- Create: `desktop/scripts/package-paths.mjs`
- Create: `desktop/tests/package-paths.test.ts`
- Modify: `frontend/tests/e2e/electron-packaged.spec.ts`
- Modify: `scripts/test.sh`
- Modify: `scripts/build-windows.sh`
- Modify: `scripts/ci.sh`

**Interfaces:**

```js
export function unpackedPackage(platform, arch, releaseRoot) {
  return { executable, resources, host, frontend, asar };
}
```

```text
./scripts/test.sh desktop package [--no-build]
```

- [ ] **Step 1: Add package-layout tests**

Test the expected electron-builder directory and executable for:

```text
linux x64    desktop/release/linux-unpacked/signalscope
windows x64  desktop/release/win-unpacked/signalscope.exe
macOS x64    desktop/release/mac/SignalScope.app/Contents/MacOS/signalscope
macOS arm64  desktop/release/mac-arm64/SignalScope.app/Contents/MacOS/signalscope
```

The resolver must verify regular executable, `app.asar`, bundled host, and
`frontend/index.html`. It fails on zero or multiple matching layouts; it does
not guess another architecture.

- [ ] **Step 2: Add a package-test anti-bypass policy**

Extend `scripts/ci-policy.test.sh` to reject assignments or forwarded values
for these variables in the package-smoke invocation and `electron.launch()`:

```text
SIGNALSCOPE_ELECTRON_BIN
SIGNALSCOPE_PACKAGED_APP
SIGNALSCOPE_HOST_BIN
SIGNALSCOPE_RESOURCE_DIR
```

Only `SIGNALSCOPE_PACKAGED_BIN` identifies the executable produced by the
current build. The spec may name the four variables only to delete them from
the inherited environment before launch.

- [ ] **Step 3: Run and preserve failure**

Run: `./scripts/test.sh desktop package`

Expected before implementation: the test launches Nix/npm Electron with
`app.asar` and injected resource/host paths, so it can pass while the package
executable or resource discovery is broken.

- [ ] **Step 4: Launch the package from outside the checkout**

The Playwright spec must:

1. Copy the CSV fixture to a temporary root.
2. Install the one-panel `alpha @*` session under temporary user data.
3. Set the spawned process `cwd` to that temporary root.
4. Remove all four override variables from the child environment.
5. Launch `SIGNALSCOPE_PACKAGED_BIN` directly with only user-data and open
   arguments.
6. Assert `app://signalscope/index.html`, sandboxing, bridge availability,
   protocol handshake, and production resource discovery.

On Linux, set `SIGNALSCOPE_GPU_MODE=software` and require native-data
cardinality plus non-background pixels. On Windows and macOS, require startup,
host handshake, source ingest, and panel cardinality; do not invent software
GPU support when the target runner cannot provide it.

- [ ] **Step 5: Separate building from smoke reuse**

`./scripts/test.sh desktop package` builds `--dir` by default.
`--no-build` validates and tests the existing current-OS unpacked directory.
No other arguments may be interpreted as this option.

On Linux/macOS, `./scripts/ci.sh build` calls `build.sh native --dir` followed
by `test.sh desktop package --no-build`. On Windows,
`scripts/build-windows.sh` retains its temporary locked pnpm environment and
runs the same no-build smoke after electron-builder. Permit only this package
mode to bypass the Nix re-exec when `SIGNALSCOPE_WINDOWS_BUILD=1`.

- [ ] **Step 6: Verify current-platform behavior and commit**

Run: `./scripts/test.sh desktop package`

Expected on a supported FHS Linux host: the package executable starts and
proves software-WebGPU pixels. On NixOS, an unpacked generic Linux executable
may fail to load because it is not an FHS environment; report that honestly.
The NixOS developer authority remains `run.sh native`, while Ubuntu CI proves
the Linux package.

Run: `./scripts/test.sh desktop package-paths`

Run: `./scripts/test.sh policy`

```bash
git add desktop/scripts/package-paths.mjs desktop/tests/package-paths.test.ts frontend/tests/e2e/electron-packaged.spec.ts scripts/test.sh scripts/build-windows.sh scripts/ci.sh
git commit -m "test(package): launch bundled Electron resources"
```

### Task 7: Rebuild the hardware benchmark around the production package

**Files:**

- Create: `frontend/tests/bench/native-session.ts`
- Modify: `desktop/src/window.ts`
- Modify: `desktop/tests/window.test.ts`
- Modify: `desktop/src/main.ts`
- Modify: `frontend/tests/bench/electron-hardware.spec.ts`
- Modify: `frontend/tests/bench/measure.ts`
- Modify: `frontend/tests/bench/report.ts`
- Modify: `scripts/test.sh`
- Modify: `scripts/collect-bench-report.mjs`

**Interfaces:**

```ts
export async function installBenchmarkSession(userData: string): Promise<void>;
```

The session is one focused full-size time-series panel whose only binding is:

```json
{
  "kind": "query",
  "selector": "response @*",
  "refs": [],
  "set_id": null
}
```

- [ ] **Step 1: Add production-entry and session tests**

Refactor `WindowConfig` to receive one absolute entry URL rather than a
development-only URL. Unit-test:

```text
development       http://127.0.0.1:4173/
development bench http://127.0.0.1:4173/?signalscope-bench=1
production        app://signalscope/index.html
production bench  app://signalscope/index.html?signalscope-bench=1
```

Origin checks must ignore the query and still admit only the exact app or dev
origin.

Test the generated benchmark session with the current session parser and
assert exactly one panel and exactly one `response @*` binding.

- [ ] **Step 2: Add benchmark failures that currently pass**

Before timing, require:

```text
reported Electron version == desktop/package.json version
URL uses app://, not localhost
NODE_ENV == production behavior
selectedSeries == expected cardinality
visibleSeries == expected cardinality
seriesWithSegments == expected cardinality
nonBackgroundPixels > 0
```

After interactions, require:

```text
resident pan upload delta == 0
resident pan descriptor rebuild delta == 0
resident bytes/pages unchanged during resident pans
drawCalls <= residentPages * 4 + 1
pick completions >= 40
device recovery samples >= 1
post-recovery nonBackgroundPixels > 0
validation errors == []
```

Keep the existing first-plot, frame-p95, RAF-stall, and long-task floors.

- [ ] **Step 3: Run and preserve failure**

Run: `SIGNALSCOPE_BENCH_TIER=mc1000 ./scripts/test.sh bench e2e`

Expected before implementation on hardware: FAIL because the harness uses a
debug host, development frontend, ambient Electron, no installed panel, and a
frame counter instead of pixel evidence. On unsupported hardware it must
still fail before timing with adapter evidence.

- [ ] **Step 4: Use one production package for both tiers**

At the start of `bench_e2e`:

1. Remove only the old hardware report.
2. Build the unpacked package once with `build.sh native --dir`; this stages
   the release Rust host and production frontend.
3. Resolve the current-OS package executable through
   `package-paths.mjs`.
4. Do not start Vite and do not set `SIGNALSCOPE_HOST_BIN`,
   `SIGNALSCOPE_RESOURCE_DIR`, or `NODE_ENV=development`.

For each tier, create a fresh temporary user-data directory, install the
benchmark session before launch, and launch the package with
`SIGNALSCOPE_BENCH=1`, `--user-data-dir`, and `--open-folder`. Remove any
inherited `SIGNALSCOPE_GPU_MODE`.

- [ ] **Step 5: Require exact corpus semantics**

Generate missing corpus data through the existing ignored release Rust tests.
Do not use file count as series count. After ingest and panel resolution,
assert:

```text
mc1000  -> exactly 1,000 response series
dense10k -> exactly 10,000 response series
```

Fail if the panel is absent, has another selector, contains an extra binding,
or resolves more/fewer series. Record source count separately from selected
series count.

- [ ] **Step 6: Make reports complete and non-overwriting**

The combined `electron-hardware.json` must contain one `corpora` entry per
requested tier. Each entry includes adapter evidence, versions, URL mode,
source count, all three cardinalities, pixel count before/after recovery,
residency before/after, draw-call bound, frame floors, picks, recovery, and
failure reasons.

`collect-bench-report.mjs` rejects:

- missing requested tiers;
- duplicate tiers;
- a top-level pass when any corpus failed;
- missing/nonfinite numeric evidence;
- software/unsupported backend marked passing;
- blank pre- or post-recovery pixels.

- [ ] **Step 7: Verify on a real adapter and commit**

Run: `./scripts/test.sh bench e2e`

Expected on hardware: both tiers PASS from `app://` with exactly 1,000 and
10,000 drawable series.

Expected without hardware: FAIL before timings, write complete adapter
diagnostics, and do not skip. Do not claim performance acceptance until the
hardware command passes.

```bash
git add frontend/tests/bench/native-session.ts desktop/src/window.ts desktop/tests/window.test.ts desktop/src/main.ts frontend/tests/bench/electron-hardware.spec.ts frontend/tests/bench/measure.ts frontend/tests/bench/report.ts scripts/test.sh scripts/collect-bench-report.mjs
git commit -m "perf(gpu): benchmark the production Electron package"
```

### Task 8: Stream large file exports into durable atomic files

**Files:**

- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `protocol/src/file_binary.rs`
- Modify: `protocol/src/lib.rs`
- Modify: `host/scope-host/src/export.rs`
- Modify: `host/scope-server/Cargo.toml`
- Modify: `host/scope-server/src/lib.rs`
- Modify: `host/scope-server/tests/http.rs`
- Modify: `frontend/src/app/file-binary.ts`
- Modify: `frontend/src/app/file-binary.test.ts`
- Modify: `frontend/src/app/native-client.ts`
- Modify: `frontend/src/app/native-client.test.ts`

**Interfaces:**

```rust
pub const FILE_FRAME_HEADER_BYTES: usize = 24;

pub struct FileFrameHeader {
    pub metadata_length: u32,
    pub payload_length: u64,
}

pub fn decode_file_frame_header(bytes: &[u8])
    -> Result<FileFrameHeader, FileBinaryError>;
pub fn decode_file_frame_metadata(
    header: &FileFrameHeader,
    bytes: &[u8],
) -> Result<Envelope<FileWriteMetadata>, FileBinaryError>;
```

```rust
pub struct PendingRawExport { /* private fields */ }

impl ScopeHost {
    pub async fn begin_raw_export(
        &self,
        metadata: &FileWriteMetadata,
    ) -> Result<PendingRawExport, HostError>;
}

impl PendingRawExport {
    pub async fn write(&mut self, bytes: &[u8]) -> Result<(), HostError>;
    pub async fn commit(self) -> Result<String, HostError>;
    pub async fn abort(self);
}
```

- [ ] **Step 1: Split frame-prefix parsing from full-frame compatibility**

Add protocol tests for every truncated header length, wrong magic/version,
nonzero reserved field, oversized metadata declaration, invalid metadata,
payload length overflow, trailing bytes, and the existing complete-frame
round trip. Keep `decode_file_frame()` as a small compatibility convenience
for bounded tests/callers, implemented from the two prefix functions.

Cap metadata at 1 MiB. Cap payload at exactly 1 GiB. Use checked arithmetic
for header + metadata + payload.

- [ ] **Step 2: Add streaming HTTP regressions**

In `host/scope-server/tests/http.rs`, create request bodies from a generated
stream of small chunks rather than one `Vec`. Cover:

1. A 32 MiB payload arriving in 64 KiB chunks writes exact bytes.
2. Header and metadata split at every possible chunk boundary.
3. A declared 1 GiB + 1 payload is rejected before a destination is created.
4. A truncated upload leaves neither destination nor sibling `.tmp` file.
5. A trailing chunk after the declared payload is rejected and cleaned.
6. Invalid metadata creates no file.
7. Ordinary JSON over 16 MiB returns `413 Payload Too Large`.
8. Raw export over 16 MiB remains accepted.

Instrument the streaming parser in tests with its maximum retained prefix;
assert it never retains payload chunks and never exceeds header plus the 1 MiB
metadata cap.

- [ ] **Step 3: Run and preserve failure**

Run: `./scripts/test.sh host export`

Expected: FAIL because the router globally permits 1 GiB, Axum extracts the
entire export as `Bytes`, and `write_raw_file` receives another complete
payload buffer.

- [ ] **Step 4: Implement route-specific limits and incremental parsing**

Set `DefaultBodyLimit::max(16 * 1024 * 1024)` on the router for ordinary
extractors. Change only `export_file` to receive `Request<Body>` and iterate
frames with `http_body_util::BodyExt`. Add `http-body-util` as an explicit
workspace/server dependency and enable Tokio `fs` and `io-util` features.

The handler state machine is:

```text
read exactly 24 header bytes
validate lengths and total limit
read exactly metadata_length bytes
decode/open metadata and create adjacent temp file
write payload slices immediately
reject EOF before payload_length
reject any byte after payload_length
flush + sync_all + close + atomic rename
return the final path envelope
```

Honor `Content-Length` when present for early rejection, but still count every
received byte because it is untrusted.

- [ ] **Step 5: Make the atomic writer durable and self-cleaning**

Move destination normalization, single-component filename validation, symlink
rejection, and temp naming behind `begin_raw_export()`. Open the sibling temp
with `create_new`. `commit()` flushes, calls `sync_all`, closes the handle, and
renames only after the exact payload succeeds. `abort()` and `Drop` remove the
temp file best-effort.

Keep the synchronous bounded `write_raw_file()` API used by host unit callers,
but route its destination validation through the same private helper. Replace
the old `fs::write` implementation used by bounded raw and HTML writes with
`OpenOptions`, `write_all`, `flush`, `sync_all`, close, and rename. Do not make
the synchronous HTML export API async merely to share a type.

- [ ] **Step 6: Stop copying the full frame in TypeScript**

Keep strict frame decode tests, but add a request-body builder that returns a
pull-driven `ReadableStream<Uint8Array>` yielding:

```text
24-byte header
encoded metadata
original Uint8Array payload
```

Yield the payload as bounded subarray chunks rather than enqueueing it all in
`start()`. `NativeClient` sends the stream with Chromium's required
`duplex: "half"` request option. It must not allocate a
`HEADER + metadata + payload` `Uint8Array` or another payload-sized copy.
Preserve exact protocol bytes and content type. Unit tests consume the stream
and assert exact framing, bounded chunks, and no mutation of the source bytes.

- [ ] **Step 7: Verify and commit**

Run: `./scripts/test.sh host export`

Run: `./scripts/test.sh unit frontend/src/app/file-binary.test.ts frontend/src/app/native-client.test.ts`

Run: `./scripts/test.sh native-e2e`

Expected: all PASS; partial bodies leave no destination or temp file, and the
native export matrix still writes PNG/CSV.

```bash
git add Cargo.toml Cargo.lock protocol/src/file_binary.rs protocol/src/lib.rs host/scope-host/src/export.rs host/scope-server/Cargo.toml host/scope-server/src/lib.rs host/scope-server/tests/http.rs frontend/src/app/file-binary.ts frontend/src/app/file-binary.test.ts frontend/src/app/native-client.ts frontend/src/app/native-client.test.ts
git commit -m "fix(export): stream native files atomically"
```

### Task 9: Make package and release CI enforce the corrected runtime

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/bench.yml`
- Modify: `scripts/ci.sh`
- Modify: `scripts/check-ci-results.sh`
- Modify: `scripts/ci-policy.test.sh`
- Modify: `scripts/release.sh`
- Modify: `scripts/demo.sh`

**Interfaces:**

```text
required Linux gates -> ci-ok -> four package/smoke jobs -> tag -> publish
```

- [ ] **Step 1: Strengthen policy tests before editing workflows**

Add assertions that:

- `check-ci-results.sh` accepts only `success`; `skipped`, `failure`,
  `cancelled`, missing, empty, and unknown results fail.
- every workflow `run:` step invokes one repository script as its command;
  multiline direct `git`, `cargo`, `pnpm`, `npm`, and `nix` commands fail.
- the package matrix contains Linux x64, Windows x64, macOS x64, and macOS
  arm64.
- package jobs call a script path that performs package smoke.
- `tag` needs both `ci-ok` and the complete package matrix result.
- `publish` needs successful tagging and packages.
- no release or demo workflow configures Git identity directly.
- hardware benchmark is not placed on `ubuntu-latest` or interpreted as a
  scheduled passing result.

- [ ] **Step 2: Run and preserve failure**

Run: `./scripts/test.sh policy`

Expected: FAIL because skipped jobs pass the aggregate checker, package jobs
do not smoke, tag bypasses GPU/coverage through a partial needs list, and
workflow blocks run direct `git config`.

- [ ] **Step 3: Repair the gate graph**

Keep `ci-ok` dependent on all required Linux checks: version, flake, quality,
Rust, frontend, browser/native E2E, GPU, and coverage. Run the four-platform
package matrix after `ci-ok` on pull requests and main pushes. Each matrix row
uses `./scripts/ci.sh build` or `./scripts/ci.sh windows`, both of which now
include package smoke before artifact upload.

Set `tag.needs` to `[ci-ok, build]`. Set publish to the successful tag and
build outputs. GitHub artifact upload/download actions remain actions; all
artifact production and inspection remains in scripts.

- [ ] **Step 4: Move release shell behavior behind scripts**

Make `release.sh tag` supply bot identity through command-scoped `git -c`
arguments, using optional `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` defaults. The
workflow then calls only `./scripts/release.sh tag` and writes its returned tag
to `$GITHUB_OUTPUT` through a focused `release.sh tag-output <path>` mode or an
equivalent script-owned mode.

`demo.sh publish` already owns identity; pass any overrides as environment and
remove workflow `git config`. Keep workflow output quiet.

- [ ] **Step 5: Keep scheduled benchmark claims honest**

`.github/workflows/bench.yml` continues to call only `./scripts/ci.sh bench`,
which runs Rust and bounded software evidence. It must label the artifact as
software/core and must not emit a passing `electron_hardware` entry.

If a repository GPU runner is configured later, add a separately named manual
job invoking only `./scripts/test.sh bench e2e`; do not add a fake hardware job
to GitHub-hosted runners in this task.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh policy`

Run: `./scripts/ci.sh quality`

Run: `./scripts/ci.sh build`

Expected on a supported Linux packaging host: package build, inspection, and
package smoke all PASS. On NixOS, report the FHS package-smoke limitation and
use the Ubuntu workflow result for that platform claim.

```bash
git add .github/workflows/ci.yml .github/workflows/bench.yml scripts/ci.sh scripts/check-ci-results.sh scripts/ci-policy.test.sh scripts/release.sh scripts/demo.sh
git commit -m "fix(ci): gate releases on packaged Electron smoke"
```

### Task 10: Delete obsolete live host guidance and encode the boundary

**Files:**

- Modify: `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/kickoffprompt.md`
- Modify: `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/README.md`
- Modify: `docs/implementation-roadmap.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md` only if inherited wording is stale after the audit
- Modify: `scripts/lib.sh`
- Modify: `scripts/ci-policy.test.sh`

**Interfaces:**

```text
Historical allowlist:
  docs/adr/**
  docs/superpowers/plans/**
  docs/superpowers/specs/**

Live rejection roots:
  .github, scripts, desktop, frontend, host, core, protocol,
  AGENTS.md, CLAUDE.md, README.md, docs/implementation-roadmap.md,
  docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui
```

- [ ] **Step 1: Turn the stale-reference audit into a failing gate**

Expand `live_host_deletion_check()` to the live roots above. Reject:

```text
TauriPlane
src-tauri
__TAURI_INTERNALS__
@tauri-apps
cargo tauri / tauri build
tauri-build / tauri-plugin
WebKitGTK / webkit2gtk
Tauri development host / Tauri shell / Tauri bundle
```

The historical allowlist is directory-based and explicit. Do not add
per-file exclusions to hide new live references. Keep the sentinel patterns
themselves excluded from matching their own implementation and tests.

- [ ] **Step 2: Run and preserve the stale audit**

Run: `./scripts/ci.sh quality`

Expected: FAIL on `kickoffprompt.md`, which is the first required UI source
but still commands agents to build `TauriPlane`, a Tauri shell, and Tauri
bundles.

- [ ] **Step 3: Correct only host/runtime guidance**

Update the kickoff and handoff README to describe:

- Electron as the pinned Chromium presentation host;
- `NativePlane` over the authenticated Rust loopback server;
- `BakedPlane` for snapshots;
- Electron packages for Linux x64, Windows x64, macOS x64/arm64;
- mouse/keyboard desktop input only;
- WebGPU time-series strokes, without reviving the prototype's Canvas2D,
  density, XY, FFT, or histogram implementation.

Preserve visual decisions from the Final Spec. Where old host or renderer
implementation advice conflicts with accepted ADRs, state that the current
ADR wins rather than rewriting the historical HTML prototype.

Update `AGENTS.md`, README, and roadmap command/authority tables to match the
corrected script contract, production package benchmark, package smoke matrix,
and NixOS-versus-Ubuntu package limitation. Remove claims that Windows is
build-only now that it runs startup/host smoke.

- [ ] **Step 4: Audit dead migration code and dependencies**

Run the deletion search over live roots, `pnpm check:unused`, `cargo machete`,
and shell policy. Delete, rather than deprecate:

- package-smoke `SIGNALSCOPE_PACKAGED_APP` handling;
- benchmark dev-Vite and debug-host branches;
- broad all-feature GPU classification;
- duplicate Vite PID/trap code;
- stale Tauri dependency/config references;
- helpers or dependencies made unreachable by the corrected paths.

Do not delete historical ADRs or completed plans.

- [ ] **Step 5: Verify and commit**

Run: `./scripts/format.sh`

Run: `./scripts/ci.sh quality`

Expected: no obsolete live host references, unused code, workflow policy, or
dependency failures.

```bash
git add 'docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/kickoffprompt.md' 'docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/README.md' docs/implementation-roadmap.md README.md AGENTS.md CLAUDE.md scripts/lib.sh scripts/ci-policy.test.sh
git commit -m "docs(architecture): remove obsolete Tauri guidance"
```

### Task 11: Run final acceptance and bump 2.0.1

**Files:**

- Modify only if a real failure requires a fix: files owned by Tasks 1–10
- Modify through wrapper: synchronized version manifests and README cache key

- [ ] **Step 1: Review repository state before broad gates**

Run: `git status --short`

Run: `git diff --check`

Run: `git diff 02b6228 --stat`

Confirm no unrelated file was staged or modified and no temporary package,
benchmark, export, or Vite artifact is tracked.

- [ ] **Step 2: Run deterministic local acceptance**

Run: `./scripts/format.sh`

Run: `./scripts/format.sh --check`

Run: `./scripts/test.sh policy`

Run: `./scripts/test.sh host`

Run: `./scripts/test.sh desktop`

Run: `./scripts/test.sh frontend`

Run: `./scripts/test.sh gpu`

Run: `./scripts/test.sh native-e2e`

Run: `./scripts/test.sh full`

Run: `./scripts/ci.sh all`

Expected: all PASS. Record each command and result. Fix root causes; do not
change floors, cardinalities, or exclusions.

- [ ] **Step 3: Run developer and package acceptance where supported**

Run and manually close: `./scripts/run.sh native --software-gpu`

Expected: workbench opens, native CSV ingest draws pixels, pan/zoom respond,
and port 4173 is free after exit.

Run: `./scripts/test.sh desktop package`

Expected on Ubuntu/FHS: PASS through the actual package executable. On NixOS,
record generic package execution as unsupported if the dynamic loader blocks
it; do not substitute Nix Electron.

- [ ] **Step 4: Run hardware acceptance**

Run on a supported real GPU: `./scripts/test.sh bench e2e`

Expected: both `mc1000` and `dense10k` pass with production `app://`, exact
series counts, nonblank pixels, interaction floors, residency invariants,
bounded draw calls, completed picks, and successful recovery.

If the available host is software or unsupported, retain the failed diagnostic
report and state that hardware acceptance remains open. Do not mark the plan
complete or bump the version until a real adapter passes.

- [ ] **Step 5: Confirm all package platforms in CI**

Require successful package/smoke jobs for:

```text
Linux x64
Windows x64
macOS x64
macOS arm64
```

Inspect uploaded artifact listings through the repository's release-assets
script. A skipped platform is not success.

- [ ] **Step 6: Bump only after every acceptance gate**

Run: `./scripts/version.sh bump patch`

Run: `./scripts/version.sh check`

Expected: Cargo workspace/crates, frontend, desktop, help text, and README demo
cache key all report 2.0.1.

Run: `./scripts/format.sh`

Run: `./scripts/ci.sh all`

- [ ] **Step 7: Commit the final version separately**

Review the explicit version diff, then stage only the files changed by the
version wrapper.

```bash
git commit -m "chore(release): bump Electron corrections to 2.0.1"
```

- [ ] **Step 8: Final handoff**

Report:

- commits and changed subsystems;
- every validation command and result;
- manual NixOS developer-launch result;
- package smoke result per OS;
- hardware adapter and both benchmark reports;
- any unrelated work left unstaged.

Do not claim completion if hardware or any package platform remains skipped,
untested, or failing.

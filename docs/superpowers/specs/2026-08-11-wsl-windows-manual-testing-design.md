# WSL manual testing via Windows artifacts — design

**Date:** 2026-08-11
**Status:** Accepted

## Problem

Manual (human) testing of the Electron + WebGPU workbench is impossible from
WSL2 today:

- The WSLg 1.0.73 regression (missing `/mnt/shared_memory`,
  microsoft/wslg#1456) breaks Chromium shared-image presentation. Wayland
  fails Skia context creation; X11 presents a white surface. The workbench
  runs (SwiftShader frames complete) but the plot canvas never appears.
- Independently of that regression, WSL2 has never provided hardware WebGPU
  to Chromium; in-WSL runs were always SwiftShader-only.

The developer machine is Windows + WSL2. Manual testing must regularly
exercise **real hardware WebGPU**, and the developer will not install or
maintain any toolchain on the Windows side. The existing Windows package
pipeline (`scripts/build-windows.sh` via `./scripts/ci.sh windows`) currently
runs only in the CI package matrix on main pushes.

## Decisions (locked)

1. Hardware GPU is required regularly, not only at release time.
2. Nothing new is installed on Windows; only prebuilt artifacts run there.
3. Web mode stays `BakedPlane`/snapshot-based. No browser-to-host bridge, no
   browser ingest. Real-data inspection in a browser uses exported
   self-contained snapshots.
4. `./scripts/run.sh native` remains the developer authority on Linux/macOS
   hosts with working displays; it is not redesigned.

## Design

### 1. Command surface (`scripts/run.sh`)

- **`run.sh web`** — mechanics unchanged (Vite on `127.0.0.1:4173`,
  `BakedPlane` demo manifest). Help text and the startup banner gain WSL
  guidance: open the printed URL in the **Windows** browser for hardware
  WebGPU (WSL2 localhost forwarding), and open exported self-contained
  snapshot HTML files directly in a Windows browser for read-only real-data
  inspection. No new data plumbing.
- **`run.sh windows [--fresh] [--ref <branch>] [-- <app args>]`** — new mode.
  Produces and launches the real Windows package on the Windows side of a
  WSL machine without any Windows-side installation:
  1. Requires `gh` (authenticated) and a WSL environment for the launch step.
  2. Verifies `HEAD` is pushed to its upstream; fails with a clear message
     otherwise. `--ref` targets another pushed branch.
  3. Reuses the newest successful `windows-dev.yml` run for the exact HEAD
     SHA when one exists; `--fresh` forces a new dispatch. Otherwise
     dispatches the workflow and waits for completion, surfacing the run URL.
  4. Downloads the `release-windows-x64` artifact and extracts
     `win-unpacked/` into a per-SHA cache directory under
     `%LOCALAPPDATA%\SignalScopeDev\<short-sha>` (resolved through interop).
     The cache keeps the three most recent SHAs and prunes older entries.
  5. Launches `signalscope.exe` through WSL→Windows interop, forwarding
     `-- <app args>` unchanged (e.g. `--user-data-dir` for isolation).
- **`run.sh native`** — unchanged on Linux/macOS. Under WSL (detected via
  `WSL_DISTRO_NAME` or `/proc/version`) it fails early, naming the WSLg
  regression and pointing at `run.sh windows` and `run.sh web`.
  `SIGNALSCOPE_ALLOW_WSL_GUI=1` bypasses the guard (for a fixed WSLg or
  SwiftShader debugging).

### 2. Workflow `.github/workflows/windows-dev.yml`

`workflow_dispatch` only, any branch. One job with the same steps as the
`ci.yml` Windows matrix row: checkout → `./scripts/ci.sh windows` → upload
`desktop/release` as `release-windows-x64` (`if-no-files-found: error`).
`build-windows.sh` already includes the package smoke test, so a green run
proves the artifact boots. No CI gates precede it: this is a development
artifact path, not a release path. The release pipeline is untouched.

### 3. Implementation split

- New `scripts/windows-run.mjs` owns orchestration (pushed-SHA check, run
  lookup, dispatch, watch, download, extract, cache prune, interop launch).
  `run.sh` only routes arguments, mirroring the `native-dev.mjs` pattern.
- Pure helpers — run matching by SHA, cache-prune selection, WSL↔Windows
  path conversion, argument parsing — are exported and unit-tested without
  network in `scripts/windows-run.test.mjs`, wired into
  `./scripts/test.sh policy` like `process-supervisor.test.mjs`.
- `scripts/ci-policy.test.sh` gains assertions that `windows-dev.yml` is
  dispatch-only and that its `run:` steps invoke exactly one repository
  script (the existing workflow policy must pass over the new file).

### 4. Documentation

`AGENTS.md` and `README.md` command tables gain the `windows` run mode and a
note that direct WSLg GUI execution is unsupported (fail-early). No ADR: the
two-host `DataPlane` architecture, protocol, packaging, and release flow are
unchanged.

## Out of scope

- Browser↔host web mode (declined; snapshots only).
- Local cross-compilation of Windows artifacts from WSL.
- Any Windows-side installation (toolchains, runners, X servers).
- The Task 11 hardware `bench e2e` acceptance gate — still requires a full
  checkout + toolchain on a real-GPU machine and remains open.

## Acceptance

- On WSL: `./scripts/run.sh native` fails early with the guidance message;
  `SIGNALSCOPE_ALLOW_WSL_GUI=1 ./scripts/run.sh native` behaves as before.
- On WSL with a pushed branch: `./scripts/run.sh windows` ends with the
  packaged workbench visibly rendering on the Windows desktop with hardware
  WebGPU; a second invocation on the same SHA skips the CI build.
- `./scripts/test.sh policy` covers the new helper tests and workflow
  policy; `./scripts/ci.sh quality` passes.
- `./scripts/run.sh web` prints the Windows-browser guidance under WSL.

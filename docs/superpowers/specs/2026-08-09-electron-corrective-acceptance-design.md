# Electron Corrective Acceptance Design

**Status:** Approved corrective design

**Supersedes:** Incorrect completion claims in the four Electron migration
phases. ADR 0040 and the Electron architecture design remain authoritative.

## Goal

Make the merged Electron architecture dependable on NixOS and the supported
package platforms, then make repository scripts and CI prove the same runtime
that users receive. The correction preserves Electron, the Rust host,
`NativePlane`, `BakedPlane`, and the WebGPU-only series renderer.

## Decisions

1. `scripts/` remains the public developer and CI API. Shell wrappers stay
   small; cross-platform path and process behavior may use focused Node helpers.
2. Every public command has one owner for each child process. A Vite server is
   never started independently by both a wrapper and Playwright.
3. `./scripts/run.sh native` launches the `desktop` Electron application from
   its absolute directory, waits for Electron, and always terminates its Vite
   child. Existing listeners on port 4173 are errors, not silently reused.
4. Development, integration, benchmark, and packaged paths use Electron
   43.2.0. The Nix shell version must equal `desktop/package.json`; version
   drift fails a deterministic check.
5. Native integration tests use SwiftShader and real Rust operations. They
   exercise the workbench UI and prove nonblank native-data pixels, rather than
   calling `NativePlane` alone.
6. Package smoke tests launch the packaged executable without
   `SIGNALSCOPE_HOST_BIN`, `SIGNALSCOPE_RESOURCE_DIR`, or an alternate Electron
   binary. Every OS proves startup and host handshake; Linux also proves the
   software-WebGPU native-data frame.
7. Hardware benchmarks use an isolated profile, release Rust host, production
   frontend, exact Electron version, and a preinstalled one-panel benchmark
   workspace selecting `response @*`. `mc1000` must draw exactly 1,000 series;
   `dense10k` must draw exactly 10,000.
8. Hardware classification uses the selected adapter and WebGPU-specific
   status. Disabled unrelated Chromium GPU features do not imply software
   rendering. SwiftShader, llvmpipe, Lavapipe, WARP, and explicit software mode
   remain disqualifying.
9. Performance reports require measured nonblank pixels, frame and interaction
   floors, stable residency, bounded draw calls, pick completions, and device
   recovery. Unsupported hardware exits before timing with complete evidence.
10. JSON requests are limited to 16 MiB. `/v1/export/file` alone accepts at
    most 1 GiB and streams the framed payload to an adjacent temporary file,
    calls `sync_all`, and renames only after the complete frame succeeds.
11. CI package jobs build and smoke the matching artifact on Linux x64,
    Windows x64, macOS x64, and macOS arm64. Tagging and publishing depend on
    the aggregate required gate and successful packages.
12. Historical ADRs and plans may describe Tauri. Live source, scripts,
    workflows, instructions, implementation roadmap, and design handoff must
    describe Electron only. The quality gate encodes this boundary.
13. The merged `2.0.0` version is not reverted. The corrective PR ends with a
    synchronized patch bump to `2.0.1` after every required gate passes.

## Script contract

| Command                   | Authority            | Required outcome                                                |
| ------------------------- | -------------------- | --------------------------------------------------------------- |
| `run.sh web`              | Vite                 | Browser development server                                      |
| `run.sh native`           | wrapper              | Vite + Electron + debug Rust host, cleaned together             |
| `test.sh host`            | Cargo                | Rust host/server behavior                                       |
| `test.sh desktop`         | Vitest               | Electron helpers and policy                                     |
| `test.sh native-e2e`      | Playwright           | SwiftShader Electron + real Rust + UI pixels                    |
| `test.sh desktop package` | packaged executable  | Resource-relative startup outside checkout                      |
| `test.sh gpu`             | Chromium SwiftShader | Renderer correctness and pixel fidelity                         |
| `test.sh bench e2e`       | Electron hardware    | Release native corpus performance or honest unsupported failure |
| `ci.sh all`               | repository wrappers  | Format, quality, Rust, frontend, browser, GPU, native E2E       |
| `ci.sh build`             | electron-builder     | Current-OS package plus package smoke in CI                     |

`quick` remains the fast Rust/frontend gate. `full` includes desktop unit,
browser E2E, GPU, and native E2E. Hardware benchmarking and cross-OS packaging
remain explicit because they require suitable hosts.

## Acceptance

- The reported NixOS launcher failure has an automated regression test and
  `./scripts/run.sh native` opens the desktop package directory.
- Exiting or failing Electron leaves no Vite listener on port 4173.
- `CI=1 ./scripts/test.sh native-e2e` passes without port conflicts.
- Native E2E displays nonblank pixels sourced through the Rust host.
- Package smoke uses the packaged executable and default resource discovery.
- Hardware benchmark either passes on a real adapter or fails before timing
  with adapter diagnostics; it cannot pass on a blank frame or software GPU.
- A near-limit streamed export has bounded server memory and partial uploads
  leave neither destination nor temporary file.
- Workflow commands use repository scripts, package artifacts are inspected,
  and release tagging cannot bypass failed required jobs.
- Live-tree deletion checks find no obsolete host implementation or guidance.
- Version manifests finish synchronized at `2.0.1`.

# Electron Migration Phase 3: Packaging and Tauri Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove native capability parity, package Electron plus the Rust host
on every supported OS, and remove the entire Tauri implementation and toolchain.

**Architecture:** Electron-builder packages platform-native Rust binaries and
the shared frontend. Repository scripts remain the only build/release API; CI
builds on each target OS rather than cross-compiling the Rust host.

**Tech Stack:** electron-builder 26.15.7, Electron 43.2.0, GitHub Actions,
Nix, AppImage, deb, rpm, NSIS, DMG.

## Global Constraints

- Complete Phases 1 and 2 first.
- Do not delete Tauri until the parity test in Task 1 passes.
- Delete obsolete code; do not leave aliases, deprecated wrappers, or commented files.
- Preserve historical ADRs/plans; live docs and instructions must describe Electron.
- Package the Rust host outside `asar` and resolve it only through `process.resourcesPath`.
- Each OS runner builds its own Rust target and matching Electron artifact.
- Do not bump the application version in this phase.

---

### Task 1: Prove native capability parity before deletion

**Files:**

- Expand: `frontend/tests/e2e/electron-native.spec.ts`
- Create: `frontend/tests/e2e/electron-native-export.spec.ts`
- Modify: `scripts/test.sh`
- Test fixtures: existing files under `frontend/tests/e2e/fixtures/`

**Interfaces:**

- Consumes: Electron bridge, NativePlane, Rust host.
- Produces: one `native-e2e` gate covering every former Tauri capability.

- [ ] **Step 1: Add failing parity scenarios**

Using isolated config/cache/resource directories, cover:

1. source file picker response and folder scan;
2. CLI/second-instance/drop ingest classification;
3. batch start/status/detail/cancel/release;
4. container introspection and recipe write;
5. list formats/sources/signals and binary tile/sample queries;
6. derived signal and bundle create/remove;
7. autosave, explicit session save/load, reset, restore/reconcile;
8. preferences and effective recipe directory;
9. HTML estimate/write and offline open;
10. raw PNG/CSV exact-path and directory writes;
11. malformed host response, host crash, and graceful child shutdown.

Mock only the Electron OS dialog result. Do not mock NativePlane, HTTP, or Rust.

- [ ] **Step 2: Run and preserve failure**

Run: `./scripts/test.sh native-e2e`

Expected: FAIL on any missing parity behavior.

- [ ] **Step 3: Fix only parity defects**

Change Electron bridge, NativePlane, server routes, or host operations only
where the test identifies a mismatch. Do not add Tauri fallback calls.

- [ ] **Step 4: Verify parity**

Run: `./scripts/test.sh native-e2e`

Run: `./scripts/test.sh shell`

Expected: both PASS before deletion.

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/e2e scripts/test.sh desktop frontend/src host
git commit -m "test(desktop): prove native capability parity"
```

### Task 2: Package Electron and the Rust host

**Files:**

- Create: `desktop/electron-builder.yml`
- Modify: `desktop/scripts/start.mjs`
- Create: `desktop/scripts/stage.mjs`
- Modify: `desktop/package.json`
- Create: `desktop/assets/icons/icon.icns`
- Create: `desktop/assets/icons/icon.ico`
- Create: `desktop/assets/icons/icon.png`
- Modify: `scripts/build.sh`
- Modify: `scripts/lib.sh`
- Modify: `.gitignore`

**Interfaces:**

- Produces staged layout:

```text
build/desktop-stage/
  bin/signalscope-host[.exe]
  frontend/index.html
  frontend/assets/*
  frontend/snapshot-template.html
```

- Produces artifacts under `desktop/release/`.

- [ ] **Step 1: Write a failing staging check**

`stage.mjs --check` must verify: host exists and is executable where relevant;
frontend entry and snapshot template exist; package/frontend/host versions are
equal; no symlink escapes staging; and no Tauri file is included.

Run: `./scripts/build.sh native --dir`

Expected: FAIL because packaging config/staging is absent.

- [ ] **Step 2: Stage release inputs through scripts**

`build.sh native` runs release Rust host build, frontend build, desktop
TypeScript build, `stage.mjs`, then electron-builder. `--dir` forwards to
electron-builder for an unpacked smoke package. Do not invoke Cargo/pnpm from
workflows directly.

- [ ] **Step 3: Configure electron-builder**

Use app id `dev.signalscope.workbench`, product `SignalScope`, `asar: true`,
`npmRebuild: false`, and explicit `files`/`extraResources`. Configure:

```text
linux: AppImage, deb, rpm; category Science
win: nsis; x64; per-machine false
mac: dmg; x64 or arm64 from runner; hardenedRuntime true
```

Artifact names include product, version, OS, and architecture. The executable
is `signalscope`; the child remains `signalscope-host[.exe]`.

- [ ] **Step 4: Implement a Nix-safe development launcher**

Verify `start.mjs` still uses absolute `SIGNALSCOPE_ELECTRON_BIN` when set and
the installed Electron package path elsewhere. Keep `electron_43` in the Nix
dev shell and its exported binary path so NixOS never executes an unpatched
npm Electron binary. Add a launcher test to the unpacked-package smoke.

- [ ] **Step 5: Build and inspect an unpacked package**

Run: `./scripts/build.sh native --dir`

Run: `./scripts/test.sh desktop package`

The test launches the unpacked app with temporary directories, verifies host
handshake and nonblank software-WebGPU pixels, then inspects resources for the
exact staged files and absence of development source.

- [ ] **Step 6: Commit**

```bash
git add desktop scripts/build.sh scripts/lib.sh .gitignore flake.nix flake.lock
git commit -m "build(desktop): package Electron with native Rust host"
```

### Task 3: Replace platform build and release workflows

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/actions/setup/action.yml`
- Modify: `scripts/ci.sh`
- Rewrite: `scripts/build-appimage.sh`
- Rewrite: `scripts/build-windows.sh`
- Modify: `scripts/release.sh`
- Modify: `scripts/ci-policy.test.sh`
- Delete: `scripts/setup-appimage.sh`

**Interfaces:**

- Produces CI package matrix and release asset discovery under
  `desktop/release`.

- [ ] **Step 1: Update policy tests first**

Assert every workflow build command calls `scripts/`; release assets accept
`.AppImage`, `.deb`, `.rpm`, `.dmg`, and `-setup.exe`; no target/bundle path or
Tauri installer command remains; package jobs upload at least one artifact.

- [ ] **Step 2: Run and preserve failure**

Run: `./scripts/test.sh policy`

Expected: FAIL on current Tauri paths.

- [ ] **Step 3: Replace platform scripts**

`build-appimage.sh` becomes a focused Linux wrapper around
`build.sh native --linux AppImage`; it requires Linux but no WebKitGTK,
linuxdeploy, or Ubuntu-only setup. `build-windows.sh` installs locked pnpm
dependencies through `setup.sh`, builds through `build.sh native --win nsis
--x64`, and maps existing certificate secrets to electron-builder signing
variables. No global Tauri CLI install remains.

- [ ] **Step 4: Replace CI package matrix**

Use these runners:

```text
ubuntu-24.04       linux x64
windows-2025       windows x64
macos-26-intel     macOS x64
macos-26           macOS arm64
```

Each job runs its matching `./scripts/ci.sh` mode, launches the unpacked smoke
package where supported, and uploads only `desktop/release` artifacts. Keep
quality/test jobs on Linux. Do not claim signing/notarization when secrets are
absent.

- [ ] **Step 5: Update release discovery**

Keep exact accepted suffixes, reject directories and zero-byte files, sort
deterministically, and include architecture-labelled DMGs independently.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh policy`

Run: `./scripts/ci.sh quality`

Run: `./scripts/build.sh native --dir`

Expected: PASS.

```bash
git add .github scripts desktop
git commit -m "ci(desktop): build Electron packages on every target OS"
```

### Task 4: Delete Tauri and its dependencies completely

**Files:**

- Delete: `shell/`
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `flake.nix`
- Modify: `flake.lock`
- Modify: `.gitignore`
- Modify: `scripts/run.sh`
- Modify: `scripts/test.sh`
- Modify: `scripts/build.sh`
- Modify: `scripts/ci.sh`
- Modify: `scripts/version.mjs`
- Modify: `scripts/ci-policy.test.sh`

**Interfaces:**

- Removes `test.sh shell` and every Tauri command/toolchain path without alias.

- [ ] **Step 1: Add a failing live-tree deletion gate**

Extend `quality_checks()` to search live source/config locations while
excluding `docs/adr/` and `docs/superpowers/` history:

```text
shell/src-tauri
TauriPlane
__TAURI_INTERNALS__
cargo tauri
@tauri-apps
tauri-build
tauri-plugin
webkit2gtk
WebKitGTK
```

Run: `./scripts/ci.sh quality`

Expected: FAIL and list current live matches.

- [ ] **Step 2: Delete the shell directory**

Delete every file under `shell/`. Before deletion, copy only the three required
Electron icons in Task 2; do not retain mobile, Store, ACL, schema, config,
Rust source, or generated assets.

- [ ] **Step 3: Remove Rust and Nix dependencies**

Remove `shell/src-tauri` from workspace members and remove Tauri/Wry/plugin
lock entries through normal Cargo resolution. Remove cargo-tauri, WebKitGTK,
GTK/Tauri-only Linux packages, and obsolete shell hook variables from the Nix
shell. Retain Chromium for Playwright and `electron_43` for desktop development.

- [ ] **Step 4: Remove script and version compatibility**

Delete `test.sh shell`; remove Tauri branches from run/build/CI scripts;
replace the Tauri manifest in version synchronization with
`desktop/package.json` and electron-builder metadata. Do not accept old CLI
names as aliases.

- [ ] **Step 5: Regenerate and verify deletion**

Run: `./scripts/setup.sh --update-lock`

Run: `./scripts/test.sh host`

Run: `./scripts/test.sh desktop`

Run: `./scripts/ci.sh quality`

Expected: PASS and no live deletion-gate matches.

- [ ] **Step 6: Commit**

Stage explicit files and the deleted `shell/` only:

```bash
git add Cargo.toml Cargo.lock flake.nix flake.lock package.json pnpm-lock.yaml pnpm-workspace.yaml desktop scripts .gitignore
git add -u shell
git commit -m "refactor(desktop): delete Tauri and system webview host"
```

### Task 5: Make live documentation and agent rules authoritative

**Files:**

- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/implementation-roadmap.md`
- Modify: `docs/adr/README.md`
- Modify: nearest architecture diagrams/readmes outside historical plans

**Interfaces:**

- Produces one current architecture vocabulary: Electron, NativePlane,
  scope-host, scope-server, BakedPlane.

- [ ] **Step 1: Update public commands and invariants**

Replace Tauri shell/test/build wording, preserve script-first policy, state
that Electron is thin and Rust owns data/files, and document hardware versus
software WebGPU authority. Remove the old AppImage exception and WebKitGTK
setup instructions.

- [ ] **Step 2: Update roadmap truthfully**

Record host replacement as complete only if Tasks 1–4 pass. State the actual
native E2E and package matrix results; do not convert software rendering into
a performance claim.

- [ ] **Step 3: Preserve ADR history**

Do not rewrite accepted historical ADRs. Ensure ADR 0040 and its supersession
links make old host wording unambiguous.

- [ ] **Step 4: Verify documentation and commit**

Run: `./scripts/format.sh`

Run: `./scripts/ci.sh quality`

Expected: PASS.

```bash
git add AGENTS.md CLAUDE.md README.md docs/implementation-roadmap.md docs/adr
git commit -m "docs(architecture): make Electron desktop host authoritative"
```

### Task 6: Run the cross-layer phase gate

**Files:** no intended source changes except fixes directly required by failed gates.

- [ ] **Step 1: Run deterministic local gates**

```text
./scripts/format.sh
./scripts/format.sh --check
./scripts/test.sh host
./scripts/test.sh desktop
./scripts/test.sh frontend
./scripts/test.sh gpu
./scripts/test.sh native-e2e
./scripts/test.sh e2e
./scripts/build.sh web
./scripts/build.sh native --dir
./scripts/ci.sh all
```

Expected: all PASS.

- [ ] **Step 2: Verify staged and unpacked artifacts**

Inspect staged/unstaged diffs separately. Launch the unpacked Electron app
outside the repository current directory and load the roundtrip fixture. Check
that its child path and snapshot template resolve from package resources.

- [ ] **Step 3: Record platform limits**

Record only packages actually built on this host. Cross-OS artifacts are
accepted from their CI matrix jobs; do not claim local Windows/macOS execution.

## Phase 3 acceptance gate

- Tauri, Wry, WebKitGTK, and all old shell files are absent from the live tree.
- Native capability parity passes through Electron and Rust.
- Linux, Windows, macOS x64, and macOS arm64 package jobs are defined through scripts.
- An unpacked package starts outside the checkout and locates its Rust host/resources.
- Live docs and agent rules describe only the new architecture.
- No version bump has occurred; Phase 4 owns final acceptance and 2.0.0.

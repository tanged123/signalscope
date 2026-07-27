# Windows NSIS Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut a signed Windows NSIS installer as part of the automated SignalScope release, gating the release tag on its success.

**Architecture:** Windows becomes the second deliberate non-Nix build path, modeled exactly on the existing AppImage exception: a dedicated `scripts/build-windows.sh` that sources its toolchain from npm instead of `nix develop`, dispatched from `build.sh`/`ci.sh` before `ensure_dev_shell` runs. A new `windows` job on `windows-latest` uploads `release-windows-nsis`, and `release.sh` learns to recognize `*-setup.exe` as a publishable asset. Authenticode signing is env-gated: when the certificate secrets are present the script imports the PFX and passes the resulting thumbprint to Tauri via `--config`; when they are absent it warns and produces an unsigned installer, so CI stays green before a certificate exists.

**Tech Stack:** Bash (Git Bash on Windows), Tauri 2.11 CLI (`@tauri-apps/cli@2.11.4`), NSIS bundler, GitHub Actions, `signtool` via Tauri's `certificateThumbprint`, pnpm 10.27.0.

## Global Constraints

- Every workflow shell command must call a `./scripts/` wrapper. Do not add ad-hoc `cargo`/`pnpm`/`npm` steps to `ci.yml`.
- New and modified shell scripts must pass `shellcheck scripts/*.sh` and `treefmt` (shfmt, `indent_size = 2`).
- New and modified workflow files must pass `actionlint` and `zizmor .github/workflows/ .github/actions/`.
- `.github/zizmor.yml` requires `hash-pin` for every action except `actions/*`, `cachix/*`, `codecov/*`. **Add no new third-party actions** — `windows-latest` ships preinstalled Rust, Node, and npm, exactly as the `appimage` job relies on for Linux.
- JSON files must be Prettier-formatted (2-space indent) to pass the `flake` gate.
- Pinned tool versions, copied verbatim from `scripts/build-appimage.sh`: `@tauri-apps/cli@2.11.4`, `pnpm@10.27.0`.
- `pnpm install --frozen-lockfile` works unchanged on Windows: `pnpm-lock.yaml` already carries the `@esbuild/win32-x64@0.25.12` and `@rollup/rollup-win32-x64-msvc@4.62.2` optional variants. Do not regenerate the lockfile.
- Bundle target is **NSIS only** (`--bundles nsis`). No MSI.
- WebView2 install mode stays Tauri's default `downloadBootstrapper` — the installer is allowed to require a network connection.
- Windows is **build-only**. Do not add test, lint, coverage, or e2e jobs on `windows-latest`; the quality gates stay on `ubuntu-latest`.
- The `windows` job gates the release: it must appear in `needs:` for both the `tag` and `publish` jobs.
- Release asset glob must match `*-setup.exe`, not `*.exe`, so a bare binary can never be published by accident.
- Signing secret names: `WINDOWS_CERTIFICATE` (base64-encoded PFX) and `WINDOWS_CERTIFICATE_PASSWORD`.
- Final change on the branch must be `./scripts/version.sh bump patch` followed by `./scripts/version.sh check` (build/CI tooling → patch).

**Verification honesty:** none of Tasks 1–4 can be functionally verified on Linux or WSL. The Linux-reachable checks are the platform guard, `shellcheck`, `treefmt`, `actionlint`, `zizmor`, and `./scripts/ci-policy.test.sh`. The first real Windows build happens on the first push to a branch with `workflow_dispatch` or on `main`. Say so in the handoff; do not claim the installer was tested.

---

### Task 1: Windows build script and its platform guard

**Files:**

- Create: `scripts/build-windows.sh`
- Create: `shell/src-tauri/tauri.windows.conf.json`
- Modify: `scripts/build.sh` (add a `windows` mode beside the existing `appimage` dispatch at line 24, and its help text)
- Modify: `scripts/ci.sh` (add a `windows` mode to the pre-`ensure_dev_shell` case block, and its help text)
- Test: `scripts/ci-policy.test.sh`

**Interfaces:**

- Consumes: `signalscope_scripts_dir` from `scripts/lib.sh`.
- Produces: `./scripts/build-windows.sh` (no arguments required; extra args forwarded to `tauri build`), reachable as `./scripts/build.sh windows` and `./scripts/ci.sh windows`. Exits 1 with `Windows installer builds require Windows with Git Bash.` on any non-Windows `uname -s`. On success writes `target/release/bundle/nsis/*-setup.exe`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/ci-policy.test.sh`, immediately before the `if [ "$failures" -ne 0 ]` block:

```bash
# The Windows installer script must refuse to run anywhere but Windows.
case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*) ;;
*) expect_status 1 "$script_dir/build-windows.sh" ;;
esac
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/ci-policy.test.sh`
Expected: FAIL — `expected exit 1, got 127: .../build-windows.sh` (the script does not exist yet), then a non-zero exit.

- [ ] **Step 3: Create the Windows platform config**

Tauri automatically merges `tauri.windows.conf.json` with `tauri.conf.json` on Windows builds. This file holds only the signing parameters that are inert until a certificate thumbprint is supplied in Task 4.

Create `shell/src-tauri/tauri.windows.conf.json`:

```json
{
  "bundle": {
    "windows": {
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

- [ ] **Step 4: Create the Windows build script**

Create `scripts/build-windows.sh`. This deliberately mirrors `scripts/build-appimage.sh`: it does not source `lib.sh`, because `ensure_dev_shell` would re-exec into `nix develop`, which does not exist on `windows-latest`.

```bash
#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
tool_root="$project_root/build/windows-tools"

case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*) ;;
*)
  echo "Windows installer builds require Windows with Git Bash." >&2
  exit 1
  ;;
esac

for command_name in cargo node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

mkdir -p "$tool_root"
npm install \
  --no-package-lock \
  --no-save \
  --prefix "$tool_root" \
  @tauri-apps/cli@2.11.4 \
  pnpm@10.27.0

export PATH="$tool_root/node_modules/.bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

cd "$project_root"
pnpm install --frozen-lockfile

cd "$project_root/shell/src-tauri"
exec tauri build --bundles nsis "$@"
```

Then make it executable:

```bash
chmod +x scripts/build-windows.sh
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `./scripts/ci-policy.test.sh`
Expected: PASS — `CI policy tests passed.`

- [ ] **Step 6: Add the `windows` dispatch to `build.sh`**

In `scripts/build.sh`, immediately after the existing `appimage` block (currently lines 24–27, ending with the `exec "$signalscope_scripts_dir/build-appimage.sh" "$@"` line and its closing `fi`), add:

```bash
if [ "$mode" = "windows" ]; then
  shift || true
  exec "$signalscope_scripts_dir/build-windows.sh" "$@"
fi
```

This must stay above `ensure_dev_shell "$@"` for the same reason the AppImage branch does.

In the same file's `show_help` heredoc, change the usage line and add the mode description:

```text
Usage: ./scripts/build.sh [native|appimage|windows|web] [additional arguments]
```

and after the `appimage` description block, before the `web` line:

```text
  windows
          Build the Windows NSIS installer. Runs outside the Nix shell using
          Git Bash and the runner-provided Rust, Node, and npm toolchain.
```

- [ ] **Step 7: Add the `windows` dispatch to `ci.sh`**

In `scripts/ci.sh`, inside the first `case "$mode" in` block (the one above `ensure_dev_shell` that already handles `flake` and `appimage`), add before its closing `esac`:

```bash
windows)
  exec "$signalscope_scripts_dir/build-windows.sh"
  ;;
```

In `show_help`, change the usage line to:

```text
Usage: ./scripts/ci.sh [all|flake|format|quality|rust|frontend|e2e|build|appimage|windows]
```

and add after the `appimage` description line:

```text
  windows   Windows-only NSIS installer build; runs outside the Nix shell.
```

- [ ] **Step 8: Verify the guards and formatting**

```bash
./scripts/build.sh windows; echo "exit=$?"
./scripts/ci.sh windows; echo "exit=$?"
```

Expected: both print `Windows installer builds require Windows with Git Bash.` and `exit=1`.

```bash
nix develop --command shellcheck scripts/*.sh .github/hooks/pre-commit
nix fmt -- scripts/build-windows.sh scripts/build.sh scripts/ci.sh scripts/ci-policy.test.sh shell/src-tauri/tauri.windows.conf.json
git diff --stat
```

Expected: shellcheck silent; `nix fmt` either reports no change or reformats — if it reformats, keep the reformatted result.

- [ ] **Step 9: Commit**

```bash
git add scripts/build-windows.sh scripts/build.sh scripts/ci.sh scripts/ci-policy.test.sh shell/src-tauri/tauri.windows.conf.json
git commit -m "build: add Windows NSIS installer build script"
```

---

### Task 2: Publish NSIS installers as release assets

**Files:**

- Modify: `scripts/release.sh:60-72` (the `publish` function's asset discovery), plus `show_help`
- Test: `scripts/ci-policy.test.sh`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `./scripts/release.sh assets <dir>` — prints every publishable asset path under `<dir>`, NUL-separated, sorted. `publish` consumes it. Recognized extensions: `.deb`, `.rpm`, `.AppImage`, `.dmg`, `-setup.exe`.

The `assets` subcommand exists so the glob is testable without network access or a GitHub token; `publish` itself cannot be exercised in the policy test because it calls `gh release create`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/ci-policy.test.sh`, before the `if [ "$failures" -ne 0 ]` block:

```bash
windows_asset_dir="$(mktemp -d)"
: >"$windows_asset_dir/SignalScope_0.3.3_x64-setup.exe"
: >"$windows_asset_dir/signalscope-shell.exe"
listed="$("$script_dir/release.sh" assets "$windows_asset_dir" | tr -d '\0')"
if [ "$listed" != "$windows_asset_dir/SignalScope_0.3.3_x64-setup.exe" ]; then
  printf 'release assets must list the NSIS installer and nothing else, got: %s\n' "$listed" >&2
  failures=$((failures + 1))
fi
```

The existing cleanup trap only calls `rmdir`, which cannot remove the now-populated directories. Replace the existing trap line

```bash
trap 'rmdir "$asset_dir"' EXIT
```

with

```bash
trap 'rm -rf "$asset_dir" ${windows_asset_dir:+"$windows_asset_dir"}' EXIT
```

The `${windows_asset_dir:+...}` form omits the argument entirely when the variable
is unset, so an early exit before the new block cannot make `rm` fail inside the
trap and change the script's exit status.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./scripts/ci-policy.test.sh`
Expected: FAIL — `Unknown release mode: assets` on stderr and `release assets must list the NSIS installer and nothing else, got:` with an empty value.

- [ ] **Step 3: Extract and extend asset discovery**

In `scripts/release.sh`, add this function immediately above `publish()`:

```bash
assets() {
  local asset_dir="${1:-}"
  if [ -z "$asset_dir" ]; then
    echo "assets requires a staged asset directory" >&2
    exit 2
  fi
  if [ ! -d "$asset_dir" ]; then
    echo "asset directory does not exist: $asset_dir" >&2
    exit 1
  fi

  find "$asset_dir" -type f \
    \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.dmg' \
    -o -name '*-setup.exe' \) -print0 | sort -z
}
```

Then replace the `mapfile`/`find` block inside `publish` (currently lines 64–71) with:

```bash
  mapfile -d '' release_assets < <(assets "$asset_dir")
  if [ "${#release_assets[@]}" -eq 0 ]; then
    echo "no release assets found in $asset_dir" >&2
    exit 1
  fi
```

and update the `gh` invocation two lines below from `"${assets[@]}"` to `"${release_assets[@]}"`:

```bash
  gh release create "$tag" "${release_assets[@]}" \
    --verify-tag \
    --title "SignalScope $tag" \
    --generate-notes
```

The rename matters: an array named `assets` would shadow the function.

- [ ] **Step 4: Register the subcommand**

In `scripts/release.sh`, add to the bottom `case "$mode" in` block, above the `-h | --help | help)` arm:

```bash
assets)
  shift
  assets "$@"
  ;;
```

In `show_help`, add to the usage list after the `publish` line:

```text
  assets <dir>            List publishable release assets in a staged directory.
```

and update the trailing paragraph's asset sentence to:

```text
'tag' is strict: it refuses an existing tag and never overwrites release
history. 'publish' expects .deb, .rpm, .AppImage, .dmg, or *-setup.exe files in
the staged asset directory and uses GH_TOKEN for GitHub authentication.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `./scripts/ci-policy.test.sh`
Expected: PASS — `CI policy tests passed.`

- [ ] **Step 6: Verify the pre-existing asset types still resolve**

```bash
d="$(mktemp -d)"
: >"$d/signalscope_0.3.3_amd64.deb"
: >"$d/SignalScope_0.3.3_amd64.AppImage"
: >"$d/SignalScope_0.3.3_x64-setup.exe"
./scripts/release.sh assets "$d" | tr '\0' '\n'
rm -rf "$d"
```

Expected: all three paths listed, one per line, and no other output.

- [ ] **Step 7: Verify formatting**

```bash
nix develop --command shellcheck scripts/*.sh .github/hooks/pre-commit
nix fmt -- scripts/release.sh scripts/ci-policy.test.sh
```

Expected: shellcheck silent.

- [ ] **Step 8: Commit**

```bash
git add scripts/release.sh scripts/ci-policy.test.sh
git commit -m "release: publish Windows NSIS installers"
```

---

### Task 3: Wire the Windows job into CI and gate the tag

**Files:**

- Modify: `.github/workflows/ci.yml` (add a `windows` job after the `appimage` job at line 160; extend `needs:` on `tag` at line 180 and `publish` at line 199)

**Interfaces:**

- Consumes: `./scripts/ci.sh windows` from Task 1; the `release-*` artifact naming contract the `publish` job's `pattern: release-*` download already relies on; the `*-setup.exe` glob from Task 2.
- Produces: an artifact named `release-windows-nsis` containing `target/release/bundle/nsis/*-setup.exe`, and a `windows` job that both `tag` and `publish` depend on.

- [ ] **Step 1: Add the `windows` job**

In `.github/workflows/ci.yml`, insert after the `appimage` job's final line (`          if-no-files-found: error`) and before `  tag:`:

```yaml
windows:
  if: github.event_name != 'pull_request'
  runs-on: windows-latest
  steps:
    - uses: actions/checkout@v4
      with:
        persist-credentials: false
    - uses: ./.github/actions/cargo-cache
      with:
        target-key: windows
    - run: ./scripts/ci.sh windows
      shell: bash
    - uses: actions/upload-artifact@v4
      with:
        name: release-windows-nsis
        path: target/release/bundle/nsis/*-setup.exe
        if-no-files-found: error
```

Three details that are load-bearing:

- `shell: bash` is required. `windows-latest` defaults `run:` steps to `pwsh`, which cannot execute the script.
- There is deliberately **no** `./.github/actions/setup` step. That action installs Nix, which is Linux/macOS-only; `build-windows.sh` provisions its own toolchain from the runner's preinstalled Rust/Node/npm, exactly as the `appimage` job does.
- The artifact name must start with `release-` so the `publish` job's `pattern: release-*` download picks it up.

- [ ] **Step 2: Gate the tag on Windows**

Change the `tag` job's `needs:` line from

```yaml
needs: [version, flake, quality, rust, frontend, e2e, build, appimage]
```

to

```yaml
needs: [version, flake, quality, rust, frontend, e2e, build, appimage, windows]
```

- [ ] **Step 3: Gate publish on Windows**

Change the `publish` job's `needs:` line from

```yaml
needs: [tag, build, appimage]
```

to

```yaml
needs: [tag, build, appimage, windows]
```

- [ ] **Step 4: Verify the workflow lints**

```bash
nix develop --command bash -c 'actionlint && zizmor .github/workflows/ .github/actions/'
```

Expected: no findings. If `zizmor` reports `unpinned-uses`, a third-party action was added — remove it; the policy in `.github/zizmor.yml` only exempts `actions/*`, `cachix/*`, and `codecov/*`.

- [ ] **Step 5: Verify the full deterministic gate**

```bash
./scripts/ci.sh quality
```

Expected: `CI policy tests passed.` from `ci-policy.test.sh` and a clean finish. This is the gate that covers `shellcheck`, `actionlint`, `zizmor`, `typos`, and the policy test together.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build the Windows NSIS installer and gate releases on it"
```

---

### Task 4: Authenticode signing

**Files:**

- Modify: `scripts/build-windows.sh` (insert signing between the `pnpm install` block and the final `exec`)
- Modify: `.github/workflows/ci.yml` (pass the certificate secrets to the `windows` job's build step)

**Interfaces:**

- Consumes: `scripts/build-windows.sh` and the `windows` job from Tasks 1 and 3; `digestAlgorithm`/`timestampUrl` from `shell/src-tauri/tauri.windows.conf.json`.
- Produces: signing behavior driven entirely by two environment variables. When both `WINDOWS_CERTIFICATE` (base64 PFX) and `WINDOWS_CERTIFICATE_PASSWORD` are set, the installer is signed. When either is absent, the script prints `WINDOWS_CERTIFICATE is not set; building an unsigned installer.` to stderr and continues successfully.

The env-gate is what keeps CI green before a certificate is purchased, and keeps local Windows dev builds working for contributors who will never have the cert. A committed `certificateThumbprint` would hard-fail every build without the cert in the store, which is why the thumbprint is injected via `--config` at build time instead.

- [ ] **Step 1: Add signing to the build script**

In `scripts/build-windows.sh`, insert between the `pnpm install --frozen-lockfile` line and the `cd "$project_root/shell/src-tauri"` line:

```bash
# Authenticode signing is opt-in. Without the certificate secrets the build
# still succeeds and produces an unsigned installer, so forks and pre-certificate
# CI runs are not blocked.
signing_config=()
if [ -n "${WINDOWS_CERTIFICATE:-}" ] && [ -n "${WINDOWS_CERTIFICATE_PASSWORD:-}" ]; then
  pfx_path="$tool_root/signing-certificate.pfx"
  printf '%s' "$WINDOWS_CERTIFICATE" | base64 --decode >"$pfx_path"

  thumbprint="$(
    powershell -NoProfile -NonInteractive -Command "
      \$password = ConvertTo-SecureString -String \$env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
      (Import-PfxCertificate -FilePath '$(cygpath -w "$pfx_path")' -CertStoreLocation Cert:\\CurrentUser\\My -Password \$password).Thumbprint
    " | tr -d '\r\n'
  )"
  rm -f "$pfx_path"

  if [ -z "$thumbprint" ]; then
    echo "failed to import the Windows signing certificate" >&2
    exit 1
  fi
  echo "Signing the installer with certificate $thumbprint"
  signing_config=(--config "{\"bundle\":{\"windows\":{\"certificateThumbprint\":\"$thumbprint\"}}}")
else
  echo "WINDOWS_CERTIFICATE is not set; building an unsigned installer." >&2
fi
```

Then change the final line from

```bash
exec tauri build --bundles nsis "$@"
```

to

```bash
exec tauri build --bundles nsis ${signing_config[@]:+"${signing_config[@]}"} "$@"
```

Three details that are load-bearing:

- The password is read inside PowerShell from `$env:WINDOWS_CERTIFICATE_PASSWORD`, never interpolated onto a command line where it could reach a process list or a log.
- `${signing_config[@]:+"${signing_config[@]}"}` is the `set -u`-safe way to expand a possibly-empty array. A bare `"${signing_config[@]}"` aborts on older bash when the array is empty.
- `cygpath -w` converts the Git Bash path to the Windows form `Import-PfxCertificate` requires.

- [ ] **Step 2: Verify the unsigned path still guards correctly on Linux**

```bash
./scripts/build-windows.sh; echo "exit=$?"
./scripts/ci-policy.test.sh
```

Expected: `Windows installer builds require Windows with Git Bash.` with `exit=1`, then `CI policy tests passed.` The platform guard runs before any signing code, so the Linux behavior is unchanged.

- [ ] **Step 3: Verify shellcheck accepts the array expansion**

```bash
nix develop --command shellcheck scripts/*.sh .github/hooks/pre-commit
nix fmt -- scripts/build-windows.sh
```

Expected: shellcheck silent. `SC2086` should not fire on the `${signing_config[@]:+...}` line because the inner expansion is quoted; if it does, add no blanket disable — re-check the quoting first.

- [ ] **Step 4: Pass the secrets in CI**

In `.github/workflows/ci.yml`, change the `windows` job's build step from

```yaml
- run: ./scripts/ci.sh windows
  shell: bash
```

to

```yaml
- env:
    WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
    WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
  run: ./scripts/ci.sh windows
  shell: bash
```

Secrets go through `env:`, never interpolated into the `run:` body — that is what keeps `zizmor`'s template-injection rule quiet and matches how `CODECOV_TOKEN` is handled in the `coverage` job.

- [ ] **Step 5: Verify the workflow lints**

```bash
nix develop --command bash -c 'actionlint && zizmor .github/workflows/ .github/actions/'
```

Expected: no findings.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-windows.sh .github/workflows/ci.yml
git commit -m "build: sign the Windows installer when certificate secrets are present"
```

---

### Task 5: Document the Windows path and bump the version

**Files:**

- Modify: `AGENTS.md:40-58` (canonical command table) and the AppImage-exception paragraph below it
- Modify: `README.md:92-113` (development command list)
- Modify: `Cargo.toml`, `frontend/package.json`, `shell/src-tauri/tauri.conf.json` (via `./scripts/version.sh bump patch`)

**Interfaces:**

- Consumes: the command surface established in Tasks 1–4.
- Produces: no code interfaces. This task closes out the branch.

- [ ] **Step 1: Update the AGENTS.md command table**

In `AGENTS.md`, in the `text` canonical-commands block, change

```text
./scripts/build.sh web|native         frontend or native bundles
```

to

```text
./scripts/build.sh web|native         frontend or native bundles
./scripts/build.sh windows            Windows NSIS installer (Git Bash only)
```

and change

```text
./scripts/release.sh publish <tag> <dir> publish staged release assets
```

to

```text
./scripts/release.sh publish <tag> <dir> publish staged release assets
./scripts/release.sh assets <dir>       list publishable release assets
```

and change

```text
./scripts/ci.sh format|quality|rust|frontend|e2e|build|appimage
```

to

```text
./scripts/ci.sh format|quality|rust|frontend|e2e|build|appimage|windows
```

- [ ] **Step 2: Document the second non-Nix exception**

In `AGENTS.md`, the paragraph beginning "The Nix flake supplies the normal pinned toolchain. AppImage packaging is the intentional exception" now understates the situation. Replace its final sentence — "Do not “fix” that path by reintroducing the known Nix `linuxdeploy` GTK schema mismatch." — with:

```text
Do not “fix” that path by reintroducing the known Nix `linuxdeploy` GTK schema
mismatch. Windows packaging is the second intentional exception: run
`./scripts/build.sh windows` from Git Bash on Windows, where the script sources
its Tauri CLI and pnpm from npm because Nix is unavailable. Windows is
build-only — every quality gate stays on Linux.
```

- [ ] **Step 3: Update the README command list**

In `README.md`, in the development `bash` block, after

```bash
./scripts/build.sh appimage # portable Linux AppImage (Ubuntu/FHS only)
```

add

```bash
./scripts/build.sh windows  # Windows NSIS installer (Git Bash only)
```

- [ ] **Step 4: Verify docs formatting**

```bash
nix fmt -- AGENTS.md README.md
./scripts/ci.sh quality
```

Expected: no reformatting churn beyond your edits; `quality` passes, including `typos`.

- [ ] **Step 5: Commit the documentation**

```bash
git add AGENTS.md README.md
git commit -m "docs: document the Windows installer build path"
```

- [ ] **Step 6: Bump the version**

Build/CI tooling change → `patch`.

```bash
./scripts/version.sh bump patch
./scripts/version.sh check
```

Expected: `check` prints the new synchronized version with no mismatch error. `0.3.3` becomes `0.3.4`.

- [ ] **Step 7: Commit the bump**

```bash
git add Cargo.toml Cargo.lock frontend/package.json shell/src-tauri/tauri.conf.json
git commit -m "chore: bump version to 0.3.4"
```

- [ ] **Step 8: Run the broad gate before handoff**

```bash
./scripts/ci.sh all
```

Expected: format, quality, rust, frontend, artifact, and e2e all pass. Report the result verbatim.

---

## Post-merge follow-ups (not part of this plan)

These need a human with credentials and cannot be done by an implementing agent:

1. **Purchase and upload the certificate.** An OV certificate now requires hardware/HSM storage under CA/B Forum rules, which a plain PFX secret cannot satisfy — most CI signing today uses either a cloud signing service (Azure Trusted Signing, SSL.com eSigner) or an EV token. If the certificate cannot be exported as a PFX, Task 4's import step must be replaced with `bundle.windows.signCommand` pointing at the provider's CLI. Decide the provider before buying.
2. Set repository secrets `WINDOWS_CERTIFICATE` (`base64 -w0 cert.pfx`) and `WINDOWS_CERTIFICATE_PASSWORD`.
3. **Watch the first `main` run.** Until a certificate exists the installer ships unsigned and SmartScreen will warn on download. Reputation also accrues per-certificate, so early signed builds may still warn for a while.
4. **Update the required-check target.** `ci-ok` aggregates only the gate jobs, not `build`/`appimage`/`windows`, so branch protection is unaffected — but confirm that matches intent now that a fourth platform can block a release.

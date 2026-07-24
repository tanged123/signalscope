# CI & Scripts Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop capping CI builds at 2 cargo jobs, share the crate-registry cache across jobs, deduplicate the hand-rolled cache block in the appimage job, run the packaging/release half of CI only on `main` (not every PR), and derive `version.mjs`'s crate list from `Cargo.toml` instead of a third hardcoded enumeration.

**Architecture:** A tiny composite action `.github/actions/cargo-cache` owns both cargo caches (shared registry key + per-profile target key) and is consumed by the setup action and the appimage job. Packaging jobs (`build`, `appimage`, and their dependents `tag`, `publish`) gate on non-PR events, with `workflow_dispatch` added so packaging can be exercised on demand. `version.mjs` reads workspace membership from the manifests that define it.

**Tech Stack:** GitHub Actions (composite actions), bash, Node ESM.

## Global Constraints

- **No dependency on Plans 01–05** — this plan can run first or in parallel. Sole overlap: Plan 01 Step 6 edits the hardcoded list in `scripts/version.mjs` that Task 4 here deletes; whichever lands second resolves a one-hunk conflict in favor of this plan's derivation.
- CI behavior can only be fully verified on a pushed branch — each task states what to check in the Actions UI of its PR. Local verification is `./scripts/ci.sh <mode>` plus shell/YAML review.
- Do NOT delete the release pipeline (tag/publish/appimage) — it was built deliberately (see git history); this plan only moves it off the per-PR hot path.
- Commit messages lowercase imperative.

---

### Task 1: Cap cargo jobs only for local runs

**Files:**

- Modify: `scripts/lib.sh:13`

**Interfaces:**

- Produces: in CI (`$CI` set — GitHub Actions always sets it), cargo uses all runner cores; locally the 2-job default remains so a dev machine stays responsive. An explicit `CARGO_BUILD_JOBS` still wins everywhere.

- [ ] **Step 1: Make the default conditional**

In `ensure_dev_shell()` replace:

```bash
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
```

with:

```bash
# Keep local machines responsive; let CI runners use every core.
if [ -z "${CI:-}" ]; then
  export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
fi
```

- [ ] **Step 2: Verify locally, then commit**

Run: `./scripts/test.sh core` — Expected: PASS (behavior unchanged locally).

```bash
git add scripts/lib.sh
git commit -m "cap cargo build jobs only outside ci"
```

After push: the `rust` job's log should show cargo compiling with more than 2 parallel units (compare wall-clock against the previous run of the same job).

---

### Task 2: Shared cargo-cache composite action

**Files:**

- Create: `.github/actions/cargo-cache/action.yml`
- Modify: `.github/actions/setup/action.yml`, `.github/workflows/ci.yml` (appimage job)

**Interfaces:**

- Produces: `./.github/actions/cargo-cache` with one input `target-key` (empty skips the target cache). The registry/git cache key is shared by ALL jobs (it holds downloaded crates + index, identical across profiles); only the `target` directory stays per-profile.

- [ ] **Step 1: Write the composite action** — `.github/actions/cargo-cache/action.yml`:

```yaml
name: Cargo caches
description: >-
  Restore the crate registry cache shared by every job and, when target-key
  is set, a per-profile target-directory cache.

inputs:
  target-key:
    description: Per-profile target cache key. Empty skips the target cache.
    default: ""

runs:
  using: composite
  steps:
    - uses: actions/cache@v4
      with:
        path: |
          ~/.cargo/registry
          ~/.cargo/git
        key: cargo-registry-${{ runner.os }}-${{ hashFiles('Cargo.lock') }}
        restore-keys: |
          cargo-registry-${{ runner.os }}-
    - if: inputs.target-key != ''
      uses: actions/cache@v4
      with:
        path: target
        key: cargo-target-${{ inputs.target-key }}-${{ runner.os }}-${{ hashFiles('Cargo.lock', 'flake.lock') }}
        restore-keys: |
          cargo-target-${{ inputs.target-key }}-${{ runner.os }}-
```

- [ ] **Step 2: Use it from the setup action**

In `.github/actions/setup/action.yml`, replace the whole `- if: inputs.cargo-cache-key != ''` cache step (paths registry+git+target under one key) with:

```yaml
- if: inputs.cargo-cache-key != ''
  uses: ./.github/actions/cargo-cache
  with:
    target-key: ${{ inputs.cargo-cache-key }}
```

Update the `cargo-cache-key` input description to: "Per-profile key for the target-directory cache. Empty disables Cargo caching."

- [ ] **Step 3: Use it from the appimage job**

In `.github/workflows/ci.yml`, replace the appimage job's inline `- uses: actions/cache@v4` block (the hand-rolled duplicate) with:

```yaml
- uses: ./.github/actions/cargo-cache
  with:
    target-key: appimage
```

- [ ] **Step 4: Commit and verify on the PR**

```bash
git add .github/actions/cargo-cache/action.yml .github/actions/setup/action.yml .github/workflows/ci.yml
git commit -m "share the cargo registry cache across ci jobs"
```

On the pushed PR, check the Actions run: each rust-compiling job restores `cargo-registry-…` (same key everywhere) and its own `cargo-target-<key>-…`; no job re-downloads the crates.io index after the first populated run.

---

### Task 3: Run packaging only off the PR hot path

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Produces: `build` and `appimage` run on `main` pushes and manual `workflow_dispatch`, not on every PR; `tag`/`publish` (already `main`-gated / dependent) are unaffected on `main`. The PR gate keeps `version`, `flake`, `rust`, `frontend`, `e2e`, `coverage`.

- [ ] **Step 1: Add the manual trigger**

In the `on:` block, add:

```yaml
on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:
```

- [ ] **Step 2: Gate the two packaging jobs**

Add to BOTH the `build` job and the `appimage` job, directly under the job key:

```yaml
if: github.event_name != 'pull_request'
```

- [ ] **Step 3: Keep `tag` correct for dispatch runs**

`tag` currently has `if: github.ref == 'refs/heads/main'`, which also covers `workflow_dispatch` runs from `main` — leave it. `publish` runs only via `needs: [tag, …]` — leave it. No other edit.

- [ ] **Step 4: Commit and verify**

```bash
git add .github/workflows/ci.yml
git commit -m "run packaging jobs on main and manual dispatch only"
```

On the pushed PR: `build` and `appimage` show as "skipped"; the six check jobs run. After merge to `main`: the full pipeline including packaging runs. (Trade-off, accepted in the audit: packaging regressions surface on `main`/dispatch instead of per-PR — use `workflow_dispatch` on a branch when touching bundling code.)

---

### Task 4: Derive the crate list in `version.mjs` from the workspace manifest

**Files:**

- Modify: `scripts/version.mjs`

**Interfaces:**

- Produces: `workspacePackageNames()` reads `[workspace] members` from the root `Cargo.toml` and each member's `name`, replacing the hardcoded `Set` at `scripts/version.mjs:8-16`. Adding/renaming a crate no longer silently breaks `./scripts/version.sh check`.

- [ ] **Step 1: Replace the hardcoded set**

Delete:

```js
const workspacePackageNames = new Set([
  "scope-compute",
  "scope-ingest",
  "scope-pyramid",
  "scope-session",
  "scope-store",
  "scope-protocol",
  "signalscope-shell",
]);
```

Add in its place (the file already imports `readFile` and `resolve`):

```js
async function workspacePackageNames() {
  const cargo = await readFile(releaseFiles.cargo, "utf8");
  const members = /\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/.exec(
    cargo,
  );
  if (!members) throw new Error("Cargo.toml has no [workspace] members list");
  const names = new Set();
  for (const [, member] of members[1].matchAll(/"([^"]+)"/g)) {
    const manifest = await readFile(
      resolve(repositoryRoot, member, "Cargo.toml"),
      "utf8",
    );
    const name = /^name\s*=\s*"([^"]+)"\s*$/m.exec(manifest);
    if (!name) throw new Error(`${member}/Cargo.toml has no package name`);
    names.add(name[1]);
  }
  return names;
}
```

Note the function is now async and takes no arguments. `releaseFiles.cargo` is declared below the old set in the current file — move the `releaseFiles` declaration above this function so it is in scope.

- [ ] **Step 2: Update the call sites**

Find every use of `workspacePackageNames` in the file (currently: `lockVersions` filters lock entries with `workspacePackageNames.has(packageName)`, and the set/replace path asserts `replacements !== workspacePackageNames.size`). Thread the resolved set through instead: in the top-level command handlers that reach those helpers, add `const packageNames = await workspacePackageNames();` and pass `packageNames` down as a parameter (`lockVersions(text, packageNames)`, etc.). Read the current function bodies and keep their logic byte-for-byte otherwise.

- [ ] **Step 3: Verify all commands**

```bash
./scripts/version.sh get
./scripts/version.sh check
```

Expected: `get` prints `0.1.0`; `check` reports every manifest synchronized (same output as before the change). The two commands above plus CI's `version` job on the pushed PR are sufficient verification — the derivation is exercised on every `check`.

- [ ] **Step 4: Commit**

```bash
git add scripts/version.mjs
git commit -m "derive workspace package names from the cargo manifest"
```

---

### Task 5: Full gate + PR verification checklist

- [ ] **Step 1: Run `./scripts/ci.sh all`** — Expected: PASS (nothing in this plan changes what the local gate covers).

- [ ] **Step 2: Push the branch and confirm in the Actions UI:**
  - `version` job passes (Task 4).
  - `build`/`appimage` are skipped on the PR (Task 3).
  - Compiling jobs restore the shared `cargo-registry-…` cache and use >2 cargo jobs (Tasks 1–2).

- [ ] **Step 3: Hand off** with a note in the PR description that packaging now runs on `main` pushes and `workflow_dispatch` only.

# ChartGPU Submodule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the committed ChartGPU source copy with a pinned Git submodule that local setup and relevant CI jobs initialize automatically.

**Architecture:** Keep `frontend/vendor/chartgpu` as the build path, but replace its tracked tree with a gitlink pinned to ChartGPU revision `671e1c157a6fd9a80df35d5b43795314214569d0`. A focused shell entry point owns initialization, revision validation, and intentional updates; local setup and the shared GitHub setup action call it. Existing Vite, Vitest, TypeScript, formatting, and artifact boundaries remain unchanged.

**Tech Stack:** Git submodules, Bash, GitHub composite actions, Nix/treefmt, Vite, Vitest

## Global Constraints

- Preserve unrelated staged and unstaged work; never use `git add -A`.
- Keep the submodule at `frontend/vendor/chartgpu` and use `https://github.com/ChartGPU/ChartGPU.git`.
- Preserve revision `671e1c157a6fd9a80df35d5b43795314214569d0` during migration.
- The gitlink is the only revision pin; remove `VENDORED_REV.txt`.
- Do not change ChartGPU source, renderer behavior, build output, aliases, or snapshot networking behavior.
- All repository and CI operations go through `scripts/` entry points.
- Do not run GUI, platform-build, or end-to-end checks until Task 5.
- The final repository change is a patch bump from the current target-branch version, followed by `./scripts/version.sh check`.

---

### Task 1: ChartGPU submodule lifecycle script

**Files:**

- Create: `scripts/chartgpu-submodule.sh`
- Create: `scripts/chartgpu-submodule.test.sh`

**Interfaces:**

- Consumes: parent-repository gitlink at `frontend/vendor/chartgpu` and `.gitmodules` URL configuration.
- Produces: `./scripts/chartgpu-submodule.sh init`, `check`, and `update <revision>`.

- [ ] **Step 1: Write the failing hermetic script test**

Create `scripts/chartgpu-submodule.test.sh`. It builds local upstream and parent repositories, so it needs no network and does not touch the real submodule.

```bash
#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

git_config() {
  git -C "$1" config user.name "SignalScope test"
  git -C "$1" config user.email "signalscope-test@example.invalid"
}

expect_status() {
  local expected="$1"
  shift
  local actual=0
  "$@" >/dev/null 2>&1 || actual=$?
  [ "$actual" -eq "$expected" ] || {
    printf 'expected exit %s, got %s: %s\n' "$expected" "$actual" "$*" >&2
    exit 1
  }
}

upstream="$test_root/upstream"
parent="$test_root/parent"
checkout="$test_root/checkout"

git init --quiet "$upstream"
git_config "$upstream"
mkdir -p "$upstream/src"
printf 'export const revision = 1;\n' >"$upstream/src/index.ts"
git -C "$upstream" add src/index.ts
git -C "$upstream" commit --quiet -m "first"
first_revision="$(git -C "$upstream" rev-parse HEAD)"
printf 'export const revision = 2;\n' >"$upstream/src/index.ts"
git -C "$upstream" commit --quiet -am "second"
second_revision="$(git -C "$upstream" rev-parse HEAD)"

git init --quiet "$parent"
git_config "$parent"
mkdir -p "$parent/scripts"
cp "$script_dir/chartgpu-submodule.sh" "$parent/scripts/"
git -C "$parent" add scripts/chartgpu-submodule.sh
git -C "$parent" commit --quiet -m "add script"
git -C "$parent" -c protocol.file.allow=always submodule add --quiet \
  "$upstream" frontend/vendor/chartgpu
git -C "$parent/frontend/vendor/chartgpu" checkout --quiet --detach "$first_revision"
git -C "$parent" add .gitmodules frontend/vendor/chartgpu
git -C "$parent" commit --quiet -m "pin submodule"

git clone --quiet --no-recurse-submodules "$parent" "$checkout"

expect_status 1 "$checkout/scripts/chartgpu-submodule.sh" check
uninitialized_output="$test_root/uninitialized-output"
"$checkout/scripts/chartgpu-submodule.sh" check >"$uninitialized_output" 2>&1 || true
grep -Fq "run ./scripts/chartgpu-submodule.sh init" "$uninitialized_output"
GIT_ALLOW_PROTOCOL=file "$checkout/scripts/chartgpu-submodule.sh" init
[ "$(git -C "$checkout/frontend/vendor/chartgpu" rev-parse HEAD)" = "$first_revision" ]
"$checkout/scripts/chartgpu-submodule.sh" check

GIT_ALLOW_PROTOCOL=file \
  "$checkout/scripts/chartgpu-submodule.sh" update "$second_revision"
[ "$(git -C "$checkout/frontend/vendor/chartgpu" rev-parse HEAD)" = "$second_revision" ]
expect_status 1 "$checkout/scripts/chartgpu-submodule.sh" check
mismatch_output="$test_root/mismatch-output"
"$checkout/scripts/chartgpu-submodule.sh" check >"$mismatch_output" 2>&1 || true
grep -Fq "expected $first_revision" "$mismatch_output"
grep -Fq "run ./scripts/chartgpu-submodule.sh init" "$mismatch_output"
git -C "$checkout" diff --quiet -- frontend/vendor/chartgpu && {
  echo "update must leave a reviewable gitlink change" >&2
  exit 1
}

GIT_ALLOW_PROTOCOL=file "$checkout/scripts/chartgpu-submodule.sh" init
"$checkout/scripts/chartgpu-submodule.sh" check

echo "ChartGPU submodule tests passed."
```

Make the test executable:

```bash
chmod +x scripts/chartgpu-submodule.test.sh
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
./scripts/chartgpu-submodule.test.sh
```

Expected: FAIL because `scripts/chartgpu-submodule.sh` does not exist.

- [ ] **Step 3: Implement the lifecycle script**

Create `scripts/chartgpu-submodule.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
submodule_path="frontend/vendor/chartgpu"

cd "$project_root"

usage() {
  cat <<'EOF'
Usage: ./scripts/chartgpu-submodule.sh [init|check|update <revision>]

  init               initialize and check out the recorded ChartGPU revision
  check              verify the initialized checkout matches the gitlink
  update <revision>  fetch and check out a new revision for parent-repo review
EOF
}

recorded_revision() {
  git ls-files --stage -- "$submodule_path" |
    awk '$1 == "160000" { print $2; exit }'
}

check_submodule() {
  local expected actual
  expected="$(recorded_revision)"
  [ -n "$expected" ] || {
    echo "$submodule_path is not recorded as a Git submodule" >&2
    return 1
  }
  [ -e "$submodule_path/.git" ] || {
    echo "$submodule_path is not initialized; run ./scripts/chartgpu-submodule.sh init" >&2
    return 1
  }
  actual="$(git -C "$submodule_path" rev-parse HEAD)"
  [ "$actual" = "$expected" ] || {
    printf '%s is at %s; expected %s\n' "$submodule_path" "$actual" "$expected" >&2
    echo "run ./scripts/chartgpu-submodule.sh init to restore the recorded revision" >&2
    return 1
  }
}

mode="${1:-init}"
case "$mode" in
init)
  [ "$#" -eq 1 ] || { usage >&2; exit 2; }
  git submodule sync -- "$submodule_path"
  git submodule update --init --checkout -- "$submodule_path"
  check_submodule
  ;;
check)
  [ "$#" -eq 1 ] || { usage >&2; exit 2; }
  check_submodule
  ;;
update)
  [ "$#" -eq 2 ] || { usage >&2; exit 2; }
  revision="$2"
  git submodule sync -- "$submodule_path"
  git submodule update --init --checkout -- "$submodule_path"
  git -C "$submodule_path" fetch origin
  resolved="$(git -C "$submodule_path" rev-parse --verify "$revision^{commit}")"
  git -C "$submodule_path" checkout --detach "$resolved"
  printf 'ChartGPU updated to %s; review and stage %s\n' "$resolved" "$submodule_path"
  ;;
-h | --help | help)
  usage
  ;;
*)
  echo "unknown ChartGPU submodule command: $mode" >&2
  usage >&2
  exit 2
  ;;
esac
```

Make the entry point executable:

```bash
chmod +x scripts/chartgpu-submodule.sh
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
./scripts/chartgpu-submodule.test.sh
./scripts/ci.sh quality
```

Expected: both commands PASS; the focused test prints only `ChartGPU submodule tests passed.` and the quality gate shellchecks both files.

- [ ] **Step 5: Commit only the lifecycle files**

```bash
git add scripts/chartgpu-submodule.sh scripts/chartgpu-submodule.test.sh
git diff --cached --check
git commit -m "build: manage the ChartGPU submodule"
```

### Task 2: Replace the source copy with the pinned gitlink

**Files:**

- Create: `.gitmodules`
- Replace: `frontend/vendor/chartgpu` tracked tree with a mode `160000` gitlink
- Delete: `scripts/vendor-chartgpu.sh`
- Modify: `scripts/format.sh`

**Interfaces:**

- Consumes: `scripts/chartgpu-submodule.sh` from Task 1.
- Produces: parent-repository gitlink pinned to `671e1c157a6fd9a80df35d5b43795314214569d0`; unchanged imports at `frontend/vendor/chartgpu/src/index.ts`.

- [ ] **Step 1: Record the pristine current state**

Run:

```bash
test "$(cat frontend/vendor/chartgpu/VENDORED_REV.txt)" = \
  "671e1c157a6fd9a80df35d5b43795314214569d0"
git diff --quiet -- frontend/vendor/chartgpu
```

Expected: PASS. Stop if the copied source has local changes.

- [ ] **Step 2: Replace the tracked tree with the submodule**

Run:

```bash
git rm -r -- frontend/vendor/chartgpu
git submodule add https://github.com/ChartGPU/ChartGPU.git \
  frontend/vendor/chartgpu
git -C frontend/vendor/chartgpu checkout --detach \
  671e1c157a6fd9a80df35d5b43795314214569d0
git add .gitmodules frontend/vendor/chartgpu
git rm scripts/vendor-chartgpu.sh
```

Expected: `.gitmodules` records the HTTPS URL and the index contains one mode `160000` entry for ChartGPU. The one-time branch diff removes the copied source; future diffs show only gitlink revisions.

- [ ] **Step 3: Validate the pin and unchanged import surface**

Run:

```bash
./scripts/chartgpu-submodule.sh check
test "$(git -C frontend/vendor/chartgpu rev-parse HEAD)" = \
  "671e1c157a6fd9a80df35d5b43795314214569d0"
test "$(git ls-files --stage frontend/vendor/chartgpu | awk '{print $1}')" = 160000
test -f frontend/vendor/chartgpu/src/index.ts
rg -n 'vendor/chartgpu/src/index\.ts' frontend/vite.config.ts frontend/vitest.config.ts
```

Expected: all commands PASS and both aliases still target the existing path.

- [ ] **Step 4: Keep the isolated format check out of the nested repository**

In `scripts/format.sh`, stop the temporary archive from recursively copying a
gitlink directory. All ordinary `git ls-files` entries are files; the ChartGPU
gitlink is the directory entry that needs this boundary.

```bash
    tar --null --no-recursion --files-from=- -cf - |
```

- [ ] **Step 5: Prove repository tools leave upstream source pristine**

Run:

```bash
./scripts/format.sh --check
test -z "$(git -C frontend/vendor/chartgpu status --porcelain)"
```

Expected: formatting passes and the nested repository remains clean. Existing
`.prettierignore` and `typos.toml` exclusions continue to cover
`frontend/vendor/**`; no new formatter-specific exclusions are required.

- [ ] **Step 6: Build the frontend from the submodule source**

Run:

```bash
./scripts/build.sh web
```

Expected: TypeScript and Vite compile ChartGPU and produce `frontend/dist/snapshot-template.html`.

- [ ] **Step 7: Commit only the repository-shape migration**

```bash
git add .gitmodules frontend/vendor/chartgpu scripts/vendor-chartgpu.sh \
  scripts/format.sh
git diff --cached --check
git diff --cached --submodule=short --stat
git commit -m "build: pin ChartGPU as a Git submodule"
```

### Task 3: Initialize ChartGPU in local setup and CI

**Files:**

- Modify: `scripts/setup.sh`
- Modify: `scripts/lib.sh`
- Modify: `scripts/ci-policy.test.sh`
- Modify: `.github/actions/setup/action.yml`

**Interfaces:**

- Consumes: `./scripts/chartgpu-submodule.sh init` from Task 1.
- Produces: automatic initialization through local `./scripts/setup.sh`, every CI job using `.github/actions/setup`, and the deterministic quality gate.

- [ ] **Step 1: Add failing CI-policy assertions**

Add after `failures=0` in `scripts/ci-policy.test.sh`:

```bash
setup_script="$script_dir/setup.sh"
setup_action="$script_dir/../.github/actions/setup/action.yml"

if ! grep -Fq '"$signalscope_scripts_dir/chartgpu-submodule.sh" init' "$setup_script"; then
  echo "local setup must initialize the ChartGPU submodule" >&2
  failures=$((failures + 1))
fi
if ! grep -Fq 'run: ./scripts/chartgpu-submodule.sh init' "$setup_action"; then
  echo "the shared CI setup action must initialize ChartGPU" >&2
  failures=$((failures + 1))
fi
```

- [ ] **Step 2: Run the policy test to verify it fails**

Run:

```bash
./scripts/ci-policy.test.sh
```

Expected: FAIL with both new initialization messages.

- [ ] **Step 3: Wire local setup**

In `scripts/setup.sh`, call the lifecycle script after `ensure_dev_shell` and before pnpm:

```bash
ensure_dev_shell "$@"

"$signalscope_scripts_dir/chartgpu-submodule.sh" init
pnpm install --frozen-lockfile
```

- [ ] **Step 4: Wire the shared GitHub setup action**

In `.github/actions/setup/action.yml`, add this unconditional step after Nix/Cachix setup and before the conditional frontend install:

```yaml
- run: ./scripts/chartgpu-submodule.sh init
  shell: bash
```

Do not add `submodules:` to every `actions/checkout` call. Jobs that require ChartGPU already use the shared action; version, aggregation, tagging, and artifact-only publishing jobs do not need it.

- [ ] **Step 5: Add the lifecycle test to the quality source of truth**

Add this line to `quality_checks()` in `scripts/lib.sh` after `shellcheck`:

```bash
  "$signalscope_scripts_dir/chartgpu-submodule.test.sh"
```

- [ ] **Step 6: Run the focused checks**

Run:

```bash
./scripts/chartgpu-submodule.test.sh
./scripts/ci-policy.test.sh
./scripts/ci.sh quality
```

Expected: all PASS. `actionlint` and `zizmor` validate the composite action, and the lifecycle test runs once through the quality gate.

- [ ] **Step 7: Commit the setup and CI wiring**

```bash
git add scripts/setup.sh scripts/lib.sh scripts/ci-policy.test.sh \
  .github/actions/setup/action.yml
git diff --cached --check
git commit -m "ci: initialize the ChartGPU submodule"
```

### Task 4: Record the source-delivery decision

**Files:**

- Create: `docs/adr/0040-chartgpu-submodule-delivery.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/superpowers/specs/2026-08-12-chartgpu-browser-renderer-design.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: final script name, submodule path, URL, and pin from Tasks 1–3.
- Produces: an accepted superseding record for the source-delivery portion of ADR 0039 and user-facing setup documentation.

- [ ] **Step 1: Add ADR 0040**

Create `docs/adr/0040-chartgpu-submodule-delivery.md`:

```markdown
# ADR 0040: ChartGPU submodule delivery

- Status: Accepted
- Date: 2026-08-16

## Context

ADR 0039 pinned ChartGPU by committing a copied subset of its source under
`frontend/vendor/chartgpu`. That made ordinary clones self-contained but added
about 68,000 upstream lines to the SignalScope tree and made revision changes
appear as repository source diffs.

## Decision

Keep ChartGPU at `frontend/vendor/chartgpu`, but represent it as a Git submodule
of `https://github.com/ChartGPU/ChartGPU.git`. The parent repository's gitlink is
the only revision pin. SignalScope continues to import ChartGPU's TypeScript and
WGSL source through the existing Vite and Vitest aliases.

`./scripts/chartgpu-submodule.sh` owns initialization, validation, and updates.
`./scripts/setup.sh` and the shared GitHub setup action initialize the submodule
before commands that need its source.

## Consequences

A normal development setup and relevant CI jobs require network access the first
time the submodule is initialized. A raw clone that bypasses `./scripts/setup.sh`
does not contain ChartGPU source. In return, upstream source no longer inflates
ordinary SignalScope diffs, and a ChartGPU update is a reviewable gitlink change.

This supersedes only the source-delivery portion of ADR 0039. Its renderer scope,
revision choice, data flow, capture behavior, and fork triggers remain accepted.
```

- [ ] **Step 2: Index the ADR and amend the historical design**

Add to `docs/adr/README.md`:

```markdown
40. [ChartGPU submodule delivery](0040-chartgpu-submodule-delivery.md)
```

Append to `docs/superpowers/specs/2026-08-12-chartgpu-browser-renderer-design.md`:

```markdown
## Amendment (2026-08-16, source delivery)

ADR 0040 supersedes amendment 7's copied-source mechanism. ChartGPU remains at
the same pinned revision and path, but `frontend/vendor/chartgpu` is a Git
submodule initialized by repository setup and CI. The Vite/Vitest source aliases
and offline snapshot bundle are unchanged.
```

- [ ] **Step 3: Update README setup language**

Change the renderer paragraph to say `pinned ChartGPU submodule`, and change the Development command comment to:

```text
./scripts/setup.sh          # initialize ChartGPU and install locked dependencies
```

- [ ] **Step 4: Format and validate documentation**

Run:

```bash
./scripts/format.sh
./scripts/format.sh --check
rg -n "ChartGPU submodule|chartgpu-submodule" README.md docs/adr/0040-chartgpu-submodule-delivery.md \
  docs/superpowers/specs/2026-08-12-chartgpu-browser-renderer-design.md
```

Expected: formatting passes and each document names the submodule delivery mechanism. Review `git diff` after formatting and do not stage unrelated formatted files.

- [ ] **Step 5: Commit only the documentation**

```bash
git add README.md docs/adr/README.md \
  docs/adr/0040-chartgpu-submodule-delivery.md \
  docs/superpowers/specs/2026-08-12-chartgpu-browser-renderer-design.md
git diff --cached --check
git commit -m "docs: record ChartGPU submodule delivery"
```

### Task 5: Final validation and version bump

**Files:**

- Modify through script: `Cargo.toml`, `Cargo.lock`, `frontend/package.json`, and synchronized version-bearing files reported by `./scripts/version.sh bump patch`

**Interfaces:**

- Consumes: completed Tasks 1–4 and the latest target-branch version.
- Produces: a fully validated patch release with synchronized manifests.

- [ ] **Step 1: Audit scope before finalization**

Run:

```bash
git status --short
git diff --submodule=short
git diff --cached --submodule=short
git submodule status frontend/vendor/chartgpu
./scripts/chartgpu-submodule.sh check
```

Expected: ChartGPU shows revision `671e1c157a6fd9a80df35d5b43795314214569d0` without a `+`, `-`, or `U` prefix. Identify and leave all unrelated user changes unstaged.

- [ ] **Step 2: Run pre-release checks**

Run:

```bash
./scripts/format.sh
./scripts/ci.sh flake
./scripts/ci.sh quality
./scripts/test.sh frontend
```

Expected: all PASS. The frontend build proves that an initialized submodule supplies the same TypeScript/WGSL bundle.

- [ ] **Step 3: Reconcile with the latest target version and bump patch**

Fetch the target branch without merging unrelated work, inspect its version, then bump from the current synchronized version:

```bash
git fetch origin main
./scripts/version.sh check
./scripts/version.sh bump patch
./scripts/version.sh check
```

Expected: version `1.0.1` if `origin/main` and the current branch still use `1.0.0`; otherwise the next patch after the reconciled target version.

- [ ] **Step 4: Run the completed-plan gates**

Run only now, after the full implementation and version bump:

```bash
./scripts/format.sh --check
./scripts/ci.sh all
./scripts/ci.sh build
```

Expected: formatting, quality, Rust, frontend, artifact, Playwright, smoke, and application build checks PASS. Report any platform limitation rather than claiming an unrun native GUI check.

- [ ] **Step 5: Commit only the synchronized version files**

Inspect `git diff --name-only` from the bump, then stage exactly those paths:

```bash
./scripts/version.sh check
git diff --check
git commit -m "chore: bump version to 1.0.1" -- \
  Cargo.toml Cargo.lock frontend/package.json \
  frontend/src/ui/app-shell.ts README.md
```

Replace `1.0.1` in the commit subject if the reconciled target version differs. Do not use a blanket add.

- [ ] **Step 6: Final handoff audit**

Run:

```bash
git status --short
git log --oneline --decorate -6
git submodule status frontend/vendor/chartgpu
./scripts/version.sh check
```

Expected: implementation files are committed, ChartGPU is at the recorded gitlink, versions are synchronized, and only pre-existing unrelated work remains staged or unstaged.

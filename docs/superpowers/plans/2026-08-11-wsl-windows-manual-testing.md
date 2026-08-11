# WSL Manual Testing via Windows Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a WSL2 developer manually test the real Windows package on real
hardware WebGPU with `./scripts/run.sh windows`, and fail `run.sh native`
early under WSL with actionable guidance.

**Architecture:** A new dispatch-only workflow
`.github/workflows/windows-dev.yml` reuses `./scripts/ci.sh windows` to build
and smoke the Windows package on any branch. A new `scripts/windows-run.mjs`
(same split as `native-dev.mjs`: `run.sh` routes, the `.mjs` orchestrates)
finds or dispatches the run via `gh`, downloads `release-windows-x64`, stages
`win-unpacked` into a per-SHA cache under `%LOCALAPPDATA%\SignalScopeDev`, and
launches `signalscope.exe` through WSL interop. `run.sh` gains a WSL GUI
guard and Windows-browser guidance for web mode.

**Tech Stack:** Bash, Node.js 22 (`node --test`), GitHub CLI (`gh`), GitHub
Actions (windows-2025 runner), WSL interop (`cmd.exe`, `wslpath`).

## Global Constraints

- Accepted design: `docs/superpowers/specs/2026-08-11-wsl-windows-manual-testing-design.md`.
- Nothing is installed on the Windows side; only prebuilt artifacts run there.
- Web mode stays `BakedPlane`/snapshot-based; no browser↔host bridge, no
  browser ingest.
- `run.sh native` behavior on Linux/macOS is unchanged; the WSL guard bypass
  is exactly `SIGNALSCOPE_ALLOW_WSL_GUI=1`.
- The release pipeline (`ci.yml` build matrix, tag, publish) is untouched.
- `scripts/` remains the only public command surface; every workflow `run:`
  step invokes one repository script.
- The artifact name is `release-windows-x64`; the launched executable is
  `win-unpacked/signalscope.exe`; the cache keeps the 3 most recent SHAs.
- Preserve user worktree changes; stage only the files each task names.
- All commit messages end with
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Dispatch-only Windows dev workflow, gated by policy tests

**Files:**

- Create: `.github/workflows/windows-dev.yml`
- Modify: `scripts/ci-policy.test.sh` (workflow section, after the
  `bench.yml` check near line 110)

**Interfaces:**

- Produces: workflow `windows-dev.yml` with one job `build` that uploads
  artifact `release-windows-x64` containing the contents of
  `desktop/release` (including `win-unpacked/signalscope.exe`). Task 4
  depends on the workflow file name and artifact name exactly.

- [ ] **Step 1: Add failing policy assertions**

In `scripts/ci-policy.test.sh`, directly after the existing `bench.yml`
check (the `rg -n 'bench e2e|electron-hardware' "$workflow_root/bench.yml"`
block), add:

```bash
windows_dev="$workflow_root/windows-dev.yml"
if [ ! -f "$windows_dev" ]; then
  echo "windows-dev.yml must exist for run.sh windows" >&2
  failures=$((failures + 1))
else
  windows_dev_triggers=$(sed -n '/^on:/,/^permissions:/p' "$windows_dev")
  if ! grep -q 'workflow_dispatch' <<<"$windows_dev_triggers" ||
    rg -n 'push:|pull_request:|schedule:' <<<"$windows_dev_triggers" >/dev/null; then
    echo "windows-dev.yml must trigger on workflow_dispatch only" >&2
    failures=$((failures + 1))
  fi
  if ! grep -Fq './scripts/ci.sh windows' "$windows_dev"; then
    echo "windows-dev.yml must build through ./scripts/ci.sh windows" >&2
    failures=$((failures + 1))
  fi
  if ! grep -Fq 'name: release-windows-x64' "$windows_dev" ||
    ! grep -Fq 'path: desktop/release' "$windows_dev"; then
    echo "windows-dev.yml must upload desktop/release as release-windows-x64" >&2
    failures=$((failures + 1))
  fi
fi
```

Note: `failures` and `workflow_root` already exist in this script; reuse
them.

- [ ] **Step 2: Run policy to verify it fails**

Run: `./scripts/test.sh policy`

Expected: FAIL with `windows-dev.yml must exist for run.sh windows`.

- [ ] **Step 3: Create the workflow**

Create `.github/workflows/windows-dev.yml`:

```yaml
name: SignalScope Windows dev build

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: windows-2025
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - run: ./scripts/ci.sh windows
        shell: bash
      - uses: actions/upload-artifact@v7
        with:
          name: release-windows-x64
          path: desktop/release
          if-no-files-found: error
```

Deliberately no signing secrets: `build-windows.sh` already prints
"building an unsigned installer" and proceeds, and dev artifacts extracted
by WSL onto `/mnt/c` carry no mark-of-the-web, so unsigned is fine.
`ci.sh windows` includes the package smoke
(`test.sh desktop package --no-build`), so a green run proves the artifact
boots.

- [ ] **Step 4: Verify policy and workflow linters pass**

Run: `./scripts/test.sh policy`

Expected: PASS.

Run: `actionlint && zizmor .github/workflows/ .github/actions/`

Expected: no findings on `windows-dev.yml`. (Both tools are in the dev
shell; run them directly for a fast loop — the final task runs the full
`ci.sh quality` gate.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/windows-dev.yml scripts/ci-policy.test.sh
git commit -m "ci(windows): add dispatch-only Windows dev build

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Push the branch**

Run: `git push`

The dispatch API only sees workflow files that exist on the pushed branch;
Task 5's manual acceptance needs this push. If the user has asked you not
to push, note this dependency in the handoff instead.

---

### Task 2: WSL GUI guard and web-mode guidance in `run.sh`

**Files:**

- Modify: `scripts/lib.sh` (append after `run_gui_command`, near line 40)
- Modify: `scripts/run.sh` (`native` and `web` cases, and `show_help`)
- Modify: `scripts/ci-policy.test.sh` (run.sh section, after the existing
  `grep -Fq 'native-dev.mjs'` check near line 15)

**Interfaces:**

- Produces: `is_wsl` (exit 0 under WSL) and `guard_wsl_gui` (exit 3 with
  guidance under WSL unless `SIGNALSCOPE_ALLOW_WSL_GUI=1`) in
  `scripts/lib.sh`. Task 5's docs reference this behavior.

- [ ] **Step 1: Add failing policy assertions**

In `scripts/ci-policy.test.sh`, after the `grep -Fq 'native-dev.mjs'`
check on `run.sh`, add:

```bash
if ! grep -Fq 'guard_wsl_gui' "$script_dir/run.sh"; then
  echo "run.sh native must guard against unsupported WSLg presentation" >&2
  failures=$((failures + 1))
fi
expect_status 3 env WSL_DISTRO_NAME=PolicyTest SIGNALSCOPE_ALLOW_WSL_GUI= \
  bash -c "source '$script_dir/lib.sh'; guard_wsl_gui"
expect_status 0 env WSL_DISTRO_NAME=PolicyTest SIGNALSCOPE_ALLOW_WSL_GUI=1 \
  bash -c "source '$script_dir/lib.sh'; guard_wsl_gui"
```

Note: `expect_status` is defined around line 48 of the current file, which
is _after_ the run.sh section. Place these two `expect_status` calls after
its definition (next to the other `expect_status` uses), keeping the `grep`
check in the run.sh section. Do not test the non-WSL negative case — it
would be environment-dependent (this dev machine IS WSL).

- [ ] **Step 2: Run policy to verify it fails**

Run: `./scripts/test.sh policy`

Expected: FAIL with `run.sh native must guard...` and one
`expected exit 3, got 127` from the missing `guard_wsl_gui` function.

- [ ] **Step 3: Implement the helpers in `scripts/lib.sh`**

Append after `run_gui_command`:

```bash
is_wsl() {
  if [ -n "${WSL_DISTRO_NAME:-}" ]; then
    return 0
  fi
  grep -qi microsoft /proc/version 2>/dev/null
}

# WSLg 1.0.73 cannot present Chromium's GPU surface (microsoft/wslg#1456),
# and WSL has no hardware WebGPU regardless, so a native run there shows a
# blank plot at best.
guard_wsl_gui() {
  if [ "${SIGNALSCOPE_ALLOW_WSL_GUI:-}" = 1 ]; then
    return 0
  fi
  if ! is_wsl; then
    return 0
  fi
  cat >&2 <<'EOF'
run.sh native is unsupported under WSL: WSLg cannot present the Electron
WebGPU surface (microsoft/wslg#1456), and WSL has no hardware WebGPU.

Use instead:
  ./scripts/run.sh windows   build this branch in CI, then launch the real
                             Windows package on this machine
  ./scripts/run.sh web       then open http://127.0.0.1:4173 in your
                             WINDOWS browser for hardware WebGPU

Set SIGNALSCOPE_ALLOW_WSL_GUI=1 to bypass this guard.
EOF
  return 3
}
```

- [ ] **Step 4: Wire the guard and banner into `scripts/run.sh`**

In the `native)` case, immediately after `shift || true` (before argument
parsing and builds):

```bash
  guard_wsl_gui || exit "$?"
```

In the `web)` case, before `exec pnpm dev "$@"`:

```bash
  if is_wsl; then
    cat <<'EOF'
WSL detected: open http://127.0.0.1:4173 in your WINDOWS browser to get
hardware WebGPU (the WSL browser and WSLg cannot). Exported self-contained
snapshot HTML files also open directly in the Windows browser.
EOF
  fi
```

In `show_help`, replace the last line of the heredoc
(`Use ./scripts/run.sh native --software-gpu for SwiftShader integration runs.`)
with:

```text
Use ./scripts/run.sh native --software-gpu for SwiftShader integration runs.

Under WSL, native is unsupported (WSLg cannot present the WebGPU surface);
use ./scripts/run.sh windows or open web mode in the Windows browser.
Set SIGNALSCOPE_ALLOW_WSL_GUI=1 to bypass the guard.
EOF
```

- [ ] **Step 5: Verify**

Run: `./scripts/test.sh policy`

Expected: PASS.

Run: `shellcheck scripts/lib.sh scripts/run.sh`

Expected: clean.

Run: `./scripts/run.sh native`

Expected on this WSL machine: exits 3 immediately with the guidance
message, no builds started.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib.sh scripts/run.sh scripts/ci-policy.test.sh
git commit -m "fix(scripts): fail native runs early under WSL

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `windows-run.mjs` pure helpers (TDD)

**Files:**

- Create: `scripts/windows-run.mjs` (helpers only in this task; the main
  orchestration body is Task 4)
- Create: `scripts/windows-run.test.mjs`
- Modify: `scripts/ci-policy.test.sh` (line 8 area, next to
  `node --test "$script_dir/process-supervisor.test.mjs"`)

**Interfaces:**

- Produces (consumed by Task 4's main body in the same file):

```js
export const CACHE_LIMIT = 3;
export function parseWindowsRunArguments(argv):
  { fresh: boolean; ref: string | null; appArguments: string[] };
export function isWsl(environment, procVersion): boolean;
export function chooseRun(runs, headSha):
  { run: Run | null; action: "reuse" | "watch" | "dispatch" };
// Run = { databaseId, headSha, status, conclusion, createdAt } as returned
// by: gh run list --json databaseId,headSha,status,conclusion,createdAt
export function pruneSelection(entries, keepName, limit = CACHE_LIMIT):
  string[];
// entries = [{ name: string, mtimeMs: number }]
```

- [ ] **Step 1: Write the failing tests**

Create `scripts/windows-run.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseRun,
  isWsl,
  parseWindowsRunArguments,
  pruneSelection,
} from "./windows-run.mjs";

test("parse defaults", () => {
  assert.deepEqual(parseWindowsRunArguments([]), {
    fresh: false,
    ref: null,
    appArguments: [],
  });
});

test("parse flags and app arguments", () => {
  assert.deepEqual(
    parseWindowsRunArguments([
      "--fresh",
      "--ref",
      "feature/x",
      "--",
      "--user-data-dir=C:\\tmp\\ss",
    ]),
    {
      fresh: true,
      ref: "feature/x",
      appArguments: ["--user-data-dir=C:\\tmp\\ss"],
    },
  );
});

test("parse rejects unknown and malformed arguments", () => {
  assert.throws(() => parseWindowsRunArguments(["--wat"]), /unknown argument/);
  assert.throws(() => parseWindowsRunArguments(["--ref"]), /--ref requires/);
  assert.throws(
    () => parseWindowsRunArguments(["--ref", "--fresh"]),
    /--ref requires/,
  );
});

test("isWsl detects distro name, proc version, and neither", () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, ""), true);
  assert.equal(isWsl({}, "Linux version 6.6-microsoft-standard-WSL2"), true);
  assert.equal(isWsl({}, "Linux version 6.6-generic"), false);
});

const run = (overrides) => ({
  databaseId: 1,
  headSha: "abc",
  status: "completed",
  conclusion: "success",
  createdAt: "2026-08-11T00:00:00Z",
  ...overrides,
});

test("chooseRun reuses the newest matching success", () => {
  const old = run({ databaseId: 1, createdAt: "2026-08-10T00:00:00Z" });
  const newer = run({ databaseId: 2, createdAt: "2026-08-11T00:00:00Z" });
  assert.deepEqual(chooseRun([old, newer], "abc"), {
    run: newer,
    action: "reuse",
  });
});

test("chooseRun watches an in-progress matching run", () => {
  const active = run({ status: "in_progress", conclusion: null });
  assert.deepEqual(chooseRun([active], "abc"), {
    run: active,
    action: "watch",
  });
});

test("chooseRun dispatches on no match or newest failure", () => {
  assert.deepEqual(chooseRun([], "abc"), { run: null, action: "dispatch" });
  assert.deepEqual(chooseRun([run({ headSha: "other" })], "abc"), {
    run: null,
    action: "dispatch",
  });
  const failed = run({ conclusion: "failure" });
  assert.deepEqual(chooseRun([failed], "abc"), {
    run: null,
    action: "dispatch",
  });
});

test("pruneSelection keeps the current entry plus the two newest others", () => {
  const entries = [
    { name: "aaa", mtimeMs: 100 },
    { name: "bbb", mtimeMs: 300 },
    { name: "ccc", mtimeMs: 200 },
    { name: "ddd", mtimeMs: 400 },
    { name: "cur", mtimeMs: 50 },
  ];
  assert.deepEqual(pruneSelection(entries, "cur"), ["ccc", "aaa"]);
});

test("pruneSelection deletes nothing under the limit", () => {
  assert.deepEqual(pruneSelection([{ name: "cur", mtimeMs: 1 }], "cur"), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/windows-run.test.mjs`

Expected: FAIL — cannot find module `./windows-run.mjs`.

- [ ] **Step 3: Implement the helpers**

Create `scripts/windows-run.mjs`:

```js
export const CACHE_LIMIT = 3;

export function parseWindowsRunArguments(argv) {
  const result = { fresh: false, ref: null, appArguments: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      result.appArguments = argv.slice(index + 1);
      break;
    }
    if (argument === "--fresh") {
      result.fresh = true;
      continue;
    }
    if (argument === "--ref") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--ref requires a branch name");
      }
      result.ref = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

export function isWsl(environment, procVersion) {
  if ((environment.WSL_DISTRO_NAME ?? "") !== "") return true;
  return /microsoft/i.test(procVersion);
}

export function chooseRun(runs, headSha) {
  const matching = runs
    .filter((run) => run.headSha === headSha)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const newest = matching[0];
  if (newest === undefined) return { run: null, action: "dispatch" };
  if (newest.status !== "completed") return { run: newest, action: "watch" };
  if (newest.conclusion === "success") return { run: newest, action: "reuse" };
  return { run: null, action: "dispatch" };
}

export function pruneSelection(entries, keepName, limit = CACHE_LIMIT) {
  return entries
    .filter((entry) => entry.name !== keepName)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(Math.max(0, limit - 1))
    .map((entry) => entry.name);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/windows-run.test.mjs`

Expected: PASS (9 tests).

- [ ] **Step 5: Wire the test file into the policy gate**

In `scripts/ci-policy.test.sh`, after
`node --test "$script_dir/process-supervisor.test.mjs"`, add:

```bash
node --test "$script_dir/windows-run.test.mjs"
```

Run: `./scripts/test.sh policy`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/windows-run.mjs scripts/windows-run.test.mjs scripts/ci-policy.test.sh
git commit -m "feat(scripts): add windows-run selection helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `windows-run.mjs` orchestration and `run.sh windows` routing

**Files:**

- Modify: `scripts/windows-run.mjs` (append the orchestration below the
  Task 3 helpers)
- Modify: `scripts/run.sh` (new `windows)` case and `show_help`)
- Modify: `scripts/ci-policy.test.sh` (run.sh section)

**Interfaces:**

- Consumes: Task 3 helpers (`parseWindowsRunArguments`, `isWsl`,
  `chooseRun`, `pruneSelection`), Task 1 workflow (`windows-dev.yml`,
  artifact `release-windows-x64`).
- Produces: `./scripts/run.sh windows [--fresh] [--ref <branch>] [-- <app args>]`.

- [ ] **Step 1: Add the failing policy assertion**

In `scripts/ci-policy.test.sh`, next to the `grep -Fq 'native-dev.mjs'`
check, add:

```bash
if ! grep -Fq 'windows-run.mjs' "$script_dir/run.sh"; then
  echo "run.sh windows must route through windows-run.mjs" >&2
  failures=$((failures + 1))
fi
```

Run: `./scripts/test.sh policy`

Expected: FAIL with `run.sh windows must route through windows-run.mjs`.

- [ ] **Step 2: Append the orchestration to `scripts/windows-run.mjs`**

The file keeps its exported helpers on top; append:

```js
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKFLOW = "windows-dev.yml";
const ARTIFACT = "release-windows-x64";
const CMD_EXE = "/mnt/c/Windows/System32/cmd.exe";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, commandArguments) {
  const result = spawnSync(command, commandArguments, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArguments.join(" ")} failed:\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

function readProcVersion() {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}

function listRuns(branch) {
  const raw = run("gh", [
    "run",
    "list",
    "--workflow",
    WORKFLOW,
    "--branch",
    branch,
    "--json",
    "databaseId,headSha,status,conclusion,createdAt",
    "--limit",
    "50",
  ]);
  return raw === "" ? [] : JSON.parse(raw);
}

function resolveTarget(options) {
  const branch =
    options.ref ?? run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") {
    throw new Error("detached HEAD: pass --ref <branch>");
  }
  const remote = run("git", ["ls-remote", "origin", `refs/heads/${branch}`]);
  if (remote === "") {
    throw new Error(`origin has no branch ${branch}; push it first`);
  }
  const sha = remote.split(/\s+/)[0];
  if (options.ref === null && run("git", ["rev-parse", "HEAD"]) !== sha) {
    throw new Error(
      `origin/${branch} is at ${sha.slice(0, 10)} but HEAD differs; push first`,
    );
  }
  return { branch, sha };
}

async function obtainRun(branch, sha, fresh) {
  let choice = chooseRun(fresh ? [] : listRuns(branch), sha);
  if (choice.action === "dispatch") {
    run("gh", ["workflow", "run", WORKFLOW, "--ref", branch]);
    console.log(`dispatched ${WORKFLOW} on ${branch} @ ${sha.slice(0, 10)}`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
      choice = chooseRun(listRuns(branch), sha);
      if (choice.action !== "dispatch") break;
    }
    if (choice.run === null) {
      throw new Error("dispatched run did not appear; check `gh run list`");
    }
  }
  if (choice.action !== "reuse") {
    const id = String(choice.run.databaseId);
    console.log(`waiting on run ${id} (\`gh run view ${id} --web\` to watch)`);
    const watch = spawnSync(
      "gh",
      ["run", "watch", id, "--exit-status", "--interval", "15"],
      { stdio: "inherit" },
    );
    if (watch.status !== 0) {
      throw new Error(`run ${id} failed; see \`gh run view ${id}\``);
    }
  } else {
    console.log(`reusing successful run ${choice.run.databaseId}`);
  }
  return choice.run;
}

function download(runId, sha) {
  const downloadDir = resolve(root, "build/windows-run", sha.slice(0, 10));
  rmSync(downloadDir, { recursive: true, force: true });
  mkdirSync(downloadDir, { recursive: true });
  run("gh", [
    "run",
    "download",
    String(runId),
    "--name",
    ARTIFACT,
    "--dir",
    downloadDir,
  ]);
  const unpacked = join(downloadDir, "win-unpacked");
  if (!existsSync(join(unpacked, "signalscope.exe"))) {
    throw new Error(`${ARTIFACT} lacks win-unpacked/signalscope.exe`);
  }
  return unpacked;
}

function windowsCacheRoot() {
  const echoed = spawnSync(CMD_EXE, ["/c", "echo %LOCALAPPDATA%"], {
    encoding: "utf8",
    cwd: "/mnt/c",
  });
  const localAppData = (echoed.stdout ?? "").trim();
  if (
    echoed.status !== 0 ||
    localAppData === "" ||
    localAppData.includes("%")
  ) {
    throw new Error("could not resolve %LOCALAPPDATA% through cmd.exe interop");
  }
  const cacheRoot = join(
    run("wslpath", ["-u", localAppData]),
    "SignalScopeDev",
  );
  mkdirSync(cacheRoot, { recursive: true });
  return cacheRoot;
}

function stage(unpacked, sha) {
  const cacheRoot = windowsCacheRoot();
  const shortSha = sha.slice(0, 10);
  const stageDir = join(cacheRoot, shortSha);
  rmSync(stageDir, { recursive: true, force: true });
  cpSync(unpacked, join(stageDir, "win-unpacked"), { recursive: true });
  const entries = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      mtimeMs: statSync(join(cacheRoot, entry.name)).mtimeMs,
    }));
  for (const name of pruneSelection(entries, shortSha)) {
    rmSync(join(cacheRoot, name), { recursive: true, force: true });
  }
  return join(stageDir, "win-unpacked", "signalscope.exe");
}

async function main() {
  const options = parseWindowsRunArguments(process.argv.slice(2));
  if (!isWsl(process.env, readProcVersion())) {
    throw new Error(
      "run.sh windows launches the package on the Windows side of a WSL " +
        "machine; on Linux/macOS use run.sh native",
    );
  }
  run("gh", ["auth", "status"]);
  const { branch, sha } = resolveTarget(options);
  const selected = await obtainRun(branch, sha, options.fresh);
  const executable = stage(download(selected.databaseId, sha), sha);
  console.log(`launching ${executable}`);
  const child = spawn(executable, options.appArguments, {
    stdio: "inherit",
    cwd: dirname(executable),
  });
  return await new Promise((resolveExit) =>
    child.on("close", (code) => resolveExit(code ?? 0)),
  );
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
```

Move the `import` statements to the very top of the file, above the Task 3
helpers — ES modules require imports at top level, and the `isMain` guard
keeps `node --test` imports side-effect free.

- [ ] **Step 3: Verify the helper tests still pass and the guard works**

Run: `node --test scripts/windows-run.test.mjs`

Expected: PASS — importing the module must not execute `main()`.

Run: `node scripts/windows-run.mjs --wat`

Expected: exit 1 with `unknown argument: --wat` (proves the entry guard
runs `main` when invoked directly).

- [ ] **Step 4: Route `run.sh windows`**

In `scripts/run.sh`, add a `windows)` case between `native)` and `web)`:

```bash
windows)
  shift || true
  exec node "$signalscope_scripts_dir/windows-run.mjs" "$@"
  ;;
```

Update `show_help`'s usage line and mode list:

```text
Usage: ./scripts/run.sh [native|windows|web]

  native   Launch the Electron workbench (default; Linux/macOS displays).
  windows  Build the pushed branch via GitHub Actions, then launch the real
           Windows package through WSL interop.
           Flags: --fresh (force a new CI build), --ref <branch>,
           -- <app args> forwarded to signalscope.exe.
  web      Launch the shared frontend in a browser at http://127.0.0.1:4173.
```

- [ ] **Step 5: Verify**

Run: `./scripts/test.sh policy`

Expected: PASS.

Run: `shellcheck scripts/run.sh`

Expected: clean.

Run: `./scripts/run.sh windows --wat`

Expected: exit 1 with `unknown argument: --wat` (routing works; no network
touched).

- [ ] **Step 6: Commit**

```bash
git add scripts/windows-run.mjs scripts/run.sh scripts/ci-policy.test.sh
git commit -m "feat(scripts): launch CI Windows packages from WSL

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation, full quality gate, and manual acceptance

**Files:**

- Modify: `README.md` (command listings near lines 32, 58, 147–148)
- Modify: `AGENTS.md` (command table near lines 61–62)

**Interfaces:**

- Consumes: the Task 2 guard behavior and Task 4 command exactly as built.

- [ ] **Step 1: Update the command surfaces in docs**

In `AGENTS.md`, extend the run-command listing (currently lines 61–62):

```text
./scripts/run.sh web                  browser development host
./scripts/run.sh native               Electron development host (Linux/macOS)
./scripts/run.sh windows              CI-built Windows package via WSL interop
```

Add one sentence where the surrounding section describes developer
commands: `run.sh native` fails early under WSL because WSLg cannot present
the WebGPU surface; WSL developers use `run.sh windows` for the packaged
app on hardware WebGPU, or open `run.sh web` / exported snapshots in the
Windows browser.

In `README.md`, mirror the same: add `./scripts/run.sh windows` beside the
existing `run.sh native` mentions (lines 58 and 147–148) with the same
one-line description, and add the WSL note next to whichever of those
sections describes running the app. Keep wording consistent with the
`show_help` text from Task 4.

- [ ] **Step 2: Format and run the full quality gate**

Run: `./scripts/format.sh`

Run: `./scripts/ci.sh quality`

Expected: PASS — shellcheck, ci-policy (including the new workflow,
guard, and node tests), actionlint, zizmor, typos all green.

- [ ] **Step 3: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs(scripts): document the windows run mode and WSL limits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Manual acceptance (requires the branch pushed and gh auth)**

Run: `git push`

Run: `./scripts/run.sh windows`

Expected sequence:

1. Prints `dispatched windows-dev.yml on <branch> @ <sha>` (first run) and
   waits on the run (~15–30 min), or `reusing successful run <id>` on a
   repeat SHA.
2. Downloads and stages into `%LOCALAPPDATA%\SignalScopeDev\<short-sha>`.
3. The SignalScope workbench opens **on the Windows desktop**; verify the
   plot presents (non-blank) and the status bar does NOT say
   `Software WebGPU`.
4. Close the app; the command exits 0.

Run: `./scripts/run.sh windows` again — expected: reuses the run, skips CI,
relaunches within ~1 minute.

Run: `./scripts/run.sh native` — expected: exit 3 with guidance.

Run: `./scripts/run.sh web` — expected: banner with the Windows-browser
URL; opening `http://127.0.0.1:4173` in Edge/Chrome on Windows shows the
workbench with hardware WebGPU.

If any manual step cannot be performed (e.g. no `gh` auth), report it as
untested in the handoff — do not claim acceptance.

- [ ] **Step 5: Hand off**

Report: commits, validation commands with results, the manual acceptance
outcomes per Step 4, and the still-open Task 11 hardware `bench e2e` gate
(out of scope here, per the spec).

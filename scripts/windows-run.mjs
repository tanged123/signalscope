import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
  const executable = join(stageDir, "win-unpacked", "signalscope.exe");
  // Artifact zips carry no unix permissions, and on a metadata-enabled
  // drvfs mount the extracted exe lands non-executable, so WSL interop
  // spawns fail with EACCES without this.
  chmodSync(executable, 0o755);
  return executable;
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

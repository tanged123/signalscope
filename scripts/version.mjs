import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, "..");
const workspacePackageNames = new Set([
  "scope-core",
  "scope-protocol",
  "signalscope-shell",
]);

const releaseFiles = {
  cargo: resolve(repositoryRoot, "Cargo.toml"),
  lock: resolve(repositoryRoot, "Cargo.lock"),
  frontend: resolve(repositoryRoot, "frontend/package.json"),
  tauri: resolve(repositoryRoot, "shell/src-tauri/tauri.conf.json"),
};

function usage() {
  console.log(`Usage: ./scripts/version.sh <command>

Commands:
  get                         Print the canonical application version.
  check                       Verify every release manifest is synchronized.
  check-pr <base-ref>        Require a version strictly newer than base-ref.
  set <major.minor.patch>     Set all application release manifests.
  bump <major|minor|patch>    Increment the canonical version everywhere.

The protocol and session schema versions are independent compatibility
boundaries and are intentionally not changed by this command.
`);
}

function parseVersion(value, source = "version") {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(
      `${source} must be a stable semantic version (major.minor.patch): ${value}`,
    );
  }
  return match.slice(1).map(Number);
}

function formatVersion(parts) {
  return parts.join(".");
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index])
      return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function cargoWorkspaceVersion(text) {
  const section = /\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/.exec(text);
  const match = section?.[1].match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) throw new Error("Cargo.toml has no [workspace.package] version");
  return match[1];
}

function lockVersions(text) {
  const versions = new Map();
  let packageName = null;
  for (const line of text.split("\n")) {
    const packageMatch = /^name = "([^"]+)"$/.exec(line);
    if (packageMatch) packageName = packageMatch[1];
    const versionMatch = /^version = "([^"]+)"$/.exec(line);
    if (packageName && versionMatch && workspacePackageNames.has(packageName)) {
      versions.set(packageName, versionMatch[1]);
      packageName = null;
    }
    if (line === "[[package]]") packageName = null;
  }
  return versions;
}

async function readReleaseState() {
  const [cargoText, lockText, frontendText, tauriText] = await Promise.all(
    Object.values(releaseFiles).map((file) => readFile(file, "utf8")),
  );
  const versions = new Map([
    ["Cargo.toml [workspace.package]", cargoWorkspaceVersion(cargoText)],
    ["frontend/package.json", JSON.parse(frontendText).version],
    ["shell/src-tauri/tauri.conf.json", JSON.parse(tauriText).version],
  ]);
  for (const [name, version] of lockVersions(lockText)) {
    versions.set(`Cargo.lock ${name}`, version);
  }
  return versions;
}

function assertConsistent(versions) {
  const entries = [...versions.entries()];
  if (entries.length === 0) throw new Error("No release versions found");
  const expected = entries[0][1];
  parseVersion(expected, entries[0][0]);
  const mismatches = entries.filter(([, version]) => version !== expected);
  if (mismatches.length > 0) {
    const details = mismatches
      .map(([file, version]) => `  ${file}: ${version}`)
      .join("\n");
    throw new Error(
      `release versions are inconsistent; expected ${expected}:\n${details}`,
    );
  }
  return expected;
}

async function setCargoVersion(text, version) {
  let inSection = false;
  let replaced = false;
  const lines = text.split("\n").map((line) => {
    if (line === "[workspace.package]") {
      inSection = true;
      return line;
    }
    if (inSection && /^\[/.test(line)) inSection = false;
    if (inSection && /^version\s*=/.test(line)) {
      replaced = true;
      return `version = "${version}"`;
    }
    return line;
  });
  if (!replaced)
    throw new Error("Cargo.toml workspace version was not updated");
  return lines.join("\n");
}

function setJsonVersion(text, version, file) {
  const updated = text.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${version}"`);
  if (updated === text) throw new Error(`${file} version was not updated`);
  return updated;
}

function setLockVersions(text, version) {
  const lines = text.split("\n");
  let packageName = null;
  let replacements = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const packageMatch = /^name = "([^"]+)"$/.exec(lines[index]);
    if (packageMatch) packageName = packageMatch[1];
    if (
      packageName &&
      /^version = "/.test(lines[index]) &&
      workspacePackageNames.has(packageName)
    ) {
      lines[index] = `version = "${version}"`;
      replacements += 1;
      packageName = null;
    }
    if (lines[index] === "[[package]]") packageName = null;
  }
  if (replacements !== workspacePackageNames.size) {
    throw new Error(
      `Cargo.lock updated ${replacements} workspace packages; expected ${workspacePackageNames.size}`,
    );
  }
  return lines.join("\n");
}

async function setVersion(version) {
  parseVersion(version);
  const [cargoText, lockText, frontendText, tauriText] = await Promise.all(
    Object.values(releaseFiles).map((file) => readFile(file, "utf8")),
  );
  await Promise.all([
    writeFile(releaseFiles.cargo, await setCargoVersion(cargoText, version)),
    writeFile(releaseFiles.lock, setLockVersions(lockText, version)),
    writeFile(
      releaseFiles.frontend,
      setJsonVersion(frontendText, version, "frontend/package.json"),
    ),
    writeFile(
      releaseFiles.tauri,
      setJsonVersion(tauriText, version, "shell/src-tauri/tauri.conf.json"),
    ),
  ]);
  console.log(`SignalScope version set to ${version}`);
}

function baseVersion(baseRef) {
  try {
    const text = execFileSync("git", ["show", `${baseRef}:Cargo.toml`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return cargoWorkspaceVersion(text);
  } catch (error) {
    if (error?.status === 128) return null;
    throw error;
  }
}

const [command, argument] = process.argv.slice(2);
try {
  if (!command || command === "help" || command === "--help") {
    usage();
  } else if (command === "get") {
    console.log(assertConsistent(await readReleaseState()));
  } else if (command === "check") {
    console.log(
      `Release manifests are synchronized at ${assertConsistent(await readReleaseState())}.`,
    );
  } else if (command === "check-pr") {
    if (!argument) throw new Error("check-pr requires a base git ref or SHA");
    const current = parseVersion(
      assertConsistent(await readReleaseState()),
      "current version",
    );
    const base = baseVersion(argument);
    if (base === null) {
      console.log(
        `Base ref ${argument} has no Cargo workspace; current version is ${formatVersion(current)}.`,
      );
    } else {
      const parsedBase = parseVersion(base, "base version");
      if (compareVersions(current, parsedBase) <= 0) {
        throw new Error(
          `PR version ${formatVersion(current)} must be newer than base version ${base}`,
        );
      }
      console.log(
        `PR version ${formatVersion(current)} is newer than base version ${base}.`,
      );
    }
  } else if (command === "set") {
    if (!argument) throw new Error("set requires major.minor.patch");
    await setVersion(argument);
  } else if (command === "bump") {
    if (!["major", "minor", "patch"].includes(argument)) {
      throw new Error("bump requires major, minor, or patch");
    }
    const current = parseVersion(assertConsistent(await readReleaseState()));
    const next = [...current];
    if (argument === "major") {
      next[0] += 1;
      next[1] = 0;
      next[2] = 0;
    } else if (argument === "minor") {
      next[1] += 1;
      next[2] = 0;
    } else {
      next[2] += 1;
    }
    await setVersion(formatVersion(next));
  } else {
    throw new Error(`unknown version command: ${command}`);
  }
} catch (error) {
  console.error(
    `version: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

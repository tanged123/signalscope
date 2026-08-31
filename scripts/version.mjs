import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, "..");
const releaseFiles = {
  cargo: resolve(repositoryRoot, "Cargo.toml"),
  lock: resolve(repositoryRoot, "Cargo.lock"),
  frontend: resolve(repositoryRoot, "frontend/package.json"),
  desktop: resolve(repositoryRoot, "desktop/package.json"),
  about: resolve(repositoryRoot, "frontend/src/ui/app-shell.ts"),
  readme: resolve(repositoryRoot, "README.md"),
};

/** The version the About command shows; nothing else checks this literal. */
const aboutPattern = /(showModeHelp\("SignalScope )(\d+\.\d+\.\d+)("\))/;
const demoPattern =
  /(https:\/\/tanged123\.github\.io\/signalscope\/demo\.gif\?v=)(\d+\.\d+\.\d+)/;

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

function usage() {
  console.log(`Usage: ./scripts/version.sh <command>

Commands:
  get                         Print the canonical application version.
  check                       Verify every release manifest is synchronized.
  check-pr <base-ref>        Require one semantic-version increment from base-ref.
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

function isSingleIncrement(current, base) {
  return (
    (current[0] === base[0] &&
      current[1] === base[1] &&
      current[2] === base[2] + 1) ||
    (current[0] === base[0] &&
      current[1] === base[1] + 1 &&
      current[2] === 0) ||
    (current[0] === base[0] + 1 && current[1] === 0 && current[2] === 0)
  );
}

function cargoWorkspaceVersion(text) {
  const section = /\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/.exec(text);
  const match = section?.[1].match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) throw new Error("Cargo.toml has no [workspace.package] version");
  return match[1];
}

function workspaceDependencyVersions(text, packageNames) {
  const section = /\[workspace\.dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(text);
  const versions = new Map();
  for (const line of section?.[1].split("\n") ?? []) {
    const match = /^([\w-]+)\s*=\s*\{[^}]*\bversion\s*=\s*"([^"]+)"/.exec(line);
    if (match && packageNames.has(match[1])) versions.set(match[1], match[2]);
  }
  return versions;
}

function lockVersions(text, packageNames) {
  const versions = new Map();
  let packageName = null;
  for (const line of text.split("\n")) {
    const packageMatch = /^name = "([^"]+)"$/.exec(line);
    if (packageMatch) packageName = packageMatch[1];
    const versionMatch = /^version = "([^"]+)"$/.exec(line);
    if (packageName && versionMatch && packageNames.has(packageName)) {
      versions.set(packageName, versionMatch[1]);
      packageName = null;
    }
    if (line === "[[package]]") packageName = null;
  }
  return versions;
}

function aboutVersion(text) {
  const match = aboutPattern.exec(text);
  if (!match) {
    throw new Error("frontend/src/ui/app-shell.ts has no About version string");
  }
  return match[2];
}

function demoVersion(text) {
  const match = demoPattern.exec(text);
  if (!match) throw new Error("README.md has no versioned demo GIF URL");
  return match[2];
}

async function readReleaseState(packageNames) {
  const [
    cargoText,
    lockText,
    frontendText,
    desktopText,
    aboutText,
    readmeText,
  ] = await Promise.all(
    Object.values(releaseFiles).map((file) => readFile(file, "utf8")),
  );
  const versions = new Map([
    ["Cargo.toml [workspace.package]", cargoWorkspaceVersion(cargoText)],
    ["frontend/package.json", JSON.parse(frontendText).version],
    ["desktop/package.json", JSON.parse(desktopText).version],
    ["frontend/src/ui/app-shell.ts About", aboutVersion(aboutText)],
    ["README.md demo GIF", demoVersion(readmeText)],
  ]);
  for (const [name, version] of workspaceDependencyVersions(
    cargoText,
    packageNames,
  )) {
    versions.set(`Cargo.toml dependency ${name}`, version);
  }
  for (const [name, version] of lockVersions(lockText, packageNames)) {
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

async function setCargoVersion(text, version, packageNames) {
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
    const dependency = /^([\w-]+)\s*=\s*\{[^}]*\bversion\s*=\s*"[^"]+"/.exec(
      line,
    );
    if (dependency && packageNames.has(dependency[1])) {
      return line.replace(/\bversion\s*=\s*"[^"]+"/, `version = "${version}"`);
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

function setLockVersions(text, version, packageNames) {
  const lines = text.split("\n");
  let packageName = null;
  let replacements = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const packageMatch = /^name = "([^"]+)"$/.exec(lines[index]);
    if (packageMatch) packageName = packageMatch[1];
    if (
      packageName &&
      /^version = "/.test(lines[index]) &&
      packageNames.has(packageName)
    ) {
      lines[index] = `version = "${version}"`;
      replacements += 1;
      packageName = null;
    }
    if (lines[index] === "[[package]]") packageName = null;
  }
  if (replacements !== packageNames.size) {
    throw new Error(
      `Cargo.lock updated ${replacements} workspace packages; expected ${packageNames.size}`,
    );
  }
  return lines.join("\n");
}

function setAboutVersion(text, version) {
  const updated = text.replace(aboutPattern, `$1${version}$3`);
  if (updated === text) {
    throw new Error(
      "frontend/src/ui/app-shell.ts About version was not updated",
    );
  }
  return updated;
}

function setDemoVersion(text, version) {
  const updated = text.replace(demoPattern, `$1${version}`);
  if (updated === text)
    throw new Error("README.md demo GIF version was not updated");
  return updated;
}

async function setVersion(version, packageNames) {
  parseVersion(version);
  const [
    cargoText,
    lockText,
    frontendText,
    desktopText,
    aboutText,
    readmeText,
  ] = await Promise.all(
    Object.values(releaseFiles).map((file) => readFile(file, "utf8")),
  );
  await Promise.all([
    writeFile(
      releaseFiles.cargo,
      await setCargoVersion(cargoText, version, packageNames),
    ),
    writeFile(
      releaseFiles.lock,
      setLockVersions(lockText, version, packageNames),
    ),
    writeFile(
      releaseFiles.frontend,
      setJsonVersion(frontendText, version, "frontend/package.json"),
    ),
    writeFile(
      releaseFiles.desktop,
      setJsonVersion(desktopText, version, "desktop/package.json"),
    ),
    writeFile(releaseFiles.about, setAboutVersion(aboutText, version)),
    writeFile(releaseFiles.readme, setDemoVersion(readmeText, version)),
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
    const packageNames = await workspacePackageNames();
    console.log(assertConsistent(await readReleaseState(packageNames)));
  } else if (command === "check") {
    const packageNames = await workspacePackageNames();
    console.log(
      `Release manifests are synchronized at ${assertConsistent(await readReleaseState(packageNames))}.`,
    );
  } else if (command === "check-pr") {
    if (!argument) throw new Error("check-pr requires a base git ref or SHA");
    const packageNames = await workspacePackageNames();
    const current = parseVersion(
      assertConsistent(await readReleaseState(packageNames)),
      "current version",
    );
    const base = baseVersion(argument);
    if (base === null) {
      console.log(
        `Base ref ${argument} has no Cargo workspace; current version is ${formatVersion(current)}.`,
      );
    } else {
      const parsedBase = parseVersion(base, "base version");
      if (!isSingleIncrement(current, parsedBase)) {
        throw new Error(
          `PR version ${formatVersion(current)} must be one major, minor, or patch increment from base version ${base}`,
        );
      }
      console.log(
        `PR version ${formatVersion(current)} is one increment from base version ${base}.`,
      );
    }
  } else if (command === "set") {
    if (!argument) throw new Error("set requires major.minor.patch");
    await setVersion(argument, await workspacePackageNames());
  } else if (command === "bump") {
    if (!["major", "minor", "patch"].includes(argument)) {
      throw new Error("bump requires major, minor, or patch");
    }
    const packageNames = await workspacePackageNames();
    const current = parseVersion(
      assertConsistent(await readReleaseState(packageNames)),
    );
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
    await setVersion(formatVersion(next), packageNames);
  } else {
    throw new Error(`unknown version command: ${command}`);
  }
} catch (error) {
  console.error(
    `version: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

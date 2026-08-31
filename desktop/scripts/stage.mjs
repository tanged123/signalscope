import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "..");
const stageRoot = resolve(repositoryRoot, "build/desktop-stage");
const binRoot = join(stageRoot, "bin");
const frontendRoot = join(stageRoot, "frontend");
const executableName =
  process.platform === "win32" ? "scope-server.exe" : "scope-server";
const executableSource = join(repositoryRoot, "target/release", executableName);
const frontendSource = join(repositoryRoot, "frontend/dist");

function fail(message) {
  throw new Error(`desktop stage: ${message}`);
}

async function regularFile(path, label) {
  const entry = await lstat(path).catch(() => null);
  if (entry === null || !entry.isFile() || entry.isSymbolicLink())
    fail(`${label} is not a regular file: ${path}`);
}

async function noSymlinks(root, label) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`${label} contains a symlink: ${path}`);
    if (entry.isDirectory()) await noSymlinks(path, label);
  }
}

function workspaceVersion(cargo) {
  const section =
    /\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/.exec(cargo)?.[1] ?? "";
  const version = /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1];
  if (version === undefined) fail("Cargo workspace version is missing");
  return version;
}

async function versions() {
  const [desktop, frontend, cargo] = await Promise.all([
    readFile(join(desktopRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, "frontend/package.json"), "utf8"),
    readFile(join(repositoryRoot, "Cargo.toml"), "utf8"),
  ]);
  return [
    JSON.parse(desktop).version,
    JSON.parse(frontend).version,
    workspaceVersion(cargo),
  ];
}

async function check() {
  const releaseVersions = await versions();
  const version = releaseVersions[0];
  if (releaseVersions.some((candidate) => candidate !== version))
    fail(`version mismatch: ${releaseVersions.join(", ")}`);
  await regularFile(join(binRoot, executableName), "scope-server");
  if (process.platform !== "win32") {
    const executable = await lstat(join(binRoot, executableName));
    if ((executable.mode & 0o111) === 0) fail("scope-server is not executable");
  }
  await regularFile(join(frontendRoot, "index.html"), "frontend entry");
  await regularFile(
    join(frontendRoot, "snapshot-template.html"),
    "snapshot template",
  );
  await regularFile(join(stageRoot, "version"), "version marker");
  if ((await readFile(join(stageRoot, "version"), "utf8")).trim() !== version)
    fail("stage version marker does not match the release version");
  await noSymlinks(stageRoot, "stage");
  const topLevel = (await readdir(stageRoot)).sort();
  if (topLevel.join("\n") !== ["bin", "frontend", "version"].join("\n"))
    fail(`unexpected staged content: ${topLevel.join(", ")}`);
}

if (process.argv.includes("--check")) {
  await check();
} else {
  await regularFile(executableSource, "built scope-server");
  await noSymlinks(frontendSource, "frontend build");
  const releaseVersions = await versions();
  const version = releaseVersions[0];
  const { stdout } = await execute(executableSource, ["--version"]);
  if (stdout.trim() !== version)
    fail(
      `built scope-server version ${stdout.trim()} does not match ${version}`,
    );
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(binRoot, { recursive: true });
  await cp(executableSource, join(binRoot, basename(executableSource)));
  await cp(frontendSource, frontendRoot, { recursive: true });
  await writeFile(join(stageRoot, "version"), `${version}\n`);
  await check();
}

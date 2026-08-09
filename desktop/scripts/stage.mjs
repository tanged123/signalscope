import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "..");
const stageRoot = resolve(repositoryRoot, "build/desktop-stage");
const binRoot = join(stageRoot, "bin");
const frontendRoot = join(stageRoot, "frontend");

const packageJson = JSON.parse(
  await readFile(join(desktopRoot, "package.json"), "utf8"),
);
const frontendPackage = JSON.parse(
  await readFile(join(repositoryRoot, "frontend/package.json"), "utf8"),
);
const cargo = await readFile(join(repositoryRoot, "Cargo.toml"), "utf8");
const workspaceVersion = /^version\s*=\s*"([^"]+)"/m.exec(
  /\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/.exec(cargo)?.[1] ?? "",
)?.[1];
const hostName =
  process.platform === "win32" ? "signalscope-host.exe" : "signalscope-host";
const hostSource = join(repositoryRoot, "target/release", hostName);
const frontendSource = join(repositoryRoot, "frontend/dist");

function fail(message) {
  throw new Error(`desktop stage: ${message}`);
}

async function assertRegularFile(path, label) {
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`${label} is not a regular file: ${path}`);
}

async function assertNoSymlinks(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink())
      fail(`symlink in stage: ${relative(stageRoot, path)}`);
    if (entry.isDirectory()) await assertNoSymlinks(path);
  }
}

async function check() {
  const versions = [
    packageJson.version,
    frontendPackage.version,
    workspaceVersion,
  ];
  if (
    versions.some((version) => version === undefined || version !== versions[0])
  ) {
    fail(`version mismatch: ${versions.join(", ")}`);
  }
  await assertRegularFile(join(frontendRoot, "index.html"), "frontend entry");
  await assertRegularFile(
    join(frontendRoot, "snapshot-template.html"),
    "snapshot template",
  );
  await assertRegularFile(join(binRoot, hostName), "Rust host");
  if (process.platform !== "win32") {
    const entry = await lstat(join(binRoot, hostName));
    if ((entry.mode & 0o111) === 0) fail("Rust host is not executable");
  }
  await assertNoSymlinks(stageRoot);
  const files = [];
  async function collect(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await collect(path);
      else files.push(relative(stageRoot, path));
    }
  }
  await collect(stageRoot);
  if (
    files.some(
      (path) =>
        path.includes(`${sep}shell${sep}`) || path.startsWith(`shell${sep}`),
    )
  ) {
    fail("obsolete shell content is present");
  }
}

if (process.argv.includes("--check")) {
  await check();
  process.stdout.write("desktop stage is valid\n");
} else {
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(binRoot, { recursive: true });
  await mkdir(frontendRoot, { recursive: true });
  await cp(hostSource, join(binRoot, hostName), { dereference: true });
  await cp(frontendSource, frontendRoot, {
    recursive: true,
    dereference: true,
  });
  await writeFile(join(stageRoot, "version"), `${packageJson.version}\n`);
  await check();
  process.stdout.write(`staged desktop inputs in ${stageRoot}\n`);
}

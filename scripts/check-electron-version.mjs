import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseVersion(value) {
  const match = String(value).match(/(?:^|\D)(\d+\.\d+\.\d+)(?:$|\D)/);
  return match?.[1] ?? null;
}

export function parseElectronLockVersion(lockfile) {
  const desktopImporter = lockfile.match(
    /^  desktop:\n([\s\S]*?)(?=\n  [A-Za-z0-9_.-]+:\n|$)/m,
  );
  const importer = desktopImporter?.[1].match(
    /^      electron:\n\s+specifier: [^\n]+\n\s+version: ([^\n]+)/m,
  );
  const packageEntry = lockfile.match(/^  electron@(\d+\.\d+\.\d+):\s*$/m);
  return parseVersion(importer?.[1] ?? packageEntry?.[1] ?? "");
}

export function electronVersionPolicy({
  packageJson,
  lockfile,
  binaryVersion,
}) {
  const packageVersion = parseVersion(
    JSON.parse(packageJson).devDependencies?.electron ?? "",
  );
  const lockVersion = parseElectronLockVersion(lockfile);
  const resolvedBinaryVersion = parseVersion(binaryVersion);
  const versions = {
    packageVersion,
    lockVersion,
    binaryVersion: resolvedBinaryVersion,
  };
  const expected = packageVersion;
  const ok = Boolean(
    expected && lockVersion === expected && resolvedBinaryVersion === expected,
  );
  return { ok, expected, versions };
}

export function readElectronVersion(binary) {
  if (!binary || !isAbsolute(binary)) {
    throw new Error("SIGNALSCOPE_ELECTRON_BIN must be an absolute path");
  }
  try {
    return execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const status = error?.status == null ? "unknown" : String(error.status);
    throw new Error(`Electron version command failed with status ${status}`);
  }
}

function run() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const packageJson = readFileSync(
    resolve(root, "desktop/package.json"),
    "utf8",
  );
  const lockfile = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  const binary = process.env.SIGNALSCOPE_ELECTRON_BIN;
  const binaryVersion = readElectronVersion(binary);
  const result = electronVersionPolicy({
    packageJson,
    lockfile,
    binaryVersion,
  });
  if (!result.ok) {
    throw new Error(
      `Electron version mismatch: package=${result.versions.packageVersion ?? "missing"} ` +
        `lock=${result.versions.lockVersion ?? "missing"} ` +
        `binary=${result.versions.binaryVersion ?? "missing"}`,
    );
  }
  console.log(`Electron ${result.expected} (package, lockfile, binary)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();

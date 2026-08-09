import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const layouts = {
  linux: {
    root: "linux-unpacked",
    executable: "signalscope",
    resources: "resources",
  },
  win32: {
    root: "win-unpacked",
    executable: "signalscope.exe",
    resources: "resources",
  },
  darwin: {
    x64: {
      root: "mac/SignalScope.app/Contents",
      executable: "MacOS/signalscope",
      resources: "Resources",
    },
    arm64: {
      root: "mac-arm64/SignalScope.app/Contents",
      executable: "MacOS/signalscope",
      resources: "Resources",
    },
  },
};

export function unpackedPackage(platform, arch, releaseRoot) {
  if (platform !== "darwin" && arch !== "x64") {
    throw new Error(`unsupported unpacked package ${platform}/${arch}`);
  }
  const layout =
    platform === "darwin" ? layouts.darwin[arch] : layouts[platform];
  if (layout === undefined) {
    throw new Error(`unsupported unpacked package ${platform}/${arch}`);
  }
  const root = resolve(releaseRoot, layout.root);
  const resources = resolve(root, layout.resources);
  const executable = resolve(root, layout.executable);
  const asar = resolve(resources, "app.asar");
  const host = resolve(
    resources,
    `bin/signalscope-host${platform === "win32" ? ".exe" : ""}`,
  );
  const frontend = resolve(resources, "frontend/index.html");
  const paths = { executable, resources, host, frontend, asar };
  if (!isRegularFile(executable)) {
    throw new Error(`unpacked package executable is missing: ${executable}`);
  }
  if (!isDirectory(resources)) {
    throw new Error(`unpacked package resources is missing: ${resources}`);
  }
  for (const [name, path] of Object.entries(paths)) {
    if (name !== "executable" && name !== "resources" && !isRegularFile(path)) {
      throw new Error(`unpacked package ${name} is missing: ${path}`);
    }
  }
  return paths;
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const releaseRoot = process.argv[2] ?? "desktop/release";
  const field = process.argv[3] ?? "executable";
  const paths = unpackedPackage(process.platform, process.arch, releaseRoot);
  if (!(field in paths)) throw new Error(`unknown package path: ${field}`);
  process.stdout.write(`${paths[field]}\n`);
}

import { cp, lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "..");
const sourceRoot = join(desktopRoot, "release");
const [platform, arch, version] = process.argv.slice(2);
if (!platform || !arch || !/^\d+\.\d+\.\d+$/.test(version ?? ""))
  throw new Error(
    "usage: collect.mjs <linux|windows|mac> <x64|arm64> <version>",
  );

const installer = {
  linux: `SignalScope-${version}-linux-${arch}.AppImage`,
  windows: `SignalScope-${version}-windows-${arch}-setup.exe`,
  mac: `SignalScope-${version}-mac-${arch}.dmg`,
}[platform];
if (installer === undefined)
  throw new Error(`unsupported package platform: ${platform}`);

const outputRoot = join(
  repositoryRoot,
  "build/packages",
  `${platform}-${arch}`,
);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

async function copyRegular(name, required) {
  const source = join(sourceRoot, name);
  const entry = await lstat(source).catch(() => null);
  if (entry === null && !required) return;
  if (entry === null || !entry.isFile() || entry.isSymbolicLink())
    throw new Error(`package artifact is missing or unsafe: ${source}`);
  await cp(source, join(outputRoot, name));
}

await copyRegular(installer, true);
if (platform === "linux")
  await copyRegular(
    `SignalScope-${version}-linux-${arch}-server.tar.gz`,
    false,
  );

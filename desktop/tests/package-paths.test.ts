import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { unpackedPackage } from "../scripts/package-paths.mjs";

const targets = [
  ["linux", "x64", "linux-unpacked/signalscope"],
  ["win32", "x64", "win-unpacked/signalscope.exe"],
  ["darwin", "x64", "mac/SignalScope.app/Contents/MacOS/signalscope"],
  ["darwin", "arm64", "mac-arm64/SignalScope.app/Contents/MacOS/signalscope"],
];

test.each(targets)(
  "resolves the %s/%s unpacked layout",
  async (platform, arch, executable) => {
    const root = await mkdtemp(join(tmpdir(), "signalscope-package-paths-"));
    try {
      const executablePath = join(root, executable);
      const packageRoot = executablePath.slice(
        0,
        executablePath.lastIndexOf("/"),
      );
      const resources =
        platform === "darwin"
          ? join(packageRoot, "..", "Resources")
          : join(packageRoot, "resources");
      await mkdir(packageRoot, { recursive: true });
      await mkdir(join(resources, "bin"), { recursive: true });
      await mkdir(join(resources, "frontend"), { recursive: true });
      await writeFile(executablePath, "electron");
      await writeFile(join(resources, "app.asar"), "asar");
      await writeFile(
        join(
          resources,
          "bin",
          `signalscope-host${platform === "win32" ? ".exe" : ""}`,
        ),
        "host",
      );
      await writeFile(join(resources, "frontend", "index.html"), "html");
      await chmod(executablePath, 0o755);
      const result = unpackedPackage(platform, arch, root);
      expect(result.executable).toBe(executablePath);
      expect(result.resources).toBe(resources);
      expect(result.asar).toBe(join(resources, "app.asar"));
      expect(result.host).toContain("signalscope-host");
      expect(result.frontend).toBe(join(resources, "frontend", "index.html"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("fails without the exact current-platform layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "signalscope-package-paths-"));
  try {
    await expect(() => unpackedPackage("linux", "x64", root)).toThrow(
      /unpacked package executable is missing/,
    );
    await expect(() => unpackedPackage("linux", "arm64", root)).toThrow(
      /unsupported unpacked package/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

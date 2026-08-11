import { _electron as electron, expect, test } from "@playwright/test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plotPixelEvidence } from "../bench/measure";
import { installNativeSession } from "./native-session";

const csvPath = fileURLToPath(
  new URL("fixtures/roundtrip.csv", import.meta.url),
);

test("the unpacked Electron package starts outside the checkout", async () => {
  test.setTimeout(120_000);
  const executablePath = process.env.SIGNALSCOPE_PACKAGED_BIN;
  if (executablePath === undefined) {
    test.skip(true, "SIGNALSCOPE_PACKAGED_BIN is not configured");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "signalscope-package-"));
  const userData = join(root, "user-data");
  const source = join(root, "roundtrip.csv");
  await copyFile(csvPath, source);
  await installNativeSession(userData, "alpha @*");
  const removedVariables = new Set([
    "SIGNALSCOPE_ELECTRON_BIN",
    "SIGNALSCOPE_PACKAGED_APP",
    "SIGNALSCOPE_HOST_BIN",
    "SIGNALSCOPE_RESOURCE_DIR",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !removedVariables.has(entry[0]),
    ),
  );
  env.NODE_ENV = "production";
  if (process.env.SIGNALSCOPE_PACKAGE_PLATFORM === "linux")
    env.SIGNALSCOPE_GPU_MODE = "software";
  else delete env.SIGNALSCOPE_GPU_MODE;
  try {
    const app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`, `--open=${source}`],
      cwd: root,
      env,
    });
    app
      .process()
      .stdout?.on("data", (chunk: Buffer) =>
        console.log(`[electron-main] ${chunk.toString().trimEnd()}`),
      );
    app
      .process()
      .stderr?.on("data", (chunk: Buffer) =>
        console.log(`[electron-main:err] ${chunk.toString().trimEnd()}`),
      );
    try {
      const page = await app.firstWindow();
      page.on("console", (message) =>
        console.log(`[renderer:${message.type()}] ${message.text()}`),
      );
      page.on("pageerror", (error) =>
        console.log(`[renderer:pageerror] ${error.message}`),
      );
      await expect(page).toHaveURL("app://signalscope/index.html");
      await expect(page.locator("#app")).toBeVisible();
      // 90s inner wait < 120s test timeout so a hang here fails as this
      // locator assertion instead of an anonymous test timeout.
      await expect(page.locator(".status-aggregate")).toHaveText(
        /1 sources · 2 signals · [1-9\d,]+ pts/,
        { timeout: 90_000 },
      );
      await expect(page.locator(".panel")).toHaveCount(1);
      await expect(
        page.locator('.outline-series-row[data-path$="/alpha"]'),
      ).toHaveCount(1);
      await expect(page.locator(".panel-bindings .binding-chip")).toHaveText(
        /alpha @\* · 1/,
      );
      expect(
        await page.evaluate(async () => {
          const bridge = window.scopeDesktop;
          if (bridge === undefined) throw new Error("desktop bridge is absent");
          const connection = await bridge.connect();
          return {
            bridge: typeof bridge,
            connection,
            node: typeof (globalThis as { process?: unknown }).process,
            require: typeof (globalThis as { require?: unknown }).require,
            gpu: typeof navigator.gpu,
          };
        }),
      ).toMatchObject({
        bridge: "object",
        connection: {
          transportVersion: 1,
          baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
          protocolVersion: expect.any(Number),
        },
        node: "undefined",
        require: "undefined",
        gpu: "object",
      });
      if (process.env.SIGNALSCOPE_PACKAGE_PLATFORM === "linux") {
        expect(
          (await plotPixelEvidence(page)).nonBackgroundPixels,
        ).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

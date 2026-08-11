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

// eslint-disable-next-line no-empty-pattern -- Playwright requires the object pattern
test("the unpacked Electron package starts outside the checkout", async ({}, testInfo) => {
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
  // Linux and Windows CI runners have no GPU adapter; without software
  // WebGPU the workbench cannot mount and only the unsupported-host screen
  // renders. SwiftShader works on both platforms. Pixel evidence stays
  // Linux-only below.
  if (
    process.env.SIGNALSCOPE_PACKAGE_PLATFORM === "linux" ||
    process.env.SIGNALSCOPE_PACKAGE_PLATFORM === "win32"
  )
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
      const dumpDiagnostics = async (): Promise<void> => {
        await page
          .screenshot({ path: testInfo.outputPath("failure.png") })
          .catch(() => {});
        const markup = await page
          .evaluate(
            () =>
              document.querySelector("#app")?.innerHTML.slice(0, 3000) ??
              "#app missing",
          )
          .catch((reason: unknown) => `unavailable: ${String(reason)}`);
        console.log(`[diagnostic] #app innerHTML: ${markup}`);
        const bridgeState = await page
          .evaluate(async () => {
            const bridge = window.scopeDesktop;
            if (bridge === undefined) return "bridge absent";
            return Promise.race([
              bridge.connect().then((value) => JSON.stringify(value)),
              new Promise<string>((resolve) =>
                setTimeout(
                  () => resolve("connect() unresolved after 5s"),
                  5000,
                ),
              ),
            ]);
          })
          .catch((reason: unknown) => `error: ${String(reason)}`);
        console.log(`[diagnostic] bridge.connect(): ${bridgeState}`);
      };
      try {
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
            if (bridge === undefined)
              throw new Error("desktop bridge is absent");
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
      } catch (error) {
        await dumpDiagnostics();
        throw error;
      }
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

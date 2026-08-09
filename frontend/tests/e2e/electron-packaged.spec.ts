import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the unpacked Electron package starts outside the checkout", async () => {
  const executablePath = process.env.SIGNALSCOPE_PACKAGED_BIN;
  if (executablePath === undefined) {
    test.skip(true, "SIGNALSCOPE_PACKAGED_BIN is not configured");
    return;
  }
  const electronBinary = process.env.SIGNALSCOPE_ELECTRON_BIN;
  const appPath = process.env.SIGNALSCOPE_PACKAGED_APP;
  const userData = await mkdtemp(join(tmpdir(), "signalscope-package-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    executablePath: electronBinary ?? executablePath,
    args: [
      ...(electronBinary === undefined || appPath === undefined
        ? []
        : [appPath]),
      `--user-data-dir=${userData}`,
    ],
    env: {
      ...env,
      NODE_ENV: "production",
      SIGNALSCOPE_GPU_MODE: "software",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveURL("app://signalscope/index.html");
    await expect(page.locator("#app")).toBeVisible();
    expect(
      await page.evaluate(async () => {
        const bridge = window.scopeDesktop;
        if (bridge === undefined) throw new Error("desktop bridge is absent");
        return {
          bridge: typeof bridge,
          protocolVersion: (await bridge.connect()).protocolVersion,
          node: typeof (globalThis as { process?: unknown }).process,
          gpu: typeof navigator.gpu,
        };
      }),
    ).toMatchObject({
      bridge: "object",
      node: "undefined",
      gpu: "object",
    });
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

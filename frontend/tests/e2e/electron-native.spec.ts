import { _electron as electron, expect, test } from "@playwright/test";

test("launches the sandboxed shared frontend with the Rust host", async () => {
  const electronPath = process.env.SIGNALSCOPE_ELECTRON_BIN;
  if (electronPath === undefined) {
    test.skip(true, "SIGNALSCOPE_ELECTRON_BIN is not configured");
    return;
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    executablePath: electronPath,
    args: [new URL("../../../desktop", import.meta.url).pathname],
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveURL("http://127.0.0.1:4173/");
    await expect
      .poll(() => page.evaluate(() => typeof window.scopeDesktop))
      .toBe("object");
    expect(
      await page.evaluate(() => ({
        node: typeof (globalThis as { process?: unknown }).process,
        gpu: typeof navigator.gpu,
      })),
    ).toEqual({ node: "undefined", gpu: "object" });
  } finally {
    await app.close();
  }
});

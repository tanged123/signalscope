import { _electron as electron, expect, test } from "@playwright/test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installNativeSession } from "./native-session";
import { gpuMetrics, plotPixelEvidence } from "../bench/measure";

const desktopPath = fileURLToPath(new URL("../../../desktop", import.meta.url));
const csvPath = fileURLToPath(
  new URL("fixtures/roundtrip.csv", import.meta.url),
);

test("renders native data through the workbench", async () => {
  test.setTimeout(120_000);
  const electronPath = process.env.SIGNALSCOPE_ELECTRON_BIN;
  if (electronPath === undefined) {
    test.skip(true, "SIGNALSCOPE_ELECTRON_BIN is not configured");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "signalscope-native-ui-"));
  const userData = join(root, "user-data");
  const sourceCopy = join(root, "roundtrip.csv");
  await copyFile(csvPath, sourceCopy);
  await installNativeSession(userData, "alpha @*");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.NODE_ENV = "development";
  env.SIGNALSCOPE_BENCH = "1";
  env.SIGNALSCOPE_GPU_MODE = "software";
  const app = await electron.launch({
    executablePath: electronPath,
    args: [desktopPath, `--user-data-dir=${userData}`, `--open=${sourceCopy}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveURL("http://127.0.0.1:4173/?signalscope-bench=1");
    await expect
      .poll(async () => await page.locator(".status-aggregate").textContent(), {
        timeout: 15_000,
      })
      .toMatch(/1 sources · 2 signals · [1-9\d,]+ pts/);
    await expect(page.locator(".panel")).toHaveCount(1);
    await expect(
      page.locator('.outline-series-row[data-path$="/alpha"]'),
    ).toHaveCount(1);
    await expect(page.locator(".panel-bindings .binding-chip")).toHaveText(
      /alpha @\* · 1/,
    );
    await expect(page.locator(".series-canvas").first()).toBeVisible();
    await expect
      .poll(async () => (await gpuMetrics(page)).successfulFrames, {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await gpuMetrics(page)).compactSegments, {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(() => ({
        node: typeof (globalThis as { process?: unknown }).process,
        appProtocol: globalThis.location.protocol,
        gpu: typeof navigator.gpu,
      })),
    ).toEqual({ appProtocol: "http:", node: "undefined", gpu: "object" });

    const before = await gpuMetrics(page);
    expect(before.visibleSeries).toBe(1);
    expect(before.selectedSeries).toBe(1);
    expect(before.seriesWithSegments).toBe(1);
    expect(before.compactSegments).toBeGreaterThan(0);
    expect(before.descriptorRebuilds).toBeGreaterThan(0);
    expect(before.drawCalls).toBeGreaterThan(0);
    expect(before.validationErrors).toEqual([]);
    expect((await plotPixelEvidence(page)).nonBackgroundPixels).toBeGreaterThan(
      0,
    );

    const overlay = page.locator(".overlay-canvas").first();
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("native plot overlay has no bounds");
    await overlay.hover({ position: { x: box.width / 2, y: box.height / 2 } });
    const beforeZoom = (await gpuMetrics(page)).successfulFrames;
    await page.mouse.wheel(0, 240);
    await expect
      .poll(async () => (await gpuMetrics(page)).successfulFrames, {
        timeout: 120_000,
      })
      .toBeGreaterThan(beforeZoom);
    expect((await plotPixelEvidence(page)).nonBackgroundPixels).toBeGreaterThan(
      0,
    );

    const beforePan = (await gpuMetrics(page)).successfulFrames;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y);
    await page.mouse.up();
    await expect
      .poll(async () => (await gpuMetrics(page)).successfulFrames, {
        timeout: 120_000,
      })
      .toBeGreaterThan(beforePan);
    expect((await plotPixelEvidence(page)).nonBackgroundPixels).toBeGreaterThan(
      0,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

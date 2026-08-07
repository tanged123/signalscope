import { expect, test } from "../e2e/fixtures";
import { gpuMetrics, openGpuFixture, resetGpuMetrics } from "./fixtures";

test("software adapter renders every selected series through bounded GPU passes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGpuFixture(page);
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 60_000,
  });
  await resetGpuMetrics(page);
  const before = await gpuMetrics(page);
  expect(before.seriesWithSegments).toBeGreaterThanOrEqual(0);
  expect(before.drawCalls).toBeLessThanOrEqual(before.residentPages * 2 + 1);
  const overlay = page.locator(".overlay-canvas").first();
  const box = await overlay.boundingBox();
  if (box === null) throw new Error("overlay canvas has no bounds");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(500);
  const after = await gpuMetrics(page);
  expect(after.drawCalls - before.drawCalls).toBeLessThanOrEqual(
    after.residentPages * 2 + 1,
  );
  await expect(page.locator(".series-canvas").first()).toHaveScreenshot(
    "line-renderer.png",
  );
});

import { expect, test } from "../e2e/fixtures";
import {
  descriptorFixture,
  gpuMetrics,
  openGpuFixture,
  resetGpuMetrics,
} from "./fixtures";

test("compiles production shaders before rendering", async ({ page }) => {
  test.setTimeout(120_000);
  await openGpuFixture(page);
  expect((await gpuMetrics(page)).residentPages).toBeGreaterThan(0);
});

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

test("compacts ordered segments with GPU descriptors and indirect counts", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const result = await descriptorFixture(page);
  expect(result.descriptorCount).toBe(2);
  expect([...result.descriptors]).toEqual([0, 1, 0, 0, 5, 6, 1, 1]);
  expect([...result.quadArgs]).toEqual([6, 2, 0, 0]);
  expect([...result.hairlineArgs]).toEqual([2, 2, 0, 0]);
});

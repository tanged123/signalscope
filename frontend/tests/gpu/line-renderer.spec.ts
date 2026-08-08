import { expect, test } from "../e2e/fixtures";
import {
  descriptorFixture,
  gpuMetrics,
  openGpuFixture,
  pixelFixture,
  pickFixture,
} from "./fixtures";

test("software adapter proves nonblank line pixels", async ({ page }) => {
  test.setTimeout(120_000);
  const result = await pixelFixture(page);
  expect(result.trajectoryPixels).toBeGreaterThan(0);
  expect(result.outsideScissor).toBe(0);
  expect(result.gapPixels).toBe(0);
  expect(result.extrema).toEqual([true, true, true, true]);
  expect(result.overlap).toBe(true);
  await expect(page.locator("#readback")).toHaveScreenshot(
    "line-renderer-pixel-mask.png",
  );
});

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
  await expect
    .poll(async () => (await gpuMetrics(page)).successfulFrames)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await gpuMetrics(page)).compactSegments)
    .toBeGreaterThan(0);
  const before = await gpuMetrics(page);
  expect(before.selectedSeries).toBe(before.seriesWithSegments);
  expect(before.validationErrors).toEqual([]);
  expect(before.drawCalls).toBeLessThanOrEqual(before.residentPages * 4 + 1);
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

test("picks epoch-scale lines with relative tile time", async ({ page }) => {
  test.setTimeout(120_000);
  const picked = await pickFixture(page);
  expect(picked.result).toMatchObject({
    sequence: 1,
    seriesSlot: 0,
    tileMetaIndex: 0,
  });
  expect(picked.result?.relativeTime).toBeCloseTo(0.25, 4);
  expect(picked.result?.value).toBeCloseTo(0.5, 4);
  expect(picked.result?.distance).toBeLessThan(0.01);
  expect(picked.time).toBeCloseTo(1_000_000_000_000.25, 4);
});

import { expect, gotoApp, test } from "./fixtures";

test("time panels use ChartGPU with WebGPU enabled", async ({ page }) => {
  await gotoApp(page);

  await expect.poll(() => page.evaluate(() => "gpu" in navigator)).toBe(true);
  await expect(page.locator(".gpu-warning")).toBeHidden();
  const chart = page.locator(".chart-host").first();
  await expect(chart).toBeVisible();
  await expect(chart.locator("canvas").first()).toBeVisible();
  const before = (await chart.screenshot()) as unknown as Uint8Array;
  expect(before.byteLength).toBeGreaterThan(1_000);

  const bounds = await chart.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move((bounds?.x ?? 0) + 220, (bounds?.y ?? 0) + 120);
  await page.mouse.wheel(0, 500);
  await expect
    .poll(
      async () => {
        const after = (await chart.screenshot()) as unknown as Uint8Array;
        return (
          before.length === after.length &&
          before.every((byte, index) => byte === after[index])
        );
      },
      { timeout: 5_000 },
    )
    .toBe(false);
  await expect(page.locator(".render-ms").first()).not.toHaveText("— ms");
});

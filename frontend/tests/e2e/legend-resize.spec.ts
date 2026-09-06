import { expect, gotoApp, test } from "./fixtures";

test("legend rail follows the pointer without reverting between frames", async ({
  page,
}) => {
  await page.route("**/api/health", (route) => route.fulfill({ status: 503 }));
  await gotoApp(page);
  await page.locator(".layout-slot").click();
  await page.locator('[data-legend-state="rail"]').click();
  const panel = page.locator(".panel").first();
  const rail = panel.locator(".plot-series-legend");
  const seam = rail.locator(".plot-legend-resize-left");
  await expect(seam).toBeVisible();
  const box = await rail.boundingBox();
  const handle = await seam.boundingBox();
  if (box === null || handle === null) throw new Error("Rail seam is missing");
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const delta of [-40, -80, -60, 50]) {
    await page.mouse.move(x + delta, y);
    const widths = await rail.evaluate(async (element) => {
      const widths: number[] = [];
      for (let frame = 0; frame < 15; frame++) {
        await new Promise(requestAnimationFrame);
        widths.push(element.getBoundingClientRect().width);
      }
      return widths;
    });
    expect(
      Math.max(...widths.map((width) => Math.abs(width - (box.width - delta)))),
    ).toBeLessThan(1);
  }
  await page.mouse.up();
  await expect
    .poll(async () => (await rail.boundingBox())?.width)
    .toBeCloseTo(box.width - 50, 0);
});

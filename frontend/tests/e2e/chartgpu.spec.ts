import { openPlotSettings } from "./fixtures";
import { expect, gotoApp, test } from "./fixtures";

test("recovers when the GPU is lost before the application subscribes", async ({
  page,
}) => {
  await page.addInitScript({
    content: `
    const requestDevice = GPUAdapter.prototype.requestDevice;
    let first = true;
    GPUAdapter.prototype.requestDevice = async function(descriptor) {
      const device = await requestDevice.call(this, descriptor);
      if (first) {
        first = false;
        Object.defineProperty(device, "lost", { value: Promise.resolve({
          reason: "unknown", message: "Device lost during application startup",
        }) });
      }
      return device;
    };
  `,
  });
  await gotoApp(page);
  await expect(
    page.locator(".chart-host canvas:not(.colorbar-canvas)").first(),
  ).toBeVisible();
  await expect(page.locator(".gpu-warning")).toBeHidden();
});

test("time panels use ChartGPU with WebGPU enabled", async ({ page }) => {
  await gotoApp(page);

  await expect.poll(() => page.evaluate(() => "gpu" in navigator)).toBe(true);
  await expect(page.locator(".gpu-warning")).toBeHidden();
  const chart = page.locator(".chart-host").first();
  await expect(chart).toBeVisible();
  await expect(
    chart.locator("canvas:not(.colorbar-canvas)").first(),
  ).toBeVisible({
    timeout: 20_000,
  });
  const before = (await chart.screenshot()) as unknown as Uint8Array;
  expect(before.byteLength).toBeGreaterThan(1_000);

  const bounds = await chart.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    (bounds?.x ?? 0) + (bounds?.width ?? 0) * 0.65,
    (bounds?.y ?? 0) + (bounds?.height ?? 0) * 0.65,
  );
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

test("line style changes submit valid WebGPU command buffers", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await gotoApp(page);

  const panel = page.locator(".panel").first();
  await openPlotSettings(panel);
  await panel.locator(".panel-stats-toggle").click();
  await panel
    .locator(".plot-stat-row .plot-row-inspector-toggle")
    .first()
    .click();
  const inspector = panel.locator(".plot-row-inspector");
  for (const dash of ["dash", "dot", "solid"]) {
    await inspector.locator(".plot-row-dashes").getByText(dash).click();
  }

  const width = inspector.getByLabel("Line width");
  await width.fill("0.5");
  await width.dispatchEvent("change");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  expect(
    consoleErrors.filter((message) =>
      /WGSL|WebGPU|ShaderModule|RenderPipeline|CommandBuffer/i.test(message),
    ),
  ).toEqual([]);
  await expect(page.locator(".render-ms")).not.toHaveText(/^error:/);
});

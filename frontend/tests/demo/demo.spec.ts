import { expect, test, type Page } from "@playwright/test";

const artifact = new URL("../../../build/demo/demo.html", import.meta.url);
const beat = (page: Page) => page.waitForTimeout(900);

test("records the release demo", async ({ page }) => {
  const networkRequests: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) networkRequests.push(request.url());
  });

  await page.goto(artifact.href);
  const firstPanel = page.locator(".panel").first();
  await expect(firstPanel).toBeVisible();
  await beat(page);

  for (const path of [
    "demo_flight/attitude/pitch_deg",
    "demo_flight/attitude/roll_deg",
  ]) {
    await page.locator(`[data-signal-path="${path}"]`).dblclick();
    await expect(
      firstPanel.locator(".plot-legend-row", { hasText: path }),
    ).toHaveCount(1);
    await beat(page);
  }

  const windowReadout = page.locator(".window-readout");
  const initialWindow = await windowReadout.textContent();
  await firstPanel.locator(".overlay-canvas").hover({
    position: { x: 480, y: 260 },
  });
  await page.mouse.wheel(0, -240);
  await expect(windowReadout).not.toHaveText(initialWindow ?? "");
  await beat(page);

  await firstPanel.locator(".panel-split-right").click();
  const firstRow = page.locator(".workspace-row").first();
  await expect(firstRow.locator(".panel")).toHaveCount(2);
  const secondPanel = firstRow.locator(".panel").last();
  await secondPanel.locator(".panel-header").click();
  await beat(page);

  const contrastingSignal = "demo_flight/battery_v";
  await page.locator(`[data-signal-path="${contrastingSignal}"]`).dblclick();
  await expect(
    secondPanel.locator(".plot-legend-row", { hasText: contrastingSignal }),
  ).toHaveCount(1);
  await beat(page);

  await page.locator(".workspace-tab-add").click();
  await expect(page.locator(".workspace-tab")).toHaveCount(2);
  await expect(page.locator(".workspace-tab.active")).toContainText(
    "Workspace 2",
  );
  await beat(page);

  await page
    .locator(".workspace-tab")
    .first()
    .locator(".workspace-tab-select")
    .click();
  await expect(page.locator(".workspace-tab.active")).toContainText(
    "Workspace 1",
  );
  await expect(
    page.locator(".workspace-row").first().locator(".panel"),
  ).toHaveCount(2);
  await beat(page);

  expect(networkRequests).toEqual([]);
});

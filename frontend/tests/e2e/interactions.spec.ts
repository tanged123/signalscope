import { expect, test } from "./fixtures";

test.describe("desktop plot interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("cursor readout, tooltip, linked zoom and stats update", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const panel = page.locator(".panel").first();
    const overlay = panel.locator(".overlay-canvas");
    await overlay.hover({ position: { x: 300, y: 120 } });
    await expect(page.locator(".cursor-readout")).toHaveText("t = —");
    await expect(page.locator(".plot-tip")).toBeHidden();

    await page.locator(".cursor-style-toggle").click();
    await overlay.hover({ position: { x: 300, y: 120 } });
    await expect(page.locator(".cursor-readout")).not.toHaveText("t = —");
    await expect(page.locator(".plot-tip")).toBeHidden();
    await expect(
      page.locator(".tree-scroll .signal-value").first(),
    ).not.toHaveText("—");

    await page.locator(".cursor-style-toggle").click();
    await overlay.hover({ position: { x: 300, y: 120 } });
    await expect(page.locator(".plot-tip")).toBeVisible();
    await expect(page.locator(".plot-tip-row").first()).not.toContainText("—");

    const readout = page.locator(".window-readout");
    const beforeWindow = await readout.textContent();
    await page.mouse.wheel(0, -240);
    await expect(readout).not.toHaveText(beforeWindow ?? "");

    await panel.locator(".panel-header").click();
    await page.keyboard.press("s");
    await expect(panel.locator(".panel-stats")).toBeVisible();
    await expect(panel.locator(".panel-stats")).toContainText("μ");
  });

  test("directional zoom and double-click fit round-trip the window", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const readout = page.locator(".window-readout");
    const fitted = await readout.textContent();
    const overlay = page.locator(".overlay-canvas").first();
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("overlay not laid out");
    await page.mouse.move(box.x + 220, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 225, box.y + 190, { steps: 6 });
    await page.mouse.up();
    await expect(readout).toHaveText(fitted ?? "");

    await page.mouse.move(box.x + 150, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 65, { steps: 6 });
    await page.mouse.up();
    await expect(readout).not.toHaveText(fitted ?? "");
    await overlay.dblclick({ position: { x: 300, y: 120 } });
    await expect(readout).toHaveText(fitted ?? "");
  });

  test("title editing, inline axes and legend inspector are keyboard reachable", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const panel = page.locator(".panel").first();
    const title = panel.locator(".panel-title");
    await title.dblclick();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Body velocity");
    await page.keyboard.press("Enter");
    await expect(title).toHaveText("Body velocity");

    await panel.locator(".panel-axis-toggle").click();
    await expect(panel.locator(".panel-axis-toggle")).toHaveText(
      "axes: inline",
    );

    await panel.locator(".legend-chip-caret").first().click();
    const inspector = panel.locator(".series-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector.locator(".inspector-slot")).toHaveCount(7);
    await inspector.locator(".inspector-dash", { hasText: "dot" }).click();
    await expect(inspector).toBeHidden();
  });
});

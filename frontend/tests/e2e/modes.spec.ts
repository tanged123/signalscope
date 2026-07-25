import { expect, test } from "./fixtures";

test.describe("panel modes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("XY mode adopts the first series as the x axis", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const panel = page.locator(".panel").first();
    await expect(panel.locator(".legend-chip")).toHaveCount(2);
    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    await expect(panel.locator(".mode-pill.active")).toHaveText("XY");
    // The promoted x signal leaves the plotted series.
    await expect(panel.locator(".legend-chip")).toHaveCount(1);
    await expect(panel.locator(".panel-empty")).toBeHidden();
  });

  test("the x chip and the palette both reach XY mode", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const panel = page.locator(".panel").first();
    await panel.locator(".legend-chip-caret").first().click();
    await panel.locator(".inspector-action", { hasText: "use as X" }).click();
    const chip = panel.locator(".x-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("x:");

    await chip.click();
    await expect(panel.locator(".mode-pill.active")).toHaveText("T");
    await expect(chip).toBeHidden();

    await page.keyboard.press("ControlOrMeta+p");
    await page.keyboard.type("switch to XY");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".mode-pill.active")).toHaveText("XY");
  });
});

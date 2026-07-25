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
});

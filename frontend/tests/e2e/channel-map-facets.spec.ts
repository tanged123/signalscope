import { expect, test } from "./fixtures";

test.describe("channel map and facets", () => {
  test("opens the workspace channel map from the dock and palette", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".channel-map-button").click();
    await expect(page.locator(".channel-map-dialog")).toBeVisible();
    await expect(page.locator(".channel-map-header h2")).toHaveText(
      "CHANNEL MAP — WORKSPACE",
    );
    await page.locator(".channel-map-close").click();

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.locator(".palette-input").fill("open channel map");
    await page.keyboard.press("Enter");
    await expect(page.locator(".channel-map-dialog")).toBeVisible();
  });

  test("splits time panels and disables split outside time mode", async ({
    page,
  }) => {
    await page.goto("/");
    const panel = page.locator(".panel").first();
    const split = panel.locator(".panel-split-by");
    await split.click();
    await panel
      .locator(".split-by-popover button", { hasText: "source" })
      .click();
    await expect(panel.locator(".facet-grid")).toBeVisible();
    await expect(panel.locator(".facet-cell").first()).toBeVisible();
    await expect(panel.locator(".legend-split-token")).toContainText(
      "split ← source",
    );

    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    await expect(split).toBeDisabled();
    await expect(split).toHaveAttribute(
      "title",
      "Split applies to time panels",
    );
  });
});

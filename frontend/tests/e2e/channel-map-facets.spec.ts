import { expect, test } from "./fixtures";

test.describe("channel map", () => {
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
});

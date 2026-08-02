import { expect, test } from "./fixtures";

test.describe("channel suggestions and outline replacement", () => {
  test("keeps suggestions in the footer and removes the map surface", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".outline-scroll")).toBeVisible();
    await expect(page.locator(".channel-map-button")).toHaveCount(0);
    await expect(page.locator(".channel-map-dialog")).toHaveCount(0);
    await expect(page.locator(".channel-suggestions")).toHaveCount(1);
  });
});

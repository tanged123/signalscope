import { expect, test } from "@playwright/test";

test("shared presentation plane renders the walking skeleton", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByText("SIGNALSCOPE")).toBeVisible();
  await expect(page.getByLabel("Body velocity panel")).toBeVisible();
  await expect(page.getByText("rocket/velocity_body/x")).toBeVisible();
  await expect(page.locator(".plot-canvas")).toBeVisible();
  await expect(page.locator(".render-ms")).not.toHaveText("— ms");
});

test("theme is a pure token swap", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("Toggle theme (T)").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByLabel("Body velocity panel")).toBeVisible();
});

import { expect, test } from "./fixtures";

test("shared presentation plane renders the demo workspace", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByText("SIGNALSCOPE")).toBeVisible();
  await expect(page.locator(".menu-bar")).toHaveCount(0);
  await expect(page.locator(".tool-bar")).toBeVisible();
  await expect(page.locator(".tool-bar > button").first()).toHaveClass(
    /tree-toggle/,
  );
  await expect(page.locator(".workspace-tabs")).toBeVisible();
  await expect(page.locator(".new-panel")).toHaveCount(0);
  await expect(page.locator(".formula-bar")).toBeHidden();
  await expect(page.locator(".formula-toggle")).toBeVisible();
  await expect(page.locator(".panel-split-right")).toBeVisible();
  await expect(page.locator(".panel-split-down")).toBeVisible();
  await expect(page.getByLabel("Panel 1 panel")).toBeVisible();
  await expect(page.locator(".legend-chip")).toHaveCount(2);
  for (const name of await page.locator(".legend-name").allTextContents()) {
    expect(name.trim()).not.toBe("");
  }
  await expect(page.locator(".plot-canvas").first()).toBeVisible();
  await expect(page.locator(".render-ms")).not.toHaveText("— ms");
  await expect(page.locator(".open-files")).toBeHidden();
});

test("theme is a pure token swap", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("Toggle theme (T)").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByLabel("Panel 1 panel")).toBeVisible();
});

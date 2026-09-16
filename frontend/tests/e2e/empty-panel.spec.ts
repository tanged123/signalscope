import { expect, gotoApp, test } from "./fixtures";

test("N creates an empty panel with keyboard-accessible type choices before signal assignment", async ({
  page,
}, testInfo) => {
  await gotoApp(page);
  await page.locator(".workspace-tab-add").click();
  await expect(page.locator(".workspace-empty")).toBeVisible();
  await page.keyboard.press("n");
  const panel = page.locator(".panel");
  await expect(panel).toHaveCount(1);
  const id = await panel.getAttribute("data-panel-id");
  const choices = panel.getByRole("group", { name: "Panel type", exact: true });
  const scatter = choices.getByRole("button", { name: /^Scatter/ });
  const line = choices.getByRole("button", { name: /^Time series/ });
  await expect(line).toHaveAttribute("aria-pressed", "true");
  await scatter.focus();
  await page.keyboard.press("Enter");
  await expect(scatter).toHaveAttribute("aria-pressed", "true");
  await expect(scatter).toBeFocused();
  await expect(panel.locator(".panel-axes-value")).toContainText("scatter");
  await expect(panel).toHaveAttribute("data-panel-id", id ?? "");
  await panel.locator(".panel-title").click();
  await page.keyboard.press("Control+z");
  await expect(line).toHaveAttribute("aria-pressed", "true");
  await scatter.click();
  await page.screenshot({ path: testInfo.outputPath("empty-panel-types.png") });
  const row = page.locator('.outline-scroll [data-row-kind="series"]').first();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer });
  await panel.dispatchEvent("dragover", { dataTransfer });
  await panel.dispatchEvent("drop", { dataTransfer });
  await expect(panel.locator(".binding-chip")).toHaveCount(1);
  await expect(choices).toHaveCount(0);
  await expect(panel.locator(".panel-axes-value")).toContainText("scatter");
  await expect(panel).toHaveAttribute("data-panel-id", id ?? "");
});

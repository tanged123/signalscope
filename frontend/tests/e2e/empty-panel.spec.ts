import { addPanel, expect, gotoApp, test } from "./fixtures";

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
  const line = choices.getByRole("button", { name: /^2D line/ });
  await expect(line).toHaveAttribute("aria-pressed", "true");
  await scatter.focus();
  await page.keyboard.press("Enter");
  await expect(choices).toHaveCount(0);
  await expect(panel).toBeFocused();
  await expect(panel.locator(".panel-axes-value")).toContainText("scatter");
  await expect(panel).toHaveAttribute("data-panel-id", id ?? "");
  await panel.locator(".panel-title").click();
  await page.keyboard.press("Control+z");
  await expect(line).toHaveAttribute("aria-pressed", "true");
  await scatter.click();
  await expect(choices).toHaveCount(0);
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

test("Right and Down create the selected type once; shortcuts also preserve both split directions", async ({
  page,
}, testInfo) => {
  await gotoApp(page);
  await page.locator(".workspace-tab-add").click();
  await page.keyboard.press("n");
  const panels = page.locator(".panel");
  const first = panels.first();
  await first.getByRole("button", { name: /^2D line/ }).click();
  await expect(first.locator(".panel-empty-choice")).toHaveCount(0);
  await addPanel(first, "Scatter", "Right");
  await expect(panels).toHaveCount(2);
  const rows = page.locator(".workspace-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".panel")).toHaveCount(2);
  await expect(panels.nth(1).locator(".panel-axes-value")).toContainText(
    "scatter",
  );
  await first
    .getByRole("button", { name: "Maximize plot", exact: true })
    .click();
  await addPanel(first, "2D line", "Down");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).locator(".panel")).toHaveCount(1);
  await expect(panels).toHaveCount(3);
  await expect(page.locator(".panel-empty-choice")).toHaveCount(0);
  await expect(panels.last().locator(".panel-axes-value")).not.toContainText(
    "scatter",
  );
  const top = await first.boundingBox();
  const below = await panels.last().boundingBox();
  expect(top).not.toBeNull();
  expect(below?.y).toBeGreaterThanOrEqual((top?.y ?? 0) + (top?.height ?? 0));
  await page.screenshot({
    path: testInfo.outputPath("right-and-down-panels.png"),
  });
  await panels
    .last()
    .getByRole("button", { name: "Add plot right", exact: true })
    .click();
  await expect(rows.nth(1).locator(".panel")).toHaveCount(2);
  await panels
    .last()
    .getByRole("button", { name: "Add plot down", exact: true })
    .click();
  await expect(rows).toHaveCount(3);
  await expect(panels).toHaveCount(5);
  await expect(page.locator(".panel-empty-choice")).toHaveCount(0);
});

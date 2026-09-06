import { expect, gotoApp, openPlotSettings, test } from "./fixtures";

test("session title edits inline with keyboard, cancellation, and undo", async ({
  page,
}) => {
  await gotoApp(page);
  const title = page.getByRole("button", {
    name: "Rename session",
    exact: true,
  });
  await title.click();
  const input = page.getByRole("textbox", {
    name: "Session name",
    exact: true,
  });
  await expect(input).toBeFocused();
  await input.fill("Thermal review");
  await input.press("Enter");
  await expect(title).toHaveText("Thermal review");
  await expect(title).toBeFocused();
  await title.press("Enter");
  await input.fill("Cancelled");
  await input.press("Escape");
  await expect(title).toHaveText("Thermal review");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(title).toHaveText("Untitled");
});

test("Help opens from the menu, traps focus, and closes by Escape or button", async ({
  page,
}) => {
  await gotoApp(page);
  const menu = page.getByRole("button", {
    name: "Application menu",
    exact: true,
  });
  await menu.click();
  await page
    .getByRole("menuitem", { name: "Keyboard and gesture help" })
    .click();
  const help = page.getByRole("dialog", { name: "SignalScope help" });
  await expect(help).toBeVisible();
  await expect(page.getByRole("button", { name: "Close help" })).toBeFocused();
  await expect(help).toContainText("Box zoom");
  await page.keyboard.press("t");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close help" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(menu).toBeFocused();
  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await page.getByRole("button", { name: "Close help" }).click();
  await expect(help).toHaveCount(0);
  await page.getByRole("button", { name: "? Help", exact: true }).click();
  await expect(help).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(help).toHaveCount(0);
});

test("performance details and plot settings stay out of the way and dismiss", async ({
  page,
}) => {
  await gotoApp(page);
  const performance = page.locator(".performance-details");
  await expect(performance.locator(".performance-popover")).toBeHidden();
  await performance.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(performance.locator(".performance-popover")).toBeVisible();
  await expect(performance).toContainText("Estimated GPU memory");
  await page.keyboard.press("Escape");
  await expect(performance.locator(".performance-popover")).toBeHidden();
  const panel = page.locator(".panel").first();
  await expect(panel.locator(".panel-line-width")).toBeHidden();
  await expect(panel.locator(".panel-x-axis")).toBeVisible();
  await openPlotSettings(panel);
  await expect(panel.locator(".panel-line-width")).toBeVisible();
  await panel.locator(".panel-legend-state").click();
  await panel
    .getByRole("menuitemradio", { name: "badge", exact: false })
    .click();
  await expect(panel.locator(".plot-series-legend")).toHaveAttribute(
    "data-state",
    "badge",
  );
  await expect(panel.locator(".plot-settings > summary")).toBeFocused();
  await openPlotSettings(panel);
  await panel.locator(".plot-settings > summary").focus();
  await page.keyboard.press("Escape");
  await expect(panel.locator(".panel-line-width")).toBeHidden();
  await page.setViewportSize({ width: 1100, height: 800 });
  const bounds = await page
    .locator(".status-bar")
    .evaluate((bar) => ({ width: bar.clientWidth, scroll: bar.scrollWidth }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "../build/review/chrome.png" });
});

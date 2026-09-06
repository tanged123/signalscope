import { expect, gotoApp, test } from "./fixtures";

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

test("plot controls and chart metrics are visible inline at desktop sizes", async ({
  page,
}) => {
  await gotoApp(page);
  const performance = page.getByRole("group", { name: "Chart performance" });
  for (const selector of [
    ".render-ms",
    ".performance-cpu",
    ".performance-gpu",
    ".performance-density",
  ]) {
    await expect(performance.locator(selector)).toBeVisible();
  }
  const panel = page.locator(".panel").first();
  for (const selector of [
    ".panel-axis-toggle",
    ".panel-x-axis",
    ".panel-line-width",
    ".panel-ghost-opacity",
    ".panel-legend-state",
    ".panel-stats-toggle",
    ".panel-tips",
  ]) {
    await expect(panel.locator(selector)).toBeVisible();
  }
  await panel.locator(".panel-legend-state").click();
  await panel
    .getByRole("menuitemradio", { name: "badge", exact: false })
    .click();
  await expect(panel.locator(".plot-series-legend")).toHaveAttribute(
    "data-state",
    "badge",
  );
  await expect(panel.locator(".panel-legend-state")).toBeFocused();
  await panel.locator(".panel-line-width").focus();
  await page.keyboard.press("Enter");
  await expect(panel.locator(".panel-config-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.locator(".panel-line-width")).toBeFocused();
  for (const width of [1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await page
      .locator(".status-bar")
      .evaluate((bar) => bar.scrollWidth <= bar.clientWidth);
    expect(fits).toBe(true);
  }
  await page.keyboard.press("n");
  for (const header of await page.locator(".panel-header").all()) {
    expect(
      await header.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
});

test("UI fonts and sizes apply consistently to controls, muted text, and the signal tree", async ({
  page,
}) => {
  await gotoApp(page);
  const selectors = [
    ".workspace-name",
    ".signal-search",
    ".tree-empty",
    ".signal-outline-label",
    ".panel-line-width",
  ];
  for (const selector of selectors) {
    await expect(page.locator(selector).first()).toHaveCSS(
      "font-family",
      /^Inter,/,
    );
  }
  await expect(page.locator(".signal-search")).toHaveCSS("font-size", "11px");
  await expect(page.locator(".tree-empty").first()).toHaveCSS(
    "font-size",
    "11px",
  );
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".palette-hint").first()).toHaveCSS(
    "font-family",
    /^Inter,/,
  );
  await page
    .locator(".palette-row", { hasText: /^UI font/ })
    .first()
    .click();
  await page.keyboard.press("Escape");
  for (const selector of selectors) {
    await expect(page.locator(selector).first()).toHaveCSS(
      "font-family",
      /^"DejaVu Sans",/,
    );
  }
  await page.keyboard.press("Control+Comma");
  const paletteInput = page.locator(".palette-input");
  await paletteInput.press("ArrowDown");
  await paletteInput.press("ArrowDown");
  await paletteInput.press("ArrowDown");
  await paletteInput.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(page.locator(":root")).toHaveCSS("font-size", "14px");
  for (const selector of [
    ".signal-search",
    ".tree-empty",
    ".signal-outline-label",
  ]) {
    const size = await page
      .locator(selector)
      .first()
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(size).toBeCloseTo((11 * 14) / 13, 3);
  }
  await page.locator(".panel-line-width").first().click();
  for (const selector of [
    ".panel-config-title",
    ".panel-config-popover button",
  ]) {
    await expect(page.locator(selector).first()).toHaveCSS(
      "font-family",
      /^"DejaVu Sans",/,
    );
  }
  await page.keyboard.press("Escape");
  await page.locator(".menu-button").click();
  await expect(page.locator(".app-menu-item").first()).toHaveCSS(
    "font-family",
    /^"DejaVu Sans",/,
  );
  await expect(page.locator(".app-menu-heading").first()).toHaveCSS(
    "font-family",
    /^"DejaVu Sans",/,
  );
});

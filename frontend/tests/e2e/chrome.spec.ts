import { expect, gotoApp, test } from "./fixtures";
import manifest from "../../package.json" with { type: "json" };

test("About opens useful release information from the menu and command palette", async ({
  page,
}) => {
  await gotoApp(page);
  const menu = page.getByRole("button", {
    name: "Application menu",
    exact: true,
  });
  const about = page.getByRole("dialog", {
    name: "About SignalScope",
    exact: true,
  });
  const close = page.getByRole("button", { name: "Close about", exact: true });
  await menu.click();
  await page
    .getByRole("menuitem", { name: "About SignalScope", exact: true })
    .click();
  await expect(about).toBeVisible();
  await expect(page.locator(".app-menu")).toBeHidden();
  await expect(about).toContainText(`Version ${manifest.version}`);
  await expect(about).toContainText("engineering telemetry");
  await expect(about).toContainText("MIT License");
  await expect(about).toHaveCSS("font-family", /^Inter,/);
  await expect(close).toBeFocused();
  const docs = about.getByRole("link", { name: "Documentation" });
  const issues = about.getByRole("link", { name: "Report an issue" });
  await expect(docs).toHaveAttribute(
    "href",
    "https://github.com/tanged123/signalscope#readme",
  );
  await expect(issues).toHaveAttribute(
    "href",
    "https://github.com/tanged123/signalscope/issues",
  );
  await page.keyboard.press("Tab");
  await expect(docs).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(issues).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(issues).toBeFocused();
  await page.keyboard.press("t");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");
  await expect(about).toHaveCount(0);
  await expect(menu).toBeFocused();
  await page.keyboard.press("Control+Shift+P");
  await page.locator(".palette-input").fill("About SignalScope");
  await page.locator(".palette-input").press("Enter");
  await expect(about).toBeVisible();
  await close.click();
  await expect(about).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await page
    .getByRole("menuitem", { name: "About SignalScope", exact: true })
    .click();
  await page.mouse.click(2, 2);
  await expect(about).toHaveCount(0);
  await expect(menu).toBeFocused();
});

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

test("compact plot menus retain settings and a single header row", async ({
  page,
}, testInfo) => {
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
    ".panel-axes-summary",
    ".panel-line-width",
    ".plot-legend-header",
    ".panel-legend-state",
  ]) {
    await expect(panel.locator(selector)).toBeVisible();
  }
  await panel.locator(".panel-legend-state").click();
  await panel
    .getByRole("menuitemradio", { name: "collapsed", exact: false })
    .click();
  await expect(panel.locator(".plot-series-legend")).toHaveAttribute(
    "data-state",
    "badge",
  );
  await expect(panel.locator(".panel-legend-state")).toBeFocused();
  await panel.locator(".panel-axes-summary").click();
  for (const control of [
    ".panel-axis-toggle",
    ".panel-y-axis",
    ".panel-x-axis",
    ".panel-c-axis",
    ".panel-axis-limits",
  ])
    await expect(panel.locator(control)).toBeVisible();
  await panel.locator(".panel-axis-limits").click();
  await expect(
    panel.getByRole("dialog", { name: "Axis limits", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.locator(".panel-axes-summary")).toBeFocused();
  await panel.locator(".panel-line-width").focus();
  await page.keyboard.press("Enter");
  await expect(panel.locator(".panel-config-popover")).toBeVisible();
  await expect(
    panel.getByRole("group", { name: "Line width", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("group", { name: "Dim others", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("menuitemradio", { name: "3.0 px", exact: false })
    .click();
  await expect(panel.locator(".panel-line-width")).toContainText("3.0");
  await panel.locator(".panel-legend-state").click();
  await expect(
    panel.getByRole("group", { name: "Statistics", exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("group", { name: /^Tips/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.locator(".panel-legend-state")).toBeFocused();
  for (const width of [1100, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await page
      .locator(".status-bar")
      .evaluate((bar) => bar.scrollWidth <= bar.clientWidth);
    expect(fits).toBe(true);
  }
  await panel.locator(".panel-split-right").click();
  await page.setViewportSize({ width: 1100, height: 900 });
  for (const header of await page.locator(".panel-header").all()) {
    expect(
      await header.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const row = await header.evaluate((element) => {
      const controls = element.querySelector(".panel-toolbar-slot");
      return {
        height: element.getBoundingClientRect().height,
        controlHeight: controls?.getBoundingClientRect().height ?? 0,
      };
    });
    expect(row.height).toBeLessThanOrEqual(row.controlHeight + 2);
  }
  await page.screenshot({
    path: testInfo.outputPath("compact-panel-menus.png"),
  });
  await panel.locator(".panel-line-width").click();
  await expect(
    panel.getByRole("group", { name: "Dim others", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("compact-style-menu.png"),
  });
});

test("UI fonts and sizes apply consistently to controls, muted text, and the signal tree", async ({
  page,
}) => {
  await gotoApp(page);
  const panel = page.locator(".panel").first();
  await panel.getByRole("button", { name: "Readouts", exact: true }).click();
  await panel
    .getByRole("menuitemradio", { name: "expanded", exact: true })
    .click();
  const selectors = [
    ".workspace-name",
    ".signal-search",
    ".tree-empty",
    ".signal-outline-label",
    ".panel-line-width",
    ".plot-legend-header",
    ".plot-legend-encoding",
    ".plot-legend-footer",
  ];
  for (const selector of selectors) {
    await expect(page.locator(selector).first()).toHaveCSS(
      "font-family",
      /^Inter,/,
    );
  }
  await expect(
    page.getByRole("textbox", { name: "Search signals", exact: true }),
  ).toHaveCSS("font-size", "12px");
  await expect(page.locator(".tree-empty").first()).toHaveCSS(
    "font-size",
    "12px",
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
  await paletteInput.fill("UI font size");
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
    expect(size).toBeCloseTo((12 * 14) / 13, 3);
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

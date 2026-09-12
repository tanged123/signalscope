import { expect, gotoApp, test } from "./fixtures";
import { openPanelAxes, togglePanelStats } from "./fixtures";
import { THEME_ORDER } from "../../src/app/themes";

test("panel focus stays quiet and legends stay opaque during navigation", async ({
  page,
}) => {
  await gotoApp(page);
  const panel = page.locator(".panel").first();
  const overlay = panel.locator(".overlay-canvas");
  const legend = panel.locator(".plot-series-legend");
  await expect(legend).toBeVisible();
  await overlay.click({ modifiers: ["Shift"], position: { x: 100, y: 100 } });
  await expect(panel).toBeFocused();
  await expect(panel).toHaveCSS("outline-style", "none");
  await page.mouse.wheel(0, -100);
  await expect(page.locator(".gesture-hint")).toHaveText("wheel: zoom");
  await expect(legend).toHaveCSS("opacity", "1");
  await expect(page.locator(".gesture-hint")).toHaveText("");
  await page.mouse.down({ button: "right" });
  const bounds = await overlay.boundingBox();
  if (bounds === null) throw new Error("missing plot geometry");
  await page.mouse.move(bounds.x + 140, bounds.y + 120);
  await expect(page.locator(".gesture-hint")).toHaveText("drag: pan");
  await expect(legend).toHaveCSS("opacity", "1");
  await page.mouse.up({ button: "right" });
  await expect(page.locator(".gesture-hint")).toHaveText("");
  await openPanelAxes(panel);
  const control = panel.locator(".panel-axis-limits");
  await page.keyboard.press("Tab");
  await control.focus();
  await expect(control).toHaveCSS("outline-style", "solid");
});

test("named theme selection and T cycling preserve plot colors", async ({
  page,
}) => {
  await gotoApp(page);
  const root = page.locator("html");
  const color = await root.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--series-1"),
  );
  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("Theme");
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "Theme", exact: true });
  await expect(
    picker.getByRole("button", { name: "Dark", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await picker.getByRole("button", { name: "Graphite", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Application menu", exact: true }),
  ).toBeFocused();
  await expect(root).toHaveAttribute("data-theme", "graphite");
  await expect(root).toHaveCSS("color-scheme", "dark");
  for (const theme of [
    "paper",
    "contrast_dark",
    "contrast_light",
    "dark",
    "light",
    "graphite",
  ]) {
    await page.keyboard.press("t");
    await expect(root).toHaveAttribute("data-theme", theme);
    expect(
      await root.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--series-1"),
      ),
    ).toBe(color);
  }
  await expect(page.locator(".gpu-warning")).toBeHidden();
});

test("appearance keeps controls and plot space across themes and UI scaling", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.locator(".panel-split-right").click();
  const row = page
    .locator('.signal-outline-row[data-row-kind="series"]')
    .first();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer });
  const secondPanel = page.locator(".panel").last();
  await secondPanel.dispatchEvent("drop", { dataTransfer });
  await row.dispatchEvent("dragend", { dataTransfer });
  await dataTransfer.dispose();
  await expect(secondPanel.locator(".binding-chip")).toHaveCount(1);
  await togglePanelStats(secondPanel);
  const firstPanel = page.locator(".panel").first();
  await firstPanel.locator(".panel-legend-state").click();
  await firstPanel
    .getByRole("menuitemradio", { name: "expanded", exact: false })
    .click();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const plots = page.locator(".plot-wrap");
  const geometry = () =>
    plots.evaluateAll((elements) =>
      elements.map((element) => {
        const { width, height } = element.getBoundingClientRect();
        return { width, height };
      }),
    );
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 1100) {
      await page.keyboard.press("Control+Comma");
      await page.locator(".palette-input").fill("UI font size");
      for (let step = 0; step < 5; step += 1)
        await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Escape");
      await expect(page.locator("html")).toHaveCSS("font-size", "18px");
    }
    const bounds = await geometry();
    for (const theme of THEME_ORDER) {
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const search of [
        page.getByRole("textbox", { name: "Search signals" }),
        page.getByRole("searchbox", { name: "Filter panel roster" }),
      ]) {
        await search.focus();
        await expect(search).toBeFocused();
        await search.press("Tab");
        await expect(search).not.toBeFocused();
      }
      for (const panel of await page.locator(".panel").all()) {
        for (const control of [
          ".panel-axes-summary",
          ".panel-line-width",
          ".panel-legend-state",
          ".panel-split-right",
          ".panel-close",
        ])
          await expect(panel.locator(control)).toBeVisible();
        expect(
          await panel
            .locator(".panel-header")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
      expect(await geometry()).toEqual(bounds);
      const name = `${theme}-${String(width)}`;
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path });
      await testInfo.attach(name, {
        path,
        contentType: "image/png",
      });
      await page.keyboard.press("t");
    }
  }
});

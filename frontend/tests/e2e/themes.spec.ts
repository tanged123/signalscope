import { expect, gotoApp, test } from "./fixtures";
import { THEME_ORDER } from "../../src/app/themes";

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
      const search = page.getByRole("textbox", { name: "Search signals" });
      await search.focus();
      expect(
        await page.locator(".search-filter-row").evaluate((element) => {
          const swatch = document.createElement("span");
          swatch.style.color = "var(--amber-7)";
          element.append(swatch);
          const matches =
            getComputedStyle(element).borderTopColor ===
            getComputedStyle(swatch).color;
          swatch.remove();
          return matches;
        }),
      ).toBe(true);
      await search.press("Tab");
      await expect(search).not.toBeFocused();
      for (const panel of await page.locator(".panel").all()) {
        for (const control of [
          ".panel-x-axis",
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
      await testInfo.attach(`${theme}-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.keyboard.press("t");
    }
  }
});

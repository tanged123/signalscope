import { expect, gotoApp, test } from "./fixtures";

test("ctrl+z undoes and ctrl+y redoes a panel split", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);

  await page.keyboard.press("Control+z");
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".panel")).toHaveCount(2);

  await page.keyboard.press("Control+z");
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.keyboard.press("Control+y");
  await expect(page.locator(".panel")).toHaveCount(2);
});

test("ctrl+z in a text field edits text, not the workspace", async ({
  page,
}) => {
  await gotoApp(page);
  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);

  const search = page.locator(".signal-search");
  await search.click();
  await search.fill("velocity");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".panel")).toHaveCount(2);
});

test("settings apply UI fonts, scale text, and reset line width", async ({
  page,
}) => {
  await gotoApp(page);
  const search = page.getByRole("textbox", {
    name: "Search signals",
    exact: true,
  });
  const initial = await search.evaluate((element) => ({
    font: getComputedStyle(element).fontFamily,
    size: parseFloat(getComputedStyle(element).fontSize),
    rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  await page.keyboard.press("Control+Comma");
  const input = page.getByRole("textbox", {
    name: "Command palette",
    exact: true,
  });
  await input.fill("UI font");
  await input.press("Enter");
  await expect(search).not.toHaveCSS("font-family", initial.font);

  await input.fill("UI font size");
  await input.press("ArrowRight");
  await input.press("+");
  await input.press("-");
  await expect(page.locator(":root")).toHaveCSS(
    "font-size",
    `${String(initial.rootSize + 1)}px`,
  );
  await expect
    .poll(() =>
      search.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      ),
    )
    .toBeCloseTo((initial.size * (initial.rootSize + 1)) / initial.rootSize, 2);

  await input.fill("Plot line width");
  const lineWidth = page.locator(".palette-row", {
    hasText: "Plot line width",
  });
  const originalWidth = await lineWidth.locator(".palette-hint").textContent();
  await input.press("ArrowRight");
  await expect(lineWidth.locator(".palette-hint")).not.toHaveText(
    originalWidth ?? "",
  );
  await input.press("Escape");

  await page.keyboard.press("Control+Shift+P");
  await input.fill("Plot line width: reset");
  await input.press("Enter");
  await page.keyboard.press("Control+Comma");
  await input.fill("Plot line width");
  await expect(lineWidth.locator(".palette-hint")).toHaveText(
    originalWidth ?? "",
  );
});

test("undo restores chrome and preserves panel focus", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("n");
  const panels = page.locator(".panel");
  await panels.nth(0).click();
  const linked = page.getByRole("button", { name: "linked" });
  await linked.click();
  await expect(linked).not.toHaveClass(/active/);

  await page.keyboard.press("Control+z");

  await expect(linked).toHaveClass(/active/);
  await page.keyboard.press("n");
  await expect(
    page.locator(".workspace-row").nth(1).locator(".panel"),
  ).toHaveAttribute("data-panel-id", "panel-3");
});

test("a wheel burst is one undo step", async ({ page }) => {
  await gotoApp(page);
  const readout = page.locator(".window-readout");
  const before = await readout.textContent();
  const overlay = page.locator(".overlay-canvas").first();
  await overlay.hover({ position: { x: 300, y: 160 } });
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  await expect(readout).not.toHaveText(before ?? "");
  await page.waitForTimeout(750);

  await page.keyboard.press("Control+z");

  await expect(readout).toHaveText(before ?? "");
});

test("ctrl+= scales plot text and ctrl+0 resets", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Equal");
  await page.keyboard.press("Control+Equal");

  await page.keyboard.press("Control+Comma");
  const plotSize = page.locator(".palette-row", { hasText: "Plot font size" });
  await expect(plotSize.locator(".palette-hint")).toHaveText("10px");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Digit0");
  await page.keyboard.press("Control+Comma");
  await expect(plotSize.locator(".palette-hint")).toHaveText("9px");
});

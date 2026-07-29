import { expect, test } from "./fixtures";

test("ctrl+z undoes and ctrl+y redoes a panel split", async ({ page }) => {
  await page.goto("/");
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
  await page.goto("/");
  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);

  const search = page.locator(".signal-search");
  await search.click();
  await search.fill("velocity");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".panel")).toHaveCount(2);
});

test("settings palette adjusts fonts and sizes in place", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+Comma");
  const palette = page.locator(".palette");
  await expect(palette).toBeVisible();
  await expect(palette.locator(".palette-row")).toHaveCount(6);

  const plotFont = palette
    .locator(".palette-row", { hasText: "Plot font" })
    .first();
  await expect(plotFont.locator(".palette-hint")).toHaveText("JetBrains Mono");

  const uiSize = palette.locator(".palette-row", { hasText: "UI font size" });
  await expect(uiSize.locator(".palette-hint")).toHaveText("13px");
  await page.locator(".palette-input").press("ArrowDown");
  await page.locator(".palette-input").press("ArrowDown");
  await page.locator(".palette-input").press("ArrowDown");
  await page.locator(".palette-input").press("ArrowRight");
  await expect(uiSize.locator(".palette-hint")).toHaveText("14px");
  await page.locator(".palette-input").press("+");
  await expect(uiSize.locator(".palette-hint")).toHaveText("15px");
  await page.locator(".palette-input").press("-");
  await expect(uiSize.locator(".palette-hint")).toHaveText("14px");
  await expect(page.locator(":root")).toHaveCSS("font-size", "14px");

  await page.keyboard.press("Escape");
});

test("undo restores chrome, favorites, and preserves panel focus", async ({
  page,
}) => {
  await page.goto("/");
  const firstStar = page.locator(".tree-scroll .tree-star").first();
  await firstStar.click();
  await expect(page.locator(".tree-favorites .tree-leaf")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".tree-favorites .tree-leaf")).toHaveCount(0);

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
  await page.goto("/");
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
  await page.goto("/");
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

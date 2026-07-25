import { expect, test } from "./fixtures";

test.describe("panel modes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("XY mode adopts the first series as the x axis", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const panel = page.locator(".panel").first();
    await expect(panel.locator(".legend-chip")).toHaveCount(2);
    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    await expect(panel.locator(".mode-pill.active")).toHaveText("XY");
    // The promoted x signal leaves the plotted series.
    await expect(panel.locator(".legend-chip")).toHaveCount(1);
    await expect(panel.locator(".panel-empty")).toBeHidden();
  });

  test("the x chip and the palette both reach XY mode", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const panel = page.locator(".panel").first();
    await panel.locator(".legend-chip-caret").first().click();
    await panel.locator(".inspector-action", { hasText: "use as X" }).click();
    const chip = panel.locator(".x-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("x:");

    await chip.click();
    await expect(panel.locator(".mode-pill.active")).toHaveText("T");
    await expect(chip).toBeHidden();

    await page.keyboard.press("ControlOrMeta+p");
    await page.keyboard.type("switch to XY");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".mode-pill.active")).toHaveText("XY");
  });

  test("XY zoom stays panel-local and the cursor rings the trajectory", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "desktop interaction");
    const panel = page.locator(".panel").first();
    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    const readout = page.locator(".window-readout");
    const before = await readout.textContent();

    const overlay = panel.locator(".overlay-canvas");
    await overlay.hover({ position: { x: 200, y: 120 } });
    await page.mouse.wheel(0, -240);
    // ADR 0006: an XY panel never writes the linked time window.
    await expect(readout).toHaveText(before ?? "");

    await page.locator(".cursor-style-toggle").click();
    const trajectoryPoint = await panel
      .locator(".plot-canvas")
      .evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext("2d");
        if (context === null) return null;
        const color = getComputedStyle(document.documentElement)
          .getPropertyValue("--series-2")
          .trim();
        const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
        if (match === null) return null;
        const target = match.slice(1).map((part) => Number.parseInt(part, 16));
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        for (let y = 8; y < canvas.height - 8; y += 1) {
          for (let x = 8; x < canvas.width - 8; x += 1) {
            const offset = (y * canvas.width + x) * 4;
            if (
              Math.abs((pixels[offset] ?? 0) - (target[0] ?? 0)) <= 3 &&
              Math.abs((pixels[offset + 1] ?? 0) - (target[1] ?? 0)) <= 3 &&
              Math.abs((pixels[offset + 2] ?? 0) - (target[2] ?? 0)) <= 3
            ) {
              return {
                x: (x * canvas.clientWidth) / canvas.width,
                y: (y * canvas.clientHeight) / canvas.height,
              };
            }
          }
        }
        return null;
      });
    expect(trajectoryPoint).not.toBeNull();
    if (trajectoryPoint !== null) {
      await overlay.hover({ position: trajectoryPoint });
    }
    await expect(page.locator(".cursor-readout")).not.toHaveText("t = —");
  });
});

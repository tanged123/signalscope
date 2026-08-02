import { expect, test } from "./fixtures";

test.describe("desktop plot interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("cursor readout, tooltip, linked zoom and stats update", async ({
    page,
  }) => {
    const panel = page.locator(".panel").first();
    const overlay = panel.locator(".overlay-canvas");
    await overlay.hover({ position: { x: 300, y: 120 } });
    await expect(page.locator(".cursor-mode")).toBeEmpty();
    await expect(page.locator(".cursor-time")).toHaveText("t —");
    await expect(page.locator(".plot-tip")).toBeHidden();

    await page.keyboard.press("c");
    await overlay.hover({ position: { x: 300, y: 120 } });
    await expect(page.locator(".cursor-mode")).toHaveText("cursor: track");
    await expect(page.locator(".cursor-time")).not.toHaveText("t —");
    await expect(page.locator(".plot-tip")).toBeVisible();
    await expect(
      page
        .locator(
          '.outline-scroll [data-row-kind="series"] [data-column="value"]',
        )
        .first(),
    ).not.toHaveText("—");

    await page.keyboard.press("c");
    await overlay.hover({ position: { x: 300, y: 120 } });
    await expect(page.locator(".cursor-mode")).toHaveText("cursor: measure");
    await expect(page.locator(".plot-tip")).toBeHidden();

    const readout = page.locator(".window-readout");
    const beforeWindow = await readout.textContent();
    await page.mouse.wheel(0, -240);
    await expect(readout).not.toHaveText(beforeWindow ?? "");

    await panel.locator(".panel-stats-toggle").click();
    await expect(panel.locator(".panel-stats")).toBeVisible();
    await expect(panel.locator(".panel-stats")).toContainText("μ");
    const metricMargins = await panel
      .locator(".stats-series")
      .first()
      .locator(".stats-item")
      .evaluateAll((items) =>
        items
          .slice(1)
          .map((item) =>
            getComputedStyle(item).getPropertyValue("margin-left"),
          ),
      );
    expect(metricMargins.length).toBeGreaterThan(0);
    expect(metricMargins.every((margin) => margin === "8px")).toBe(true);
  });

  test("the status-bar cursor button cycles the same three modes as C", async ({
    page,
  }) => {
    const button = page.locator(".cursor-toggle");
    const readout = page.locator(".cursor-mode");
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).not.toHaveClass(/active/);
    await expect(button).toHaveAttribute("title", /none/);

    await button.click();
    await expect(readout).toHaveText("cursor: track");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toHaveClass(/active/);
    await expect(button).toHaveAttribute("title", /track/);

    await button.click();
    await expect(readout).toHaveText("cursor: measure");
    await expect(button).toHaveAttribute("aria-pressed", "true");

    await button.click();
    await expect(readout).toBeEmpty();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).not.toHaveClass(/active/);

    // The keyboard path drives the same state, so the button follows it.
    await page.keyboard.press("c");
    await expect(readout).toHaveText("cursor: track");
    await expect(button).toHaveAttribute("aria-pressed", "true");
  });

  test("directional zoom and double-click fit round-trip the window", async ({
    page,
  }) => {
    const readout = page.locator(".window-readout");
    const fitted = await readout.textContent();
    const overlay = page.locator(".overlay-canvas").first();
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("overlay not laid out");
    await page.mouse.move(box.x + 220, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 225, box.y + 190, { steps: 6 });
    await page.mouse.up();
    await expect(readout).toHaveText(fitted ?? "");

    await page.mouse.move(box.x + 150, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 65, { steps: 6 });
    await expect(page.locator(".gesture-hint")).toHaveText("drag: zoom X");
    await page.mouse.up();
    await expect(page.locator(".gesture-hint")).toBeEmpty();
    await expect(readout).not.toHaveText(fitted ?? "");
    await overlay.dblclick({ position: { x: 300, y: 120 } });
    await expect(readout).toHaveText(fitted ?? "");
  });

  test("title editing, inline axes and rules are keyboard reachable", async ({
    page,
  }) => {
    const panel = page.locator(".panel").first();
    const title = panel.locator(".panel-title");
    await title.dblclick();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Body velocity");
    await page.keyboard.press("Enter");
    await expect(title).toHaveText("Body velocity");

    await panel.locator(".panel-axis-toggle").click();
    await expect(panel.locator(".panel-axis-toggle")).toHaveText(
      "axes: inline",
    );

    await panel.locator(".color-rule-token").click();
    const rules = panel.locator(".rules-popover");
    await expect(rules).toBeVisible();
    await expect(rules.locator(".rules-dimension")).toHaveCount(5);
    await rules.getByRole("button", { name: "color ← channel" }).click();
    await expect(rules).toBeHidden();
  });
});

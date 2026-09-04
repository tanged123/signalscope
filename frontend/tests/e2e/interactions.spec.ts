import { expect, gotoApp, test } from "./fixtures";
import type { Page } from "@playwright/test";

interface AxisLabelProbe {
  frames: Array<Array<{ text: string; x: number; y: number }>>;
  current: Array<{ text: string; x: number; y: number }>;
}

async function installAxisLabelProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: AxisLabelProbe = { frames: [], current: [] };
    (
      window as unknown as { __axisLabelProbe: AxisLabelProbe }
    ).__axisLabelProbe = probe;
    const originalClearRect = Object.getOwnPropertyDescriptor(
      CanvasRenderingContext2D.prototype,
      "clearRect",
    )?.value as (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
      width: number,
      height: number,
    ) => void;
    const originalFillText = Object.getOwnPropertyDescriptor(
      CanvasRenderingContext2D.prototype,
      "fillText",
    )?.value as (
      this: CanvasRenderingContext2D,
      text: string,
      x: number,
      y: number,
      maxWidth?: number,
    ) => void;
    CanvasRenderingContext2D.prototype.clearRect = function (
      this: CanvasRenderingContext2D,
      x: number,
      y: number,
      width: number,
      height: number,
    ): void {
      if (this.canvas.closest(".chart-host") !== null) {
        if (probe.current.length > 0) probe.frames.push(probe.current);
        probe.current = [];
      }
      originalClearRect.call(this, x, y, width, height);
    };
    CanvasRenderingContext2D.prototype.fillText = function (
      this: CanvasRenderingContext2D,
      text: string,
      x: number,
      y: number,
      maxWidth?: number,
    ): void {
      if (this.canvas.closest(".chart-host") !== null) {
        probe.current.push({ text, x, y });
      }
      if (maxWidth === undefined) originalFillText.call(this, text, x, y);
      else originalFillText.call(this, text, x, y, maxWidth);
    };
  });
}

async function resetAxisLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (window as unknown as { __axisLabelProbe: AxisLabelProbe })
      .__axisLabelProbe;
    probe.frames.splice(0);
    probe.current.splice(0);
  });
}

async function latestAxisLabels(
  page: Page,
): Promise<Array<{ text: string; x: number; y: number }>> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __axisLabelProbe: AxisLabelProbe })
      .__axisLabelProbe;
    return probe.frames.at(-1) ?? probe.current;
  });
}

test.describe("desktop plot interactions", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    const panel = page.locator(".panel").first();
    await expect(panel).toBeVisible();
    await expect(panel.locator(".chart-host canvas").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator(".render-ms").first()).not.toHaveText("— ms");
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
    const stats = panel.locator(".plot-legend-stats");
    await expect(stats).toBeVisible();
    await expect(stats).toContainText("μ");
    await expect(panel.locator(".panel-stats")).toHaveCount(0);
    await expect(stats.locator(".plot-stat-row")).not.toHaveCount(0);

    const mean = stats.locator('.plot-stat-sort[data-column="mean"]');
    await mean.click();
    await expect(mean).toHaveClass(/active/);
    await expect(mean).toContainText("↓");
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
    const overlay = page.locator(".panel").first().locator(".overlay-canvas");
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("overlay not laid out");
    await overlay.hover({ position: { x: 220, y: 50 } });
    await page.mouse.down();
    await overlay.hover({ position: { x: 225, y: 190 } });
    await page.mouse.up();
    await expect(readout).toHaveText(fitted ?? "");

    await overlay.hover({
      position: { x: box.width * 0.25, y: box.height * 0.55 },
    });
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.56, {
      steps: 6,
    });
    await expect(page.locator(".gesture-hint")).toHaveText("drag: zoom X");
    await page.mouse.up();
    await expect(page.locator(".gesture-hint")).toBeEmpty();
    await expect(readout).not.toHaveText(fitted ?? "");
    await overlay.dblclick({
      position: { x: box.width * 0.5, y: box.height * 0.5 },
    });
    await expect(readout).toHaveText(fitted ?? "");
  });

  test("title editing, inline axes and line properties are keyboard reachable", async ({
    page,
  }) => {
    const panel = page.locator(".panel").first();
    const title = panel.locator(".panel-title");
    await title.dblclick();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Body velocity");
    await page.keyboard.press("Enter");
    await expect(title).toHaveText("Body velocity");

    const colorEncoding = panel.locator(
      '.plot-legend-encoding-chip[data-property="color"]',
    );
    await colorEncoding.click();
    const drawer = panel.locator(".plot-encoding-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".plot-encoding-choice")).toHaveCount(6);
    await drawer.getByRole("button", { name: "channel" }).click();
    await expect(colorEncoding).toContainText("color ← channel");
    await expect(drawer).toBeHidden();

    await panel.locator(".panel-stats-toggle").click();
    const swatch = panel
      .locator(".plot-stat-body .plot-stat-row .plot-row-inspector-toggle")
      .first();
    await swatch.click();
    const inspector = panel.locator(".plot-row-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText("line");
    await expect(inspector.locator(".plot-row-dashes")).toBeVisible();
    await expect(
      inspector.locator('input[aria-label="Line width"]'),
    ).toBeVisible();
    await expect(inspector.locator(".quick-transform")).toHaveCount(0);
  });
});

test("zoomed axes keep visible tick labels distinct", async ({ page }) => {
  await installAxisLabelProbe(page);
  await gotoApp(page);

  const panel = page.locator(".panel").first();
  const overlay = panel.locator(".overlay-canvas");
  await expect(overlay).toBeVisible();
  await expect
    .poll(async () => (await latestAxisLabels(page)).length)
    .toBeGreaterThan(0);
  await resetAxisLabels(page);

  const fitted = await page.locator(".window-readout").textContent();
  await overlay.hover({ position: { x: 300, y: 120 } });
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, -240);
  }
  await expect(page.locator(".window-readout")).not.toHaveText(fitted ?? "");
  await expect
    .poll(async () => (await latestAxisLabels(page)).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  const chartHeight =
    (await panel.locator(".chart-host").boundingBox())?.height ?? 0;
  const xLabels = (await latestAxisLabels(page))
    .filter(
      ({ text, x, y }) =>
        x >= 60 && y >= chartHeight - 45 && /^[-−]?\d/.test(text),
    )
    .map(({ text }) => text);
  expect(xLabels.length).toBeGreaterThan(1);
  expect(new Set(xLabels).size).toBe(xLabels.length);
  expect(xLabels.some((label) => label.includes("."))).toBe(true);
});

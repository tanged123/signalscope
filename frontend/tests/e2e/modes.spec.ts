import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

async function trajectoryPoints(
  panel: Locator,
  count: number,
  horizontalOnly = false,
): Promise<{ x: number; y: number }[]> {
  return panel.locator(".plot-canvas").evaluate(
    (canvas: HTMLCanvasElement, options) => {
      const context = canvas.getContext("2d");
      if (context === null) return [];
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue("--series-1")
        .trim();
      const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
      if (match === null) {
        throw new Error(
          `trajectoryPoints expected --series-1 as #rrggbb, received "${color}"`,
        );
      }
      const target = match.slice(1).map((part) => Number.parseInt(part, 16));
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      const matchesColor = (x: number, y: number): boolean => {
        const offset = (y * canvas.width + x) * 4;
        return (
          Math.abs((pixels[offset] ?? 0) - (target[0] ?? 0)) <= 3 &&
          Math.abs((pixels[offset + 1] ?? 0) - (target[1] ?? 0)) <= 3 &&
          Math.abs((pixels[offset + 2] ?? 0) - (target[2] ?? 0)) <= 3
        );
      };
      const matches: { x: number; y: number }[] = [];
      for (let y = 8; y < canvas.height - 8; y += 1) {
        for (let x = 8; x < canvas.width - 8; x += 1) {
          if (
            matchesColor(x, y) &&
            (!options.horizontalOnly ||
              (matchesColor(x - 4, y) && matchesColor(x + 4, y)))
          ) {
            matches.push({
              x: (x * canvas.clientWidth) / canvas.width,
              y: (y * canvas.clientHeight) / canvas.height,
            });
          }
        }
      }
      if (matches.length === 0) return [];
      const selected = [matches[0] as { x: number; y: number }];
      while (selected.length < options.count) {
        let best: { x: number; y: number } | undefined;
        let bestDistance = -1;
        for (const candidate of matches) {
          const distance = Math.min(
            ...selected.map((point) =>
              Math.hypot(candidate.x - point.x, candidate.y - point.y),
            ),
          );
          if (distance > bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
        if (best === undefined || bestDistance < 20) break;
        selected.push(best);
      }
      return selected;
    },
    { count, horizontalOnly },
  );
}

async function histogramBinStart(
  overlay: Locator,
  readout: Locator,
): Promise<number> {
  await overlay.hover({ position: { x: 250, y: 120 } });
  await expect(readout).toContainText("bin");
  const text = (await readout.textContent()) ?? "";
  const match = /bin\s+([−+\d.e]+)/.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(`could not parse histogram interval from "${text}"`);
  }
  return Number(match[1].replace("−", "-"));
}

test.describe("panel modes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("XY mode adopts the first series as the x axis", async ({ page }) => {
    const panel = page.locator(".panel").first();
    await expect(panel.locator(".binding-chip")).toHaveCount(2);
    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    await expect(panel.locator(".mode-pill.active")).toHaveText("XY");
    // The promoted x signal leaves the plotted series.
    await expect(panel.locator(".binding-chip")).toHaveCount(1);
    await expect(panel.locator(".panel-empty")).toBeHidden();

    await panel.locator(".mode-pill", { hasText: "FFT" }).click();
    await expect(panel.locator(".binding-chip")).toHaveCount(1);

    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    await expect(panel.locator(".binding-chip")).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.keyboard.type("switch to histogram");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".mode-pill.active")).toHaveText("H");
    await expect(panel.locator(".binding-chip")).toHaveCount(1);
  });

  test("the x chip and the palette both reach XY mode", async ({ page }) => {
    const panel = page.locator(".panel").first();
    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    const chip = panel.locator(".x-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("x:");

    await chip.click();
    await expect(panel.locator(".mode-pill.active")).toHaveText("XY");
    await expect(chip).toBeHidden();
    await expect(panel.locator(".panel-empty")).toContainText("set the X axis");

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.keyboard.type("clear X signal");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".mode-pill.active")).toHaveText("XY");
    await expect(chip).toBeHidden();
  });

  test("XY zoom stays panel-local and the cursor rings the trajectory", async ({
    page,
  }) => {
    const panel = page.locator(".panel").first();
    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    const readout = page.locator(".window-readout");
    const before = await readout.textContent();

    const overlay = panel.locator(".overlay-canvas");
    await overlay.hover({ position: { x: 200, y: 120 } });
    await page.mouse.wheel(0, -240);
    // ADR 0006: an XY panel never writes the linked time window.
    await expect(readout).toHaveText(before ?? "");

    await page.keyboard.press("c");
    const [trajectoryPoint] = await trajectoryPoints(panel, 1);
    expect(trajectoryPoint).toBeDefined();
    if (trajectoryPoint !== undefined) {
      await overlay.hover({ position: trajectoryPoint });
    }
    await expect(page.locator(".cursor-mode")).toHaveText("cursor: track");
    await expect(page.locator(".cursor-time")).not.toHaveText("t —");

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.keyboard.type("set color signal");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".c-chip")).toContainText("time");
    if (trajectoryPoint !== undefined) {
      await overlay.hover({ position: trajectoryPoint });
    }
    const tip = page.locator(".plot-tip");
    await expect(tip).toBeVisible();
    await expect(tip.locator(".plot-tip-header")).toContainText("t =");
    await expect(tip.locator(".plot-tip-row")).toHaveCount(3);
    await expect(tip.locator(".signal-path").nth(0)).toContainText("x ·");
    await expect(tip.locator(".signal-path").nth(1)).toContainText("y ·");
    await expect(tip.locator(".signal-path").nth(2)).toContainText("c · time");
    await expect(tip.locator(".plot-tip-row").first()).not.toContainText("—");

    // Clicking elsewhere dismisses the transient tooltip even when a
    // synthetic pointer event does not first move the cursor off the canvas.
    await page.locator(".brand").dispatchEvent("pointerdown");
    await expect(tip).toBeHidden();
  });

  test("XY datatips pin, list, and show a delta", async ({ page }) => {
    const panel = page.locator(".panel").first();
    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    const overlay = panel.locator(".overlay-canvas");
    const list = panel.locator(".panel-annotations");
    const [firstPoint] = await trajectoryPoints(panel, 1);
    expect(firstPoint).toBeDefined();
    if (firstPoint !== undefined) {
      await overlay.click({ position: firstPoint });
    }
    await expect(list).toBeVisible();
    const pointsAfterReflow = await trajectoryPoints(panel, 2);
    expect(pointsAfterReflow).toHaveLength(2);
    const secondPoint = pointsAfterReflow[1];
    if (secondPoint !== undefined) {
      await overlay.click({ position: secondPoint });
    }
    await expect(list.locator(".annotation-row")).toHaveCount(2);
  });

  test("the colour channel is assignable and clearable", async ({ page }) => {
    const panel = page.locator(".panel").first();
    await panel.locator(".mode-pill", { hasText: "XY" }).click();
    const chip = panel.locator(".c-chip");
    await expect(chip).toContainText("none");

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.keyboard.type("set color signal");
    await page.keyboard.press("Enter");
    await expect(chip).toContainText("time");

    const overlay = panel.locator(".overlay-canvas");
    const box = await overlay.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      const colorLabel = { x: box.width - 48, y: box.height / 2 };
      await overlay.dblclick({ position: colorLabel });
      const editor = panel.getByLabel("Color axis name");
      await expect(editor).toBeVisible();
      await editor.fill("flight phase");
      await page.keyboard.press("Enter");
      await overlay.dblclick({ position: colorLabel });
      await expect(editor).toHaveValue("flight phase");
      await editor.fill("");
      await page.keyboard.press("Enter");
      await overlay.dblclick({ position: colorLabel });
      await expect(editor).toHaveValue("");
      await page.keyboard.press("Escape");
    }

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.locator(".palette-input").fill("edit color axis label");
    await page.keyboard.press("Enter");
    await expect(panel.getByLabel("Color axis name")).toBeVisible();
    await page.keyboard.press("Escape");

    await panel.locator(".mode-pill", { hasText: "FFT" }).click();
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.locator(".palette-input").fill("edit color axis label");
    await expect(
      page.locator(".palette-row", { hasText: "edit color axis label" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await panel.locator(".mode-pill", { hasText: "XY" }).click();

    await chip.click();
    await expect(chip).toContainText("none");

    const leaf = page.locator(".tree-scroll .tree-leaf").last();
    const signalPath = await leaf.getAttribute("data-signal-path");
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await leaf.dispatchEvent("dragstart", { dataTransfer: transfer });
    await chip.dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(chip).toHaveClass(/drop-target/);
    await chip.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(chip).toContainText(
      signalPath?.split("/").slice(-2).join("/") ?? "",
    );

    await chip.click();
    await expect(chip).toContainText("none");

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.keyboard.type("set color signal");
    await page.keyboard.press("Enter");
    await expect(chip).toContainText("time");
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.keyboard.type("clear color signal");
    await page.keyboard.press("Enter");
    await expect(chip).toContainText("none");
  });

  test("FFT mode announces its window and zooms locally", async ({ page }) => {
    const panel = page.locator(".panel").first();
    await panel.locator(".mode-pill", { hasText: "FFT" }).click();
    await expect(panel.locator(".panel-mode-note")).toHaveText(
      "window: visible t",
    );
    await expect(panel.locator(".panel-empty")).toBeHidden();

    const readout = page.locator(".window-readout");
    const before = await readout.textContent();
    const cursorReadout = page.locator(".cursor-time");
    await page.keyboard.press("c");
    await panel
      .locator(".overlay-canvas")
      .hover({ position: { x: 250, y: 120 } });
    await expect(cursorReadout).toContainText("f =");
    const tip = page.locator(".plot-tip");
    await expect(tip).toBeVisible();
    await expect(tip.locator(".plot-tip-header")).toContainText("f =");
    await expect(tip.locator(".plot-tip-row")).toHaveCount(2);
    await expect(tip.locator(".plot-tip-value").first()).toContainText("dB");
    await page.mouse.wheel(0, -240);
    await expect(readout).toHaveText(before ?? "");
  });

  test("histogram mode draws a distribution of the visible window", async ({
    page,
  }) => {
    const panel = page.locator(".panel").first();
    await panel.locator(".mode-pill", { hasText: "H" }).click();
    await expect(panel.locator(".mode-pill.active")).toHaveText("H");
    await expect(panel.locator(".panel-empty")).toBeHidden();
    await expect(panel.locator(".panel-mode-note")).toHaveText(
      "window: visible t",
    );
    await expect(page.locator(".render-ms")).not.toHaveText("— ms");

    await page.keyboard.press("c");
    await panel
      .locator(".overlay-canvas")
      .hover({ position: { x: 250, y: 120 } });
    await expect(page.locator(".cursor-time")).toContainText("bin");
    const tip = page.locator(".plot-tip");
    await expect(tip).toBeVisible();
    await expect(tip.locator(".plot-tip-header")).toContainText("bin");
    await expect(tip.locator(".plot-tip-row")).toHaveCount(2);
    await expect(tip.locator(".plot-tip-value").first()).toContainText(
      "samples",
    );
  });

  test("histogram zoom, pan, and fit move only its viewport", async ({
    page,
  }) => {
    const panel = page.locator(".panel").first();
    await panel.locator(".mode-pill", { hasText: "H" }).click();
    await page.keyboard.press("c");
    const overlay = panel.locator(".overlay-canvas");
    const readout = page.locator(".cursor-time");
    const fitted = await histogramBinStart(overlay, readout);

    await overlay.hover({ position: { x: 400, y: 120 } });
    await page.mouse.wheel(0, -240);
    const zoomed = await histogramBinStart(overlay, readout);
    expect(zoomed).not.toBeCloseTo(fitted, 4);

    const box = await overlay.boundingBox();
    if (box === null) throw new Error("overlay not laid out");
    await page.keyboard.down("Control");
    await page.mouse.move(box.x + 250, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(box.x + 330, box.y + 120, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    const panned = await histogramBinStart(overlay, readout);
    expect(panned).toBeLessThan(zoomed);

    await overlay.dblclick({ position: { x: 250, y: 120 } });
    expect(await histogramBinStart(overlay, readout)).toBeCloseTo(fitted, 4);
  });

  for (const mode of [
    { pill: "FFT", delta: "Δf", stats: "peak f" },
    { pill: "H", delta: "Δvalue", stats: "bins" },
  ]) {
    test(`${mode.pill} supports retained annotations, deltas, and native stats`, async ({
      page,
    }) => {
      const panel = page.locator(".panel").first();
      await panel.locator(".mode-pill", { hasText: mode.pill }).click();
      await panel.locator(".panel-stats-toggle").click();
      await expect(panel.locator(".panel-stats")).toBeVisible();
      await expect(panel.locator(".panel-stats")).toContainText(mode.stats);

      const horizontalOnly = mode.pill === "H";
      const [firstPoint] = await trajectoryPoints(panel, 1, horizontalOnly);
      expect(firstPoint).toBeDefined();
      const overlay = panel.locator(".overlay-canvas");
      if (firstPoint !== undefined) {
        await overlay.click({ position: firstPoint });
      }
      const pointsAfterReflow = await trajectoryPoints(
        panel,
        2,
        horizontalOnly,
      );
      expect(pointsAfterReflow).toHaveLength(2);
      const secondPoint = pointsAfterReflow[1];
      if (secondPoint !== undefined) {
        await overlay.click({ position: secondPoint });
      }
      const list = panel.locator(".panel-annotations");
      await expect(list.locator(".annotation-row")).toHaveCount(2);
      await expect(list.locator(".annotation-delta")).toContainText(mode.delta);

      await panel.getByRole("button", { name: "T", exact: true }).click();
      await expect(list).toBeHidden();
      await panel.locator(".mode-pill", { hasText: mode.pill }).click();
      await expect(list.locator(".annotation-row")).toHaveCount(2);
    });
  }

  test("the application menu stats command reaches every panel", async ({
    page,
  }) => {
    await page.keyboard.press("n");
    await expect(page.locator(".panel")).toHaveCount(2);
    // A panel with nothing plotted has no statistics to show, so the new panel
    // needs a signal before the strip can prove the command reached it.
    const second = page.locator(".panel").last();
    await page.locator(".tree-scroll .tree-leaf").first().focus();
    await page.keyboard.press("Enter");
    await expect(second.locator(".binding-chip")).toHaveCount(1);
    const stats = page.locator(".panel-stats");

    await page.locator(".menu-button").click();
    const toggle = page.locator(".app-menu-item", {
      hasText: "Toggle statistics",
    });
    await toggle.click();
    await expect(stats).toHaveCount(2);
    await expect(stats.first()).toBeVisible();
    await expect(stats.last()).toBeVisible();

    await page.locator(".menu-button").click();
    await expect(
      page
        .locator(".app-menu-item", { hasText: "Toggle statistics" })
        .locator(".app-menu-check"),
    ).toHaveText("✓");
    await page
      .locator(".app-menu-item", { hasText: "Toggle statistics" })
      .click();
    await expect(stats.first()).toBeHidden();
    await expect(stats.last()).toBeHidden();
  });

  test("mode help preserves the render metric", async ({ page }) => {
    const renderMetric = page.locator(".render-ms");
    const before = await renderMetric.textContent();
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.keyboard.type("Help: XY mode gestures");
    await page.keyboard.press("Enter");
    await expect(page.locator(".mode-help")).toContainText("XY: drag box-zoom");
    await expect(renderMetric).toHaveText(before ?? "");
  });
});

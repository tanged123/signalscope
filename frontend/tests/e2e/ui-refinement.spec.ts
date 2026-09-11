import { expect, gotoApp, test } from "./fixtures";
import { WorkspaceModel } from "../../src/app/workspace";
import { seal } from "../../src/app/envelope";
import { mkdirSync } from "node:fs";

test("dense workspace readability and independent signal states", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const phase = process.env.SIGNALSCOPE_UI_CAPTURE ?? "after";
  const workspace = new WorkspaceModel();
  const first = workspace.addPanelRow();
  const second = workspace.splitPanelRight(first.id);
  if (second === null) throw new Error("Missing second panel");
  const signals = Array.from({ length: 48 }, (_, index) => {
    const channel = `propulsion/test_stand/temperature_sensor_${String(index + 1).padStart(2, "0")}`;
    const bins = Array.from({ length: 1800 }, (_, sample) => {
      const t = sample / 30;
      const v = 30 + index * 0.8 + 10 * Math.sin(t / 6 + index / 9);
      return {
        t0: t,
        t1: t,
        first: v,
        last: v,
        min: v,
        max: v,
        sum: v,
        sum_sq: v * v,
        finite_count: "1",
        sample_count: "1",
        has_gap: false,
      };
    });
    return {
      summary: {
        signal_id: String(index + 1),
        source_id: "1",
        source_key: "test-stand",
        local_path: channel,
        path: `test-stand/${channel}`,
        unit: "°C",
        point_count: "1800",
        t_min: 0,
        t_max: 59.9667,
        last_value: bins.at(-1)?.last ?? null,
      },
      levels: [bins],
    };
  });
  for (const [index, panel] of [first, second].entries()) {
    panel.title =
      index === 0 ? "Propulsion temperature overview" : "Sensor comparison";
    panel.bindings = [{ kind: "query", selector: "*", refs: [], set_id: null }];
    panel.axis_style = "gutter";
    panel.legend_state = index === 0 ? "roster" : "rail";
    panel.legend_dock = index === 0 ? null : "right";
    panel.legend_size = [250, 420];
    panel.ghost_mode = "ghost";
    panel.ghost_opacity = 0.35;
    panel.focus = signals.slice(0, 2).map((signal) => ({
      kind: "series",
      ref: {
        source_key: "test-stand",
        channel: signal.summary.local_path,
      },
      source_key: null,
      channel: signal.summary.local_path,
    }));
    panel.overrides = signals.slice(1, 3).map((signal) => ({
      target_ref: {
        source_key: "test-stand",
        channel: signal.summary.local_path,
      },
      target_selector: null,
      color_slot: null,
      dash: null,
      width: null,
      opacity: null,
      visible: false,
    }));
  }
  const manifest = seal({
    preferences_json: null,
    session_json: JSON.stringify(workspace.snapshot()),
    signals,
    line2d: null,
  });
  await page.route(/http:\/\/127\.0\.0\.1:417[34]\/$/, async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(
      /(<script id="signalscope-baked-data"[^>]*>)[\s\S]*?(<\/script>)/,
      `$1${JSON.stringify(manifest)}$2`,
    );
    await route.fulfill({ response, body: html });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  if (phase === "before") {
    await page.goto("http://127.0.0.1:4174/");
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
  } else await gotoApp(page);
  await expect(page.locator(".panel")).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator(".render-ms")).not.toHaveText("— ms");
  await page.mouse.move(5, 5);
  mkdirSync("../build/ui-review", { recursive: true });
  await page.screenshot({ path: `../build/ui-review/${phase}-native.png` });
  await testInfo.attach(`${phase}-native`, {
    path: `../build/ui-review/${phase}-native.png`,
    contentType: "image/png",
  });
  const firstPanel = page.locator(".panel").first();
  const row = (index: number) =>
    firstPanel.locator(".plot-legend-roster-row").filter({
      hasText: `temperature_sensor_${String(index).padStart(2, "0")}`,
    });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("UI font size");
  const uiSize = page.locator(".palette-row.selected .palette-hint");
  await expect(page.locator(".palette-row.selected")).toContainText(
    "UI font size",
  );
  for (let step = 0; step < 5; step++) {
    await page.keyboard.press("ArrowRight");
    await expect(uiSize).toHaveText(`${String(14 + step)}px`);
  }
  await page.locator(".palette-input").fill("Plot font size");
  await expect(page.locator(".palette-row.selected")).toContainText(
    "Plot font size",
  );
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press("ArrowRight");
    await expect(uiSize).toHaveText(`${String(9.5 + step * 0.5)}px`);
  }
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await page.screenshot({
    path: `../build/ui-review/${phase}-large-narrow.png`,
  });
  await testInfo.attach(`${phase}-large-narrow`, {
    path: `../build/ui-review/${phase}-large-narrow.png`,
    contentType: "image/png",
  });
  if (phase === "before") return;
  if (phase !== "before") {
    await expect(row(1)).toHaveClass(/focused/);
    await expect(row(1)).toHaveAttribute("data-hidden", "false");
    await expect(row(2)).toHaveClass(/focused/);
    await expect(row(2)).toHaveAttribute("data-hidden", "true");
    await expect(row(3)).not.toHaveClass(/focused/);
    await expect(row(3)).toHaveAttribute("data-hidden", "true");
    await expect(row(4)).toHaveAttribute("data-dimmed", "true");
    await expect(row(4).locator(".plot-series-state")).toHaveText("dimmed");
    await expect(row(4).locator(".plot-legend-label")).toHaveCSS(
      "text-decoration-line",
      "none",
    );
    await row(4).locator(".plot-legend-roster-action").hover();
    await expect(row(4)).toHaveAttribute("data-hidden", "false");
    await row(3).locator(".plot-legend-roster-action").focus();
    await expect(row(3).locator(".plot-legend-roster-action")).toBeFocused();
    await expect(row(3).locator(".plot-legend-roster-action")).toHaveCSS(
      "outline-style",
      "solid",
    );
    await page.keyboard.press("Enter");
    await expect(row(3)).toHaveClass(/focused/);
    await expect(row(3)).toHaveAttribute("data-hidden", "true");
    await row(3).locator(".plot-row-inspector-toggle").click();
    await firstPanel
      .getByRole("button", { name: "restore", exact: true })
      .click();
    await expect(row(3)).toHaveAttribute("data-hidden", "false");
    await expect(row(3)).toHaveClass(/focused/);
    await firstPanel.getByTitle("Close line inspector").click();
  }
  for (const panel of await page.locator(".panel").all()) {
    expect(
      await panel
        .locator(".panel-header")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    for (const control of [
      ".panel-axis-toggle",
      ".panel-y-axis",
      ".panel-x-axis",
      ".panel-c-axis",
      ".panel-axis-limits",
      ".panel-line-width",
      ".panel-ghost-opacity",
      ".panel-legend-state",
      ".panel-stats-toggle",
      ".panel-tips",
      ".panel-split-right",
      ".panel-split-down",
      ".panel-maximize",
      ".panel-close",
    ]) {
      await expect(panel.locator(control)).toBeVisible();
      await panel.locator(control).focus();
      await expect(panel.locator(control)).toBeFocused();
    }
    await expect(panel.locator(".plot-series-legend")).toHaveCSS(
      "font-size",
      "13px",
    );
    expect(
      await panel
        .locator(".plot-legend-encoding")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  }
  const list = firstPanel.locator(".plot-legend-roster-rows");
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(row(48)).toBeVisible();
  const bounds = await firstPanel
    .locator(".plot-legend-roster-row")
    .evaluateAll((rows) =>
      rows.map((element) => {
        const { top, bottom } = element.getBoundingClientRect();
        return { top, bottom };
      }),
    );
  for (const [index, bound] of bounds.entries()) {
    const previous = bounds[index - 1];
    if (previous !== undefined)
      expect(bound.top).toBeGreaterThanOrEqual(previous.bottom);
  }
  await firstPanel.locator(".panel-stats-toggle").click();
  const hiddenStat = firstPanel
    .locator(".plot-stat-row")
    .filter({ hasText: "temperature_sensor_02" });
  await expect(hiddenStat).toHaveAttribute("data-hidden", "true");
  await expect(hiddenStat).toHaveClass(/focused/);
  await expect(hiddenStat.locator(".plot-series-state")).toHaveText("hidden");
  const statBody = firstPanel.locator(".plot-stat-body");
  await statBody.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(async () => {
      const heading = await firstPanel
        .locator(".plot-stat-sort")
        .last()
        .boundingBox();
      const value = await firstPanel
        .locator(".plot-stat-body .plot-stat-cell")
        .last()
        .boundingBox();
      return Math.abs((heading?.x ?? 0) - (value?.x ?? 1000));
    })
    .toBeLessThan(1);
  await firstPanel.locator(".panel-stats-toggle").click();
  const actions = firstPanel.getByRole("group", {
    name: "All plot signals",
    exact: true,
  });
  await actions
    .getByRole("button", { name: "Select all", exact: true })
    .click();
  await expect(
    actions.getByRole("button", { name: "Clear selection", exact: true }),
  ).toBeVisible();
  await actions.getByRole("button", { name: "Dim all", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    actions.getByRole("button", { name: "Undim all", exact: true }),
  ).toBeFocused();
  await expect(row(1)).toHaveClass(/focused/);
  await expect(row(1)).toHaveAttribute("data-dimmed", "true");
  await expect(row(2)).toHaveAttribute("data-hidden", "true");
  await actions.getByRole("button", { name: "Hide all", exact: true }).click();
  await expect(row(1)).toHaveAttribute("data-hidden", "true");
  await expect(row(1)).toHaveClass(/focused/);
  await actions.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(row(2)).toHaveAttribute("data-hidden", "false");
  await expect(row(2)).toHaveAttribute("data-dimmed", "true");
  await actions.getByRole("button", { name: "Undim all", exact: true }).click();
  await expect(row(1)).toHaveAttribute("data-dimmed", "false");
  await actions
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(row(1)).not.toHaveClass(/focused/);
  await expect(row(1)).toHaveAttribute("data-hidden", "false");
  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("UI font size");
  await expect(page.locator(".palette-row.selected")).toContainText(
    "UI font size",
  );
  for (let step = 0; step < 5; step++) {
    await page.keyboard.press("ArrowLeft");
    await expect(uiSize).toHaveText(`${String(17 - step)}px`);
  }
  await page.keyboard.press("Escape");
  // Enlarged plot text must not enlarge the legend past the UI caption size.
  await expect(firstPanel.locator(".plot-series-legend")).toHaveCSS(
    "font-size",
    "11px",
  );
  const selectAll = actions.getByRole("button", {
    name: "Select all",
    exact: true,
  });
  await expect(selectAll).toHaveCSS("font-family", /Inter/);
  await expect(selectAll).toHaveCSS("border-top-style", "solid");
  await expect(selectAll).toHaveCSS("border-top-width", "1px");
  await selectAll.hover();
  await selectAll.focus();
  await expect(selectAll).toBeFocused();
  await firstPanel.locator(".panel-legend-state").click();
  await firstPanel
    .getByRole("menuitemradio", { name: "simple", exact: false })
    .click();
  const simple = firstPanel.locator(".plot-series-legend");
  await expect(simple.locator(".plot-legend-simple-row")).toHaveCount(48);
  for (const selector of [
    ".plot-legend-bulk-actions",
    ".plot-legend-search",
    ".plot-legend-encoding",
    ".plot-legend-group-title",
    ".plot-legend-tips",
    ".plot-legend-footer",
    ".plot-row-inspector-toggle",
  ])
    await expect(simple.locator(selector)).toHaveCount(0);
  const simpleFirst = simple.locator(".plot-legend-simple-row").first();
  await simpleFirst.focus();
  await page.keyboard.press("Enter");
  await expect(simpleFirst).toHaveAttribute("aria-pressed", "true");
  await expect(simpleFirst).toHaveAttribute("data-hidden", "false");
  await page.screenshot({ path: "../build/ui-review/after-simple.png" });
  await simple.locator(".plot-legend-title").click();
  await expect(simple.locator(".plot-legend-search")).toBeVisible();
  await expect(simple.locator(".plot-legend-bulk-actions")).toBeVisible();
});

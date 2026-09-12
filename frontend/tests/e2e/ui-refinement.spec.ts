import { expect, gotoApp, test, togglePanelStats } from "./fixtures";
import { WorkspaceModel } from "../../src/app/workspace";
import { seal } from "../../src/app/envelope";
import { mkdirSync } from "node:fs";
import type { Page, Locator } from "@playwright/test";

async function openWorkspace(page: Page, capture?: string): Promise<Locator> {
  const sampleCount = capture === undefined ? 120 : 1800;
  const workspace = new WorkspaceModel();
  const first = workspace.addPanelRow();
  const second = workspace.splitPanelRight(first.id);
  if (second === null) throw new Error("Missing second panel");
  const signals = Array.from({ length: 48 }, (_, index) => {
    const channel = `propulsion/test_stand/temperature_sensor_${String(index + 1).padStart(2, "0")}`;
    const bins = Array.from({ length: sampleCount }, (_, sample) => {
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
        point_count: String(sampleCount),
        t_min: 0,
        t_max: (sampleCount - 1) / 30,
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
  if (capture === "before") {
    await page.goto("http://127.0.0.1:4174/");
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
  } else await gotoApp(page);
  await expect(page.locator(".panel")).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator(".render-ms")).not.toHaveText("— ms");
  await page.mouse.move(5, 5);

  return page.locator(".panel").first();
}

function seriesRow(panel: Locator, index: number): Locator {
  return panel.locator(".plot-legend-roster-row").filter({
    hasText: `temperature_sensor_${String(index).padStart(2, "0")}`,
  });
}

test("hidden and dimmed signals preserve independent keyboard selection", async ({
  page,
}) => {
  const firstPanel = await openWorkspace(page);
  const row = (index: number) => seriesRow(firstPanel, index);
  await expect(row(1)).toHaveClass(/focused/);
  await expect(row(1)).toHaveAttribute("data-hidden", "false");
  await expect(row(2)).toHaveClass(/focused/);
  await expect(row(2)).toHaveAttribute("data-hidden", "true");
  await expect(row(3)).not.toHaveClass(/focused/);
  await expect(row(3)).toHaveAttribute("data-hidden", "true");
  await expect(row(4)).toHaveAttribute("data-dimmed", "true");
  await expect(row(4).locator(".plot-series-state")).toHaveText("dimmed");
  await row(4).locator(".plot-legend-roster-action").hover();
  await expect(row(4)).toHaveAttribute("data-hidden", "false");
  await row(3).locator(".plot-legend-roster-action").focus();
  await expect(row(3).locator(".plot-legend-roster-action")).toBeFocused();
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
});

test("bulk actions preserve selection and visibility across legend modes", async ({
  page,
}) => {
  const firstPanel = await openWorkspace(page);
  const row = (index: number) => seriesRow(firstPanel, index);
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

  await simple.locator(".plot-legend-title").click();
  await expect(simple.locator(".plot-legend-search")).toBeVisible();
  await expect(simple.locator(".plot-legend-bulk-actions")).toBeVisible();
});

test("dense legend rows scroll and statistics stay aligned at larger UI sizes", async ({
  page,
}) => {
  const firstPanel = await openWorkspace(page);
  const row = (index: number) => seriesRow(firstPanel, index);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("UI font size");
  for (let step = 0; step < 5; step++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  const list = firstPanel.locator(".plot-legend-roster-rows");
  await list.hover();
  await page.mouse.wheel(0, 10_000);
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
  await togglePanelStats(firstPanel);
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
  await togglePanelStats(firstPanel);
});

test("dense workspace visual review captures", async ({ page }, testInfo) => {
  const phase = process.env.SIGNALSCOPE_UI_CAPTURE ?? "after";
  test.skip(
    process.env.SIGNALSCOPE_UI_CAPTURE === undefined,
    "Opt-in visual review; behavior is covered separately.",
  );
  test.setTimeout(60_000);
  const firstPanel = await openWorkspace(page, phase);
  mkdirSync("../build/ui-review", { recursive: true });
  const capture = async (name: string) => {
    const path = `../build/ui-review/${phase}-${name}.png`;
    await page.mouse.move(5, 5);
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  await capture("native");
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.keyboard.press("Control+Comma");
  await page.locator(".palette-input").fill("UI font size");
  for (let step = 0; step < 5; step++) await page.keyboard.press("ArrowRight");
  await page.locator(".palette-input").fill("Plot font size");
  for (let step = 0; step < 8; step++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await capture("large-narrow");
  if (phase === "before") return;
  await firstPanel
    .getByRole("button", { name: "Readouts", exact: true })
    .click();
  await firstPanel
    .getByRole("menuitemradio", { name: "simple", exact: true })
    .click();
  await capture("simple");
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../e2e/fixtures";
import {
  installPresentationProbe,
  interact,
  panInPad,
  startFrameProbe,
  stopFrameProbe,
} from "./measure";

const artifact = new URL("../../../build/bench/mc1000.html", import.meta.url);
const reportDir = new URL("../../../build/bench/report/", import.meta.url);

test("mc1000 snapshot first plot and pan/zoom stay interactive", async ({
  page,
}) => {
  test.setTimeout(240_000);
  expect(
    existsSync(fileURLToPath(artifact)),
    "bake first: ./scripts/test.sh bench e2e",
  ).toBe(true);

  await installPresentationProbe(page);
  const started = Date.now();
  await page.goto(artifact.href);
  await expect(page.locator(".chart-host canvas").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 120_000,
  });
  const firstPlotMs = Date.now() - started;

  await startFrameProbe(page);
  await interact(page);
  const stats = await stopFrameProbe(page);
  const overlay = page.locator(".overlay-canvas").first();
  const box = await overlay.boundingBox();
  if (box === null) throw new Error("overlay is not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -4_000);
  await expect
    .poll(() =>
      page
        .locator(".panel")
        .first()
        .locator(".chart-bank:not([hidden])")
        .getAttribute("data-bank-role"),
    )
    .toBe("detail");
  await page.waitForTimeout(250);
  const beforeFitQueries = await page.evaluate(
    () =>
      (window as unknown as { __benchTileQueryCount: number })
        .__benchTileQueryCount,
  );
  const fitStarted = Date.now();
  await overlay.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect
    .poll(() =>
      page
        .locator(".panel")
        .first()
        .locator(".chart-bank:not([hidden])")
        .getAttribute("data-bank-role"),
    )
    .toBe("overview");
  const fitOverviewMs = Date.now() - fitStarted;
  const afterFitQueries = await page.evaluate(
    () =>
      (window as unknown as { __benchTileQueryCount: number })
        .__benchTileQueryCount,
  );
  const presentation = await page.locator(".presentation-stat").textContent();
  const density = Number(presentation?.match(/· ([\d.]+)\//)?.[1] ?? 2);
  const visibleSeries = Number(
    presentation?.match(/· ([\d,]+) series$/)?.[1]?.replaceAll(",", "") ?? 0,
  );
  const bake = JSON.parse(
    readFileSync(new URL("bake.json", reportDir), "utf8"),
  ) as { input_files: number };

  mkdirSync(fileURLToPath(reportDir), { recursive: true });
  writeFileSync(
    new URL("e2e_mc1000.json", reportDir),
    JSON.stringify(
      {
        bench: "e2e_mc1000",
        input_files: bake.input_files,
        first_plot_ms: firstPlotMs,
        frame_p95_ms: stats.p95Ms,
        frame_max_ms: stats.maxMs,
        frames: stats.frames,
        long_tasks: stats.longTasks,
        longest_task_ms: stats.longestTaskMs,
        fit_overview_ms: fitOverviewMs,
        floor_fit_overview_ms: 33,
        presentation_density: density,
        visible_series: visibleSeries,
        query_count_during_fit: afterFitQueries - beforeFitQueries,
        floor_first_plot_ms: 10_000,
        floor_frame_p95_ms: 33,
        floor_frames: 100,
        floor_stall_ms: 250,
        pass:
          firstPlotMs <= 10_000 &&
          stats.frames > 100 &&
          stats.p95Ms <= 33 &&
          Math.max(stats.maxMs, stats.longestTaskMs) <= 250 &&
          fitOverviewMs <= 33 &&
          afterFitQueries - beforeFitQueries === 0,
      },
      null,
      2,
    ),
  );

  expect(firstPlotMs, "first plot").toBeLessThanOrEqual(10_000);
  expect(stats.frames, "frame probe collected samples").toBeGreaterThan(100);
  expect(stats.p95Ms, "frame interval p95").toBeLessThanOrEqual(33);
  expect(
    Math.max(stats.maxMs, stats.longestTaskMs),
    "longest stall",
  ).toBeLessThanOrEqual(250);
  expect(fitOverviewMs, "fit overview").toBeLessThanOrEqual(33);
  expect(afterFitQueries - beforeFitQueries, "fit queries").toBe(0);
});

test("mc1000 in-pad pan stays interactive", async ({ page }) => {
  test.setTimeout(240_000);
  expect(
    existsSync(fileURLToPath(artifact)),
    "bake first: ./scripts/test.sh bench e2e",
  ).toBe(true);

  await page.goto(artifact.href);
  await expect(page.locator(".chart-host canvas").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 120_000,
  });

  await startFrameProbe(page);
  await panInPad(page);
  const stats = await stopFrameProbe(page);

  mkdirSync(fileURLToPath(reportDir), { recursive: true });
  writeFileSync(
    new URL("e2e_mc1000_pan.json", reportDir),
    JSON.stringify(
      {
        bench: "e2e_mc1000_pan",
        frame_p95_ms: stats.p95Ms,
        frame_max_ms: stats.maxMs,
        frames: stats.frames,
        long_tasks: stats.longTasks,
        longest_task_ms: stats.longestTaskMs,
        floor_frame_p95_ms: 33,
        floor_frames: 100,
        floor_stall_ms: 250,
        pass:
          stats.frames > 100 &&
          stats.p95Ms <= 33 &&
          Math.max(stats.maxMs, stats.longestTaskMs) <= 250,
      },
      null,
      2,
    ),
  );

  expect(stats.frames, "frame probe collected samples").toBeGreaterThan(100);
  expect(stats.p95Ms, "frame interval p95").toBeLessThanOrEqual(33);
  expect(
    Math.max(stats.maxMs, stats.longestTaskMs),
    "longest stall",
  ).toBeLessThanOrEqual(250);
});

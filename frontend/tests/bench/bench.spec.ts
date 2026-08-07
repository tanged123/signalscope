import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../e2e/fixtures";
import { interact, startFrameProbe, stopFrameProbe } from "./measure";

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

  const started = Date.now();
  await page.goto(artifact.href);
  await expect(page.locator(".series-canvas").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 120_000,
  });
  const firstPlotMs = Date.now() - started;

  await startFrameProbe(page);
  await interact(page);
  const stats = await stopFrameProbe(page);
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
        floor_first_plot_ms: 10_000,
        floor_frame_p95_ms: 33,
        floor_frames: 100,
        floor_stall_ms: 250,
        pass:
          firstPlotMs <= 10_000 &&
          stats.frames > 100 &&
          stats.p95Ms <= 33 &&
          Math.max(stats.maxMs, stats.longestTaskMs) <= 250,
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
});

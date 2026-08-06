import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../e2e/fixtures";
import { interact, startFrameProbe, stopFrameProbe } from "./measure";

const artifact = new URL(
  "../../../build/bench/mc1000-modes.html",
  import.meta.url,
);
const reportDir = new URL("../../../build/bench/report/", import.meta.url);

test("mc1000 modes workspace renders all four modes and records baselines", async ({
  page,
}) => {
  test.setTimeout(240_000);
  expect(
    existsSync(fileURLToPath(artifact)),
    "bake first: ./scripts/test.sh bench",
  ).toBe(true);

  const started = Date.now();
  await page.goto(artifact.href);
  await expect(page.locator(".plot-canvas").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 120_000,
  });
  const firstPlotMs = Date.now() - started;

  await expect(page.locator(".panel-empty:not([hidden])")).toHaveCount(0);

  await startFrameProbe(page);
  await interact(page);
  const stats = await stopFrameProbe(page);

  mkdirSync(fileURLToPath(reportDir), { recursive: true });
  writeFileSync(
    new URL("e2e_mc1000_modes.json", reportDir),
    `${JSON.stringify(
      {
        bench: "e2e_mc1000_modes",
        first_plot_ms: firstPlotMs,
        frame_p95_ms: stats.p95Ms,
        frame_max_ms: stats.maxMs,
        frames: stats.frames,
        long_tasks: stats.longTasks,
        longest_task_ms: stats.longestTaskMs,
        report_only: true,
      },
      null,
      2,
    )}\n`,
  );
});

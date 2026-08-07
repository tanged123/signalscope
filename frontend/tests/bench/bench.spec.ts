import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../e2e/fixtures";
import { interact, startFrameProbe, stopFrameProbe } from "./measure";
import type { GpuMetricsSnapshot } from "../../src/render/gpu/metrics";
import { percentile } from "../../src/app/percentile";

const tier = process.env.SIGNALSCOPE_BENCH_TIER ?? "mc1000";
const artifact = new URL(`../../../build/bench/${tier}.html`, import.meta.url);
const reportDir = new URL("../../../build/bench/report/", import.meta.url);

test(`${tier} snapshot first plot and pan/zoom stay interactive`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  expect(
    existsSync(fileURLToPath(artifact)),
    "bake first: ./scripts/test.sh bench e2e",
  ).toBe(true);

  const started = Date.now();
  await page.goto(`${artifact.href}?signalscope-bench=1`);
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
  const metrics = await page.evaluate(() => {
    const host = window as typeof window & {
      __signalscopeBench?: { snapshot: () => GpuMetricsSnapshot };
    };
    return host.__signalscopeBench?.snapshot() ?? null;
  });
  const bake = JSON.parse(
    readFileSync(new URL("bake.json", reportDir), "utf8"),
  ) as { input_files: number };
  const visibleSeries = metrics?.visibleSeries ?? 0;
  const seriesWithSegments = metrics?.seriesWithSegments ?? 0;
  const pass =
    firstPlotMs <= 10_000 &&
    stats.frames > 100 &&
    stats.p95Ms <= 33 &&
    Math.max(stats.maxMs, stats.longestTaskMs) <= 250 &&
    visibleSeries === bake.input_files &&
    seriesWithSegments === bake.input_files;
  mkdirSync(fileURLToPath(reportDir), { recursive: true });
  writeFileSync(
    new URL(`e2e_${tier}.json`, reportDir),
    JSON.stringify(
      {
        bench: `e2e_${tier}`,
        tier,
        input_files: bake.input_files,
        first_plot_ms: firstPlotMs,
        cold_first_plot_ms: firstPlotMs,
        coarse_first_ms: firstPlotMs,
        refinement_ms: 0,
        upload_bytes: metrics?.uploadBytes ?? 0,
        resident_gpu_bytes: metrics?.residentBytes ?? 0,
        draw_calls: metrics?.drawCalls ?? 0,
        submitted_segments: metrics?.submittedSegments ?? 0,
        frame_p95_ms: stats.p95Ms,
        frame_p50_ms: stats.p50Ms,
        frame_max_ms: stats.maxMs,
        frames: stats.frames,
        long_tasks: stats.longTasks,
        longest_task_ms: stats.longestTaskMs,
        pick_p95_ms:
          metrics === null || metrics.pickLatencyMs.length === 0
            ? 0
            : percentile(metrics.pickLatencyMs, 0.95),
        device_recovery_ms: metrics?.deviceRecoveryMs.at(-1) ?? 0,
        resident_pan_upload_bytes: 0,
        resident_pan_descriptor_rebuilds: 0,
        ...(metrics ?? {}),
        visible_series: visibleSeries,
        series_with_segments: seriesWithSegments,
        floor_first_plot_ms: 10_000,
        floor_frame_p95_ms: 33,
        floor_frames: 100,
        floor_stall_ms: 250,
        pass,
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
  expect(visibleSeries, "visible series cardinality").toBe(bake.input_files);
  expect(seriesWithSegments, "drawable series cardinality").toBe(
    bake.input_files,
  );
});

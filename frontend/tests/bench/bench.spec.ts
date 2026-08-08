import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../e2e/fixtures";
import {
  gpuMetrics,
  interact,
  startFrameProbe,
  stopFrameProbe,
  waitForBenchEvent,
  waitForPickCount,
  waitForSuccessfulFrame,
} from "./measure";
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

  await page.goto(`${artifact.href}?signalscope-bench=1`);
  await expect(page.locator(".series-canvas").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 120_000,
  });
  const navigationStart = await waitForBenchEvent(page, "navigation-start");
  const coarseComplete = await waitForBenchEvent(page, "coarse-complete");
  const firstSuccessfulGpuFrame = await waitForSuccessfulFrame(page);
  const fineComplete = await waitForBenchEvent(page, "fine-complete");

  await startFrameProbe(page);
  const residentPan = await interact(page);
  const picks = await waitForPickCount(page, 40);
  const stats = await stopFrameProbe(page);
  const beforeRecovery = await gpuMetrics(page);
  await page.evaluate(() => {
    const host = window as typeof window & {
      __signalscopeBench?: { loseDeviceForTest: () => void };
    };
    host.__signalscopeBench?.loseDeviceForTest();
  });
  await page.waitForFunction(() => {
    const host = window as typeof window & {
      __signalscopeBench?: { state: () => { kind: string } };
    };
    return host.__signalscopeBench?.state().kind === "recovering";
  });
  await page.waitForFunction(
    () => {
      const host = window as typeof window & {
        __signalscopeBench?: { state: () => { kind: string } };
      };
      return host.__signalscopeBench?.state().kind === "ready";
    },
    { timeout: 120_000 },
  );
  await page.waitForFunction(
    (previous) => {
      const host = window as typeof window & {
        __signalscopeBench?: { snapshot: () => GpuMetricsSnapshot };
      };
      return (
        (host.__signalscopeBench?.snapshot().successfulFrames ?? 0) > previous
      );
    },
    beforeRecovery.successfulFrames,
    { timeout: 120_000 },
  );
  await waitForBenchEvent(page, "restored");
  const metrics = await gpuMetrics(page);
  const bake = JSON.parse(
    readFileSync(new URL("bake.json", reportDir), "utf8"),
  ) as { input_files: number };
  const firstPlotMs = firstSuccessfulGpuFrame - navigationStart;
  const coarseFirstMs = coarseComplete - navigationStart;
  const refinementMs = fineComplete - coarseComplete;
  const visibleSeries = metrics.visibleSeries;
  const seriesWithSegments = metrics.seriesWithSegments;
  const rendererFrames = [...metrics.frameCpuMs].sort(
    (left, right) => left - right,
  );
  const rendererP95Ms = percentile(rendererFrames, 0.95);
  const rendererP50Ms = percentile(rendererFrames, 0.5);
  const rendererMaxMs = rendererFrames.at(-1) ?? 0;
  const pass =
    firstPlotMs <= 10_000 &&
    stats.frames > 100 &&
    rendererP95Ms <= 33 &&
    Math.max(rendererMaxMs, stats.longestTaskMs) <= 250 &&
    visibleSeries === bake.input_files &&
    seriesWithSegments === bake.input_files &&
    metrics.selectedSeries === bake.input_files &&
    metrics.compactSegments > 0 &&
    metrics.successfulFrames > 0 &&
    metrics.validationErrors.length === 0 &&
    metrics.pickLatencyMs.length >= 40 &&
    metrics.deviceRecoveryMs.length > 0 &&
    residentPan.uploadBytes === 0 &&
    residentPan.descriptorRebuilds === 0;
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
        coarse_first_ms: coarseFirstMs,
        refinement_ms: refinementMs,
        upload_bytes: metrics.uploadBytes,
        resident_gpu_bytes: metrics.residentBytes,
        draw_calls: metrics.drawCalls,
        submitted_segments: metrics.submittedSegments,
        compact_segments: metrics.compactSegments,
        selected_series: metrics.selectedSeries,
        successful_frames: metrics.successfulFrames,
        validation_errors: metrics.validationErrors.length,
        frame_p95_ms: rendererP95Ms,
        frame_p50_ms: rendererP50Ms,
        frame_max_ms: rendererMaxMs,
        raf_interval_p95_ms: stats.p95Ms,
        raf_interval_max_ms: stats.maxMs,
        frames: stats.frames,
        long_tasks: stats.longTasks,
        longest_task_ms: stats.longestTaskMs,
        pick_p95_ms: percentile(metrics.pickLatencyMs, 0.95),
        device_recovery_ms: metrics.deviceRecoveryMs.at(-1) ?? 0,
        resident_pan_upload_bytes: residentPan.uploadBytes,
        resident_pan_descriptor_rebuilds: residentPan.descriptorRebuilds,
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
  expect(rendererP95Ms, "renderer frame p95").toBeLessThanOrEqual(33);
  expect(
    Math.max(rendererMaxMs, stats.longestTaskMs),
    "longest stall",
  ).toBeLessThanOrEqual(250);
  expect(visibleSeries, "visible series cardinality").toBe(bake.input_files);
  expect(seriesWithSegments, "drawable series cardinality").toBe(
    bake.input_files,
  );
  expect(metrics.selectedSeries, "selected series cardinality").toBe(
    bake.input_files,
  );
  expect(
    metrics.compactSegments,
    "GPU compact descriptor count",
  ).toBeGreaterThan(0);
  expect(metrics.successfulFrames, "successful GPU frames").toBeGreaterThan(0);
  expect(metrics.validationErrors, "GPU validation errors").toEqual([]);
  expect(
    picks.pickLatencyMs.length,
    "completed GPU picks",
  ).toBeGreaterThanOrEqual(40);
  expect(
    metrics.deviceRecoveryMs.length,
    "device recovery measurement",
  ).toBeGreaterThan(0);
  expect(residentPan.uploadBytes, "resident pan uploads").toBe(0);
  expect(
    residentPan.descriptorRebuilds,
    "resident pan descriptor rebuilds",
  ).toBe(0);
});

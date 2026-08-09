import { _electron as electron, expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
  classifyGpuEvidence,
  gpuEvidenceFromNative,
  type GpuEvidence,
} from "../../src/render/gpu/adapter-info";
import {
  gpuMetrics,
  interact,
  meetsInteractiveFloors,
  startFrameProbe,
  stopFrameProbe,
  waitForBenchEvent,
  waitForPickCount,
  waitForSuccessfulFrame,
} from "./measure";
import { waitForNativeSourceCount } from "./native-measure";
import { writeElectronHardwareReport } from "./report";
import { percentile } from "../../src/app/percentile";

test("native Electron hardware acceptance uses the full corpus", async () => {
  const corpusTier = process.env.SIGNALSCOPE_BENCH_TIER ?? "mc1000";
  const electronPath = process.env.SIGNALSCOPE_ELECTRON_BIN;
  const hostPath = process.env.SIGNALSCOPE_HOST_BIN;
  const corpusPath = process.env.SIGNALSCOPE_BENCH_CORPUS_DIR;
  if (electronPath === undefined || hostPath === undefined) {
    throw new Error(
      "native hardware acceptance requires SIGNALSCOPE_ELECTRON_BIN and SIGNALSCOPE_HOST_BIN",
    );
  }
  if (corpusPath === undefined) {
    throw new Error(
      "native hardware acceptance requires SIGNALSCOPE_BENCH_CORPUS_DIR",
    );
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "SIGNALSCOPE_GPU_MODE",
    ),
  );
  const app = await electron.launch({
    executablePath: electronPath,
    args: [
      fileURLToPath(new URL("../../../desktop", import.meta.url)),
      "--open-folder",
      corpusPath,
    ],
    env: {
      ...env,
      NODE_ENV: "development",
      SIGNALSCOPE_BENCH: "1",
      SIGNALSCOPE_HOST_BIN: hostPath,
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveURL("http://127.0.0.1:4173/?signalscope-bench=1");
    const diagnostics = await page.evaluate(async () => {
      const bridge = window.scopeDesktop;
      if (bridge === undefined) throw new Error("desktop bridge is absent");
      const native = await bridge.gpuInfo();
      const host = window as typeof window & {
        __signalscopeBench?: {
          backend: () => string;
          evidence: () => GpuEvidence;
        };
      };
      return {
        native,
        backend: host.__signalscopeBench?.backend() ?? "unsupported",
        evidence: host.__signalscopeBench?.evidence() ?? null,
      };
    });
    const evidence =
      diagnostics.evidence ?? gpuEvidenceFromNative(diagnostics.native);
    const backend =
      diagnostics.backend === "unsupported"
        ? classifyGpuEvidence(evidence)
        : diagnostics.backend;
    if (backend !== "hardware") {
      await writeElectronHardwareReport({
        bench: "electron_hardware",
        backend,
        fallback_reason: evidence.fallbackReason,
        software_rendering: evidence.softwareRendering,
        pass: false,
        corpus_tier: corpusTier,
        electron: evidence.electronVersion,
        chromium: evidence.chromiumVersion,
        adapter_vendor: evidence.adapterVendor,
        adapter_architecture: evidence.adapterArchitecture,
        adapter_device: evidence.adapterDevice,
        adapter_description: evidence.adapterDescription,
        adapter_limits: evidence.limits,
        evidence,
      });
      throw new Error(
        `native hardware acceptance requires hardware WebGPU; observed ${backend}`,
      );
    }

    const expectedSources = Number(
      process.env.SIGNALSCOPE_BENCH_NATIVE_FILES ?? "1000",
    );
    await waitForNativeSourceCount(page, expectedSources);
    await expect(page.locator(".series-canvas").first()).toBeVisible({
      timeout: 120_000,
    });
    const navigationStart = await waitForBenchEvent(page, "navigation-start");
    const coarseComplete = await waitForBenchEvent(page, "coarse-complete");
    const firstPlot = await waitForSuccessfulFrame(page);
    const fineComplete = await waitForBenchEvent(page, "fine-complete");
    await startFrameProbe(page);
    const residentPan = await interact(page);
    const frameStats = await stopFrameProbe(page);
    await waitForPickCount(page, 40);
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
          __signalscopeBench?: { snapshot: () => { successfulFrames: number } };
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
    const frameTimes = [...metrics.frameCpuMs].sort(
      (left, right) => left - right,
    );
    const firstPlotMs = firstPlot - navigationStart;
    const failures = [
      ...(!meetsInteractiveFloors(firstPlotMs, frameStats, metrics, residentPan)
        ? ["renderer interaction floor"]
        : []),
      ...(metrics.selectedSeries !== expectedSources
        ? ["selected series cardinality"]
        : []),
      ...(metrics.visibleSeries !== expectedSources
        ? ["visible series cardinality"]
        : []),
      ...(metrics.seriesWithSegments !== expectedSources
        ? ["drawable series cardinality"]
        : []),
      ...(metrics.pickLatencyMs.length < 40 ? ["pick completions"] : []),
      ...(metrics.deviceRecoveryMs.length === 0 ? ["device recovery"] : []),
    ];
    const pass = failures.length === 0;
    await writeElectronHardwareReport({
      bench: "electron_hardware",
      backend,
      fallback_reason: evidence.fallbackReason,
      software_rendering: evidence.softwareRendering,
      pass,
      corpus_tier: corpusTier,
      electron: evidence.electronVersion,
      chromium: evidence.chromiumVersion,
      adapter_vendor: evidence.adapterVendor,
      adapter_architecture: evidence.adapterArchitecture,
      adapter_device: evidence.adapterDevice,
      adapter_description: evidence.adapterDescription,
      adapter_limits: evidence.limits,
      evidence,
      input_files: expectedSources,
      first_plot_ms: firstPlotMs,
      coarse_first_ms: coarseComplete - navigationStart,
      refinement_ms: fineComplete - coarseComplete,
      frame_p95_ms: percentile(frameTimes, 0.95),
      frame_max_ms: frameTimes.at(-1) ?? 0,
      raf_interval_p95_ms: frameStats.p95Ms,
      raf_interval_max_ms: frameStats.maxMs,
      longest_task_ms: frameStats.longestTaskMs,
      validation_errors: metrics.validationErrors.length,
      selected_series: metrics.selectedSeries,
      visible_series: metrics.visibleSeries,
      series_with_segments: metrics.seriesWithSegments,
      draw_calls: metrics.drawCalls,
      compact_segments: metrics.compactSegments,
      pick_count: metrics.pickLatencyMs.length,
      pick_p95_ms: percentile(metrics.pickLatencyMs, 0.95),
      device_recovery_ms: metrics.deviceRecoveryMs.at(-1) ?? 0,
      resident_pan_upload_bytes: residentPan.uploadBytes,
      resident_pan_descriptor_rebuilds: residentPan.descriptorRebuilds,
      failure_reasons: failures,
      metrics,
    });
    expect(pass, "native hardware benchmark floors").toBe(true);
  } finally {
    await app.close();
  }
});

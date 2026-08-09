import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  plotPixelEvidence,
  startFrameProbe,
  stopFrameProbe,
  waitForBenchEvent,
  waitForPickCount,
  waitForSuccessfulFrame,
} from "./measure";
import { installBenchmarkSession } from "./native-session";
import { nativeSourceCount, waitForNativeSourceCount } from "./native-measure";
import {
  writeElectronHardwareReport,
  type ElectronHardwareReport,
} from "./report";
import { percentile } from "../../src/app/percentile";

const tiers = {
  mc1000: { sourceCount: 1000, seriesCount: 1000 },
  dense10k: { sourceCount: 10_000, seriesCount: 10_000 },
} as const;

const emptyEvidence: GpuEvidence = {
  electronVersion: "unknown",
  chromiumVersion: "unknown",
  adapterVendor: "",
  adapterArchitecture: "",
  adapterDevice: "",
  adapterDescription: "",
  softwareRendering: false,
  fallbackReason: "benchmark did not reach GPU diagnostics",
  limits: {},
};

const packageJsonPath = fileURLToPath(
  new URL("../../../desktop/package.json", import.meta.url),
);

function baseReport(
  corpusTier: string,
  backend: string,
  evidence: GpuEvidence,
  expectedSeries: number,
): ElectronHardwareReport {
  return {
    bench: "electron_hardware",
    corpus_tier: corpusTier,
    backend,
    fallback_reason: evidence.fallbackReason,
    software_rendering: evidence.softwareRendering,
    pass: false,
    electron: evidence.electronVersion,
    chromium: evidence.chromiumVersion,
    adapter_vendor: evidence.adapterVendor,
    adapter_architecture: evidence.adapterArchitecture,
    adapter_device: evidence.adapterDevice,
    adapter_description: evidence.adapterDescription,
    adapter_limits: evidence.limits,
    expected_series: expectedSeries,
    source_count: 0,
    cold_first_plot_ms: 0,
    coarse_first_ms: 0,
    refinement_ms: 0,
    first_plot_ms: 0,
    upload_bytes: 0,
    resident_gpu_bytes: 0,
    resident_pages: 0,
    draw_calls: 0,
    draw_calls_after: 0,
    draw_call_bound: 0,
    submitted_segments: 0,
    compact_segments: 0,
    selected_series: 0,
    visible_series: 0,
    series_with_segments: 0,
    successful_frames: 0,
    validation_errors: 0,
    validation_error_messages: [],
    frame_p50_ms: 0,
    frame_p95_ms: 0,
    frame_max_ms: 0,
    raf_interval_p95_ms: 0,
    raf_interval_max_ms: 0,
    longest_task_ms: 0,
    pick_count: 0,
    pick_p95_ms: 0,
    recovery_samples: 0,
    device_recovery_ms: 0,
    resident_pan_upload_bytes: 0,
    resident_pan_descriptor_rebuilds: 0,
    resident_pan_resident_bytes_before: 0,
    resident_pan_resident_bytes_after: 0,
    resident_pan_resident_pages_before: 0,
    resident_pan_resident_pages_after: 0,
    pre_plot_pixels: 0,
    post_recovery_pixels: 0,
    pre_plot_total_pixels: 0,
    post_recovery_total_pixels: 0,
    url: "",
    failure_reasons: [],
    evidence,
  };
}

test("native Electron hardware acceptance uses the packaged production app", async () => {
  test.setTimeout(2_000_000);
  const corpusTier = process.env.SIGNALSCOPE_BENCH_TIER ?? "mc1000";
  const tier = Object.hasOwn(tiers, corpusTier)
    ? tiers[corpusTier as keyof typeof tiers]
    : undefined;
  if (tier === undefined)
    throw new Error(`unknown benchmark tier: ${corpusTier}`);
  const expectedSeries = tier.seriesCount;
  const executablePath = process.env.SIGNALSCOPE_PACKAGED_BIN;
  const corpusPath = process.env.SIGNALSCOPE_BENCH_CORPUS_DIR;
  const root = await mkdtemp(join(tmpdir(), "signalscope-hardware-"));
  const userData = join(root, "user-data");
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let backend = "unsupported";
  let evidence = emptyEvidence;
  let reportWritten = false;

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    devDependencies?: { electron?: string };
  };
  const expectedElectron = packageJson.devDependencies?.electron ?? "unknown";

  const writeFailure = async (
    reasons: readonly string[],
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> => {
    await writeElectronHardwareReport({
      ...baseReport(corpusTier, backend, evidence, expectedSeries),
      package_electron_version: expectedElectron,
      failure_reasons: reasons,
      ...extra,
    });
    reportWritten = true;
  };

  try {
    const missing = [
      executablePath === undefined ? "SIGNALSCOPE_PACKAGED_BIN" : null,
      corpusPath === undefined ? "SIGNALSCOPE_BENCH_CORPUS_DIR" : null,
    ].filter((value): value is string => value !== null);
    if (
      missing.length > 0 ||
      executablePath === undefined ||
      corpusPath === undefined
    ) {
      await writeFailure([`missing environment: ${missing.join(", ")}`]);
      throw new Error(`hardware acceptance requires ${missing.join(" and ")}`);
    }

    await installBenchmarkSession(userData);
    const removedVariables = new Set([
      "NODE_ENV",
      "SIGNALSCOPE_ELECTRON_BIN",
      "SIGNALSCOPE_PACKAGED_BIN",
      "SIGNALSCOPE_PACKAGED_APP",
      "SIGNALSCOPE_HOST_BIN",
      "SIGNALSCOPE_RESOURCE_DIR",
      "SIGNALSCOPE_BENCH_NATIVE_FILES",
    ]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          entry[0] !== "SIGNALSCOPE_GPU_MODE" &&
          !removedVariables.has(entry[0]),
      ),
    );
    env.NODE_ENV = "production";
    env.SIGNALSCOPE_BENCH = "1";
    app = await electron.launch({
      executablePath,
      cwd: root,
      args: [`--user-data-dir=${userData}`, `--open-folder=${corpusPath}`],
      env,
    });

    const page = await app.firstWindow();
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
        evidence: host.__signalscopeBench?.evidence() ?? null,
        backend: host.__signalscopeBench?.backend() ?? "unsupported",
        node: typeof (globalThis as { process?: unknown }).process,
        require: typeof (globalThis as { require?: unknown }).require,
        gpu: typeof navigator.gpu,
        url: location.href,
      };
    });
    evidence =
      diagnostics.evidence ?? gpuEvidenceFromNative(diagnostics.native);
    backend = classifyGpuEvidence(evidence);
    const parsedUrl = new URL(diagnostics.url);
    const earlyFailures = [
      parsedUrl.protocol !== "app:" ||
      parsedUrl.host !== "signalscope" ||
      parsedUrl.pathname !== "/index.html" ||
      parsedUrl.search !== "?signalscope-bench=1"
        ? "packaged app URL is not the production benchmark entry"
        : null,
      diagnostics.native.electron !== expectedElectron
        ? `Electron version ${diagnostics.native.electron} does not match package ${expectedElectron}`
        : null,
      diagnostics.node !== "undefined"
        ? "Node is exposed to the renderer"
        : null,
      diagnostics.require !== "undefined"
        ? "require is exposed to the renderer"
        : null,
      diagnostics.gpu !== "object" ? "WebGPU is unavailable" : null,
      backend !== "hardware"
        ? `selected WebGPU adapter is ${backend}: ${evidence.fallbackReason ?? evidence.adapterDescription}`
        : null,
    ].filter((value): value is string => value !== null);
    if (earlyFailures.length > 0) {
      await writeFailure(earlyFailures, {
        electron_package_version: expectedElectron,
        url: diagnostics.url,
      });
      throw new Error(earlyFailures.join("; "));
    }

    await waitForNativeSourceCount(page, tier.sourceCount);
    const sourceCount = await nativeSourceCount(page);
    await expect(page.locator(".panel")).toHaveCount(1);
    const panel = page.locator(".panel").first();
    await expect(panel.locator(".panel-bindings .binding-chip")).toHaveCount(1);
    await expect(panel.locator(".panel-bindings .binding-chip")).toHaveText(
      /response @\* ·/,
    );
    await expect(page.locator(".series-canvas").first()).toBeVisible({
      timeout: 120_000,
    });

    const navigationStart = await waitForBenchEvent(page, "navigation-start");
    const coarseComplete = await waitForBenchEvent(page, "coarse-complete");
    const firstPlotAt = await waitForSuccessfulFrame(page);
    const fineComplete = await waitForBenchEvent(page, "fine-complete");
    const beforeInteraction = await gpuMetrics(page);
    const pixelsBefore = await plotPixelEvidence(page);
    const preInteractionFailures = [
      sourceCount !== tier.sourceCount
        ? `source count ${String(sourceCount)} does not match ${String(tier.sourceCount)}`
        : null,
      beforeInteraction.selectedSeries !== expectedSeries
        ? `selected series ${String(beforeInteraction.selectedSeries)} does not match ${String(expectedSeries)}`
        : null,
      beforeInteraction.visibleSeries !== expectedSeries
        ? `visible series ${String(beforeInteraction.visibleSeries)} does not match ${String(expectedSeries)}`
        : null,
      beforeInteraction.seriesWithSegments !== expectedSeries
        ? `drawable series ${String(beforeInteraction.seriesWithSegments)} does not match ${String(expectedSeries)}`
        : null,
      beforeInteraction.residentPages <= 0 ? "no resident GPU pages" : null,
      pixelsBefore.nonBackgroundPixels <= 0
        ? "initial plot pixels are blank"
        : null,
      beforeInteraction.validationErrors.length > 0
        ? "initial renderer validation errors"
        : null,
    ].filter((value): value is string => value !== null);
    if (preInteractionFailures.length > 0) {
      await writeFailure(preInteractionFailures, {
        package_electron_version: expectedElectron,
        source_count: sourceCount,
        selected_series: beforeInteraction.selectedSeries,
        visible_series: beforeInteraction.visibleSeries,
        series_with_segments: beforeInteraction.seriesWithSegments,
        resident_gpu_bytes: beforeInteraction.residentBytes,
        resident_pages: beforeInteraction.residentPages,
        pre_plot_pixels: pixelsBefore.nonBackgroundPixels,
        pre_plot_total_pixels: pixelsBefore.totalPixels,
        url: diagnostics.url,
      });
      throw new Error(preInteractionFailures.join("; "));
    }

    await startFrameProbe(page);
    const residentPan = await interact(page);
    const frameStats = await stopFrameProbe(page);
    const afterInteractions = await waitForPickCount(page, 40);
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
      afterInteractions.successfulFrames,
      { timeout: 120_000 },
    );
    await waitForBenchEvent(page, "restored");
    const pixelsAfter = await plotPixelEvidence(page);
    const metrics = await gpuMetrics(page);
    const frameTimes = [...metrics.frameCpuMs].sort(
      (left, right) => left - right,
    );
    const drawCallBound = beforeInteraction.residentPages * 4 + 1;
    const firstPlotMs = firstPlotAt - navigationStart;
    const failures = [
      ...(!meetsInteractiveFloors(firstPlotMs, frameStats, metrics, residentPan)
        ? ["renderer interaction floor"]
        : []),
      ...(beforeInteraction.drawCalls > drawCallBound
        ? [
            `draw calls ${String(beforeInteraction.drawCalls)} exceed ${String(drawCallBound)}`,
          ]
        : []),
      ...(afterInteractions.pickLatencyMs.length < 40
        ? ["pick completions"]
        : []),
      ...(metrics.deviceRecoveryMs.length < 1 ? ["device recovery"] : []),
      ...(pixelsAfter.nonBackgroundPixels <= 0
        ? ["recovered plot pixels are blank"]
        : []),
    ];
    const pass = failures.length === 0;
    await writeElectronHardwareReport({
      ...baseReport(corpusTier, backend, evidence, expectedSeries),
      pass,
      package_electron_version: expectedElectron,
      source_count: sourceCount,
      url: diagnostics.url,
      cold_first_plot_ms: firstPlotMs,
      first_plot_ms: firstPlotMs,
      coarse_first_ms: coarseComplete - navigationStart,
      refinement_ms: fineComplete - coarseComplete,
      upload_bytes: metrics.uploadBytes,
      resident_gpu_bytes: metrics.residentBytes,
      resident_pages: metrics.residentPages,
      draw_calls: beforeInteraction.drawCalls,
      draw_calls_after: metrics.drawCalls,
      draw_call_bound: drawCallBound,
      submitted_segments: metrics.submittedSegments,
      compact_segments: metrics.compactSegments,
      selected_series: metrics.selectedSeries,
      visible_series: metrics.visibleSeries,
      series_with_segments: metrics.seriesWithSegments,
      successful_frames: metrics.successfulFrames,
      validation_errors: metrics.validationErrors.length,
      validation_error_messages: metrics.validationErrors,
      frame_p50_ms: percentile(frameTimes, 0.5),
      frame_p95_ms: percentile(frameTimes, 0.95),
      frame_max_ms: frameTimes.at(-1) ?? 0,
      raf_interval_p95_ms: frameStats.p95Ms,
      raf_interval_max_ms: frameStats.maxMs,
      longest_task_ms: frameStats.longestTaskMs,
      pick_count: metrics.pickLatencyMs.length,
      pick_p95_ms: percentile(metrics.pickLatencyMs, 0.95),
      recovery_samples: metrics.deviceRecoveryMs.length,
      device_recovery_ms: metrics.deviceRecoveryMs.at(-1) ?? 0,
      resident_pan_upload_bytes: residentPan.uploadBytes,
      resident_pan_descriptor_rebuilds: residentPan.descriptorRebuilds,
      resident_pan_resident_bytes_before: residentPan.residentBytesBefore,
      resident_pan_resident_bytes_after: residentPan.residentBytesAfter,
      resident_pan_resident_pages_before: residentPan.residentPagesBefore,
      resident_pan_resident_pages_after: residentPan.residentPagesAfter,
      pre_plot_pixels: pixelsBefore.nonBackgroundPixels,
      post_recovery_pixels: pixelsAfter.nonBackgroundPixels,
      pre_plot_total_pixels: pixelsBefore.totalPixels,
      post_recovery_total_pixels: pixelsAfter.totalPixels,
      failure_reasons: failures,
      metrics,
    });
    reportWritten = true;
    expect(pass, "native hardware benchmark floors").toBe(true);
  } catch (error) {
    if (!reportWritten) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFailure([message]);
    }
    throw error;
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

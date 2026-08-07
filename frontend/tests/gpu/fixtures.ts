import { expect, type Page } from "@playwright/test";
import type { GpuMetricsSnapshot } from "../../src/render/gpu/metrics";

export async function gpuMetrics(page: Page): Promise<GpuMetricsSnapshot> {
  const snapshot = await page.evaluate(() => {
    const host = window as typeof window & {
      __signalscopeBench?: { snapshot: () => GpuMetricsSnapshot };
    };
    return host.__signalscopeBench?.snapshot() ?? null;
  });
  if (snapshot === null) throw new Error("GPU bench metrics are unavailable");
  return snapshot;
}

export async function resetGpuMetrics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as typeof window & {
      __signalscopeBench?: { reset: () => void };
    };
    host.__signalscopeBench?.reset();
  });
}

export async function openGpuFixture(page: Page): Promise<void> {
  const artifact =
    process.env.SIGNALSCOPE_GPU_ARTIFACT ?? "build/bench/smoke.html";
  await page.goto(
    `${new URL(`../../../${artifact}`, import.meta.url).href}?signalscope-bench=1`,
  );
  await page.locator(".series-canvas").first().waitFor({ state: "visible" });
  await expect
    .poll(async () => (await gpuMetrics(page)).residentPages, {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
}

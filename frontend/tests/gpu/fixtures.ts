import { expect, type Page } from "@playwright/test";
import type { GpuMetricsSnapshot } from "../../src/render/gpu/metrics";

export async function descriptorFixture(page: Page): Promise<{
  descriptors: readonly number[];
  descriptorCount: number;
  quadArgs: readonly number[];
  hairlineArgs: readonly number[];
}> {
  await page.goto("http://127.0.0.1:4173/tests/gpu/descriptor-fixture.html");
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            document.body.dataset.result ?? document.body.dataset.error ?? null,
        ),
      { timeout: 60_000 },
    )
    .not.toBeNull();
  const error = await page.locator("body").getAttribute("data-error");
  if (error !== null) throw new Error(error);
  const encoded = await page.locator("body").getAttribute("data-result");
  if (encoded === null)
    throw new Error("GPU descriptor fixture is unavailable");
  return JSON.parse(encoded) as {
    descriptors: readonly number[];
    descriptorCount: number;
    quadArgs: readonly number[];
    hairlineArgs: readonly number[];
  };
}

export async function pickFixture(page: Page): Promise<{
  result: {
    sequence: number;
    seriesSlot: number;
    tileMetaIndex: number;
    relativeTime: number;
    value: number;
    distance: number;
  } | null;
  time: number | null;
}> {
  await page.goto("http://127.0.0.1:4173/tests/gpu/pick-fixture.html");
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            document.body.dataset.result ?? document.body.dataset.error ?? null,
        ),
      { timeout: 60_000 },
    )
    .not.toBeNull();
  const error = await page.locator("body").getAttribute("data-error");
  if (error !== null) throw new Error(error);
  const encoded = await page.locator("body").getAttribute("data-result");
  if (encoded === null) throw new Error("GPU picker fixture is unavailable");
  return JSON.parse(encoded) as {
    result: {
      sequence: number;
      seriesSlot: number;
      tileMetaIndex: number;
      relativeTime: number;
      value: number;
      distance: number;
    } | null;
    time: number | null;
  };
}

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

export async function pixelFixture(page: Page): Promise<{
  trajectoryPixels: number;
  outsideScissor: number;
  gapPixels: number;
  extrema: readonly boolean[];
  overlap: boolean;
  format: string;
}> {
  await page.goto("http://127.0.0.1:4173/tests/gpu/pixel-fixture.html");
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            document.body.dataset.result ?? document.body.dataset.error ?? null,
        ),
      { timeout: 60_000 },
    )
    .not.toBeNull();
  const error = await page.locator("body").getAttribute("data-error");
  if (error !== null) throw new Error(error);
  const encoded = await page.locator("body").getAttribute("data-result");
  if (encoded === null) throw new Error("GPU pixel fixture is unavailable");
  return JSON.parse(encoded) as {
    trajectoryPixels: number;
    outsideScissor: number;
    gapPixels: number;
    extrema: readonly boolean[];
    overlap: boolean;
    format: string;
  };
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

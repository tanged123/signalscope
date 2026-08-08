import type { Page } from "@playwright/test";
import { percentile } from "../../src/app/percentile";
import type { GpuMetricsSnapshot } from "../../src/render/gpu/metrics";

interface BenchWindow {
  __benchFrames: number[];
  __benchLongTasks: number[];
  __benchStop?: () => void;
}

export interface MetricDelta {
  readonly uploadBytes: number;
  readonly descriptorRebuilds: number;
  readonly successfulFrames: number;
}

export interface FrameStats {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  frames: number;
  longTasks: number;
  longestTaskMs: number;
}

export async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bench = window as unknown as BenchWindow;
    bench.__benchFrames = [];
    bench.__benchLongTasks = [];
    let last = performance.now();
    let running = true;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        bench.__benchLongTasks.push(entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: false });
    bench.__benchStop = () => {
      running = false;
      observer.disconnect();
    };
    const tick = (now: number) => {
      bench.__benchFrames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function stopFrameProbe(page: Page): Promise<FrameStats> {
  const measured = await page.evaluate(() => {
    const bench = window as unknown as BenchWindow;
    bench.__benchStop?.();
    return {
      frames: [...bench.__benchFrames],
      longTasks: bench.__benchLongTasks.length,
      longestTaskMs: Math.max(0, ...bench.__benchLongTasks),
    };
  });
  const frames = measured.frames.sort((a, b) => a - b);
  return {
    p50Ms: percentile(frames, 0.5),
    p95Ms: percentile(frames, 0.95),
    maxMs: frames.at(-1) ?? 0,
    frames: frames.length,
    longTasks: measured.longTasks,
    longestTaskMs: measured.longestTaskMs,
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

export async function waitForBenchEvent(
  page: Page,
  kind: string,
): Promise<number> {
  await page.waitForFunction(
    (expected) => {
      const host = window as typeof window & {
        __signalscopeBenchEvents?: readonly { kind: string; time: number }[];
      };
      return host.__signalscopeBenchEvents?.some(
        (event) => event.kind === expected,
      );
    },
    kind,
    { timeout: 120_000 },
  );
  return page.evaluate((expected) => {
    const host = window as typeof window & {
      __signalscopeBenchEvents?: readonly { kind: string; time: number }[];
    };
    return (
      host.__signalscopeBenchEvents?.find((event) => event.kind === expected)
        ?.time ?? performance.now()
    );
  }, kind);
}

export async function waitForSuccessfulFrame(page: Page): Promise<number> {
  await page.waitForFunction(
    () => {
      const host = window as typeof window & {
        __signalscopeBench?: { snapshot: () => GpuMetricsSnapshot };
      };
      return (host.__signalscopeBench?.snapshot().successfulFrames ?? 0) > 0;
    },
    { timeout: 120_000 },
  );
  return page.evaluate(() => performance.now());
}

export async function waitForPickCount(
  page: Page,
  count: number,
): Promise<GpuMetricsSnapshot> {
  await page.waitForFunction(
    (expected) => {
      const host = window as typeof window & {
        __signalscopeBench?: { snapshot: () => GpuMetricsSnapshot };
      };
      return (
        (host.__signalscopeBench?.snapshot().pickLatencyMs.length ?? 0) >=
        expected
      );
    },
    count,
    { timeout: 120_000 },
  );
  return gpuMetrics(page);
}

async function plotBox(page: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const box = await page.locator(".overlay-canvas").first().boundingBox();
  if (box === null) throw new Error("plot overlay has no bounds");
  return box;
}

async function pan(page: Page, distance: number): Promise<void> {
  const box = await plotBox(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance, y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(80);
}

export async function interact(
  page: Page,
  measureResidentPan = true,
): Promise<MetricDelta> {
  const canvas = page.locator(".overlay-canvas").first();
  await canvas.hover({ position: { x: 480, y: 200 } });
  const residentBefore = measureResidentPan ? await gpuMetrics(page) : null;
  for (let index = 0; index < 10; index += 1) await pan(page, 6);
  const residentAfter = measureResidentPan ? await gpuMetrics(page) : null;
  for (let index = 0; index < 10; index += 1) await pan(page, 220);
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(80);
  }
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(80);
  }
  const box = await plotBox(page);
  for (let index = 0; index < 30; index += 1) {
    await page.mouse.move(
      box.x + box.width * (0.2 + (index % 10) * 0.06),
      box.y + box.height * (0.25 + (index % 3) * 0.2),
    );
    await page.waitForTimeout(40);
  }
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.click(
      box.x + box.width * (0.25 + (index % 5) * 0.12),
      box.y + box.height * (0.3 + (index % 2) * 0.25),
    );
    await page.waitForTimeout(40);
  }
  return {
    uploadBytes:
      residentAfter === null || residentBefore === null
        ? 0
        : residentAfter.uploadBytes - residentBefore.uploadBytes,
    descriptorRebuilds:
      residentAfter === null || residentBefore === null
        ? 0
        : residentAfter.descriptorRebuilds - residentBefore.descriptorRebuilds,
    successfulFrames:
      residentAfter === null || residentBefore === null
        ? 0
        : residentAfter.successfulFrames - residentBefore.successfulFrames,
  };
}

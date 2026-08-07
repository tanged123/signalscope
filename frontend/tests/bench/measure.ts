import type { Page } from "@playwright/test";
import { percentile } from "../../src/app/percentile";

interface BenchWindow {
  __benchFrames: number[];
  __benchLongTasks: number[];
  __benchStop?: () => void;
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

export async function interact(page: Page): Promise<void> {
  const canvas = page.locator(".overlay-canvas").first();
  await canvas.hover({ position: { x: 480, y: 200 } });
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(80);
  }
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.move(480, 200);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(320, 200, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await page.waitForTimeout(80);
  }
  await page.mouse.move(320, 150);
  await page.mouse.down();
  await page.mouse.move(640, 320, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(80);
  }
}

import type { Page } from "@playwright/test";
import { inflateSync } from "node:zlib";
import { percentile } from "../../src/app/percentile";
import type { GpuMetricsSnapshot } from "../../src/render/gpu/metrics";

interface BenchWindow {
  __benchFrames: number[];
  __benchLongTasks: number[];
  __benchStop?: () => void;
}

export interface PlotPixelEvidence {
  readonly totalPixels: number;
  readonly nonBackgroundPixels: number;
}

export type RgbColor = readonly [number, number, number];

export function countNonBackgroundPixels(
  pixels: Uint8ClampedArray,
  backgrounds: readonly RgbColor[],
  tolerance = 8,
): number {
  let count = 0;
  const threshold = tolerance * tolerance;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const isBackground = backgrounds.some(
      ([backgroundRed, backgroundGreen, backgroundBlue]) => {
        const distance =
          (red - backgroundRed) ** 2 +
          (green - backgroundGreen) ** 2 +
          (blue - backgroundBlue) ** 2;
        return distance <= threshold;
      },
    );
    if (!isBackground) count += 1;
  }
  return count;
}

export async function plotPixelEvidence(
  page: Page,
): Promise<PlotPixelEvidence> {
  const backgrounds = await page.evaluate(() => {
    const parseColor = (value: string): RgbColor | null => {
      const match = value.trim().match(/^#([0-9a-f]{6})$/i);
      if (match === null || match[1] === undefined) return null;
      return [
        Number.parseInt(match[1].slice(0, 2), 16),
        Number.parseInt(match[1].slice(2, 4), 16),
        Number.parseInt(match[1].slice(4, 6), 16),
      ];
    };
    const style = getComputedStyle(document.documentElement);
    return [
      parseColor(style.getPropertyValue("--surface-0")),
      parseColor(style.getPropertyValue("--surface-1")),
    ].filter((color): color is RgbColor => color !== null);
  });
  const png = await page.locator(".series-canvas").first().screenshot();
  const image = decodePng(png);
  return {
    totalPixels: image.width * image.height,
    nonBackgroundPixels: countNonBackgroundPixels(image.pixels, backgrounds),
  };
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

function decodePng(bytes: Uint8Array): DecodedPng {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) {
    throw new Error("plot screenshot is not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const imageParts: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const typeOffset = offset + 4;
    const type = String.fromCharCode(
      view.getUint8(typeOffset),
      view.getUint8(typeOffset + 1),
      view.getUint8(typeOffset + 2),
      view.getUint8(typeOffset + 3),
    );
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    if (dataEnd + 4 > bytes.length) throw new Error("truncated plot PNG");
    if (type === "IHDR") {
      width = view.getUint32(dataOffset);
      height = view.getUint32(dataOffset + 4);
      bitDepth = view.getUint8(dataOffset + 8);
      colorType = view.getUint8(dataOffset + 9);
    } else if (type === "IDAT") {
      imageParts.push(bytes.slice(dataOffset, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (width === 0 || height === 0 || bitDepth !== 8) {
    throw new Error("unsupported plot PNG dimensions or bit depth");
  }
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bytesPerPixel === 0) throw new Error("unsupported plot PNG color type");
  const compressed = new Uint8Array(
    imageParts.reduce((total, part) => total + part.length, 0),
  );
  let compressedOffset = 0;
  for (const part of imageParts) {
    compressed.set(part, compressedOffset);
    compressedOffset += part.length;
  }
  const filtered = inflateSync(compressed);
  const stride = width * bytesPerPixel;
  const pixels = new Uint8ClampedArray(width * height * 4);
  let inputOffset = 0;
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[inputOffset] ?? 0;
    inputOffset += 1;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[inputOffset + x] ?? 0;
      const left = x >= bytesPerPixel ? (row[x - bytesPerPixel] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upperLeft =
        x >= bytesPerPixel ? (previous[x - bytesPerPixel] ?? 0) : 0;
      row[x] = unfilterByte(filter, raw, left, up, upperLeft);
    }
    inputOffset += stride;
    for (let x = 0; x < width; x += 1) {
      const source = x * bytesPerPixel;
      const target = (y * width + x) * 4;
      pixels[target] = row[source] ?? 0;
      pixels[target + 1] = row[source + 1] ?? 0;
      pixels[target + 2] = row[source + 2] ?? 0;
      pixels[target + 3] = bytesPerPixel === 4 ? (row[source + 3] ?? 0) : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}

function unfilterByte(
  filter: number,
  raw: number,
  left: number,
  up: number,
  upperLeft: number,
): number {
  if (filter === 0) return raw;
  if (filter === 1) return (raw + left) & 0xff;
  if (filter === 2) return (raw + up) & 0xff;
  if (filter === 3) return (raw + Math.floor((left + up) / 2)) & 0xff;
  if (filter === 4) {
    const prediction = left + up - upperLeft;
    const leftDistance = Math.abs(prediction - left);
    const upDistance = Math.abs(prediction - up);
    const upperLeftDistance = Math.abs(prediction - upperLeft);
    const prior =
      leftDistance <= upDistance && leftDistance <= upperLeftDistance
        ? left
        : upDistance <= upperLeftDistance
          ? up
          : upperLeft;
    return (raw + prior) & 0xff;
  }
  throw new Error(`unsupported plot PNG filter ${String(filter)}`);
}

export interface MetricDelta {
  readonly uploadBytes: number;
  readonly descriptorRebuilds: number;
  readonly successfulFrames: number;
  readonly residentBytesBefore: number;
  readonly residentBytesAfter: number;
  readonly residentPagesBefore: number;
  readonly residentPagesAfter: number;
}

export interface FrameStats {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  frames: number;
  longTasks: number;
  longestTaskMs: number;
}

export function meetsInteractiveFloors(
  firstPlotMs: number,
  frameStats: FrameStats,
  metrics: GpuMetricsSnapshot,
  residentPan: MetricDelta,
): boolean {
  const frameTimes = [...metrics.frameCpuMs].sort(
    (left, right) => left - right,
  );
  return (
    firstPlotMs <= 10_000 &&
    frameStats.frames > 100 &&
    percentile(frameTimes, 0.95) <= 33 &&
    Math.max(frameStats.longestTaskMs, frameStats.maxMs) <= 250 &&
    metrics.validationErrors.length === 0 &&
    residentPan.uploadBytes === 0 &&
    residentPan.descriptorRebuilds === 0 &&
    residentPan.residentBytesBefore === residentPan.residentBytesAfter &&
    residentPan.residentPagesBefore === residentPan.residentPagesAfter
  );
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
  await page.mouse.move(x + distance, y);
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
    residentBytesBefore: residentBefore?.residentBytes ?? 0,
    residentBytesAfter: residentAfter?.residentBytes ?? 0,
    residentPagesBefore: residentBefore?.residentPages ?? 0,
    residentPagesAfter: residentAfter?.residentPages ?? 0,
  };
}

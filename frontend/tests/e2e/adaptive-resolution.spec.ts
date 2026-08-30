import type { Page } from "@playwright/test";
import { expect, gotoApp, test } from "./fixtures";

interface BakedQueryRequest {
  pixel_width: number;
  [key: string]: unknown;
}

interface BakedQueryResponse {
  series: readonly { level: number }[];
}

interface BakedPlaneModule {
  BakedPlane: {
    prototype: {
      queryTiles(request: BakedQueryRequest): Promise<BakedQueryResponse>;
    };
  };
}

async function installForcedFullProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const rewriteFull = new URLSearchParams(location.search).has(
      "e2e-force-full",
    );
    if (!rewriteFull) return;

    const modulePath = "/src/app/data-plane.ts";
    void import(/* @vite-ignore */ modulePath)
      .then((module) => (module as unknown as BakedPlaneModule).BakedPlane)
      .then((BakedPlane) => {
        const originalQueryTiles = Reflect.get(
          BakedPlane.prototype,
          "queryTiles",
        ) as unknown as (
          this: object,
          request: BakedQueryRequest,
        ) => Promise<BakedQueryResponse>;
        BakedPlane.prototype.queryTiles = function (
          request: BakedQueryRequest,
        ) {
          return originalQueryTiles.call(this, {
            ...request,
            pixel_width: 1_000_000,
          });
        };
      });
  });
}

async function capturePixels(page: Page): Promise<{
  width: number;
  height: number;
  data: number[];
}> {
  return page.evaluate(() => {
    const sources = [
      ...document.querySelectorAll<HTMLCanvasElement>(".chart-host canvas"),
    ];
    const target = document.createElement("canvas");
    target.width = sources[0]?.width ?? 1;
    target.height = sources[0]?.height ?? 1;
    const context = target.getContext("2d");
    if (context === null) throw new Error("2D capture unavailable");
    for (const source of sources) context.drawImage(source, 0, 0);
    return {
      width: target.width,
      height: target.height,
      data: [...context.getImageData(0, 0, target.width, target.height).data],
    };
  });
}

function assertVisualDifferenceIsPixelLocal(
  adaptive: { width: number; height: number; data: number[] },
  full: { width: number; height: number; data: number[] },
): void {
  expect(adaptive.width).toBe(full.width);
  expect(adaptive.height).toBe(full.height);
  const differing = new Uint8Array(adaptive.width * adaptive.height);
  let differingPixels = 0;
  for (let offset = 0; offset < adaptive.data.length; offset += 4) {
    const different = [0, 1, 2].some(
      (channel) =>
        Math.abs(
          (adaptive.data[offset + channel] ?? 0) -
            (full.data[offset + channel] ?? 0),
        ) > 16,
    );
    if (!different) continue;
    differing[offset / 4] = 1;
    differingPixels += 1;
  }
  expect(differingPixels).toBeLessThanOrEqual(
    Math.ceil(adaptive.width * adaptive.height * 0.005),
  );

  const pending = [
    ...Array.from({ length: adaptive.width * adaptive.height }, (_, index) =>
      differing[index] === 1 ? index : -1,
    ),
  ];
  const visited = new Uint8Array(differing.length);
  for (const start of pending) {
    if (start < 0 || visited[start] === 1) continue;
    visited[start] = 1;
    const queue = [start];
    let minX = start % adaptive.width;
    let maxX = minX;
    let minY = Math.floor(start / adaptive.width);
    let maxY = minY;
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) continue;
      const x = current % adaptive.width;
      const y = Math.floor(current / adaptive.width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const next of [
        y > 0 ? current - adaptive.width : -1,
        y + 1 < adaptive.height ? current + adaptive.width : -1,
        x > 0 ? current - 1 : -1,
        x + 1 < adaptive.width ? current + 1 : -1,
      ]) {
        if (next >= 0 && differing[next] === 1 && visited[next] === 0) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    expect(maxX - minX + 1).toBeLessThanOrEqual(1);
    expect(maxY - minY + 1).toBeLessThanOrEqual(1);
  }
}

test("adaptive and forced-full plots differ only at isolated pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await installForcedFullProbe(page);
  await gotoApp(page);
  await expect(page.locator(".chart-host canvas").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 20_000,
  });
  const adaptive = await capturePixels(page);

  await page.goto("/?e2e-force-full=1");
  await expect(page.locator("#app")).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.locator(".chart-host canvas").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 20_000,
  });
  const full = await capturePixels(page);
  assertVisualDifferenceIsPixelLocal(adaptive, full);
});

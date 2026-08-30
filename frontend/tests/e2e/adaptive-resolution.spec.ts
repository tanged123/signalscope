import type { Page } from "@playwright/test";
import { expect, gotoApp, test } from "./fixtures";

interface ResolutionProbe {
  __signalscopeTestLevels: number[][];
  __signalscopeHoldAdaptive: boolean;
  __signalscopePending: boolean;
  __signalscopeRelease?: () => void;
}

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

async function installResolutionProbe(
  page: Page,
  forceFull = false,
): Promise<void> {
  await page.addInitScript((rewriteFull: boolean) => {
    const probe = window as unknown as ResolutionProbe;
    probe.__signalscopeTestLevels = [];
    probe.__signalscopeHoldAdaptive = false;
    probe.__signalscopePending = false;

    const record = (responseLevels: number[]): void => {
      if (responseLevels.length > 0) {
        probe.__signalscopeTestLevels.push(responseLevels);
      }
    };
    const hold = <T>(value: T): Promise<T> => {
      if (!probe.__signalscopeHoldAdaptive) return Promise.resolve(value);
      probe.__signalscopePending = true;
      return new Promise((resolve) => {
        probe.__signalscopeRelease = () => {
          probe.__signalscopePending = false;
          delete probe.__signalscopeRelease;
          resolve(value);
        };
      });
    };

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
          const nextRequest = rewriteFull
            ? { ...request, pixel_width: 1_000_000 }
            : request;
          return originalQueryTiles.call(this, nextRequest).then((response) => {
            record(response.series.map((series) => series.level));
            return hold(response);
          });
        };
      });
  }, forceFull);
}

async function probeLevels(page: Page): Promise<number[][]> {
  return page.evaluate(() => {
    const probe = window as unknown as ResolutionProbe;
    return probe.__signalscopeTestLevels.map((response) => [...response]);
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

test("adaptive responses refine to raw data without clearing the plot", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 640, height: 800 });
  await installResolutionProbe(page);
  await gotoApp(page);

  const canvas = page.locator(".chart-host canvas").first();
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 20_000,
  });
  await expect
    .poll(async () => (await probeLevels(page)).length)
    .toBeGreaterThan(0);
  const overviewIndex = (await probeLevels(page)).length;
  await page.evaluate(() => {
    const workbench = document.querySelector<HTMLElement>(".workbench");
    if (workbench === null) throw new Error("workbench is missing");
    workbench.style.width = "200px";
    workbench.style.minWidth = "0";
    const workspace = document.querySelector<HTMLElement>(".workspace");
    if (workspace === null) throw new Error("workspace is missing");
    workspace.style.width = "200px";
    workspace.style.minWidth = "0";
    for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
      panel.style.width = "200px";
      panel.style.minWidth = "0";
    }
  });

  await page.evaluate(() => {
    (window as unknown as ResolutionProbe).__signalscopeHoldAdaptive = true;
  });
  await page.keyboard.press("n");
  const row = page.locator('.outline-scroll [data-row-kind="series"]').first();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer });
  await page
    .locator(".panel")
    .last()
    .dispatchEvent("dragover", { dataTransfer });
  await page.locator(".panel").last().dispatchEvent("drop", { dataTransfer });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as ResolutionProbe).__signalscopePending,
      ),
    )
    .toBe(true);
  await expect(canvas).toBeVisible();

  await page.evaluate(() => {
    const probe = window as unknown as ResolutionProbe;
    probe.__signalscopeHoldAdaptive = false;
    probe.__signalscopeRelease?.();
  });
  await expect
    .poll(async () => {
      const responses = await probeLevels(page);
      return responses.slice(overviewIndex).at(-1)?.[0] ?? -1;
    })
    .toBeGreaterThan(0);

  const detailOverlay = page.locator(".overlay-canvas").last();
  const detailBox = await detailOverlay.boundingBox();
  if (detailBox === null) throw new Error("detail overlay is not laid out");
  await page.evaluate(() => {
    (window as unknown as ResolutionProbe).__signalscopeHoldAdaptive = true;
  });
  await page.mouse.move(
    detailBox.x + detailBox.width / 2,
    detailBox.y + detailBox.height / 2,
  );
  await page.mouse.wheel(0, -4_000);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as ResolutionProbe).__signalscopePending,
      ),
    )
    .toBe(true);
  await expect(detailOverlay).toBeVisible();

  await page.evaluate(() => {
    const probe = window as unknown as ResolutionProbe;
    probe.__signalscopeHoldAdaptive = false;
    probe.__signalscopeRelease?.();
  });
  await expect
    .poll(async () => {
      const responses = await probeLevels(page);
      return responses.at(-1)?.[0] ?? -1;
    })
    .toBe(0);

  const observed = (await probeLevels(page))
    .slice(overviewIndex)
    .map((response) => response[0])
    .filter((level): level is number => level !== undefined);
  expect(observed.at(-1)).toBe(0);
  for (let index = 1; index < observed.length; index += 1) {
    expect(observed[index]).toBeLessThanOrEqual(observed[index - 1] ?? 0);
  }
});

test("adaptive and forced-full plots differ only at isolated pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await installResolutionProbe(page);
  await gotoApp(page);
  await expect(page.locator(".chart-host canvas").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(".render-ms")).not.toHaveText("— ms", {
    timeout: 20_000,
  });
  const adaptive = await capturePixels(page);

  const fullPage = await page.context().newPage();
  try {
    await fullPage.setViewportSize({ width: 640, height: 800 });
    await installResolutionProbe(fullPage, true);
    await gotoApp(fullPage);
    await expect(fullPage.locator(".chart-host canvas").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(fullPage.locator(".render-ms")).not.toHaveText("— ms", {
      timeout: 20_000,
    });
    const full = await capturePixels(fullPage);
    assertVisualDifferenceIsPixelLocal(adaptive, full);
  } finally {
    await fullPage.close();
  }
});

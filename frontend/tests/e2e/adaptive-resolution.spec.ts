import type { Page } from "@playwright/test";
import { expect, gotoApp, test } from "./fixtures";

interface ResolutionProbe {
  __signalscopeTestLevels: number[][];
  __signalscopeHoldAdaptive: boolean;
  __signalscopePending: boolean;
  __signalscopeTileQueryCount: number;
  __signalscopeTilePixelWidths: number[];
  __signalscopePreparedBankCount: number;
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
    probe.__signalscopeTileQueryCount = 0;
    probe.__signalscopeTilePixelWidths = [];
    probe.__signalscopePreparedBankCount = 0;

    const align8 = (value: number): number => (value + 7) & ~7;
    const levels = (buffer: ArrayBuffer): number[] => {
      const view = new DataView(buffer);
      const count = view.getUint32(8, true);
      const out: number[] = [];
      let offset = 16;
      for (let index = 0; index < count; index += 1) {
        const level = view.getUint32(offset + 8, true);
        const bins = view.getUint32(offset + 12, true);
        const pathBytes = view.getUint16(offset + 16, true);
        const unitBytes = view.getUint16(offset + 18, true);
        out.push(level);
        offset = align8(
          offset + 24 + pathBytes + (unitBytes === 0xffff ? 0 : unitBytes),
        );
        offset = align8(offset + bins * 73);
      }
      return out;
    };
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

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      let nextInit = init;
      if (
        rewriteFull &&
        new URL(url, window.location.href).pathname ===
          "/api/query_tiles_bin" &&
        typeof init?.body === "string"
      ) {
        const body = JSON.parse(init.body) as {
          payload?: { pixel_width?: number };
        };
        if (body.payload !== undefined) body.payload.pixel_width = 1_000_000;
        nextInit = { ...init, body: JSON.stringify(body) };
      }
      if (
        new URL(url, window.location.href).pathname ===
          "/api/query_tiles_bin" &&
        typeof init?.body === "string"
      ) {
        const body = JSON.parse(init.body) as {
          payload?: { pixel_width?: number };
        };
        const pixelWidth = body.payload?.pixel_width;
        if (typeof pixelWidth === "number")
          probe.__signalscopeTilePixelWidths.push(pixelWidth);
      }
      const response = await originalFetch(input, nextInit);
      if (
        new URL(url, window.location.href).pathname === "/api/query_tiles_bin"
      ) {
        probe.__signalscopeTileQueryCount += 1;
        record(levels(await response.clone().arrayBuffer()));
        return hold(response);
      }
      return response;
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
          probe.__signalscopeTileQueryCount += 1;
          probe.__signalscopeTilePixelWidths.push(request.pixel_width);
          const nextRequest = rewriteFull
            ? { ...request, pixel_width: 1_000_000 }
            : request;
          return originalQueryTiles.call(this, nextRequest).then((response) => {
            record(response.series.map((series) => series.level));
            return hold(response);
          });
        };
      });
    const panelModulePath = "/src/ui/panel.ts";
    void import(/* @vite-ignore */ panelModulePath).then((module) => {
      const PanelView = (module as typeof import("../../src/ui/panel"))
        .PanelView;
      const original = PanelView.prototype.publishBank;
      PanelView.prototype.publishBank = function (...args) {
        probe.__signalscopePreparedBankCount += 1;
        return original.apply(this, args);
      };
    });
  }, forceFull);
}

async function installFiveChannelFixture(page: Page): Promise<void> {
  const signals = Array.from({ length: 5_000 }, (_, index) => {
    const source = Math.floor(index / 5) + 1;
    const channel = (index % 5) + 1;
    const sourceKey = `run_${String(source).padStart(4, "0")}`;
    const path = `${sourceKey}/channel_${String(channel)}`;
    return {
      signal_id: String(index + 1),
      source_id: String(source),
      source_key: sourceKey,
      local_path: `channel_${String(channel)}`,
      path,
      unit: "u",
      point_count: "1000",
      t_min: 0,
      t_max: 1000,
      last_value: 0,
    };
  });
  const refs = signals.map((signal) => {
    const [sourceKey, channel] = signal.path.split("/");
    return { source_key: sourceKey ?? "", channel: channel ?? "" };
  });
  const session = JSON.stringify({
    app: "signalscope",
    schema_version: 22,
    theme: "dark",
    linked_time: {
      t0: 0,
      t1: 1000,
      linked: true,
      paused: false,
      cursorT: null,
      mode: "fixed",
    },
    active_tab_id: "workspace-1",
    tabs: [
      {
        id: "workspace-1",
        title: "5,000 channels",
        cursor_mode: "none",
        focused_panel_id: "panel-many",
        maximized_panel_id: null,
        panels: [
          {
            id: "panel-many",
            title: "5,000 channels",
            mode: "time",
            axis_style: "gutter",
            bindings: [{ kind: "pick", selector: null, refs, set_id: null }],
            color_by: "source",
            overrides: [],
            focus: [],
            ghost_mode: "all",
            split_by: "none",
            y_range: null,
            x_range: null,
            x_label: null,
            y_label: null,
            time_window: null,
            annotations: [],
            show_stats: false,
          },
        ],
        layout: [{ height: 1, panels: [{ panel_id: "panel-many", width: 1 }] }],
      },
    ],
    named_sets: [],
    derived: [],
    derived_bundles: [],
    sources: [],
  });
  const envelope = (payload: unknown) => ({
    protocol_version: 18,
    payload,
  });

  await page.route("**/api/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1);
    const body = route.request().postDataJSON() as {
      payload?: Record<string, unknown>;
    } | null;
    const payload = body?.payload ?? {};
    if (command === "health") {
      await route.fulfill({ status: 200, body: "ok" });
      return;
    }
    if (command === "query_tiles_bin") {
      const signalIds = Array.isArray(payload.signal_ids)
        ? payload.signal_ids.map(String)
        : [];
      const window =
        typeof payload.window === "object" && payload.window !== null
          ? (payload.window as { t0: number; t1: number })
          : { t0: 0, t1: 1000 };
      await route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: binaryResponseBody(encodeSyntheticTiles(signalIds, window)),
      });
      return;
    }

    let response: unknown;
    switch (command) {
      case "list_formats":
        response = [];
        break;
      case "load_preferences":
        response = null;
        break;
      case "effective_recipe_directory":
        response = "/tmp/signalscope-recipes";
        break;
      case "load_session":
      case "reset_session":
        response = { session_json: session, path: null };
        break;
      case "restore_sources":
        response = { job_id: "restore" };
        break;
      case "batch_status":
        response = {
          state: "done",
          fraction: 1,
          total: "0",
          done: "0",
          failed: "0",
          current_paths: [],
          recent_failures: [],
        };
        break;
      case "restore_reconcile":
        response = {
          session_json: payload.session_json ?? session,
          rewritten: "0",
          conflicts: [],
          unresolved: [],
        };
        break;
      case "release_batch":
      case "save_preferences":
      case "save_session":
        response = null;
        break;
      case "list_signals":
        response = signals;
        break;
      case "list_sources":
        response = Array.from({ length: 1_000 }, (_, index) => ({
          source_id: String(index + 1),
          source_key: `run_${String(index + 1).padStart(4, "0")}`,
          prefix: `run_${String(index + 1).padStart(4, "0")}`,
          path: `run_${String(index + 1).padStart(4, "0")}.csv`,
          point_count: "5000",
        }));
        break;
      case "query_samples":
        response = {
          request_id: payload.request_id ?? "samples",
          series: [],
        };
        break;
      default:
        await route.fulfill({
          status: 404,
          body: `unexpected fixture command: ${String(command)}`,
        });
        return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(envelope(response)),
    });
  });
}

function binaryResponseBody(bytes: Uint8Array): string {
  const nodeBuffer = (
    globalThis as typeof globalThis & {
      Buffer?: { from(value: Uint8Array): unknown };
    }
  ).Buffer;
  if (nodeBuffer === undefined) throw new Error("Node Buffer unavailable");
  // Playwright requires a Node Buffer for binary route bodies. The runtime
  // value is a Buffer; the string cast only avoids adding Node types to the
  // browser-facing TypeScript project.
  return nodeBuffer.from(bytes) as string;
}

function encodeSyntheticTiles(
  signalIds: readonly string[],
  window: { t0: number; t1: number },
): Uint8Array {
  const encoder = new TextEncoder();
  const entries = signalIds.map((signalId) => ({
    signalId,
    path: `run_${String(Math.floor((Number(signalId) - 1) / 5) + 1).padStart(4, "0")}/channel_${String(((Number(signalId) - 1) % 5) + 1)}`,
    unit: "u",
  }));
  const aligned = (value: number): number => (value + 7) & ~7;
  let size = 16;
  for (const entry of entries) {
    size = aligned(size + 24 + encoder.encode(entry.path).byteLength + 1);
    size = aligned(size + 73);
  }
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x42545353, true);
  view.setUint32(4, 18, true);
  view.setUint32(8, entries.length, true);
  let offset = 16;
  for (const entry of entries) {
    const path = encoder.encode(entry.path);
    view.setBigUint64(offset, BigInt(entry.signalId), true);
    view.setUint32(offset + 8, 0, true);
    view.setUint32(offset + 12, 1, true);
    view.setUint16(offset + 16, path.byteLength, true);
    view.setUint16(offset + 18, 1, true);
    offset += 24;
    bytes.set(path, offset);
    offset += path.byteLength;
    bytes[offset] = 117;
    offset = aligned(offset + 1);
    const t0 = offset;
    const value = Number(entry.signalId) / 1000;
    view.setFloat64(t0, window.t0, true);
    view.setFloat64(t0 + 8, window.t1, true);
    for (let column = 2; column < 7; column += 1)
      view.setFloat64(t0 + column * 8, value, true);
    view.setUint32(t0 + 64, 1, true);
    view.setUint32(t0 + 68, 1, true);
    bytes[t0 + 72] = 15;
    offset = aligned(t0 + 73);
  }
  return bytes;
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

test("fit returns to a resident overview without a tile refresh", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 640, height: 800 });
  await installResolutionProbe(page);
  await gotoApp(page);

  const overlay = page.locator(".overlay-canvas").first();
  await expect(overlay).toBeVisible();
  await expect(page.locator(".chart-host canvas").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => selectedBankRole(page)).toBe("overview");

  const box = await overlay.boundingBox();
  if (box === null) throw new Error("overlay is not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -4_000);
  await expect.poll(() => selectedBankRole(page)).toBe("detail");
  await expect
    .poll(async () => (await probeLevels(page)).at(-1)?.[0] ?? -1)
    .toBe(0);
  await page.waitForTimeout(120);

  const beforeQueries = await tileQueryCount(page);
  const beforePrepared = await preparedBankCount(page);
  await overlay.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect.poll(() => selectedBankRole(page)).toBe("overview");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(await tileQueryCount(page)).toBe(beforeQueries);
  expect(await preparedBankCount(page)).toBe(beforePrepared);
  await expect(page.locator(".chart-host canvas").first()).toBeVisible();
});

test("admits 5,000 visible channels with one budgeted density", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await installResolutionProbe(page);
  await installFiveChannelFixture(page);
  await gotoApp(page);

  await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".chart-host canvas").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator(".presentation-stat")).toContainText(
    "resolution limited",
    { timeout: 60_000 },
  );
  await expect(page.locator(".presentation-stat")).toContainText(
    "5,000 series",
  );
  await expect.poll(async () => (await tileQueryCount(page)) > 0).toBe(true);

  const widths = await page.evaluate(
    () => (window as unknown as ResolutionProbe).__signalscopeTilePixelWidths,
  );
  const stableWidth = widths.at(-1) ?? 0;
  const beforeQueries = await tileQueryCount(page);
  await page.evaluate(() => {
    const probe = window as unknown as ResolutionProbe;
    probe.__signalscopeTilePixelWidths = [];
  });
  const overlay = page.locator(".overlay-canvas").first();
  const box = await overlay.boundingBox();
  if (box === null) throw new Error("overlay is not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -4_000);
  await expect.poll(() => selectedBankRole(page)).toBe("detail");
  await expect
    .poll(async () => (await tileQueryCount(page)) > beforeQueries)
    .toBe(true);
  const zoomedWidths = await page.evaluate(
    () => (window as unknown as ResolutionProbe).__signalscopeTilePixelWidths,
  );
  expect(new Set(zoomedWidths).size).toBe(1);
  expect(Math.max(...zoomedWidths)).toBeGreaterThanOrEqual(stableWidth);
  await overlay.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect.poll(() => selectedBankRole(page)).toBe("overview");
});

async function selectedBankRole(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      (
        document.querySelector(
          ".panel .chart-bank:not([hidden])",
        ) as HTMLElement | null
      )?.dataset.bankRole ?? null,
  );
}

async function tileQueryCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as ResolutionProbe).__signalscopeTileQueryCount,
  );
}

async function preparedBankCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as ResolutionProbe).__signalscopePreparedBankCount,
  );
}

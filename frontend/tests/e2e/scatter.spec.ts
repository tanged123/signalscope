import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceModel } from "../../src/app/workspace";
import type { Session } from "../../src/generated/session";
import {
  PROTOCOL_VERSION,
  type BatchJob,
  type BatchStatus,
  type SourceSummary,
} from "../../src/generated/protocol";
import type { Envelope } from "../../src/app/envelope";
import {
  expect,
  test,
  addPanel,
  openPanelAxes,
  panelLayoutAction,
} from "./fixtures";

test("create scatter in a maximized workspace, assign XY, restore and export offline", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const directory = mkdtempSync(join(tmpdir(), "signalscope-scatter-"));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const url = "http://127.0.0.1:43129";
  const server = spawn(
    join(root, "target/debug/scope-server"),
    ["--no-auth", "--no-open", "--port", "43129", "--data-dir", directory],
    { cwd: root, stdio: "ignore" },
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript({
    content: `
    const configure = GPUCanvasContext.prototype.configure;
    const currentTexture = GPUCanvasContext.prototype.getCurrentTexture;
    let device, texture, busy = false;
    GPUCanvasContext.prototype.getCurrentTexture = function() {
      const next = currentTexture.call(this);
      if (this.canvas.closest('[data-panel-id="panel-2"]')) texture = next;
      return next;
    };
    GPUCanvasContext.prototype.configure = function(config) {
      device = config.device;
      config.device.addEventListener("uncapturederror", (event) => {
        document.documentElement.dataset.gpuError = event.error.message;
      });
      return configure.call(this, {...config, usage: (config.usage ?? 16) | 1});
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function(commands) {
      submit.call(this, commands);
      if (busy || !texture) return;
      busy = true;
      const width = texture.width, height = texture.height;
      const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
      const buffer = device.createBuffer({size: bytesPerRow * height, usage: 9});
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({texture}, {buffer, bytesPerRow}, {width, height});
      submit.call(this, [encoder.finish()]);
      buffer.mapAsync(1).then(() => {
        const pixels = new Uint8Array(buffer.getMappedRange());
        let colored = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = y * bytesPerRow + x * 4;
          if (Math.max(pixels[i], pixels[i+1], pixels[i+2]) - Math.min(pixels[i], pixels[i+1], pixels[i+2]) > 40) colored++;
        }
        document.documentElement.dataset.scatterPixels = String(colored);
        if (colored > 100) {
          const frame = document.createElement("canvas");
          frame.width = width;
          frame.height = height;
          const context = frame.getContext("2d");
          const data = context.createImageData(width, height);
          const bgra = texture.format.startsWith("bgra");
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const source = y * bytesPerRow + x * 4, target = (y * width + x) * 4;
            data.data[target] = pixels[source + (bgra ? 2 : 0)];
            data.data[target+1] = pixels[source+1];
            data.data[target+2] = pixels[source + (bgra ? 0 : 2)];
            data.data[target+3] = pixels[source+3];
          }
          context.putImageData(data, 0, 0);
          window.scatterFrame = frame.toDataURL("image/png");
        }
        buffer.unmap();
      }).catch(error => {
        if (error.name !== "AbortError") document.documentElement.dataset.gpuError = error.message;
      }).finally(() => { buffer.destroy(); busy = false; });
    };
  `,
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await request.get(`${url}/api/health`)).ok();
        } catch {
          return false;
        }
      })
      .toBe(true);
    const path = join(directory, "run.csv");
    writeFileSync(
      path,
      "time,x,y\n" +
        Array.from(
          { length: 51 },
          (_, i) =>
            `${String(i)},${String(Math.sin(i * 1.2) * 5)},${String(Math.cos(i * 0.7) * 4)}`,
        ).join("\n"),
    );
    const job = (
      (await (
        await request.post(`${url}/api/ingest_batch`, {
          data: {
            protocol_version: PROTOCOL_VERSION,
            payload: { paths: [path] },
          },
        })
      ).json()) as Envelope<BatchJob>
    ).payload;
    await expect
      .poll(
        async () =>
          (
            (await (
              await request.post(`${url}/api/batch_status`, {
                data: { protocol_version: PROTOCOL_VERSION, payload: job },
              })
            ).json()) as Envelope<BatchStatus>
          ).payload.state,
      )
      .toBe("done");
    const sources = (
      (await (
        await request.post(`${url}/api/list_sources`)
      ).json()) as Envelope<SourceSummary[]>
    ).payload;
    const source = sources[0];
    if (source === undefined) throw new Error("Missing source");
    const model = new WorkspaceModel();
    const line = model.addPanelRow();
    model.setLinkedWindow(0, 50);
    model.addSource({
      key: source.source_key,
      path: source.path,
      prefix: source.prefix,
      provider_id: null,
      decode_provenance: null,
      recipe_id: null,
      recipe_digest: null,
    });
    line.bindings = [
      {
        kind: "pick",
        selector: null,
        set_id: null,
        refs: [{ source_key: source.source_key, channel: "y" }],
      },
    ];
    const workspacePath = join(directory, "session.autosave.json");
    writeFileSync(workspacePath, JSON.stringify(model.snapshot()));
    await page.goto(url);
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
    await panelLayoutAction(page.locator(".panel"), "Maximize panel");
    await addPanel(page.locator(".panel"), "Scatter", "Right");
    await expect(page.locator(".panel")).toHaveCount(2);
    await expect(page.locator(".panel.maximized")).toHaveCount(0);
    const scatter = page.locator('[data-panel-id="panel-2"]');
    await expect(scatter.locator(".panel-axes-value")).toContainText("scatter");
    await openPanelAxes(scatter);
    await expect(scatter.locator(".panel-c-axis")).toBeHidden();
    await scatter.locator(".panel-y-axis").click();
    await scatter.locator(".axis-picker input").fill("run/y");
    const timeReply = page.waitForResponse(
      (response) =>
        response.url().includes("query_line2d") && response.status() === 200,
    );
    await scatter.locator(".axis-picker input").press("Enter");
    await timeReply;
    await expect(scatter.locator('[data-panel-slot="status"]')).toBeHidden();
    await openPanelAxes(scatter);
    await scatter.locator(".panel-x-axis").click();
    await scatter.locator(".axis-picker input").fill("run/x");
    const xyReply = page.waitForResponse(
      (response) =>
        response.url().includes("query_line2d") && response.status() === 200,
    );
    await scatter.locator(".axis-picker input").press("Enter");
    await xyReply;
    await expect
      .poll(
        () =>
          page.locator("html").getAttribute("data-scatter-pixels").then(Number),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(100);
    await expect(scatter.locator('[data-panel-slot="status"]')).toBeHidden();
    await expect(scatter.locator(".chart-host canvas").first()).toBeVisible();
    await expect
      .poll(
        () => {
          try {
            return (
              JSON.parse(
                readFileSync(pathToFileURL(workspacePath), "utf8"),
              ) as Session
            ).tabs[0]?.panels[1]?.x_axis.kind;
          } catch {
            return null;
          }
        },
        { timeout: 20_000 },
      )
      .toBe("signal");
    const saved = JSON.parse(
      readFileSync(pathToFileURL(workspacePath), "utf8"),
    ) as Session;
    expect(saved.tabs[0]?.panels.map((panel) => panel.content.kind)).toEqual([
      "line2d",
      "scatter2d",
    ]);
    await page.reload();
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
    await expect(scatter.locator(".panel-axes-value")).toContainText("scatter");
    await expect
      .poll(
        () =>
          page.locator("html").getAttribute("data-scatter-pixels").then(Number),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(100);
    await page.screenshot({
      path: testInfo.outputPath("mixed-scatter-live.png"),
    });
    const frameDownload = page.waitForEvent("download");
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = (window as unknown as { scatterFrame: string }).scatterFrame;
      link.download = "scatter-gpu.png";
      link.click();
    });
    await (await frameDownload).saveAs(testInfo.outputPath("scatter-gpu.png"));
    await page.setViewportSize({ width: 1100, height: 700 });
    await scatter.locator(".panel-layout").focus();
    await page.keyboard.press("Enter");
    await expect(
      scatter.getByRole("dialog", { name: "Add panel", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("scatter-menu.png") });
    await page.keyboard.press("Escape");
    await expect(scatter.locator(".panel-layout")).toBeFocused();
    const snapshot = testInfo.outputPath("scatter.html");
    await promisify(execFile)(
      join(root, "scripts/export.sh"),
      [
        "--no-build",
        "--data",
        path,
        "--workspace",
        workspacePath,
        "--range",
        "all",
        "--fidelity",
        "full",
        "--out",
        snapshot,
      ],
      { cwd: root },
    );
    await page.waitForLoadState("networkidle");
    const offlineRequests: string[] = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) offlineRequests.push(request.url());
    });
    await page.goto(pathToFileURL(snapshot).href);
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
    await expect(scatter.locator(".panel-axes-value")).toContainText("scatter");
    await expect
      .poll(
        () =>
          page.locator("html").getAttribute("data-scatter-pixels").then(Number),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(100);
    await expect(scatter.locator('[data-panel-slot="status"]')).toBeHidden();
    await panelLayoutAction(scatter, "Maximize panel");
    await expect(page.locator(".panel.maximized")).toHaveCount(1);
    await panelLayoutAction(scatter, "Restore panel");
    await expect(page.locator(".panel")).toHaveCount(2);
    await expect(
      page.locator('.panel [data-panel-slot="status"]:visible'),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("mixed-scatter-offline.png"),
    });
    expect(offlineRequests).toEqual([]);
    expect(errors).toEqual([]);
    expect(
      await page.locator("html").getAttribute("data-gpu-error"),
    ).toBeNull();
  } finally {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

import { WorkspaceModel } from "../../src/app/workspace";
import type { Session } from "../../src/generated/session";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PROTOCOL_VERSION,
  type BatchJob,
  type BatchStatus,
  type SourceSummary,
} from "../../src/generated/protocol";
import type { Envelope } from "../../src/app/envelope";
import { expect, test } from "./fixtures";

test("live XY axes select unplotted time and source-paired bundles by keyboard", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.addInitScript({
    content: `
    const configure = GPUCanvasContext.prototype.configure;
    const currentTexture = GPUCanvasContext.prototype.getCurrentTexture;
    let device, texture, busy = false;
    GPUCanvasContext.prototype.configure = function(config) {
      device = config.device;
      device.addEventListener("uncapturederror", event => {
        document.documentElement.dataset.gpuError = event.error.message;
      });
      return configure.call(this, {...config, usage: (config.usage ?? 16) | 1});
    };
    GPUCanvasContext.prototype.getCurrentTexture = function() {
      texture = currentTexture.call(this);
      return texture;
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function(commands) {
      submit.call(this, commands);
      if (busy || !texture || !document.querySelector(".colorbar-canvas:not([hidden])")) return;
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
        document.documentElement.dataset.gpuColoredPixels = String(colored);
        buffer.unmap();
        buffer.destroy();
        busy = false;
      });
    };
  `,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      (message.type() === "error" &&
        !message.location().url.endsWith("favicon.ico")) ||
      /validation|shader|pipeline/i.test(message.text())
    )
      errors.push(message.text());
  });
  const directory = mkdtempSync(join(tmpdir(), "signalscope-xy-"));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const url = "http://127.0.0.1:43119";
  const server = spawn(
    join(root, "target/debug/scope-server"),
    ["--no-auth", "--no-open", "--port", "43119", "--data-dir", directory],
    { cwd: root, stdio: "ignore" },
  );
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
    const paths = ["one", "two"].map((name, index) => {
      const path = join(directory, `${name}.csv`);
      writeFileSync(
        path,
        `time,x,y,temperature\n0,${String(index + 1)},3,0\n1,8,4,50\n2,2,6,100\n`,
      );
      return path;
    });
    const jobResponse = await request.post(`${url}/api/ingest_batch`, {
      data: { protocol_version: PROTOCOL_VERSION, payload: { paths } },
    });
    expect(jobResponse.ok()).toBe(true);
    const job = ((await jobResponse.json()) as Envelope<BatchJob>).payload;
    await expect
      .poll(async () => {
        const result = await request.post(`${url}/api/batch_status`, {
          data: { protocol_version: PROTOCOL_VERSION, payload: job },
        });
        return ((await result.json()) as Envelope<BatchStatus>).payload.state;
      })
      .toBe("done");
    const sourceResponse = await request.post(`${url}/api/list_sources`);
    expect(sourceResponse.ok()).toBe(true);
    const sources = ((await sourceResponse.json()) as Envelope<SourceSummary[]>)
      .payload;
    const workspace = new WorkspaceModel();
    workspace.addPanelRow();
    workspace.setLinkedWindow(0, 2);
    for (const source of sources)
      workspace.addSource({
        key: source.source_key,
        path: source.path,
        prefix: source.prefix,
        provider_id: null,
        decode_provenance: null,
        recipe_id: null,
        recipe_digest: null,
      });
    writeFileSync(
      join(directory, "session.autosave.json"),
      JSON.stringify(workspace.snapshot()),
    );
    await page.goto(url);
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
    const panel = page.locator(".panel").first();
    await expect(panel).toBeVisible();
    await panel.locator(".panel-y-axis").click();
    let search = panel.locator(".axis-picker input");
    await search.fill("y · bundle");
    await search.press("Enter");
    await panel.locator(".panel-x-axis").click();
    search = panel.locator(".axis-picker input");
    await expect(search).toBeFocused();
    await search.fill("x · bundle");
    const replies: number[] = [];
    page.on("response", (response) => {
      if (response.url().includes("query_line2d"))
        replies.push(response.status());
    });
    await search.press("Enter");
    await expect(panel.locator(".panel-x-axis")).toContainText("x · 2 runs");
    await expect
      .poll(() => replies.filter((status) => status === 200).length)
      .toBeGreaterThanOrEqual(2);
    await expect(panel.locator(".chart-host canvas").first()).toBeVisible();
    await expect(panel.locator('[data-panel-slot="status"]')).not.toContainText(
      /mismatch|unknown|unavailable/i,
    );
    await panel.screenshot({ path: testInfo.outputPath("xy-bundle.png") });
    const limitsButton = panel.locator(".panel-axis-limits");
    await limitsButton.click();
    const editor = panel.getByRole("dialog", {
      name: "Axis limits",
      exact: true,
    });
    await expect(editor).toHaveClass(/panel-config-popover/);
    await expect(editor.getByLabel("C limits mode")).toHaveCount(0);
    const triggerRect = await limitsButton.boundingBox();
    const editorRect = await editor.boundingBox();
    expect(triggerRect).not.toBeNull();
    expect(editorRect).not.toBeNull();
    if (triggerRect !== null && editorRect !== null) {
      expect(
        Math.abs(editorRect.y - triggerRect.y - triggerRect.height - 4),
      ).toBeLessThan(2);
      expect(
        Math.abs(
          editorRect.x + editorRect.width - triggerRect.x - triggerRect.width,
        ),
      ).toBeLessThan(2);
    }
    await editor.getByLabel("X limits mode").selectOption("fixed");
    await editor.getByLabel("X minimum", { exact: true }).fill("0");
    await editor.getByLabel("X maximum", { exact: true }).fill("10");
    await editor.getByLabel("Y limits mode").selectOption("fixed");
    await editor.getByLabel("Y minimum", { exact: true }).fill("1");
    await editor.getByLabel("Y maximum", { exact: true }).fill("8");
    await editor.getByRole("button", { name: "Apply limits" }).click();
    await expect(editor).toBeHidden();
    await expect(limitsButton).toBeFocused();
    await panel.locator(".panel-c-axis").click();
    await panel.locator(".axis-picker input").fill("temperature · bundle");
    await panel.locator(".axis-picker input").press("Enter");
    await expect(panel.locator(".panel-c-axis")).toContainText(
      "temperature · 2 runs",
    );
    const colorbar = panel.locator(".colorbar-canvas");
    await expect(colorbar).toBeVisible();
    await expect(colorbar).toHaveAttribute("aria-label", /0 to 100/);
    await panel.locator(".panel-axis-limits").click();
    await panel.getByLabel("C limits mode").selectOption("fixed");
    await panel.getByLabel("C minimum", { exact: true }).fill("20");
    await panel.getByLabel("C maximum", { exact: true }).fill("10");
    await panel.getByRole("button", { name: "Apply limits" }).click();
    await expect(panel.getByRole("alert")).toContainText("minimum less");
    await panel.getByLabel("C maximum", { exact: true }).fill("80");
    await editor.screenshot({ path: testInfo.outputPath("axis-limits.png") });
    await panel.getByRole("button", { name: "Apply limits" }).click();
    await expect(colorbar).toHaveAttribute("aria-label", /20 to 80/);
    await expect(panel.locator('[data-panel-slot="status"]')).not.toContainText(
      /mismatch|unknown|unavailable|failed/i,
    );
    await panel.screenshot({
      path: testInfo.outputPath("xy-color-bundle.png"),
    });
    await page.waitForTimeout(1000);
    await panel.screenshot({
      path: testInfo.outputPath("xy-color-settled.png"),
    });
    expect(errors).toEqual([]);
    expect(
      await page.locator("html").getAttribute("data-gpu-error"),
    ).toBeNull();
    await expect
      .poll(() =>
        page
          .locator("html")
          .getAttribute("data-gpu-colored-pixels")
          .then(Number),
      )
      .toBeGreaterThan(100);
    const workspacePath = join(directory, "session.autosave.json");
    await expect
      .poll(
        () => {
          try {
            return (
              JSON.parse(
                readFileSync(pathToFileURL(workspacePath), "utf8"),
              ) as Session
            ).tabs[0]?.panels[0]?.color_axis?.range;
          } catch {
            return null;
          }
        },
        { timeout: 20_000 },
      )
      .toEqual([20, 80]);
    const saved = JSON.parse(
      readFileSync(pathToFileURL(workspacePath), "utf8"),
    ) as Session;
    expect(saved.tabs[0]?.panels[0]?.x_range).toEqual([0, 10]);
    expect(saved.tabs[0]?.panels[0]?.y_range).toEqual([1, 8]);
    const snapshotPath = testInfo.outputPath("xy-color.html");
    await promisify(execFile)(
      join(root, "scripts/export.sh"),
      [
        "--no-build",
        ...paths.flatMap((path) => ["--data", path]),
        "--workspace",
        workspacePath,
        "--range",
        "all",
        "--fidelity",
        "full",
        "--out",
        snapshotPath,
      ],
      { cwd: root },
    );

    await panel.locator(".panel-x-axis").click();
    await panel.locator(".axis-picker input").fill("two/time");
    await panel.locator(".axis-picker input").press("Enter");
    await expect(panel.locator(".panel-x-axis")).toContainText("two/time");
    await expect(panel.locator(".panel-y-axis")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const offlineRequests: string[] = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) offlineRequests.push(request.url());
    });
    await page.goto(pathToFileURL(snapshotPath).href);
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
    await expect(page.locator(".colorbar-canvas")).toBeVisible();
    await expect(page.locator(".colorbar-canvas")).toHaveAttribute(
      "aria-label",
      /20 to 80/,
    );
    await expect(page.locator('[data-panel-slot="status"]')).not.toContainText(
      /mismatch|unknown|unavailable|failed/i,
    );
    expect(offlineRequests).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("xy-color-offline.png"),
    });
    await page.locator(".panel-c-axis").click();
    await page.locator(".axis-picker input").fill("none");
    await page.locator(".axis-picker input").press("Enter");
    await expect(page.locator(".colorbar-canvas")).toBeHidden();
    await expect(page.locator('[data-panel-slot="status"]')).not.toContainText(
      /mismatch|unknown|unavailable|failed/i,
    );
    expect(errors).toEqual([]);
  } finally {
    if (server.exitCode === null) {
      const exited = new Promise<void>((resolve) => {
        server.once("exit", resolve);
      });
      server.kill("SIGTERM");
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

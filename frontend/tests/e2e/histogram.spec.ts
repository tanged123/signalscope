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
  type HistogramResponse,
  type SourceSummary,
  type SnapshotManifest,
} from "../../src/generated/protocol";
import type { Envelope } from "../../src/app/envelope";
import { expect, test, addPanel, openPanelAxes } from "./fixtures";

test("histogram bins, local zoom, linked window, restore and exact offline capture", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const directory = mkdtempSync(join(tmpdir(), "signalscope-histogram-"));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const url = "http://127.0.0.1:43131";
  const server = spawn(
    join(root, "target/debug/scope-server"),
    ["--no-auth", "--no-open", "--port", "43131", "--data-dir", directory],
    { cwd: root, stdio: "ignore" },
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const workspacePath = join(directory, "session.autosave.json");
  const saved = (): Session =>
    JSON.parse(readFileSync(pathToFileURL(workspacePath), "utf8")) as Session;
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
    writeFileSync(path, "time,value\n0,0\n1,0\n2,1\n3,1\n4,2\n5,3\n");
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
    model.setLinkedWindow(0, 5);
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
        refs: [{ source_key: source.source_key, channel: "value" }],
      },
    ];
    writeFileSync(workspacePath, JSON.stringify(model.snapshot()));
    await page.goto(url);
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
    await addPanel(page.locator(".panel"), "Histogram");
    const histogram = page.locator('[data-panel-id="panel-2"]');
    await expect(histogram.locator(".panel-axes-value")).toContainText(
      "histogram",
    );
    await openPanelAxes(histogram);
    await expect(histogram.locator(".panel-x-axis")).toBeDisabled();
    await histogram.locator(".panel-y-axis").click();
    await histogram.locator(".axis-picker input").fill("run/value");
    const initial = page.waitForResponse(
      (reply) =>
        reply.url().includes("query_histogram") &&
        reply.ok() &&
        (reply.request().postDataJSON() as Envelope<{ signal_ids: string[] }>)
          .payload.signal_ids.length > 0,
    );
    await histogram.locator(".axis-picker input").press("Enter");
    await initial;
    await histogram.locator(".panel-histogram-bins").focus();
    await page.keyboard.press("Enter");
    const rebinned = page.waitForResponse(
      (reply) =>
        reply.url().includes("query_histogram") &&
        reply.ok() &&
        (reply.request().postDataJSON() as Envelope<{ bin_count: number }>)
          .payload.bin_count === 2,
    );
    await histogram
      .getByRole("menuitemradio", { name: "2", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    const distribution = (
      (await (await rebinned).json()) as Envelope<HistogramResponse>
    ).payload;
    expect(distribution.edges).toEqual([0, 1.5, 3]);
    expect(distribution.series[0]?.counts).toEqual(["4", "2"]);
    await expect(histogram.locator('[data-panel-slot="status"]')).toBeHidden();
    await expect(histogram.locator(".chart-host canvas").first()).toBeVisible();
    let histogramRequests = 0;
    page.on("request", (sent) => {
      if (sent.url().includes("query_histogram")) histogramRequests++;
    });
    const area = await histogram.locator(".chart-host").boundingBox();
    if (area === null) throw new Error("Missing histogram chart");
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await page.mouse.wheel(0, -200);
    await expect
      .poll(() => saved().tabs[0]?.panels[1]?.x_range != null)
      .toBe(true);
    expect(saved().linked_time.t0).toBe(0);
    expect(saved().linked_time.t1).toBe(5);
    expect(histogramRequests).toBe(0);
    const lineArea = await page
      .locator('[data-panel-id="panel-1"] .chart-host')
      .boundingBox();
    if (lineArea === null) throw new Error("Missing time chart");
    const linkedReply = page.waitForResponse(
      (reply) => reply.url().includes("query_histogram") && reply.ok(),
    );
    await page.mouse.move(
      lineArea.x + lineArea.width / 2,
      lineArea.y + lineArea.height / 2,
    );
    await page.mouse.wheel(0, -200);
    const latest = (
      (await (await linkedReply).json()) as Envelope<HistogramResponse>
    ).payload;
    expect(latest.window).not.toEqual(distribution.window);
    await expect
      .poll(() => ({ t0: saved().linked_time.t0, t1: saved().linked_time.t1 }))
      .toEqual(latest.window);
    await expect
      .poll(() => saved().tabs[0]?.panels[1]?.content)
      .toEqual({ kind: "histogram", bin_count: 2 });
    await page.reload();
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
    await expect(histogram.locator(".panel-histogram-bins-value")).toHaveText(
      "2",
    );
    await expect(histogram.locator('[data-panel-slot="status"]')).toBeHidden();
    await expect(
      page.locator('[data-panel-id="panel-1"] [data-panel-slot="status"]'),
    ).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("histogram-live.png") });
    const snapshot = testInfo.outputPath("histogram.html");
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
        "preview",
        "--out",
        snapshot,
      ],
      { cwd: root },
    );
    await page.waitForLoadState("networkidle");
    const network: string[] = [];
    page.on("request", (sent) => {
      if (/^https?:/.test(sent.url())) network.push(sent.url());
    });
    await page.goto(pathToFileURL(snapshot).href);
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
    await expect(histogram.locator(".panel-histogram-bins")).toBeDisabled();
    await expect(histogram.locator('[data-panel-slot="status"]')).toBeHidden();
    const manifest = JSON.parse(
      (await page.locator("#signalscope-baked-data").textContent()) ?? "null",
    ) as Envelope<SnapshotManifest>;
    expect(
      manifest.payload.histograms?.[0]?.response.series[0]?.counts,
    ).toEqual(latest.series[0]?.counts);
    expect(manifest.payload.histograms?.[0]?.response.window).toEqual(
      latest.window,
    );
    await page.screenshot({
      path: testInfo.outputPath("histogram-offline.png"),
    });
    expect(network).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

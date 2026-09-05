import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  type BatchJob,
  type BatchStatus,
} from "../../src/generated/protocol";
import type { Envelope } from "../../src/app/envelope";
import { expect, test } from "./fixtures";

test("live XY axes select unplotted time and source-paired bundles by keyboard", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
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
      writeFileSync(path, `time,x,y\n0,${String(index + 1)},3\n1,8,4\n2,2,6\n`);
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
    await page.goto(url);
    await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
    const panel = page.locator(".panel").first();
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
    await panel.locator(".panel-x-axis").click();
    await panel.locator(".axis-picker input").fill("one/time");
    await panel.locator(".axis-picker input").press("Enter");
    await expect(panel.locator(".panel-x-axis")).toContainText("one/time");
    await expect(panel.locator(".panel-y-axis")).toBeVisible();
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

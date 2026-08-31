import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../src/generated/protocol";

test("the packaged Electron workbench uses authenticated HttpPlane", async () => {
  const executablePath = process.env.SIGNALSCOPE_PACKAGED_BIN;
  if (executablePath === undefined) {
    test.skip(true, "packaged executable is not configured");
    return;
  }
  const userData = await mkdtemp(join(tmpdir(), "signalscope-package-"));
  const source = join(userData, "package-smoke.csv");
  await writeFile(source, "time,value\n0,1\n1,2\n");
  const electronBinary = process.env.SIGNALSCOPE_ELECTRON_BIN;
  const packagedApp = process.env.SIGNALSCOPE_PACKAGED_APP;
  const packagedResources = process.env.SIGNALSCOPE_PACKAGED_RESOURCES;
  const expectWebGpu = process.env.SIGNALSCOPE_EXPECT_WEBGPU !== "0";
  const usingElectronWrapper =
    electronBinary !== undefined && electronBinary.length > 0;
  const application = await electron.launch({
    executablePath: usingElectronWrapper ? electronBinary : executablePath,
    cwd: userData,
    args: [
      ...(usingElectronWrapper && packagedApp !== undefined
        ? [packagedApp]
        : []),
      ...(usingElectronWrapper && process.platform === "linux"
        ? ["--no-sandbox"]
        : []),
      `--user-data-dir=${userData}`,
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-angle=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      "--use-gpu-in-tests",
    ],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ...(packagedResources === undefined
        ? {}
        : { SIGNALSCOPE_RESOURCE_DIR: packagedResources }),
    },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.locator(".formula-toggle")).toBeVisible();
    if (expectWebGpu) await expect(page.locator(".gpu-warning")).toBeHidden();
    else await expect(page.locator(".gpu-warning")).toBeVisible();
    const state = await page.evaluate(
      async ({ source, protocolVersion }) => {
        const post = async <T>(
          command: string,
          payload: unknown,
        ): Promise<T> => {
          const response = await fetch(`/api/${command}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              protocol_version: protocolVersion,
              payload,
            }),
          });
          if (!response.ok)
            throw new Error(`${command}: ${String(response.status)}`);
          return ((await response.json()) as { payload: T }).payload;
        };
        const batch = await post<{ job_id: string }>("ingest_batch", {
          paths: [source],
        });
        let completed = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const status = await post<{ state: string }>("batch_status", {
            job_id: batch.job_id,
          });
          if (status.state === "done") {
            completed = true;
            break;
          }
          if (status.state === "failed" || status.state === "cancelled")
            throw new Error(`ingest ${status.state}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!completed) throw new Error("ingest timed out");
        const signals = await post<unknown[]>("list_signals", null);
        return {
          host: location.hostname,
          protocol: location.protocol,
          ingested: signals.length > 0,
          gpu: typeof navigator.gpu,
          node: typeof (globalThis as { process?: unknown }).process,
        };
      },
      { source, protocolVersion: PROTOCOL_VERSION },
    );
    expect(state).toMatchObject({
      host: "127.0.0.1",
      protocol: "http:",
      ingested: true,
      node: "undefined",
    });
    if (expectWebGpu) expect(state.gpu).toBe("object");
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

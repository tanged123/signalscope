import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const serverUrl = "http://127.0.0.1:43118";
let server: ChildProcess | undefined;
let dataDirectory: string | undefined;

test.beforeAll(async () => {
  // The wrapper builds once before Playwright starts so compilation does not
  // contend with the parallel browser workers. `cargo run` still builds when
  // this file is invoked directly.
  test.setTimeout(600_000);
  dataDirectory = mkdtempSync(join(tmpdir(), "signalscope-live-"));
  server = spawn(
    "cargo",
    [
      "run",
      "-p",
      "scope-server",
      "--",
      "--no-auth",
      "--no-open",
      "--port",
      "43118",
      "--data-dir",
      dataDirectory,
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "ignore", "inherit"] },
  );
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const response = await fetch(`${serverUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("scope-server did not become healthy");
});

test.afterAll(() => {
  server?.kill("SIGTERM");
  if (dataDirectory !== undefined)
    rmSync(dataDirectory, { recursive: true, force: true });
});

test("the browser selects HttpPlane when scope-server is live", async ({
  page,
}) => {
  await page.goto(`${serverUrl}/`);

  await expect(page.locator(".formula-toggle")).toBeVisible();
  await expect(page.locator(".gpu-warning")).toBeHidden();
});

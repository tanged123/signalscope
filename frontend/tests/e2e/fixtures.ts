import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  devices,
  expect,
  test as base,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type { Envelope } from "../../src/app/envelope";
import { WorkspaceModel } from "../../src/app/workspace";
import {
  PROTOCOL_VERSION,
  type BatchJob,
  type BatchStatus,
  type SourceSummary,
} from "../../src/generated/protocol";
import type { SeriesRef, Session } from "../../src/generated/session";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export interface Server {
  url: string;
  /** Session, preferences and cache directory. */
  dataDir: string;
  /** Every file dialog picks from, and saves into, this directory. */
  dialogs: string;
}

interface Fixtures {
  server: Server;
}

let serversStarted = 0;

/**
 * Each test gets a fresh browser (SwiftShader WebGPU devices do not survive
 * reuse reliably) and its own scope-server built by `./scripts/test.sh e2e`.
 */
export const test = base.extend<Fixtures>({
  page: async ({ playwright }, use, testInfo) => {
    const browser = await playwright.chromium.launch({
      ...testInfo.project.use.launchOptions,
      headless: testInfo.project.use.headless ?? true,
    });
    const { defaultBrowserType, ...desktop } = devices["Desktop Chrome"];
    void defaultBrowserType;
    try {
      const context = await browser.newContext({
        ...desktop,
        viewport: testInfo.project.use.viewport ?? desktop.viewport,
        // The bench project serves its fixture page from Vite.
        ...(testInfo.project.use.baseURL === undefined
          ? {}
          : { baseURL: testInfo.project.use.baseURL }),
      });
      await use(await context.newPage());
    } finally {
      await browser.close();
    }
  },
  server: async ({ request }, use, testInfo) => {
    // Workers run tests sequentially, so worker index plus a per-worker
    // counter gives every server its own port.
    serversStarted += 1;
    const port = 43200 + testInfo.parallelIndex * 100 + (serversStarted % 100);
    const url = `http://127.0.0.1:${String(port)}`;
    const dataDir = mkdtempSync(join(tmpdir(), "signalscope-e2e-"));
    const dialogs = join(dataDir, "dialogs");
    mkdirSync(dialogs);
    const child = spawn(
      join(root, "target/debug/scope-server"),
      [
        "--no-auth",
        "--no-open",
        "--port",
        String(port),
        "--data-dir",
        dataDir,
        "--dialog-dir",
        dialogs,
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
    );
    try {
      await expect
        .poll(
          async () => {
            if (child.exitCode !== null) throw new Error("scope-server exited");
            return request
              .get(`${url}/api/health`)
              .then((response) => response.ok())
              .catch(() => false);
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      await use({ url, dataDir, dialogs });
    } finally {
      // The server shuts down gracefully and may still write session files.
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child.once("exit", resolve),
        );
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
});

export { expect };

/** Writes a deterministic run: two time signals and an XY pair. */
export function writeRun(path: string, rows: number, phase = 0): void {
  const lines = ["time,a,b,x,y"];
  for (let index = 0; index < rows; index += 1) {
    const t = (index * 20) / rows;
    lines.push(
      [
        t,
        Math.sin(t * 3 + phase),
        Math.cos(t * 2) * 0.5,
        Math.sin(t * 1.3) * 5,
        Math.cos(t * 0.7) * 4,
      ].join(","),
    );
  }
  writeFileSync(path, lines.join("\n"));
}

async function post<T>(
  request: APIRequestContext,
  server: Server,
  endpoint: string,
  payload?: unknown,
): Promise<T> {
  const response = await request.post(`${server.url}/api/${endpoint}`, {
    data:
      payload === undefined
        ? undefined
        : { protocol_version: PROTOCOL_VERSION, payload },
  });
  expect(response.ok(), `${endpoint}: ${await response.text()}`).toBe(true);
  return ((await response.json()) as Envelope<T>).payload;
}

/** Imports files through the server API and returns every source. */
export async function ingest(
  request: APIRequestContext,
  server: Server,
  paths: string[],
): Promise<SourceSummary[]> {
  const job = await post<BatchJob>(request, server, "ingest_batch", { paths });
  await expect
    .poll(
      async () =>
        (await post<BatchStatus>(request, server, "batch_status", job)).state,
      { timeout: 60_000 },
    )
    .toBe("done");
  return post<SourceSummary[]>(request, server, "list_sources");
}

/**
 * A workspace with one panel of each plot type over `source`: time lines,
 * XY scatter, a histogram and an XY line.
 */
export function fourPanelSession(sources: SourceSummary[]): Session {
  const source = sources[0];
  if (source === undefined) throw new Error("no source was imported");
  const ref = (channel: string): SeriesRef => ({
    source_key: source.source_key,
    channel,
  });
  const pick = (...channels: string[]) => ({
    kind: "pick" as const,
    selector: null,
    set_id: null,
    refs: channels.map(ref),
  });
  const model = new WorkspaceModel();
  model.setLinkedWindow(0, 20);
  for (const entry of sources)
    model.addSource({
      key: entry.source_key,
      path: entry.path,
      prefix: entry.prefix,
      provider_id: null,
      decode_provenance: null,
      recipe_id: null,
      recipe_digest: null,
    });
  const line = model.addPanelRow();
  line.title = "line";
  line.bindings =
    sources.length > 1
      ? [{ kind: "query", selector: "a @*", refs: [], set_id: null }]
      : [pick("a", "b")];
  const scatter = model.splitPanelRight(line.id, { kind: "scatter2d" });
  const histogram = model.splitPanelDown(line.id, {
    kind: "histogram",
    bin_count: 32,
  });
  if (scatter === null || histogram === null)
    throw new Error("panel split failed");
  const xy = model.splitPanelRight(histogram.id, { kind: "line2d" });
  if (xy === null) throw new Error("panel split failed");
  scatter.title = "scatter";
  scatter.bindings = [pick("y")];
  scatter.x_axis = { kind: "signal", ref: ref("x") };
  histogram.title = "histogram";
  histogram.bindings = [pick("a")];
  xy.title = "xy";
  xy.bindings = [pick("y")];
  xy.x_axis = { kind: "signal", ref: ref("x") };
  return model.snapshot() as Session;
}

/** Makes `session` the autosave the server restores on the next page load. */
export function seedSession(server: Server, session: Session): void {
  writeFileSync(
    join(server.dataDir, "session.autosave.json"),
    JSON.stringify(session),
  );
}

/** Collects uncaught page errors; tests assert the list stays empty. */
export function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

export async function openWorkbench(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("#app")).toHaveAttribute("data-ready", "true", {
    timeout: 30_000,
  });
}

export function panel(page: Page, title: string): Locator {
  return page.getByRole("article", { name: `${title} panel` });
}

/** Runs one File ▸ Export command through the export dialog. */
export async function exportFrom(
  page: Page,
  command: RegExp,
  choose?: string,
): Promise<void> {
  await page.getByRole("button", { name: "Application menu" }).click();
  await page.getByRole("menuitem", { name: command }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  if (choose !== undefined)
    await dialog.getByRole("button", { name: choose }).click();
  const confirm = dialog.getByRole("button", { name: /^Export/ });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
}

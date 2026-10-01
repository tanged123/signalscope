import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { defaultPreferences } from "../../src/app/preferences";
import {
  expect,
  exportFrom,
  fourPanelSession,
  ingest,
  openWorkbench,
  pageErrors,
  panel,
  seedSession,
  test,
  writeRun,
} from "./fixtures";
import { compareFrames, installPlotReadback, plotFrame } from "./plot-pixels";

const TITLES = ["line", "scatter", "histogram", "xy"] as const;

async function frames(page: Page): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const title of TITLES) {
    const target = panel(page, title);
    await expect
      .poll(() => plotFrame(target), { timeout: 30_000 })
      .not.toBeNull();
    result[title] = (await plotFrame(target)) ?? "";
  }
  return result;
}

function file(directory: string, name: string): Buffer {
  return Buffer.from(readFileSync(pathToFileURL(join(directory, name))));
}

test("an HTML snapshot reproduces every plot type offline", async ({
  page,
  request,
  server,
}, testInfo) => {
  test.setTimeout(180_000);
  const data = join(server.dataDir, "run.csv");
  // Dense enough that every panel is decimated in both the live view and
  // the snapshot, so the export's default fidelity is what is under test.
  writeRun(data, 100_000);
  const session = fourPanelSession(await ingest(request, server, [data]));
  const line = session.tabs[0]?.panels.find((entry) => entry.title === "line");
  if (line !== undefined) line.line_width = 3;
  seedSession(server, session);
  // Non-default appearance must travel with the snapshot.
  writeFileSync(
    join(server.dataDir, "preferences.json"),
    JSON.stringify({
      ...defaultPreferences(),
      theme: "light",
      plot_line_width_scale: 1.75,
      color_palette: "custom",
      custom_color_palette: ["#7a1fa2", "#00897b"],
    }),
  );
  const errors = pageErrors(page);
  await installPlotReadback(page);
  await openWorkbench(page, server.url);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const live = await frames(page);

  await exportFrom(page, /HTML Snapshot/);
  const html = readdirSync(server.dialogs).find((name) =>
    name.endsWith(".html"),
  );
  expect(html).toBeDefined();

  const offline = await page.context().newPage();
  const offlineErrors = pageErrors(offline);
  const network: string[] = [];
  offline.on("request", (sent) => {
    if (/^https?:/.test(sent.url())) network.push(sent.url());
  });
  await installPlotReadback(offline);
  await offline.goto(pathToFileURL(join(server.dialogs, html ?? "")).href);
  await expect(offline.locator("#app")).toHaveAttribute("data-ready", "true");
  await expect(offline.locator("html")).toHaveAttribute("data-theme", "light");
  const exported = await frames(offline);
  for (const title of TITLES) {
    const comparison = await compareFrames(
      offline,
      live[title] ?? "",
      exported[title] ?? "",
    );
    await testInfo.attach(`${title}.json`, {
      body: JSON.stringify(comparison),
      contentType: "application/json",
    });
    expect(comparison.inkA, `${title} drew nothing live`).toBeGreaterThan(500);
    expect(comparison.overlap, `${title} placement`).toBeGreaterThan(0.98);
    expect(
      comparison.inkB / comparison.inkA,
      `${title} stroke/marker coverage`,
    ).toBeGreaterThan(0.85);
    expect(comparison.inkB / comparison.inkA).toBeLessThan(1.15);
  }
  expect(network).toEqual([]);
  expect([...errors, ...offlineErrors]).toEqual([]);
});

test("PNG and CSV export every plot type", async ({
  page,
  request,
  server,
}) => {
  test.setTimeout(180_000);
  const data = join(server.dataDir, "run.csv");
  writeRun(data, 2_000);
  seedSession(server, fourPanelSession(await ingest(request, server, [data])));
  const errors = pageErrors(page);
  await openWorkbench(page, server.url);

  for (const title of TITLES) {
    await panel(page, title).getByText(title, { exact: true }).first().click();
    await exportFrom(page, /PNG/);
    await exportFrom(page, /CSV/);
    const png = file(server.dialogs, `${title}.png`);
    expect(png.readUInt32BE(16), `${title}.png width`).toBeGreaterThan(200);
    expect(png.readUInt32BE(20), `${title}.png height`).toBeGreaterThan(200);
    const url = `data:image/png;base64,${png.toString("base64")}`;
    const { inkA } = await compareFrames(page, url, url);
    expect(inkA, `${title}.png is blank`).toBeGreaterThan(500);
    const csv = file(server.dialogs, `${title}.csv`)
      .toString("utf8")
      .trim()
      .split("\n");
    expect(csv.length, `${title}.csv rows`).toBeGreaterThan(10);
    // XY panels need their X column to be reproducible from the CSV.
    if (title === "scatter" || title === "xy")
      expect(csv[0], `${title}.csv header`).toContain("run/x");
  }

  await exportFrom(page, /PNG/, "all panels");
  const all = readdirSync(server.dialogs).filter((name) =>
    name.startsWith("Workspace 1-"),
  );
  expect(all.sort()).toEqual(
    TITLES.map((title) => `Workspace 1-${title}.png`).sort(),
  );
  expect(errors).toEqual([]);
});

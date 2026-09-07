import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { SnapshotManifest } from "../../src/generated/protocol";
import { SESSION_SCHEMA_VERSION } from "../../src/generated/session";
import type { Envelope } from "../../src/app/envelope";
import { seal } from "../../src/app/envelope";
import {
  defaultPreferences,
  snapshotPreferences,
} from "../../src/app/preferences";
import { expect, test } from "./fixtures";

const artifacts = {
  preview: new URL(
    "../../../build/export/roundtrip-preview.html",
    import.meta.url,
  ),
  full: new URL("../../../build/export/roundtrip-full.html", import.meta.url),
} as const;

function bakedManifest(artifact: URL): SnapshotManifest {
  const html = readFileSync(artifact, "utf8");
  const match = html.match(
    /<script id="signalscope-baked-data"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (match?.[1] === undefined) throw new Error("snapshot payload is missing");
  return (JSON.parse(match[1]) as Envelope<SnapshotManifest>).payload;
}

test.describe("exported snapshot round trip", () => {
  for (const scale of [0.75, 1.75]) {
    test(`restores ${String(scale * 100)}% stroke appearance offline`, async ({
      page,
    }, testInfo) => {
      const manifest = bakedManifest(artifacts.full);
      manifest.preferences_json = snapshotPreferences({
        ...defaultPreferences(),
        ui_font_family: "arimo",
        plot_font_family: "dejavu",
        ui_font_size: 15,
        plot_font_size: 12.5,
        plot_line_width_scale: scale,
      });
      const html = readFileSync(artifacts.full, "utf8").replace(
        /(<script id="signalscope-baked-data"[^>]*>)[\s\S]*?(<\/script>)/,
        (_match, start: string, end: string) =>
          start +
          JSON.stringify(seal(manifest)).replaceAll("<", "\\u003c") +
          end,
      );
      const path = testInfo.outputPath("appearance.html");
      writeFileSync(path, html);
      const requests: string[] = [];
      page.on("request", (request) => {
        if (/^https?:/.test(request.url())) requests.push(request.url());
      });
      await page.goto(pathToFileURL(path).href);
      await expect(page.locator("#app")).toHaveAttribute("data-ready", "true");
      await expect(
        page.locator(".chart-host canvas:not(.colorbar-canvas)").first(),
      ).toBeVisible();
      await expect(page.locator(".gpu-warning")).toBeHidden();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      expect(
        await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement);
          return {
            scale: style.getPropertyValue("--plot-line-width-scale"),
            plotSize: style.getPropertyValue("--plot-font-size"),
            uiSize: style.fontSize,
            uiFont: style.getPropertyValue("--font-ui"),
            plotFont: style.getPropertyValue("--font-plot"),
          };
        }),
      ).toEqual({
        scale: String(scale),
        plotSize: "12.5",
        uiSize: "15px",
        uiFont: expect.stringContaining("Arimo"),
        plotFont: expect.stringContaining("DejaVu Sans"),
      });
      await page
        .locator(".plot-stat-row .plot-row-inspector-toggle")
        .first()
        .click();
      await expect(
        page.getByRole("slider", { name: "Line width", exact: true }),
      ).toHaveValue("1.5");
      expect(requests).toEqual([]);
    });
  }

  for (const [fidelity, artifact] of Object.entries(artifacts)) {
    test(`${fidelity} restores session state and data by value`, async ({
      page,
    }) => {
      const networkRequests: string[] = [];
      page.on("request", (request) => {
        if (/^https?:/.test(request.url())) networkRequests.push(request.url());
      });
      await page.goto(artifact.href);

      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.locator(".workspace-tab.active")).toContainText(
        "Roundtrip",
      );
      const panel = page.locator(".panel");
      await expect(page.locator(".workspace-name")).toHaveText(
        "Roundtrip review",
      );
      await expect(panel).toHaveCount(1);
      await expect(panel.locator(".panel-title")).toHaveText("Alpha & Beta");
      await expect(panel.locator(".binding-chip")).toHaveText([
        "alpha ×1",
        "beta ×1",
      ]);
      await expect(panel.locator(".panel-annotations")).toHaveCount(0);
      await expect(
        panel.locator(".plot-legend-tips-heading button").first(),
      ).toHaveAttribute("aria-expanded", "true");
      await expect(panel.locator(".plot-tip-row")).toHaveCount(1);
      const session = JSON.parse(bakedManifest(artifact).session_json) as {
        tabs: Array<{
          panels: Array<{ annotations: Array<{ label: string }> }>;
        }>;
      };
      expect(session.tabs[0]?.panels[0]?.annotations[0]?.label).toBe("peak");
      await expect(page.locator(".window-readout")).toHaveText(
        "window 0.000 → 7.500 s",
      );
      const stats = panel.locator(".plot-legend-stats");
      await expect(stats).toBeVisible();
      const betaStats = stats
        .locator(".plot-stat-row")
        .filter({ hasText: "roundtrip/beta" });
      await expect(
        betaStats.locator('.plot-stat-cell[data-column="max"]'),
      ).toContainText("8");
      await expect(
        betaStats.locator('.plot-stat-cell[data-column="min"]'),
      ).toContainText("0.5");
      await expect(panel.locator(".panel-stats")).toHaveCount(0);
      expect(networkRequests).toEqual([]);
    });
  }

  test("preview materially reduces the signals payload", () => {
    const preview = JSON.stringify(
      bakedManifest(artifacts.preview).signals,
    ).length;
    const signals = bakedManifest(artifacts.full).signals;
    const full = JSON.stringify(signals).length;
    expect(preview).toBeLessThan(full / 2);
    // Time is now retained alongside alpha and beta, with the same per-signal budget.
    expect(signals).toHaveLength(3);
    expect(full).toBeLessThan(3_000_000);
  });

  test("rejects an unsupported session instead of partially restoring", async ({
    page,
  }) => {
    const html = readFileSync(artifacts.full, "utf8");
    const malformed = html.replace(
      `\\"schema_version\\":${String(SESSION_SCHEMA_VERSION)}`,
      '\\"schema_version\\":999',
    );
    expect(malformed).not.toBe(html);

    await page.setContent(malformed);

    await expect(page.locator("#app")).toHaveText(
      /SignalScope failed to start: snapshot session schema 999/,
    );
    await expect(page.locator(".panel")).toHaveCount(0);
  });
});

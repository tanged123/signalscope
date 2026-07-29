import { readFileSync } from "node:fs";

import type { SnapshotManifest } from "../../src/generated/protocol";
import { SESSION_SCHEMA_VERSION } from "../../src/generated/session";
import type { Envelope } from "../../src/app/envelope";
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
      await expect(panel).toHaveCount(1);
      await expect(panel.locator(".panel-title")).toHaveText("Alpha & Beta");
      await expect(panel.locator(".legend-name")).toHaveText([
        "roundtrip/alpha",
        "roundtrip/beta",
      ]);
      await expect(panel.locator(".annotation-row")).toContainText("peak");
      await expect(page.locator(".window-readout")).toHaveText(
        "window 0.000 → 7.500 s",
      );
      const stats = panel.locator(".panel-stats");
      await expect(stats).toBeVisible();
      await expect(stats).toContainText("max8.0000");
      await expect(stats).toContainText("min0.5000");
      expect(networkRequests).toEqual([]);
    });
  }

  test("preview materially reduces the signals payload", () => {
    const preview = JSON.stringify(
      bakedManifest(artifacts.preview).signals,
    ).length;
    const full = JSON.stringify(bakedManifest(artifacts.full).signals).length;
    expect(preview).toBeLessThan(full / 2);
    expect(full).toBeLessThan(2_000_000);
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

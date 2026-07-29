import { readFileSync } from "node:fs";

import { SESSION_SCHEMA_VERSION } from "../../src/generated/session";
import { expect, test } from "./fixtures";

const artifact = new URL(
  "../../../build/export/roundtrip.html",
  import.meta.url,
);

test.describe("exported snapshot round trip", () => {
  test("restores session state and data by value", async ({ page }) => {
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
  });

  test("stays under the export size ceiling", () => {
    const bytes = new TextEncoder().encode(
      readFileSync(artifact, "utf8"),
    ).length;
    expect(bytes).toBeLessThan(2_000_000);
  });

  test("rejects an unsupported session instead of partially restoring", async ({
    page,
  }) => {
    const html = readFileSync(artifact, "utf8");
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

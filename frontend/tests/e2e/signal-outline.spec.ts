import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { PROTOCOL_VERSION } from "../../src/generated/protocol";
import { SESSION_SCHEMA_VERSION } from "../../src/generated/session";

async function installDerivedPlane(page: Page): Promise<void> {
  await page.addInitScript(
    ({ protocolVersion, sessionSchemaVersion }) => {
      const envelope = <T>(payload: T) => ({
        protocol_version: protocolVersion,
        payload,
      });
      const base = {
        source_id: "0",
        source_key: "demo",
        unit: null,
        point_count: "2",
        t_min: 0,
        t_max: 1,
        last_value: null,
      };
      let signals = [
        {
          ...base,
          signal_id: "1",
          local_path: "velocity_body/x",
          path: "rocket/velocity_body/x",
        },
        {
          ...base,
          signal_id: "2",
          local_path: "velocity_body/y",
          path: "rocket/velocity_body/y",
        },
      ];
      const session = JSON.stringify({
        app: "signalscope",
        schema_version: sessionSchemaVersion,
        theme: "dark",
        linked_time: {
          t0: 0,
          t1: 1,
          linked: true,
          paused: false,
          cursorT: null,
          mode: "fixed",
        },
        active_tab_id: "workspace-1",
        tabs: [
          {
            id: "workspace-1",
            title: "Workspace 1",
            cursor_mode: "none",
            focused_panel_id: null,
            maximized_panel_id: null,
            panels: [],
            layout: [],
          },
        ],
        named_sets: [],
        derived: [],
        derived_bundles: [],
        sources: [],
      });
      const bridge = {
        connect: () =>
          Promise.resolve({
            transportVersion: 1 as const,
            baseUrl: "http://127.0.0.1:43817",
            token: "A".repeat(43),
            protocolVersion,
          }),
        pickSources: () => Promise.resolve([]),
        pickSourceFolder: () => Promise.resolve(null),
        pickSession: () => Promise.resolve(null),
        pickExportFile: () => Promise.resolve(null),
        pickDirectory: () => Promise.resolve(null),
        onDragDrop: () => () => undefined,
        gpuInfo: () =>
          Promise.resolve({
            electron: "43",
            chromium: "150",
            os: "test",
            featureStatus: {},
            adapter: { vendor: "", device: "", description: "" },
            gpu: {},
            softwareRendering: true,
            gpuMode: "software" as const,
          }),
      };
      window.scopeDesktop = bridge;
      window.fetch = (input, init) => {
        const url =
          input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : input;
        const path = new URL(url).pathname;
        const payload =
          typeof init?.body === "string"
            ? ((JSON.parse(init.body) as { payload?: Record<string, unknown> })
                .payload ?? {})
            : {};
        const request = path.endsWith("/signals")
          ? signals
          : path.endsWith("/formats")
            ? [{ id: "csv", label: "CSV", extensions: ["csv"] }]
            : path.endsWith("/sources")
              ? [
                  {
                    source_id: "0",
                    source_key: "demo",
                    prefix: "rocket",
                    path: "fixture.csv",
                    point_count: "4",
                  },
                ]
              : path.endsWith("/session/load") ||
                  path.endsWith("/session/reset")
                ? { session_json: session, path: null }
                : path.endsWith("/session/save")
                  ? "test.signalscope"
                  : path.endsWith("/derived/create")
                    ? (() => {
                        const derivedPath = String(payload["path"]);
                        const summary = {
                          ...base,
                          signal_id: `derived:${derivedPath}`,
                          source_id: "derived",
                          source_key: "derived",
                          local_path: derivedPath.slice("derived/".length),
                          path: derivedPath,
                          point_count: "0",
                        };
                        signals = [...signals, summary];
                        return summary;
                      })()
                    : path.endsWith("/derived/remove")
                      ? (() => {
                          signals = signals.filter(
                            (signal) => signal.path !== String(payload["path"]),
                          );
                          return null;
                        })()
                      : null;
        return Promise.resolve(
          new Response(JSON.stringify(envelope(request)), { status: 200 }),
        );
      };
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      sessionSchemaVersion: SESSION_SCHEMA_VERSION,
    },
  );
}

test("the fixed channel outline filters, selects, and saves a frozen set", async ({
  page,
}) => {
  await page.goto("/");

  const outline = page.locator(".outline-scroll");
  await expect(outline).toBeVisible();
  await expect(outline).toHaveAttribute("data-cols", "channel,value");
  await expect(
    outline.locator('.signal-outline-header [data-column="channel"]'),
  ).toHaveText("CHANNEL");
  await expect(
    outline.locator('.signal-outline-header [data-column="value"]'),
  ).toHaveText("VALUE");
  await expect(outline.locator('[data-column="unit"]')).toHaveCount(0);
  await expect(outline.locator('[data-column="source"]')).toHaveCount(0);
  await expect(page.locator(".signal-group-select")).toHaveCount(0);
  await expect(page.locator(".outline-columns-button")).toHaveCount(0);
  await expect(outline.locator('[data-row-kind="series"]')).toHaveCount(2);

  await page.locator(".signal-search").fill("velocity_body/x");
  await expect(outline.locator('[data-row-kind="series"]')).toHaveCount(1);
  await outline.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.locator(".sets-save-selection")).toBeEnabled();

  await page.locator(".sets-save-selection").click();
  await page.locator(".set-name-input").fill("all velocity");
  await page.locator(".set-name-input").press("Enter");
  await expect(
    page.locator(".tree-set", { hasText: "all velocity" }),
  ).toContainText("▣ 1");
  await expect(page.locator(".sets-save-selection")).toBeEnabled();
  await expect(page.locator(".bulk-bar")).toHaveCount(0);
});

test("manual sets support F and selected-signal drops", async ({ page }) => {
  await page.goto("/");
  const row = page.locator('.outline-scroll [data-row-kind="series"]').first();
  await row.click();
  await expect(row).toHaveClass(/selected/);

  await page.keyboard.press("f");
  await expect(page.locator(".set-name-input")).toBeFocused();
  await page.locator(".set-name-cancel").click();
  await expect(page.locator(".set-name-row")).toBeHidden();

  const sets = page.locator(".tree-sets");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer });
  await sets.dispatchEvent("dragover", { dataTransfer });
  await expect(sets).toHaveClass(/drop-target/);
  await sets.dispatchEvent("drop", { dataTransfer });
  await expect(sets).not.toHaveClass(/drop-target/);

  await page.locator(".set-name-input").fill("manual velocity");
  await page.locator(".set-name-input").press("Enter");
  await expect(
    page.locator(".tree-set", { hasText: "manual velocity" }),
  ).toContainText("▣ 1");
});

test("catalog reload clears selection for a removed derived signal", async ({
  page,
}) => {
  await installDerivedPlane(page);
  await page.goto("/");
  await page.locator(".formula-toggle").click();
  const formula = page.locator(".formula-input");
  await formula.fill("derived/transient = 'rocket/velocity_body/x' * 2");
  await formula.press("Enter");

  const derived = page.locator('[data-path="derived/transient"]');
  await expect(derived).toBeVisible();
  await derived.click();
  await expect(page.locator(".sets-save-selection")).toBeEnabled();
  await derived.locator(".outline-derived-remove").click();
  await expect(derived).toHaveCount(0);
  await expect(page.locator(".sets-save-selection")).toBeDisabled();
});

test("a new workspace tab starts without outline selection", async ({
  page,
}) => {
  await page.goto("/");
  const row = page.locator('.outline-scroll [data-row-kind="series"]').first();
  await row.click();
  await expect(row).toHaveClass(/selected/);
  await expect(page.locator(".sets-save-selection")).toBeEnabled();

  await page.locator(".workspace-tab-add").click();
  await expect(page.locator(".signal-outline-row.selected")).toHaveCount(0);
  await expect(page.locator(".sets-save-selection")).toBeDisabled();
});

test("VALUE stays blank until the cursor is active over a plot", async ({
  page,
}) => {
  await page.goto("/");
  const values = page.locator(
    '.outline-scroll [data-row-kind="series"] [data-column="value"]',
  );
  await expect(values).toHaveCount(2);
  await expect(values.first()).toHaveText("");
  await expect(values.last()).toHaveText("");

  await page.keyboard.press("c");
  await page
    .locator(".panel")
    .first()
    .locator(".overlay-canvas")
    .hover({ position: { x: 300, y: 120 } });
  await expect
    .poll(async () =>
      values.evaluateAll((cells) =>
        cells.some((cell) => cell.textContent.trim() !== ""),
      ),
    )
    .toBe(true);

  await page.keyboard.press("c");
  await page.keyboard.press("c");
  await expect(values.first()).toHaveText("");
  await expect(values.last()).toHaveText("");
});

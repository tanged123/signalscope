import type {
  ExportDelegate,
  ExportDialog as ExportDialogInstance,
} from "../../src/ui/export-dialog";
import type { ExportEstimateEntry } from "../../src/generated/protocol";
import { expect, test } from "./fixtures";

type ExportDialogConstructor = new (
  root: HTMLElement,
  delegate: ExportDelegate,
) => ExportDialogInstance;

test("shared presentation plane renders the demo workspace", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByText("SIGNALSCOPE")).toBeVisible();
  await expect(page.locator(".menu-bar")).toHaveCount(0);
  await expect(page.locator(".tool-bar")).toHaveCount(0);
  await expect(page.locator(".title-bar")).toBeVisible();
  await expect(page.locator(".dock-toggles > button").first()).toHaveClass(
    /tree-toggle/,
  );
  await expect(page.locator(".workspace-tabs")).toBeVisible();
  await expect(page.locator(".new-panel")).toHaveCount(0);
  await expect(page.locator(".formula-bar")).toBeHidden();
  await expect(page.locator(".formula-toggle")).toBeHidden();
  await expect(page.locator(".panel-split-right")).toBeVisible();
  await expect(page.locator(".panel-split-down")).toBeVisible();
  await expect(page.getByLabel("Panel 1 panel")).toBeVisible();
  await expect(page.locator(".legend-chip")).toHaveCount(2);
  for (const name of await page.locator(".legend-name").allTextContents()) {
    expect(name.trim()).not.toBe("");
  }
  await expect(page.locator(".plot-canvas").first()).toBeVisible();
  await expect(page.locator(".render-ms")).not.toHaveText("— ms");
  await expect(page.locator(".session-identity")).toContainText(
    "baked demo source",
  );
  await expect(page.locator(".open-files")).toHaveCount(0);
  await expect(page.locator(".cursor-mode")).toBeEmpty();
  await expect(page.locator(".plot-tip")).toBeHidden();
  // The mod glyph follows the platform running the browser, so the expectation
  // is derived the same way rather than pinned to a macOS-only "⌘".
  const mod = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(navigator.userAgent) ? "⌘" : "Ctrl+",
  );
  await expect(page.locator(".palette-hints")).toHaveText(
    `${mod}P signals${mod}⇧P commands`,
  );
});

test("theme is a pure token swap", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("t");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Panel 1 panel")).toBeVisible();
});

test("application menu mirrors commands and marks planned work", async ({
  page,
}) => {
  await page.goto("/");
  const button = page.locator(".menu-button");
  await button.click();
  const menu = page.locator(".app-menu");
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const unavailable = menu.locator(".app-menu-item", {
    hasText: "Open Workspace",
  });
  const newWorkspace = menu.getByRole("menuitem", {
    name: "New Workspace Ctrl+N",
    exact: true,
  });
  await expect(newWorkspace).toHaveAttribute("aria-disabled", "true");
  await expect(newWorkspace).toContainText("Ctrl+N");
  await expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await expect(unavailable).toContainText("Ctrl+O");
  await unavailable.dispatchEvent("click");
  await expect(menu).toBeVisible();
  for (const title of [
    "Export ▸ HTML Snapshot…",
    "Export ▸ PNG…",
    "Export ▸ Visible CSV…",
  ]) {
    await expect(
      menu.locator(".app-menu-item", { hasText: title }),
    ).toHaveAttribute("aria-disabled", "true");
  }

  // Opening focuses the first item; the roving arrow keys wrap in both
  // directions and Home/End reach the ends.
  const items = menu.locator(".app-menu-item");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();

  // Single-key commands belong to the workbench, not to the open menu: typing
  // in the popover must not toggle the theme behind it.
  await page.keyboard.press("t");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(menu).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.locator(".palette-input").fill("Open Workspace");
  const unavailableRow = page.locator(".palette-row", {
    hasText: "Open Workspace",
  });
  await expect(unavailableRow).toBeDisabled();
  await expect(unavailableRow).toHaveAttribute(
    "title",
    "unavailable in this context",
  );
});

test("tabbing out of the application menu dismisses it", async ({ page }) => {
  await page.goto("/");
  await page.locator(".menu-button").click();
  const menu = page.locator(".app-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();
  await expect(page.locator(".menu-button")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  // Focus returns to the trigger before Tab's default action runs, so the
  // browser resumes from the menu button instead of dropping focus to the body.
  await expect(page.locator(".menu-button")).not.toBeFocused();
  await expect(page.locator("body")).not.toBeFocused();
});

test("export dialog is modal and restores focus after a document Escape", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const moduleUrl = "/src/ui/export-dialog.ts";
    const { ExportDialog } = (await import(moduleUrl)) as {
      ExportDialog: ExportDialogConstructor;
    };
    const invoker = document.createElement("button");
    invoker.dataset.testid = "export-invoker";
    document.body.appendChild(invoker);
    invoker.focus();
    const dialog = new ExportDialog(document.body, {
      estimateHtml: () =>
        Promise.resolve({
          entries: [
            {
              range: "visible",
              fidelity: "standard",
              bytes: "100",
              series_total: "2",
              series_decimated: "1",
              series_full_rate: "1",
              coarsest_ratio: "4",
            },
          ],
        }),
      pngBytes: () => Promise.resolve(100),
      csvEstimate: () => Promise.resolve({ bytes: 100, rows: 10, stride: 2 }),
      runExport: () => Promise.resolve(),
    });
    dialog.open("html");
  });

  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("export-invoker")).toBeFocused();
});

test("export dialog exposes range, fidelity, and reduction consequences", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const moduleUrl = "/src/ui/export-dialog.ts";
    const { ExportDialog } = (await import(moduleUrl)) as {
      ExportDialog: ExportDialogConstructor;
    };
    const entries: ExportEstimateEntry[] = [];
    for (const range of ["visible", "all"] as const) {
      for (const [fidelity, bytes, ratio] of [
        ["preview", "1000000", "64"],
        ["standard", "4000000", "16"],
        ["high", "20000000", "4"],
        ["full", "1400000000", "1"],
      ] as const) {
        entries.push({
          range,
          fidelity,
          bytes,
          series_total: "41",
          series_decimated: fidelity === "full" ? "0" : "38",
          series_full_rate: fidelity === "full" ? "41" : "3",
          coarsest_ratio: ratio,
        });
      }
    }
    new ExportDialog(document.body, {
      estimateHtml: () => Promise.resolve({ entries }),
      pngBytes: () => Promise.resolve(400_000),
      csvEstimate: (fidelity) =>
        Promise.resolve({
          bytes: fidelity === "high" ? 1_200_000 : 400_000,
          rows: fidelity === "high" ? 16_384 : 512,
          stride: fidelity === "high" ? 8 : 256,
        }),
      runExport: () => Promise.resolve(),
    }).open("html");
  });

  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(dialog.locator('[data-fidelity="standard"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.locator(".export-awareness")).toHaveText(
    "38 of 41 series decimated · coarsest 1 pt per 16 samples · 3 kept at full rate",
  );
  await dialog.locator('[data-range="all"]').click();
  await dialog.locator('[data-fidelity="full"]').click();
  await expect(dialog.locator(".export-confirm")).toHaveText("Export 1.4 GB");
  await expect(dialog.locator('[data-fidelity-size="full"]')).toHaveClass(
    /warning/,
  );

  await dialog.locator('input[value="csv"]').check();
  await expect(dialog.locator('[data-fidelity="high"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.locator('[data-size="csv"]')).toHaveText(
    "1.2 MB · 16,384 rows · stride 1:8",
  );
});

test("the palette disables commands the current build cannot run", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.locator(".palette-input").fill("Open CSV");
  // The browser plane has no ingest host, so the command lists but cannot run.
  const row = page.locator(".palette-row", { hasText: "Open CSV" });
  await expect(row).toBeDisabled();
  await expect(row).toHaveAttribute("title", "unavailable in this context");
});

test("application shortcuts remain active while search has focus", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".signal-search").focus();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await expect(page.locator(".palette-input")).toBeVisible();
});

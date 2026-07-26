import { expect, test } from "./fixtures";

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
  await expect(page.locator(".formula-toggle")).toBeVisible();
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
  await expect(page.locator(".palette-hints")).toHaveText(
    "⌘P signals⌘⇧P commands",
  );
});

test("theme is a pure token swap", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("t");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
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
  const planned = menu.locator(".app-menu-item", {
    hasText: "Open Workspace",
  });
  await expect(planned).toHaveAttribute("aria-disabled", "true");
  await planned.dispatchEvent("click");
  await expect(menu).toBeVisible();

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
  const plannedRow = page.locator(".palette-row", {
    hasText: "Open Workspace",
  });
  await expect(plannedRow).toBeDisabled();
  await expect(plannedRow).toHaveAttribute("title", /planned/);
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

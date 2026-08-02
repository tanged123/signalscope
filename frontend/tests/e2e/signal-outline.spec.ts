import { expect, test } from "./fixtures";

test("the outline filters, sorts, groups, selects, and saves a frozen set", async ({
  page,
}) => {
  await page.goto("/");

  const outline = page.locator(".outline-scroll");
  await expect(outline).toBeVisible();
  await expect(page.locator(".signal-group-select")).toHaveValue("channel");
  await expect(page.locator(".signal-view-toggle")).toHaveCount(0);
  await expect(outline.locator('[data-row-kind="series"]')).toHaveCount(2);
  const sourceHeader = outline.locator(
    '.signal-outline-header button[data-column="source"]',
  );
  await expect(sourceHeader).toHaveAttribute("aria-sort", "none");

  await sourceHeader.click();
  await expect(sourceHeader).toHaveAttribute("aria-sort", "ascending");
  await page.locator(".signal-search").fill("velocity_body/*");
  await outline.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.locator(".bulk-bar")).toContainText("2 selected");

  await page.locator('[data-action="save"]').click();
  await page.locator(".set-name-input").fill("all velocity");
  await page.locator(".set-name-input").press("Enter");
  await expect(page.locator(".tree-set")).toContainText("▣ 2");

  await page.locator(".signal-group-select").selectOption("source");
  await expect(page.locator(".signal-group-select")).toHaveValue("source");
  await expect(page.locator(".bulk-bar")).toContainText("2 selected");
});

test("the outline column picker exposes PTS and closes with Escape", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".outline-columns-button").click();
  await expect(page.locator(".outline-columns-popover")).toBeVisible();
  await expect(
    page.locator(".outline-columns-popover input[type=checkbox]"),
  ).toBeVisible();
  await page.locator(".outline-columns-popover input[type=checkbox]").check();
  await expect(
    page.locator(".outline-columns-popover input[type=checkbox]"),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator(".outline-columns-popover")).toBeHidden();
});

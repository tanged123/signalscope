import { expect, test } from "./fixtures";

test("table mode filters, sorts, selects, and saves a frozen set", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('[data-dock-view="table"]').click();

  const table = page.locator(".table-scroll");
  await expect(table).toBeVisible();
  await expect(table.locator(".signal-table-row")).toHaveCount(2);
  await expect(table.locator('[data-column="source"]')).toHaveAttribute(
    "aria-sort",
    "none",
  );

  await page.locator('[data-column="source"]').click();
  await expect(table.locator('[data-column="source"]')).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await page.locator(".signal-search").fill("velocity_body/*");
  await table.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.locator(".bulk-bar")).toContainText("2 selected");

  await page.locator('[data-action="save"]').click();
  await page.locator(".set-name-input").fill("all velocity");
  await page.locator(".set-name-input").press("Enter");
  await expect(page.locator(".tree-set")).toContainText("▣ 2");

  await page.locator('[data-dock-view="tree"]').click();
  await expect(page.locator(".tree-scroll")).toBeVisible();
  await expect(page.locator(".tree-row.selected")).toHaveCount(2);
});

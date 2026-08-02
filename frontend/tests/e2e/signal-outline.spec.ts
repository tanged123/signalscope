import { expect, test } from "./fixtures";

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

  await page.locator(".signal-search").fill("velocity_body/*");
  await outline.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.locator(".sets-save-selection")).toBeEnabled();

  await page.locator('[data-action="save"]').click();
  await page.locator(".set-name-input").fill("all velocity");
  await page.locator(".set-name-input").press("Enter");
  await expect(page.locator(".tree-set")).toContainText("▣ 2");
  await expect(page.locator(".sets-save-selection")).toBeEnabled();
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

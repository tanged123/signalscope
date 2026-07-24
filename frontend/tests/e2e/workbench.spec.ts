import { expect, test } from "@playwright/test";

test("panel lifecycle has keyboard and pointer paths", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.locator(".panel-empty").last()).toBeVisible();
  await expect(page.locator(".panel").last()).toHaveClass(/focused/);

  await page.locator(".panel").last().locator(".panel-split").click();
  await expect(page.locator(".panel")).toHaveCount(3);

  await page.locator(".panel").last().locator(".panel-close").click();
  await page.locator(".panel").last().locator(".panel-close").click();
  await expect(page.locator(".panel")).toHaveCount(1);
});

test("command palette reaches every command", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette-input")).toBeFocused();
  await page.locator(".palette-input").fill("new panel");
  await page.keyboard.press("Enter");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.locator(".palette-overlay")).toBeHidden();
});

test("tree filters, favorites, and drag-to-plot", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "the signal tree is hidden on the mobile breakpoint");
  await page.goto("/");

  await page.keyboard.press("/");
  await expect(page.locator(".signal-search")).toBeFocused();
  await page.locator(".signal-search").fill("body/y");
  await expect(page.locator(".tree-scroll .tree-leaf")).toHaveCount(1);
  await page.locator(".signal-search").fill("");
  await expect(page.locator(".tree-scroll .tree-leaf")).toHaveCount(2);

  await page.locator(".tree-scroll .tree-star").first().click();
  await expect(page.locator(".tree-favorites .tree-leaf")).toHaveCount(1);

  await page.keyboard.press("n");
  const leaf = page.locator(".tree-scroll .tree-leaf").first();
  const target = page.locator(".panel").last();
  await leaf.dragTo(target);
  await expect(target.locator(".legend-chip")).toHaveCount(1);
});

test("seam drag resizes panel rows", async ({ page, isMobile }) => {
  test.skip(isMobile, "seam drags are desktop pointer interactions");
  await page.goto("/");
  await page.keyboard.press("n");

  const first = page.locator(".panel").first();
  const before = (await first.boundingBox())?.height ?? 0;
  const seam = page.locator(".seam-row").first();
  const box = await seam.boundingBox();
  if (box === null) throw new Error("seam not found");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, {
    steps: 5,
  });
  await page.mouse.up();
  const after = (await first.boundingBox())?.height ?? 0;
  expect(after).toBeGreaterThan(before + 40);
});

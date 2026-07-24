import { expect, test } from "@playwright/test";

test("panel lifecycle exposes unified directional splits", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.locator(".workspace-row")).toHaveCount(2);
  await expect(page.locator(".panel-empty").last()).toBeVisible();
  await expect(page.locator(".panel").last()).toHaveClass(/focused/);

  const bottomRow = page.locator(".workspace-row").last();
  await bottomRow.locator(".panel-split-right").click();
  await expect(page.locator(".panel")).toHaveCount(3);
  await expect(page.locator(".workspace-row")).toHaveCount(2);
  await expect(bottomRow.locator(".panel")).toHaveCount(2);

  await page.locator(".panel").last().locator(".panel-close").click();
  await page.locator(".panel").last().locator(".panel-close").click();
  await expect(page.locator(".panel")).toHaveCount(1);
});

test("maximize fills the workspace and split restores the layout", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("n");

  const workspace = page.locator(".workspace");
  const first = page.locator(".panel").first();
  const before = await first.boundingBox();
  const workspaceBox = await workspace.boundingBox();
  if (before === null || workspaceBox === null) {
    throw new Error("workspace geometry is unavailable");
  }

  await first.locator(".panel-maximize").click();
  await expect(page.locator(".panel")).toHaveCount(1);
  await expect(page.locator(".panel.maximized")).toHaveCount(1);

  const panelBar = page.locator(".maximized-panel-bar");
  await expect(panelBar).toBeVisible();
  await expect(panelBar.locator(".maximized-panel-tab")).toHaveCount(2);
  const maximized = page.locator(".panel.maximized");
  const after = await maximized.boundingBox();
  const panelBarBox = await panelBar.boundingBox();
  if (after === null)
    throw new Error("maximized panel geometry is unavailable");
  if (panelBarBox === null)
    throw new Error("maximized panel bar geometry is unavailable");
  expect(after.height).toBeGreaterThan(before.height + 100);
  expect(
    Math.abs(after.height + panelBarBox.height - workspaceBox.height),
  ).toBeLessThan(4);
  expect(Math.abs(after.width - workspaceBox.width)).toBeLessThan(4);
  await expect(maximized.locator(".panel-maximize")).toHaveAttribute(
    "title",
    "Restore panel",
  );

  await panelBar.locator(".maximized-panel-tab").last().click();
  await expect(page.locator(".panel.maximized")).toHaveAttribute(
    "data-panel-id",
    "panel-2",
  );

  await page.locator(".panel.maximized .panel-split-right").click();
  await expect(page.locator(".panel")).toHaveCount(3);
  await expect(page.locator(".panel.maximized")).toHaveCount(0);
  await expect(page.locator(".panel").last()).toBeVisible();
});

test("workspace tabs keep independent panel layouts", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".workspace-tab")).toHaveCount(1);
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.locator(".workspace-tab-add").click();
  await expect(page.locator(".workspace-tab")).toHaveCount(2);
  await expect(page.locator(".workspace-tab.active")).toContainText(
    "Workspace 2",
  );
  await expect(page.locator(".workspace-empty")).toBeVisible();

  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(1);
  await expect(page.locator(".panel")).toHaveAttribute(
    "data-panel-id",
    "panel-2",
  );

  await page
    .locator(".workspace-tab")
    .first()
    .locator("button")
    .first()
    .click();
  await expect(page.locator(".workspace-tab.active")).toContainText(
    "Workspace 1",
  );
  await expect(page.locator(".panel")).toHaveAttribute(
    "data-panel-id",
    "panel-1",
  );
  await expect(page.locator(".legend-chip")).toHaveCount(2);

  await page.locator(".workspace-tab").last().locator("button").first().click();
  await expect(page.locator(".panel")).toHaveAttribute(
    "data-panel-id",
    "panel-2",
  );
  await expect(page.locator(".legend-chip")).toHaveCount(0);
});

test("command palette runs workspace-scoped panel commands", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette-input")).toBeFocused();
  await page.locator(".palette-input").fill("split focused panel right");
  await page.keyboard.press("Enter");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.locator(".palette-overlay")).toBeHidden();
});

test("formula editor is transient with pointer and keyboard paths", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.locator(".formula-bar");
  const input = page.locator(".formula-input");
  const toggle = page.locator(".formula-toggle");

  await expect(editor).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await expect(editor).toBeVisible();
  await expect(input).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("e");
  await expect(editor).toBeVisible();
  await expect(input).toBeFocused();
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

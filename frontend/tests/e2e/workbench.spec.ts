import { expect, test } from "./fixtures";
import type { PanelView as PanelViewClass } from "../../src/ui/panel";

test("panel lifecycle exposes unified directional splits", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.locator(".workspace-row")).toHaveCount(2);
  await expect(page.locator(".panel-empty").last()).toBeVisible();
  await expect(page.locator(".panel.focused")).toHaveCount(0);

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
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await expect(page.locator(".palette-input")).toBeFocused();
  await page.locator(".palette-input").fill("split current panel right");
  await page.keyboard.press("Enter");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.locator(".palette-overlay")).toBeHidden();
});

test("panel legend keeps controls visible and exposes overflow", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/src/ui/panel.ts";
    const { PanelView } = (await import(/* @vite-ignore */ modulePath)) as {
      PanelView: typeof PanelViewClass;
    };
    const host = document.createElement("div");
    host.id = "legend-probe";
    host.style.width = "1400px";
    host.style.height = "320px";
    host.style.display = "flex";
    document.body.replaceChildren(host);
    const view = new PanelView("legend-probe-panel", {
      onFocus: () => {},
      onClose: () => {},
      onSplitRight: () => {},
      onSplitDown: () => {},
      onMaximize: () => {},
      onSelectMode: () => {},
      onDropSignal: () => {},
      onSetXSignal: () => {},
      onSetColorSignal: () => {},
      onClearXSignal: () => {},
      onToggleSeries: () => {},
      onResized: () => {},
      onGesture: () => {},
      onCursor: () => {},
      onTimeWindow: () => {},
      onYRange: () => {},
      onXRange: () => {},
      onPinAnnotation: () => {},
      onRemoveAnnotation: () => {},
      onEditAnnotationLabel: () => {},
      onFitView: () => {},
      onToggleStats: () => {},
      onToggleAxisStyle: () => {},
      onRenameTitle: () => {},
      onEditAxisLabel: () => {},
      onSetSeriesStyle: () => {},
      onRemoveSeries: () => {},
    });
    host.appendChild(view.element);
    view.update(
      {
        id: "legend-probe-panel",
        title: "Many series",
        mode: "time",
        axis_style: "gutter",
        x_signal: null,
        color_signal: null,
        series: Array.from({ length: 40 }, (_, index) => ({
          path: `monte_carlo/run_${String(index + 1)}`,
          color_slot: index + 1,
          dash: "solid" as const,
          width: 1.4,
          visible: true,
        })),
        y_range: null,
        x_range: null,
        x_label: null,
        y_label: null,
        time_window: null,
        annotations: [],
        show_stats: false,
      },
      false,
    );
  });

  const panel = page.locator("#legend-probe .panel");
  const headerChips = panel.locator(".panel-legend .legend-chip");
  await expect.poll(() => headerChips.count()).toBeGreaterThan(3);
  const wideVisible = await headerChips.count();
  const wideOverflow = Number(
    (await panel.locator(".legend-overflow").textContent())?.slice(1),
  );
  expect(wideVisible + wideOverflow).toBe(40);
  await expect(panel.locator(".panel-actions")).toBeVisible();

  await page.locator("#legend-probe").evaluate((host) => {
    host.style.width = "520px";
  });
  await expect.poll(() => headerChips.count()).toBeLessThan(wideVisible);
  const narrowVisible = await headerChips.count();
  const narrowOverflow = Number(
    (await panel.locator(".legend-overflow").textContent())?.slice(1),
  );
  expect(narrowVisible + narrowOverflow).toBe(40);

  await panel.locator(".legend-overflow").click();
  await expect(panel.locator(".legend-overflow-menu")).toBeVisible();
  await expect(panel.locator(".legend-overflow-menu .legend-chip")).toHaveCount(
    narrowOverflow,
  );
  await page.keyboard.press("Escape");
  await expect(panel.locator(".legend-overflow-menu")).toBeHidden();
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

test("signal tree toggles and collapses through its resize edge", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "the signal tree is hidden at the mobile breakpoint");
  await page.goto("/");
  const tree = page.locator(".signal-tree");
  const workspace = page.locator(".workspace");
  const toggle = page.locator(".tree-toggle");
  const seam = page.locator(".tree-resize-handle");
  const initialWorkspaceWidth = (await workspace.boundingBox())?.width ?? 0;

  await expect(tree).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(tree).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect((await workspace.boundingBox())?.width ?? 0).toBeGreaterThan(
    initialWorkspaceWidth + 200,
  );

  await toggle.click();
  await expect(tree).toBeVisible();

  const expandedSeam = await seam.boundingBox();
  if (expandedSeam === null) throw new Error("tree resize edge is unavailable");
  await page.mouse.move(
    expandedSeam.x + expandedSeam.width / 2,
    expandedSeam.y + 40,
  );
  await page.mouse.down();
  await page.mouse.move(20, expandedSeam.y + 40, { steps: 5 });
  await page.mouse.up();
  await expect(tree).toBeHidden();

  const collapsedSeam = await seam.boundingBox();
  if (collapsedSeam === null)
    throw new Error("collapsed tree resize edge is unavailable");
  await page.mouse.move(
    collapsedSeam.x + collapsedSeam.width / 2,
    collapsedSeam.y + 40,
  );
  await page.mouse.down();
  await page.mouse.move(240, collapsedSeam.y + 40, { steps: 5 });
  await page.mouse.up();
  await expect(tree).toBeVisible();
  expect(Number(await seam.getAttribute("aria-valuenow"))).toBeGreaterThan(220);
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

  const firstLeaf = page.locator(".tree-scroll .tree-leaf").first();
  await expect(firstLeaf).toHaveAttribute("role", "button");
  await expect(firstLeaf).toHaveAccessibleName(/^Plot /);

  await firstLeaf.locator(".tree-star").click();
  await expect(page.locator(".tree-favorites .tree-leaf")).toHaveCount(1);
  const favoriteTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page
    .locator(".tree-scroll .tree-leaf")
    .nth(1)
    .dispatchEvent("dragstart", { dataTransfer: favoriteTransfer });
  await page.locator(".tree-favorites").dispatchEvent("dragover", {
    dataTransfer: favoriteTransfer,
  });
  await page.locator(".tree-favorites").dispatchEvent("drop", {
    dataTransfer: favoriteTransfer,
  });
  await expect(page.locator(".tree-favorites .tree-leaf")).toHaveCount(2);

  await page.keyboard.press("n");
  const enterTarget = page.locator(".panel").last();
  await firstLeaf.focus();
  await page.keyboard.press("Enter");
  await expect(enterTarget.locator(".legend-chip")).toHaveCount(1);

  await page.keyboard.press("n");
  const spaceTarget = page.locator(".panel").last();
  const secondLeaf = page.locator(".tree-scroll .tree-leaf").nth(1);
  await secondLeaf.focus();
  await page.keyboard.press("Space");
  await expect(spaceTarget.locator(".legend-chip")).toHaveCount(1);

  const leaf = page.locator(".tree-scroll .tree-leaf").first();
  const target = page.locator(".panel").last();
  const workspace = page.locator(".workspace");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await leaf.dispatchEvent("dragstart", { dataTransfer });

  await workspace.dispatchEvent("dragover", { dataTransfer });
  await expect(workspace).toHaveClass(/drop-target/);

  await target.dispatchEvent("dragover", { dataTransfer });
  await expect(target).toHaveClass(/drop-target/);
  await expect(workspace).not.toHaveClass(/drop-target/);

  await target.dispatchEvent("drop", { dataTransfer });
  await leaf.dispatchEvent("dragend", { dataTransfer });
  await expect(target.locator(".legend-chip")).toHaveCount(2);
  await expect(target).not.toHaveClass(/focused/);
  await expect(target).not.toHaveClass(/drop-target/);
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

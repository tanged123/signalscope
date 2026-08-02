import { expect, test } from "./fixtures";
import type { PanelView as PanelViewClass } from "../../src/ui/panel";
import type { FormulaBar as FormulaBarClass } from "../../src/ui/formula-bar";
import type { Catalog as CatalogClass } from "../../src/app/catalog";

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
  await expect(page.locator(".binding-chip")).toHaveCount(2);

  await page.locator(".workspace-tab").last().locator("button").first().click();
  await expect(page.locator(".panel")).toHaveAttribute(
    "data-panel-id",
    "panel-2",
  );
  await expect(page.locator(".binding-chip")).toHaveCount(0);
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

test("command palette edits focused-panel axis labels", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".panel").first();
  for (const [query, label] of [
    ["edit X axis label", "X axis name"],
    ["edit Y axis label", "Y axis name"],
  ] as const) {
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.locator(".palette-input").fill(query);
    await page.keyboard.press("Enter");
    await expect(panel.getByLabel(label)).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

test("panel matrix legend keeps rosters virtual and exposes rules", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/src/ui/panel.ts";
    const { PanelView } = (await import(/* @vite-ignore */ modulePath)) as {
      PanelView: typeof PanelViewClass;
    };
    const catalogModulePath = "/src/app/catalog.ts";
    const catalogModule: unknown = await import(
      /* @vite-ignore */ catalogModulePath
    );
    const { Catalog } = catalogModule as { Catalog: typeof CatalogClass };
    const host = document.createElement("div");
    host.id = "legend-probe";
    host.style.width = "1400px";
    host.style.height = "320px";
    host.style.display = "flex";
    document.body.replaceChildren(host);
    const summaries = Array.from({ length: 40 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        signal_id: `id:run_${number}/temp`,
        source_id: `source:run_${number}`,
        source_key: `run_${number}`,
        local_path: "temp",
        path: `run_${number}/temp`,
        unit: "C",
        point_count: "2",
        t_min: 0,
        t_max: 1,
        last_value: null,
      };
    });
    const catalog = Catalog.build(summaries);
    const view = new PanelView("legend-probe-panel", {
      onFocus: () => {},
      onClose: () => {},
      onSplitRight: () => {},
      onSplitDown: () => {},
      onMaximize: () => {},
      onSelectMode: () => {},
      onDropSignals: () => {},
      onDropSet: () => {},
      onFocusToggle: () => {},
      onClearFocus: () => {},
      onMuteSelector: () => {},
      onMuteSeries: () => {},
      onRemoveBinding: () => {},
      onToggleGhostMode: () => {},
      onSetColorBy: (_id, dimension) => {
        host.dataset.colorBy = dimension;
      },
      onRemoveOverride: () => {},
      onClearOverrides: () => {},
      localPathFor: () => null,
      sourceKeyFor: () => null,
      pathForRef: (ref) => `${ref.source_key}/${ref.channel}`,
      catalog: () => catalog,
      namedSets: () => [],
      resolveSeries: (state) =>
        state.bindings
          .flatMap((binding) => binding.refs)
          .map((ref, index) => ({
            ref,
            path: `${ref.source_key}/${ref.channel}`,
            display: "focus" as const,
            hue: (index % 7) + 1,
            dash: "solid" as const,
            width: 1.4,
            opacity: 1,
            visible: true,
            focused: true,
            overridden: false,
          })),
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
      onQuickTransform: (id, path, kind) => {
        host.dataset.quickTransform = `${id}:${path}:${kind}`;
      },
    });
    host.appendChild(view.element);
    view.update(
      {
        id: "legend-probe-panel",
        title: "Many series",
        mode: "time",
        axis_style: "gutter",
        x_ref: null,
        color_axis: "none",
        color_ref: null,
        bindings: [
          {
            kind: "pick" as const,
            selector: null,
            refs: Array.from({ length: 40 }, (_, index) => ({
              source_key: `run_${String(index + 1).padStart(2, "0")}`,
              channel: "temp",
            })),
            set_id: null,
          },
        ],
        color_by: "source",
        overrides: [],
        focus: [],
        ghost_mode: "all",
        split_by: "none",
        y_range: null,
        x_range: null,
        x_label: null,
        y_label: null,
        c_label: null,
        time_window: null,
        annotations: [],
        show_stats: false,
      },
      false,
    );
  });

  const panel = page.locator("#legend-probe .panel");
  await expect(panel.locator(".binding-chip")).toHaveText("temp ×40");
  await expect(panel.locator(".legend-count-token")).toHaveCount(2);
  await expect(panel.locator(".panel-actions")).toBeVisible();
  await panel.locator(".legend-count-token").first().click();
  await expect(panel.locator(".matrix-roster")).toBeVisible();
  expect(await panel.locator(".matrix-roster-row").count()).toBeLessThan(40);
  await panel.locator(".matrix-roster-row").first().click();
  await expect(panel.locator(".binding-chip")).toHaveCount(1);
  await panel.locator(".binding-chip").click();
  await expect(panel.locator(".binding-popover")).toBeVisible();
  await panel.getByRole("button", { name: "remove binding" }).click();
  await expect(panel.locator(".binding-popover")).toBeHidden();
  await panel.locator(".color-rule-token").click();
  await expect(panel.locator(".rules-popover")).toBeVisible();
  await panel.getByRole("button", { name: "color ← channel" }).click();
  await expect(page.locator("#legend-probe")).toHaveAttribute(
    "data-color-by",
    "channel",
  );
  await page.keyboard.press("Escape");
});

test("formula component creates and recalls accepted formulas", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/src/ui/formula-bar.ts";
    const { FormulaBar, formulaBarMarkup } = (await import(
      /* @vite-ignore */ modulePath
    )) as {
      FormulaBar: typeof FormulaBarClass;
      formulaBarMarkup: () => string;
    };
    const host = document.createElement("div");
    host.id = "formula-probe";
    host.style.paddingTop = "300px";
    host.innerHTML = formulaBarMarkup();
    document.body.replaceChildren(host);
    const form = host.querySelector<HTMLFormElement>(".formula-bar");
    if (form === null)
      throw new Error("Formula bar markup is missing its form");
    const bar = new FormulaBar(form, {
      onCreate: (path, expression) => {
        if (path === "derived/bad") {
          return Promise.reject(new Error('unknown signal "missing/path"'));
        }
        host.dataset.created = `${path}|${expression}`;
        return Promise.resolve();
      },
      onClose: () => {
        host.dataset.closed = "true";
      },
    });
    bar.setSignals([
      "demo_flight/attitude/pitch_deg",
      "demo_flight/attitude/roll_deg",
    ]);
    bar.setOpen(true);
  });

  const host = page.locator("#formula-probe");
  const input = host.locator(".formula-input");
  await input.fill("derived/rate = gra");
  await expect(host.locator(".formula-completions")).toBeVisible();
  await expect(
    host.getByRole("option", { name: /gradient.*time derivative/ }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("derived/rate = gradient()");
  await expect(input).toBeFocused();

  await input.fill("derived/rate = 'pitch");
  await expect(
    host.getByRole("option", {
      name: /demo_flight\/attitude\/pitch_deg/,
    }),
  ).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue(
    "derived/rate = 'demo_flight/attitude/pitch_deg'",
  );

  await input.fill("derived/root = sq");
  await host.getByRole("option", { name: /sqrt.*square root/ }).click();
  await expect(input).toHaveValue("derived/root = sqrt()");
  await expect(input).toBeFocused();

  await input.fill("derived/x = atan");
  await input.press("ArrowDown");
  await expect(
    host.getByRole("option", { name: /atan2.*two-argument arctangent/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "formula-completion-1",
  );
  await input.press("ArrowUp");
  await expect(
    host.getByRole("option", { name: /atan.*inverse tangent/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "formula-completion-0",
  );
  await input.press("ArrowUp");
  await expect(
    host.getByRole("option", { name: /atan2.*two-argument arctangent/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "formula-completion-1",
  );
  await input.press("Enter");
  await expect(input).toHaveValue("derived/x = atan2(, )");
  await expect(input).toHaveJSProperty("selectionStart", 18);
  await expect(input).toBeFocused();

  await input.fill("derived/x = ");
  await input.press("Control+Space");
  await expect(host.locator(".formula-completions")).toBeVisible();
  await input.press("Escape");
  await expect(host.locator(".formula-completions")).toBeHidden();
  await expect(host).not.toHaveAttribute("data-closed", "true");
  await input.press("Escape");
  await expect(host).toHaveAttribute("data-closed", "true");

  await input.fill("derived/double = 'demo/x' * 2");
  await input.press("Enter");
  await expect(host).toHaveAttribute(
    "data-created",
    "derived/double|'demo/x' * 2",
  );
  await expect(input).toHaveValue("");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("derived/double = 'demo/x' * 2");

  await input.fill("derived/bad = 'missing/path'");
  await input.press("Enter");
  await expect(host.locator(".formula-error")).toContainText("unknown signal");
  await expect(host.locator(".formula-error-guidance")).toHaveText(
    "Signal references use quoted paths. Drag from the tree to insert.",
  );
  await expect(input).toHaveValue("derived/bad = 'missing/path'");

  await input.fill("derived/recovered = 'demo/x'");
  await input.press("Enter");
  await expect(host.locator(".formula-error")).toBeHidden();
  await expect(host.locator(".formula-error-guidance")).toBeHidden();
  await expect(host.locator(".formula-error-guidance")).toBeEmpty();
});

test("formula help teaches real paths once and remains available", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.removeItem("signalscope.formulaHelpSeen");
    const modulePath = "/src/ui/formula-bar.ts";
    const { FormulaBar, formulaBarMarkup } = (await import(
      /* @vite-ignore */ modulePath
    )) as {
      FormulaBar: typeof FormulaBarClass;
      formulaBarMarkup: () => string;
    };
    const host = document.createElement("div");
    host.id = "formula-help-probe";
    host.innerHTML = formulaBarMarkup();
    document.body.replaceChildren(host);
    const form = host.querySelector<HTMLFormElement>(".formula-bar");
    if (form === null)
      throw new Error("Formula bar markup is missing its form");
    const bar = new FormulaBar(form, {
      onCreate: () => Promise.resolve(),
      onClose: () => {
        host.dataset.closed = "true";
      },
    });
    bar.setSignals(["demo_flight/attitude/pitch_deg"]);
    bar.setOpen(true);
  });

  const host = page.locator("#formula-help-probe");
  const help = host.locator(".formula-help-popover");
  await expect(help).toBeVisible();
  await expect(help.locator(".formula-help-example")).toContainText(
    "'demo_flight/attitude/pitch_deg'",
  );
  const button = host.getByRole("button", { name: "Formula help" });
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await button.click();
  await expect(help).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("signalscope.formulaHelpSeen")),
    )
    .toBe("1");
  await button.click();
  await expect(help).toBeVisible();
  await button.focus();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(host).not.toHaveAttribute("data-closed", "true");

  const input = host.locator(".formula-input");
  await input.fill("derived/sum = hypot(, )");
  await input.evaluate((element: HTMLInputElement) => {
    element.setSelectionRange(20, 20);
  });
  const firstTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData(
      "application/x-signalscope-signal",
      "demo_flight/attitude/pitch_deg",
    );
    return transfer;
  });
  const bar = host.locator(".formula-bar");
  await bar.dispatchEvent("dragover", { dataTransfer: firstTransfer });
  await expect(bar).toHaveClass(/drop-target/);
  await bar.dispatchEvent("drop", { dataTransfer: firstTransfer });
  await expect(input).toHaveValue(
    "derived/sum = hypot('demo_flight/attitude/pitch_deg', )",
  );
  await expect(input).toBeFocused();
  await expect(bar).not.toHaveClass(/drop-target/);

  await input.evaluate((element: HTMLInputElement) => {
    const close = element.value.lastIndexOf(")");
    element.setSelectionRange(close, close);
  });
  const secondTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData(
      "application/x-signalscope-signal",
      "demo_flight/attitude/roll_deg",
    );
    return transfer;
  });
  await bar.dispatchEvent("drop", { dataTransfer: secondTransfer });
  await expect(input).toHaveValue(
    "derived/sum = hypot('demo_flight/attitude/pitch_deg', 'demo_flight/attitude/roll_deg')",
  );

  await page.keyboard.press("Escape");
  await expect(host).toHaveAttribute("data-closed", "true");
  await button.press("Enter");
  await expect(help).toBeVisible();
});

test("formula editor hides when the data plane cannot derive", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".formula-bar")).toBeHidden();
  await expect(page.locator(".formula-toggle")).toBeHidden();
});

test("signal tree toggles and collapses through its resize edge", async ({
  page,
}) => {
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

test("outline filters, sets, and drag-to-plot", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tree-sets")).toContainText(
    "Saved sets appear here",
  );

  await page.keyboard.press("/");
  await expect(page.locator(".signal-search")).toBeFocused();
  await page.locator(".signal-search").fill("body/y");
  await expect(
    page.locator('.outline-scroll [data-row-kind="series"]'),
  ).toHaveCount(1);
  await page.locator(".signal-search").fill("");
  await expect(
    page.locator('.outline-scroll [data-row-kind="series"]'),
  ).toHaveCount(2);

  const firstLeaf = page
    .locator('.outline-scroll [data-row-kind="series"]')
    .first();
  await expect(firstLeaf).toHaveAttribute("data-path", /.+/);

  await firstLeaf.focus();
  await page.keyboard.press("n");
  const enterTarget = page.locator(".panel").last();
  await firstLeaf.focus();
  await page.keyboard.press("Enter");
  await expect(enterTarget.locator(".binding-chip")).toHaveCount(1);

  await page.keyboard.press("n");
  const spaceTarget = page.locator(".panel").last();
  const secondLeaf = page
    .locator('.outline-scroll [data-row-kind="series"]')
    .nth(1);
  await secondLeaf.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".sets-save-selection")).toBeEnabled();
  await expect(spaceTarget.locator(".binding-chip")).toHaveCount(0);

  const leaf = page.locator('.outline-scroll [data-row-kind="series"]').first();
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
  await expect(target.locator(".binding-chip")).toHaveCount(1);
  await expect(target).not.toHaveClass(/focused/);
  await expect(target).not.toHaveClass(/drop-target/);
});

test("selector filter binds and saves a live set", async ({ page }) => {
  await page.goto("/");
  const search = page.locator(".signal-search");
  await search.fill("velocity_body/* @ rocket");
  await expect(page.locator(".search-count")).toContainText(
    "2 signals · 1 sources",
  );
  await search.press("Enter");
  const first = page.locator(".panel").first();
  await expect(first.locator(".binding-chip")).toHaveCount(3);

  await search.press("ControlOrMeta+s");
  await page.locator(".set-name-input").fill("thermal");
  await page.locator(".set-name-input").press("Enter");
  const setRow = page.locator(".tree-set", { hasText: "thermal" });
  await expect(setRow).toContainText("2");
  await expect(setRow).toContainText("live");

  await first.locator(".panel-header").click();
  await page.keyboard.press("n");
  const second = page.locator(".panel").last();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await setRow.dispatchEvent("dragstart", { dataTransfer });
  await second.dispatchEvent("drop", { dataTransfer });
  await expect(second.locator(".binding-chip")).toHaveCount(1);

  await setRow.focus();
  await page.keyboard.press("Delete");
  await expect(second.locator(".binding-chip")).toHaveCount(0);
});

test("legend strip and source rows stay bounded", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".panel").first();
  const strip = panel.locator(".panel-legend-strip");
  await expect(strip).toBeVisible();
  await expect(strip.locator(".legend-count-token")).toHaveCount(2);
  await expect(strip).toContainText("⇧click focus");
  await expect(panel.locator(".panel-header .legend-count-token")).toHaveCount(
    0,
  );

  const sourceRow = page
    .locator('.signal-outline-row[data-row-kind="series"]')
    .first();
  await sourceRow.hover();
  await expect(sourceRow.locator(".source-align")).toHaveCount(0);
  await expect(page.locator(".source-alignment-popover")).toHaveCount(0);
});

test("seam drag resizes panel rows", async ({ page }) => {
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

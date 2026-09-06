import { expect, gotoApp, test } from "./fixtures";
import type { PanelView as PanelViewClass } from "../../src/ui/panel";
import type { FormulaBar as FormulaBarClass } from "../../src/ui/formula-bar";
import type { Catalog as CatalogClass } from "../../src/app/catalog";

test("panel lifecycle exposes unified directional splits", async ({ page }) => {
  await gotoApp(page);
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
  await gotoApp(page);
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
  await gotoApp(page);
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

  const row = page.locator('.outline-scroll [data-row-kind="series"]').first();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer });
  await page.locator(".panel").dispatchEvent("dragover", { dataTransfer });
  await page.locator(".panel").dispatchEvent("drop", { dataTransfer });
  await expect(page.locator(".panel .binding-chip")).toHaveCount(1);

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
  await expect(page.locator(".binding-chip")).toHaveCount(1);
});

test("overflowing workspace tabs keep their controls clear", async ({
  page,
}) => {
  await gotoApp(page);
  for (let index = 0; index < 10; index += 1) {
    await page.locator(".workspace-tab-add").click();
  }

  const tabs = page.locator(".workspace-tabs");
  await expect(tabs).toHaveCSS("scrollbar-width", "none");
  const active = page.locator(".workspace-tab.active");
  await expect(active.locator(".workspace-tab-select")).toBeVisible();
  await expect(active.locator(".workspace-tab-close")).toBeVisible();
});

test("command palette runs workspace-scoped panel commands", async ({
  page,
}) => {
  await gotoApp(page);
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await expect(page.locator(".palette-input")).toBeFocused();
  await page.locator(".palette-input").fill("split current panel right");
  await page.keyboard.press("Enter");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.locator(".palette-overlay")).toBeHidden();
});

test("command palette edits focused-panel axis labels", async ({ page }) => {
  await gotoApp(page);
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

test("panel signal legend keeps rosters virtual and exposes unified styles", async ({
  page,
}) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ status: 503, body: "offline for isolated UI probe" }),
  );
  await gotoApp(page);
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
    host.style.width = "1200px";
    host.style.height = "320px";
    host.style.display = "flex";
    document.body.replaceChildren(host);
    const refs = Array.from({ length: 100 }, (_, index) => {
      if (index === 99) return { source_key: "run_01", channel: "speed" };
      return {
        source_key: `run_${String(index + 1).padStart(2, "0")}`,
        channel: "temp",
      };
    });
    const summaries = refs.map((ref) => {
      return {
        signal_id: `id:${ref.source_key}/${ref.channel}`,
        source_id: `source:${ref.source_key}`,
        source_key: ref.source_key,
        local_path: ref.channel,
        path: `${ref.source_key}/${ref.channel}`,
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
      onDropSignals: () => {},
      onDropSet: () => {},
      onFocusToggle: (_id, entry) => {
        host.dataset.focusToggle =
          entry.ref === null
            ? (entry.source_key ?? entry.channel ?? "")
            : `${entry.ref.source_key}/${entry.ref.channel}`;
      },
      onFocusAdd: (_id, entry) => {
        host.dataset.focusAdd =
          entry.ref === null
            ? (entry.source_key ?? entry.channel ?? "")
            : `${entry.ref.source_key}/${entry.ref.channel}`;
      },
      onFocusRange: (_id, entries) => {
        host.dataset.focusRange = entries
          .map((entry) =>
            entry.ref === null
              ? (entry.source_key ?? entry.channel ?? "")
              : `${entry.ref.source_key}/${entry.ref.channel}`,
          )
          .join(",");
      },
      onClearFocus: () => {},
      onMuteSelector: () => {},
      onMuteSeries: () => {},
      onRemoveBinding: () => {},
      onToggleGhostMode: () => {},
      onLegendLayout: (_id, layout) => {
        if (layout.state !== undefined) host.dataset.legendState = layout.state;
        if (layout.dock !== undefined) {
          if (layout.dock === null) delete host.dataset.legendDock;
          else host.dataset.legendDock = layout.dock;
        }
      },
      onSetEncoding: (_id, property, dimension) => {
        host.dataset.encoding = `${property}:${dimension ?? "flat"}`;
      },
      onSetPanelLineWidth: () => {},
      onSetGhostOpacity: () => {},
      onSetStatColumns: () => {},
      onSetStatsSort: () => {},
      onRevertStyleOverride: () => {},
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
            overrideFields: { color: false, dash: false, width: false },
          })),
      onToggleSeries: () => {},
      onResized: () => {},
      onGesture: () => {},
      onCursor: () => {},
      onTimeWindow: () => {},
      onYRange: () => {},
      onXRange: () => {},
      onPinAnnotation: () => {},
      onRemoveAnnotation: () => {},
      onClearAnnotations: () => {
        host.dataset.tipsCleared = "true";
      },
      onEditAnnotationLabel: () => {},
      onFitView: () => {},
      onToggleStats: () => {},
      onToggleAxisStyle: () => {},
      onRenameTitle: () => {},
      onEditAxisLabel: () => {},
      onPatchSeriesStyle: () => {},
      onRemoveSeries: () => {},
    });
    host.appendChild(view.element);
    view.update(
      {
        id: "legend-probe-panel",
        title: "Many series",
        axis_style: "inline",
        bindings: [
          {
            kind: "pick" as const,
            selector: null,
            refs,
            set_id: null,
          },
        ],
        color_by: "source",
        dash_by: null,
        width_by: null,
        line_width: 1.4,
        ghost_opacity: 0.5,
        overrides: [],
        focus: Array.from({ length: 12 }, (_, index) => ({
          kind: "series" as const,
          ref: {
            source_key: `run_${String(index + 1).padStart(2, "0")}`,
            channel: "temp",
          },
          source_key: null,
          channel: "temp",
        })),
        ghost_mode: "all",
        legend_state: "roster",
        legend_position: null,
        legend_size: null,
        legend_anchor: null,
        legend_dock: null,
        legend_hint_dismissed: false,
        x_axis: { kind: "time" },
        color_axis: null,
        y_range: null,
        x_range: null,
        x_label: null,
        y_label: null,
        time_window: null,
        annotations: [
          {
            id: "tip-1",
            series_path: "run_01/temp",
            anchor: 5.12,
            pinned_x: null,
            pinned_value: 1.0565,
            label: "",
            offset: [10, -10] as [number, number],
          },
          {
            id: "tip-2",
            series_path: "run_02/temp",
            anchor: 4.33,
            pinned_x: null,
            pinned_value: 1.1528,
            label: "",
            offset: [10, -10] as [number, number],
          },
          {
            id: "tip-3",
            series_path: "run_03/temp",
            anchor: 3.43,
            pinned_x: null,
            pinned_value: 1.1482,
            label: "",
            offset: [10, -10] as [number, number],
          },
        ],
        annotation_display: "labels",
        show_stats: false,
        stat_columns: ["min", "max", "mean", "rms", "cursor"],
        stats_sort: null,
        stats_sort_descending: false,
      },
      false,
    );
  });

  const panel = page.locator("#legend-probe .panel");
  await expect(panel.locator(".binding-chip")).toHaveText([
    "temp ×99",
    "speed ×1",
  ]);
  await expect(panel.locator(".panel-legend-strip")).toHaveCount(0);
  await expect(panel.locator(".panel-actions")).toBeVisible();
  const plotLegend = panel.locator(".plot-series-legend");
  await expect
    .poll(async () => {
      const legendBox = await plotLegend.boundingBox();
      const wrapBox = await panel.locator(".plot-wrap").boundingBox();
      if (legendBox === null || wrapBox === null) return false;
      const rightInset =
        wrapBox.x + wrapBox.width - (legendBox.x + legendBox.width);
      return Math.abs(rightInset - 8) <= 1;
    })
    .toBe(true);
  await expect
    .poll(() => plotLegend.locator(".plot-legend-roster-row").count())
    .toBeLessThan(100);
  await expect
    .poll(() => plotLegend.locator(".plot-legend-roster-row").count())
    .toBeGreaterThan(4);
  await expect
    .poll(() =>
      plotLegend.evaluate((element) => {
        const row = getComputedStyle(
          element.querySelector(".plot-legend-roster-row") as HTMLElement,
        );
        return {
          plotFamilyApplied: row.fontFamily.includes("JetBrains Mono"),
          plotSizeApplied: row.fontSize === "10px",
        };
      }),
    )
    .toEqual({ plotFamilyApplied: true, plotSizeApplied: true });
  for (const selector of [
    ".panel-line-width",
    ".panel-tips",
    ".panel-legend-state",
  ]) {
    await panel.locator(selector).click();
    const menu = panel.locator(".panel-config-popover");
    await expect(menu).toBeVisible();
    await expect
      .poll(() =>
        menu.evaluate((element) => {
          const title = getComputedStyle(
            element.querySelector(".panel-config-title") as HTMLElement,
          );
          const option = getComputedStyle(
            element.querySelector("button") as HTMLButtonElement,
          );
          return {
            titleFamily: title.fontFamily.includes("Inter"),
            titleSize: Math.round(Number.parseFloat(title.fontSize)),
            optionFamily: option.fontFamily.includes("Inter"),
            optionSize: Math.round(Number.parseFloat(option.fontSize)),
          };
        }),
      )
      .toEqual({
        titleFamily: true,
        titleSize: 10,
        optionFamily: true,
        optionSize: 10,
      });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }

  await panel.locator(".panel-tips").click();
  await panel.getByRole("menuitem", { name: "clear all" }).click();
  await expect(page.locator("#legend-probe")).toHaveAttribute(
    "data-tips-cleared",
    "true",
  );
  const rosterActions = plotLegend.locator(".plot-legend-roster-action");
  await rosterActions.nth(0).click();
  await expect(page.locator("#legend-probe")).toHaveAttribute(
    "data-focus-add",
    "run_01/temp",
  );
  await rosterActions.nth(3).click({ modifiers: ["Shift"] });
  await expect(page.locator("#legend-probe")).toHaveAttribute(
    "data-focus-range",
    "run_01/temp,run_02/temp,run_03/temp,run_04/temp",
  );
  await rosterActions.nth(4).click({ modifiers: ["Control"] });
  await expect(page.locator("#legend-probe")).toHaveAttribute(
    "data-focus-toggle",
    "run_05/temp",
  );
  const signalsToggle = plotLegend.locator(".plot-legend-signals-toggle");
  await signalsToggle.click();
  await expect(plotLegend.locator(".plot-legend-roster-rows")).toBeHidden();
  await expect(plotLegend.locator(".plot-legend-tips-heading")).toBeVisible();
  await expect(signalsToggle).toHaveAttribute("aria-expanded", "false");
  await signalsToggle.click();
  await expect(plotLegend.locator(".plot-legend-roster-rows")).toBeVisible();
  await expect(
    plotLegend.locator(".plot-legend-tips-heading button").first(),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(plotLegend.locator(".plot-tip-reading").nth(1)).toHaveText(
    "5.1200 · 1.0565",
  );
  const tips = plotLegend.locator(".plot-legend-tips");
  const tipsHeading = plotLegend.locator(".plot-legend-tips-heading");
  const beforeTipsResize = await tips.boundingBox();
  const tipsHeadingBox = await tipsHeading.boundingBox();
  if (beforeTipsResize === null || tipsHeadingBox === null)
    throw new Error("Tips resize handle is not laid out");
  await page.mouse.move(
    tipsHeadingBox.x + tipsHeadingBox.width * 0.55,
    tipsHeadingBox.y + tipsHeadingBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(tipsHeadingBox.x, tipsHeadingBox.y - 48);
  await page.mouse.up();
  await expect
    .poll(async () => (await tips.boundingBox())?.height ?? 0)
    .toBeGreaterThan(beforeTipsResize.height + 30);
  const beforeKeyboardResize = await tips.boundingBox();
  await tipsHeading.focus();
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => (await tips.boundingBox())?.height ?? 0)
    .toBeLessThan((beforeKeyboardResize?.height ?? 0) - 10);
  await expect
    .poll(() =>
      plotLegend.evaluate((element) => {
        const group = element
          .querySelector(".plot-legend-group")
          ?.getBoundingClientRect();
        const tips = element
          .querySelector(".plot-legend-tips")
          ?.getBoundingClientRect();
        return group !== undefined && tips !== undefined
          ? group.bottom <= tips.top + 1
          : false;
      }),
    )
    .toBe(true);
  await plotLegend.locator(".plot-legend-tips-heading button").first().click();
  const beforeResize = await plotLegend.boundingBox();
  const resizeHandle = plotLegend.locator(".plot-legend-resize-right");
  const resizeBox = await resizeHandle.boundingBox();
  if (beforeResize === null || resizeBox === null)
    throw new Error("Plot legend resize handle is not laid out");
  await page.mouse.move(
    resizeBox.x + resizeBox.width / 2,
    resizeBox.y + resizeBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + 80, resizeBox.y);
  await page.mouse.up();
  await expect
    .poll(async () => (await plotLegend.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforeResize.width + 50);
  await expect(page.locator("#legend-probe")).toHaveAttribute(
    "data-legend-state",
    "roster",
  );
  await expect(page.locator("#legend-probe")).not.toHaveAttribute(
    "data-legend-dock",
  );
  const beforeDrag = await plotLegend.boundingBox();
  const dragHandle = plotLegend.locator(".plot-legend-drag");
  const handleBox = await dragHandle.boundingBox();
  if (beforeDrag === null || handleBox === null)
    throw new Error("Plot legend is not laid out");
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 100, handleBox.y + 40);
  await page.mouse.up();
  await expect
    .poll(async () => (await plotLegend.boundingBox())?.x ?? beforeDrag.x)
    .toBeLessThan(beforeDrag.x - 50);
  await expect(plotLegend.locator(".plot-legend-hide")).toHaveCount(0);
  await plotLegend.locator(".plot-legend-collapse").click();
  await expect(page.locator("#legend-probe")).toHaveAttribute(
    "data-legend-state",
    "badge",
  );
  await expect
    .poll(() =>
      panel.evaluate((element) => ({
        chart: getComputedStyle(
          element.querySelector(".chart-host") as HTMLElement,
        ).zIndex,
        overlay: getComputedStyle(
          element.querySelector(".overlay-canvas") as HTMLElement,
        ).zIndex,
        plotIsolation: getComputedStyle(
          element.querySelector(".plot-wrap") as HTMLElement,
        ).isolation,
        roster: getComputedStyle(
          element.querySelector(".plot-series-legend") as HTMLElement,
        ).zIndex,
      })),
    )
    .toEqual({
      chart: "0",
      overlay: "1",
      plotIsolation: "isolate",
      roster: "2",
    });
  await expect
    .poll(() => panel.locator(".plot-legend-roster-row").count())
    .toBeLessThan(100);
  const rosterRows = panel.locator(".plot-legend-roster-rows");
  await rosterRows.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(panel.locator(".plot-legend-roster-row").last()).toContainText(
    "run_01/speed",
  );
  await panel.locator(".plot-legend-search").fill("* @ run_01");
  await expect(panel.locator(".plot-legend-roster-row")).toHaveCount(2);
  await expect(panel.locator(".plot-row-inspector-toggle:enabled")).toHaveCount(
    2,
  );
  await panel.locator(".plot-legend-roster-row").first().click();
  await expect(panel.locator(".binding-chip")).toHaveCount(2);
  await panel.locator(".binding-chip").first().click();
  await expect(panel.locator(".binding-popover")).toBeVisible();
  await panel.getByRole("button", { name: "remove all" }).click();
  await expect(panel.locator(".binding-popover")).toBeHidden();
  const colorEncoding = panel.locator(
    '.plot-legend-encoding-chip[data-property="color"]',
  );
  await colorEncoding.click();
  const encodingDrawer = panel.locator(".plot-encoding-drawer");
  await expect(encodingDrawer).toBeVisible();
  await encodingDrawer.getByRole("button", { name: "channel" }).click();
  await expect(page.locator("#legend-probe")).toHaveAttribute(
    "data-encoding",
    "color:channel",
  );
  await expect(panel.locator(".rules-popover")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("dismissing a failed ingest banner clears it", async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(async () => {
    const modulePath = "/src/ui/app-shell.ts";
    const { renderBatchProgress } = (await import(
      /* @vite-ignore */ modulePath
    )) as {
      renderBatchProgress: (
        element: HTMLElement,
        status: unknown,
        cancel: () => void,
      ) => void;
    };
    const host = document.createElement("div");
    host.id = "ingest-probe";
    const progress = document.createElement("div");
    progress.className = "ingest-progress";
    host.append(progress);
    document.body.replaceChildren(host);
    renderBatchProgress(
      progress,
      {
        state: "done",
        fraction: 1,
        total: "2",
        done: "1",
        failed: "1",
        current_paths: [],
        recent_failures: [
          {
            path: "/runs/broken.csv",
            error: "no data rows",
            recipe_required: false,
          },
        ],
      },
      () => {},
    );
    progress.hidden = false;
  });

  const progress = page.locator("#ingest-probe .ingest-progress");
  await expect(progress).toBeVisible();
  await expect(progress.locator(".ingest-failures")).toContainText(
    "broken.csv",
  );

  await progress.locator(".ingest-dismiss").click();
  await expect(progress).toBeHidden();
  await expect(progress.locator(".ingest-failures")).toHaveCount(0);
});

test("formula component creates and recalls accepted formulas", async ({
  page,
}) => {
  await gotoApp(page);
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
    "Signal and channel references use quoted paths. Drag from the tree to insert.",
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
  await gotoApp(page);
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
  await gotoApp(page);
  await expect(page.locator(".formula-bar")).toBeHidden();
  await expect(page.locator(".formula-toggle")).toBeHidden();
});

test("signal tree toggles and collapses through its resize edge", async ({
  page,
}) => {
  await gotoApp(page);
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
  await gotoApp(page);
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
  await expect(secondLeaf).toHaveClass(/selected/);
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
  await gotoApp(page);
  const search = page.locator(".signal-search");
  await search.fill("velocity_body/* @ rocket");
  await expect(page.locator(".search-count")).toContainText(
    "2 signals · 1 source",
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
  await setRow.locator(".tree-set-caret").click();
  await expect(page.locator(".tree-set-member")).toHaveCount(2);
  await expect(page.locator(".tree-set-member").first()).toContainText(
    "rocket/velocity_body/",
  );

  await first.locator(".panel-title").click();
  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);
  const second = page.locator(".panel").last();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await setRow.dispatchEvent("dragstart", { dataTransfer });
  await second.dispatchEvent("drop", { dataTransfer });
  await expect(second.locator(".binding-chip")).toHaveCount(1);

  await second.locator(".panel-close").click();
  await first.locator(".panel-close").click();
  await expect(page.locator(".panel")).toHaveCount(0);
  const emptyTransfer = await page.evaluateHandle(() => new DataTransfer());
  await setRow.dispatchEvent("dragstart", { dataTransfer: emptyTransfer });
  const workspace = page.locator(".workspace");
  await workspace.dispatchEvent("dragover", { dataTransfer: emptyTransfer });
  await expect(workspace).toHaveClass(/drop-target/);
  await workspace.dispatchEvent("drop", { dataTransfer: emptyTransfer });
  await expect(page.locator(".panel")).toHaveCount(1);
  await expect(page.locator(".panel .binding-chip")).toHaveCount(1);

  await setRow.focus();
  await page.keyboard.press("Delete");
  await expect(page.locator(".panel .binding-chip")).toHaveCount(0);
});

test("legend console replaces the strip and supports per-plot states", async ({
  page,
}) => {
  await gotoApp(page);
  const panel = page.locator(".panel").first();
  await expect(panel.locator(".panel-legend-strip")).toHaveCount(0);
  await expect(panel.locator(".plot-series-legend")).toBeVisible();
  await page.locator(".panel").first().locator(".panel-legend-state").click();
  await page
    .getByRole("menuitemradio", { name: "badge", exact: false })
    .click();
  await expect(panel.locator(".plot-series-legend")).toHaveAttribute(
    "data-state",
    "badge",
  );
  await panel.locator(".plot-legend-badge-summary").click();
  const wrap = panel.locator(".plot-wrap");
  const drag = panel.locator(".plot-legend-drag");
  const legend = panel.locator(".plot-series-legend");
  const [wrapBox, dragBox, legendBox] = await Promise.all([
    wrap.boundingBox(),
    drag.boundingBox(),
    legend.boundingBox(),
  ]);
  if (wrapBox === null || dragBox === null || legendBox === null)
    throw new Error("Legend dock targets are not laid out");
  const dragX = dragBox.x + dragBox.width / 2;
  await page.mouse.move(dragX, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    dragX + wrapBox.x + wrapBox.width - legendBox.x - legendBox.width - 8,
    dragBox.y,
  );
  await expect(wrap).toHaveAttribute("data-legend-dock-preview", "right");
  await page.mouse.up();
  await expect(panel.locator(".plot-series-legend")).toHaveAttribute(
    "data-state",
    "rail",
  );
  await expect(panel.locator(".plot-series-legend")).toHaveAttribute(
    "data-dock",
    "right",
  );
  await expect(wrap).toHaveClass(/legend-rail/);
  await expect
    .poll(() =>
      wrap.evaluate((element) => {
        const wrapRect = element.getBoundingClientRect();
        const overlayRect = (
          element.querySelector(".overlay-canvas") as HTMLElement
        ).getBoundingClientRect();
        const legendRect = (
          element.querySelector(".plot-series-legend") as HTMLElement
        ).getBoundingClientRect();
        return {
          plotReflowed: overlayRect.width < wrapRect.width,
          fullHeight: Math.abs(legendRect.height - wrapRect.height) < 1,
        };
      }),
    )
    .toEqual({ plotReflowed: true, fullHeight: true });
  const rail = panel.locator(".plot-series-legend");
  const railResize = rail.locator(".plot-legend-resize-left");
  await expect(railResize).toBeVisible();
  const railBox = await rail.boundingBox();
  if (railBox === null) throw new Error("Legend rail seam is not laid out");
  await page.mouse.move(railBox.x + 2, railBox.y + railBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    railBox.x + railBox.width - 2,
    railBox.y + railBox.height / 2,
  );
  await page.mouse.up();
  await expect(wrap).toHaveClass(/legend-rail-collapsed/);
  await expect(rail).toHaveAttribute("data-collapsed", "true");
  const collapsedRailBox = await rail.boundingBox();
  if (collapsedRailBox === null)
    throw new Error("Collapsed legend rail seam is not laid out");
  await page.mouse.move(
    collapsedRailBox.x + 2,
    collapsedRailBox.y + collapsedRailBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    collapsedRailBox.x - 180,
    collapsedRailBox.y + collapsedRailBox.height / 2,
  );
  await page.mouse.up();
  await expect(wrap).not.toHaveClass(/legend-rail-collapsed/);
  await panel.locator(".plot-legend-undock").click();
  await expect(panel.locator(".plot-series-legend")).toHaveAttribute(
    "data-state",
    "roster",
  );
  await expect(wrap).not.toHaveClass(/legend-rail/);
});

test("seam drag resizes panel rows", async ({ page }) => {
  await gotoApp(page);
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

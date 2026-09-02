// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Catalog } from "../app/catalog";
import { binColumnsFromWire } from "../app/bin-columns";
import { resolvePanel } from "../app/resolution";
import type { SignalSummary } from "../generated/protocol";
import type { PanelState } from "../generated/session";
import { ChartHost } from "../render/chart-host";
import type { GpuContext } from "../render/gpu-context";
import { PanelView, type PanelCallbacks } from "./panel";

function signal(source: string, channel: string): SignalSummary {
  return {
    signal_id: `${source}-${channel}`,
    source_id: source,
    source_key: source,
    local_path: channel,
    path: `${source}/${channel}`,
    unit: null,
    point_count: "1",
    t_min: 0,
    t_max: 1,
    last_value: null,
  };
}

function state(): PanelState {
  return {
    id: "panel",
    title: "Panel",
    axis_style: "gutter",
    bindings: [{ kind: "query", selector: "*", refs: [], set_id: null }],
    color_by: "source",
    dash_by: null,
    width_by: null,
    line_width: 1.4,
    ghost_opacity: 0.5,
    overrides: [],
    focus: [],
    ghost_mode: "all",
    legend_state: "keys",
    legend_position: null,
    legend_size: null,
    legend_anchor: null,
    legend_hint_dismissed: false,
    y_range: null,
    x_range: null,
    x_label: null,
    y_label: null,
    time_window: null,
    annotations: [],
    show_stats: false,
    stat_columns: ["min", "max", "mean", "rms", "cursor"],
    stats_sort: null,
    stats_sort_descending: false,
  };
}

function callbacks(catalog: Catalog): PanelCallbacks {
  return {
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onMaximize: vi.fn(),
    onDropSignals: vi.fn(),
    onDropSet: vi.fn(),
    onFocusToggle: vi.fn(),
    onFocusSolo: vi.fn(),
    onClearFocus: vi.fn(),
    onMuteSelector: vi.fn(),
    onMuteSeries: vi.fn(),
    onRemoveBinding: vi.fn(),
    onToggleGhostMode: vi.fn(),
    onLegendLayout: vi.fn(),
    localPathFor: () => null,
    sourceKeyFor: () => null,
    pathForRef: (ref) => `${ref.source_key}/${ref.channel}`,
    catalog: () => catalog,
    namedSets: () => [],
    resolveSeries: (panel) => resolvePanel(catalog, panel, []),
    onToggleSeries: vi.fn(),
    onResized: vi.fn(),
    onGesture: vi.fn(),
    onCursor: vi.fn(),
    onTimeWindow: vi.fn(),
    onYRange: vi.fn(),
    onXRange: vi.fn(),
    onPinAnnotation: vi.fn(),
    onRemoveAnnotation: vi.fn(),
    onEditAnnotationLabel: vi.fn(),
    onFitView: vi.fn(),
    onToggleStats: vi.fn(),
    onToggleAxisStyle: vi.fn(),
    onRenameTitle: vi.fn(),
    onEditAxisLabel: vi.fn(),
    onSetEncoding: vi.fn(),
    onSetPanelLineWidth: vi.fn(),
    onSetGhostOpacity: vi.fn(),
    onSetStatColumns: vi.fn(),
    onSetStatsSort: vi.fn(),
    onRevertStyleOverride: vi.fn(),
    onClearOverrides: vi.fn(),
    onPatchSeriesStyle: vi.fn(),
    onRemoveSeries: vi.fn(),
  };
}

const originalResizeObserver = globalThis.ResizeObserver;

function mockCanvas(): void {
  const context = new Proxy(
    {},
    {
      get: (_target, property: string) => {
        if (property === "measureText") return () => ({ width: 0 });
        if (property === "createLinearGradient") {
          return () => ({ addColorStop: vi.fn() });
        }
        return vi.fn();
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
}

beforeEach(() => {
  mockCanvas();
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  vi.restoreAllMocks();
});

describe("PanelView chrome", () => {
  it("waits for a mounted panel before creating ChartGPU", () => {
    const create = vi
      .spyOn(ChartHost, "create")
      .mockResolvedValue({} as ChartHost);
    const view = new PanelView(
      "panel",
      callbacks(Catalog.build([])),
      {} as GpuContext,
    );

    expect(create).not.toHaveBeenCalled();
    document.body.appendChild(view.element);
    view.mount();

    expect(create).toHaveBeenCalledWith(
      view.element.querySelector(".chart-host"),
      expect.anything(),
    );
  });

  it("resizes an existing chart after its panel is remounted", async () => {
    const resize = vi.fn();
    vi.spyOn(ChartHost, "create").mockResolvedValue({
      resize,
    } as unknown as ChartHost);
    const view = new PanelView(
      "panel",
      callbacks(Catalog.build([])),
      {} as GpuContext,
    );
    document.body.appendChild(view.element);
    view.mount();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    view.element.remove();
    document.body.appendChild(view.element);
    view.mount();

    expect(resize).toHaveBeenCalledOnce();
  });

  it("retries transient chart initialization failures", async () => {
    vi.useFakeTimers();
    const create = vi
      .spyOn(ChartHost, "create")
      .mockRejectedValueOnce(new Error("context unavailable"))
      .mockResolvedValue({ resize: vi.fn() } as unknown as ChartHost);
    const view = new PanelView(
      "panel",
      callbacks(Catalog.build([])),
      {} as GpuContext,
    );
    document.body.appendChild(view.element);

    view.mount();
    await vi.runAllTimersAsync();

    expect(create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("reports chart initialization that never settles", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi
      .spyOn(ChartHost, "create")
      .mockImplementation(() => new Promise(() => {}));
    const reportFailure = vi.fn();
    const gpu = { reportFailure } as unknown as GpuContext;
    const view = new PanelView("panel", callbacks(Catalog.build([])), gpu);
    document.body.appendChild(view.element);

    view.mount();
    await vi.runAllTimersAsync();

    expect(create).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledWith({
      kind: "host-initialization",
      message: "ChartGPU initialization timed out",
    });
    vi.useRealTimers();
  });

  it("renders the in-plot legend without a duplicate strip", () => {
    const catalog = Catalog.build([
      signal("run-01", "temp"),
      signal("run-02", "temp"),
    ]);
    const view = new PanelView("panel", callbacks(catalog));
    const panel = state();
    panel.focus = [
      {
        kind: "series",
        ref: { source_key: "run-01", channel: "temp" },
        source_key: null,
        channel: null,
      },
    ];
    view.update(panel, false);

    expect(view.element.querySelector(".panel-legend-strip")).toBeNull();
    const legend = view.element.querySelector(".plot-series-legend");
    expect(legend?.getAttribute("data-state")).toBe("keys");
    expect(legend?.querySelectorAll(".plot-legend-row")).toHaveLength(1);
    expect(
      [...(legend?.querySelectorAll(".plot-legend-encoding-chip") ?? [])].map(
        (chip) => chip.textContent,
      ),
    ).toEqual(["color ← source", "dash ← flat", "width ← flat · 1.4"]);
    expect(view.element.querySelector(".panel-config-toggle")).toBeNull();
    expect(view.element.querySelector(".panel-line-width")?.textContent).toBe(
      "1.4 ▾",
    );
    expect(
      view.element.querySelector(".panel-ghost-opacity")?.textContent,
    ).toBe("ghost all ▾");
    expect(view.element.querySelector(".panel-focus-chip")).toBeNull();
    expect(
      view.element.querySelector<HTMLElement>(".panel-annotations")?.hidden,
    ).toBe(true);
  });

  it("keeps the style cascade visible in the legend and routes encoding edits", () => {
    const catalog = Catalog.build([signal("run-01", "temp")]);
    const panelCallbacks = callbacks(catalog);
    const onSetEncoding = vi.fn();
    panelCallbacks.onSetEncoding = onSetEncoding;
    const view = new PanelView("panel", panelCallbacks);
    view.update(state(), false);

    const legend = view.element.querySelector<HTMLElement>(
      ".plot-series-legend",
    );
    expect(legend).not.toBeNull();
    expect(
      [...(legend?.querySelectorAll(".plot-legend-encoding-chip") ?? [])].map(
        (chip) => chip.textContent,
      ),
    ).toEqual(["color ← source", "dash ← flat", "width ← flat · 1.4"]);

    legend
      ?.querySelector<HTMLButtonElement>(
        '.plot-legend-encoding-chip[data-property="color"]',
      )
      ?.click();
    expect(legend?.querySelector(".plot-encoding-choices")).not.toBeNull();
    view.element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(legend?.querySelector(".plot-encoding-choices")).toBeNull();
    legend
      ?.querySelector<HTMLButtonElement>(
        '.plot-legend-encoding-chip[data-property="color"]',
      )
      ?.click();
    const channelChoice = [
      ...(legend?.querySelectorAll<HTMLButtonElement>(
        ".plot-encoding-choice",
      ) ?? []),
    ].find((choice) => choice.textContent === "channel");
    channelChoice?.click();
    expect(onSetEncoding).toHaveBeenCalledWith("panel", "color", "channel");
  });

  it("opens line editing from the series name hit target", () => {
    const catalog = Catalog.build([signal("run-01", "temp")]);
    const view = new PanelView("panel", callbacks(catalog));
    const panel = state();
    panel.focus = [
      {
        kind: "series",
        ref: { source_key: "run-01", channel: "temp" },
        source_key: null,
        channel: null,
      },
    ];
    view.update(panel, false);

    const row = view.element.querySelector<HTMLButtonElement>(
      ".plot-legend-row-action",
    );
    expect(row?.title).toContain("Edit run-01/temp line properties");
    row?.click();
    expect(view.element.querySelector(".plot-row-inspector")).not.toBeNull();
  });

  it("reports attribute encoding values by unit", () => {
    const catalog = Catalog.build([
      { ...signal("run-01", "temp"), unit: "°C" },
      { ...signal("run-02", "temp"), unit: "°C" },
    ]);
    const panel = state();
    panel.color_by = "attr";
    const view = new PanelView("panel", callbacks(catalog));
    view.update(panel, false);

    view.element
      .querySelector<HTMLButtonElement>(
        '.plot-legend-encoding-chip[data-property="color"]',
      )
      ?.click();

    expect(
      view.element.querySelector(".plot-encoding-note")?.textContent,
    ).toMatch(/^1 value → \d+ slots$/);
  });

  it("edits a series inline and exposes field-level revert without legacy actions", () => {
    const catalog = Catalog.build([signal("run-01", "temp")]);
    const panelCallbacks = callbacks(catalog);
    const onPatchSeriesStyle = vi.fn();
    panelCallbacks.onPatchSeriesStyle = onPatchSeriesStyle;
    const panel = state();
    panel.overrides = [
      {
        target_ref: { source_key: "run-01", channel: "temp" },
        target_selector: null,
        color_slot: 2,
        dash: "dash",
        width: 2.5,
        opacity: null,
        visible: null,
      },
    ];
    panel.focus = [
      {
        kind: "series",
        ref: { source_key: "run-01", channel: "temp" },
        source_key: null,
        channel: null,
      },
    ];
    const view = new PanelView("panel", panelCallbacks);
    view.update(panel, false);

    view.element
      .querySelector<HTMLButtonElement>(".plot-row-inspector-toggle")
      ?.click();
    const inspector = view.element.querySelector<HTMLElement>(
      ".plot-row-inspector",
    );
    expect(inspector).not.toBeNull();
    expect(inspector?.querySelector(".plot-row-remove")).toBeNull();
    expect(inspector?.querySelector(".plot-row-transform")).toBeNull();
    expect(inspector?.querySelector(".quick-transform")).toBeNull();

    inspector
      ?.querySelector<HTMLButtonElement>(
        ".plot-row-color-slots button:nth-child(3)",
      )
      ?.click();
    inspector
      ?.querySelector<HTMLButtonElement>(".plot-row-dashes button")
      ?.click();
    const width = inspector?.querySelector<HTMLInputElement>(
      'input[type="range"]',
    );
    if (width === undefined || width === null) throw new Error("missing width");
    width.value = "3";
    width.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatchSeriesStyle).toHaveBeenCalledWith(
      "panel",
      { source_key: "run-01", channel: "temp" },
      { color_slot: 3 },
    );
    expect(onPatchSeriesStyle).toHaveBeenCalledWith(
      "panel",
      { source_key: "run-01", channel: "temp" },
      { dash: "solid" },
    );
    expect(onPatchSeriesStyle).toHaveBeenCalledWith(
      "panel",
      { source_key: "run-01", channel: "temp" },
      { width: 3 },
    );
    const provenance = inspector?.querySelectorAll<HTMLButtonElement>(
      ".plot-row-provenance",
    );
    expect(provenance).toHaveLength(2);
    provenance?.[0]?.click();
    expect(onPatchSeriesStyle).toHaveBeenCalledWith(
      "panel",
      { source_key: "run-01", channel: "temp" },
      { color_slot: null },
    );
    provenance?.[1]?.click();
    expect(onPatchSeriesStyle).toHaveBeenCalledWith(
      "panel",
      { source_key: "run-01", channel: "temp" },
      { dash: null, width: null },
    );
  });

  it("renders configurable statistics in the legend rather than a bottom strip", () => {
    const catalog = Catalog.build([signal("run-01", "temp")]);
    const panelCallbacks = callbacks(catalog);
    const onSetStatColumns = vi.fn();
    const onSetStatsSort = vi.fn();
    panelCallbacks.onSetStatColumns = onSetStatColumns;
    panelCallbacks.onSetStatsSort = onSetStatsSort;
    const panel = state();
    panel.show_stats = true;
    panel.stat_columns = ["min", "mean", "n"];
    panel.stats_sort = "mean";
    panel.stats_sort_descending = false;
    panel.focus = [
      {
        kind: "series",
        ref: { source_key: "run-01", channel: "temp" },
        source_key: null,
        channel: null,
      },
    ];
    const view = new PanelView("panel", panelCallbacks);
    const legend = view.element.querySelector<HTMLElement>(
      ".plot-series-legend",
    );
    if (legend === null) throw new Error("missing legend");
    Object.defineProperty(legend, "clientWidth", { value: 320 });
    view.update(panel, false);

    expect(legend.querySelector(".plot-legend-stats")).not.toBeNull();
    expect(view.element.querySelector(".panel-stats")).toBeNull();
    expect(
      [
        ...legend.querySelectorAll<HTMLElement>(
          ".plot-legend-header > :not(.plot-legend-resize)",
        ),
      ].map((element) => element.className),
    ).toEqual([
      "plot-legend-drag",
      "plot-legend-title",
      "plot-legend-stats-scope",
      "plot-legend-collapse",
    ]);
    expect(
      [...legend.querySelectorAll<HTMLElement>(".plot-stat-sort")].map(
        (button) => button.dataset.column,
      ),
    ).toEqual(["min", "mean"]);

    legend
      .querySelector<HTMLButtonElement>('.plot-stat-sort[data-column="min"]')
      ?.click();
    expect(onSetStatsSort).toHaveBeenCalledWith("panel", "min", true);
    legend
      .querySelector<HTMLButtonElement>(".plot-stat-column-picker")
      ?.click();
    const columnN = legend.querySelector<HTMLButtonElement>(
      '.plot-stats-columns-drawer button[aria-pressed="true"]',
    );
    expect(columnN).not.toBeNull();
    expect(legend.querySelector(".plot-stats-columns-drawer")).not.toBeNull();
    const nChoice = [
      ...legend.querySelectorAll<HTMLButtonElement>(
        ".plot-stats-columns-drawer button",
      ),
    ].find((button) => button.textContent.trim().replace(/^✓\s*/, "") === "N");
    nChoice?.click();
    expect(onSetStatColumns).toHaveBeenCalledWith("panel", ["min", "mean"]);
  });

  it("updates cursor statistic cells without rebuilding open drawers", () => {
    const catalog = Catalog.build([signal("run-01", "temp")]);
    const panel = state();
    panel.show_stats = true;
    panel.stat_columns = ["cursor"];
    const view = new PanelView("panel", callbacks(catalog));
    view.update(panel, false);
    view.element
      .querySelector<HTMLButtonElement>(
        '.plot-legend-encoding-chip[data-property="color"]',
      )
      ?.click();
    const drawer = view.element.querySelector(".plot-encoding-drawer");
    Object.assign(view, {
      lastTiles: {
        requestId: "cursor",
        series: [
          {
            signalId: "run-01-temp",
            signalPath: "run-01/temp",
            unit: null,
            level: 0,
            bins: binColumnsFromWire([
              {
                t0: 0,
                t1: 0,
                first: 4,
                last: 4,
                min: 4,
                max: 4,
                sum: 4,
                sum_sq: 16,
                finite_count: "1",
                sample_count: "1",
                has_gap: false,
              },
            ]),
          },
        ],
      },
    });

    view.setLocalCursor(0);

    expect(view.element.querySelector(".plot-encoding-drawer")).toBe(drawer);
    expect(
      view.element.querySelector(
        '.plot-stat-cell[data-column="cursor"][data-path="run-01/temp"]',
      )?.textContent,
    ).toBe("4");
  });

  it("does not intercept Tab or Enter from descendant controls", () => {
    const catalog = Catalog.build([signal("run-01", "temp")]);
    const panelCallbacks = callbacks(catalog);
    const onFocusToggle = vi.fn();
    panelCallbacks.onFocusToggle = onFocusToggle;
    const view = new PanelView("panel", panelCallbacks);
    view.update(state(), false);
    Object.assign(view, {
      cursorT: 0,
      emphasizePaths: new Set(["run-01/temp"]),
    });
    const button =
      view.element.querySelector<HTMLButtonElement>(".panel-close");
    if (button === null) throw new Error("missing panel button");
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });

    button.dispatchEvent(tab);
    button.dispatchEvent(enter);

    expect(tab.defaultPrevented).toBe(false);
    expect(enter.defaultPrevented).toBe(false);
    expect(onFocusToggle).not.toHaveBeenCalled();
  });
});

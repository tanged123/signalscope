// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { SignalSummary } from "../generated/protocol";
import type { FocusEntry } from "../generated/session";
import { Catalog } from "../app/catalog";
import type { PreparedPlot } from "../app/plot-capabilities";
import type { PlotLayout } from "../app/plot-math";
import type { GpuContext } from "../render/gpu-context";

import {
  MAX_SERIES_PER_PANEL,
  MAXIMIZE_GLYPH,
  PanelView,
  bindingChipEntries,
  focusChips,
  matrixLegendRows,
  parseSetPayload,
  parseSignalPayload,
  parseSignalRefsPayload,
  type RenderPanelState,
  type RenderSeries,
} from "./panel";
import type { PanelCallbacks } from "./panel";

function sourceKeyFor(path: string): string | null {
  const match = /^run_0*(\d+)\//.exec(path);
  return match === null ? null : `k${String(match[1])}`;
}

function localPathFor(path: string): string | null {
  const source = sourceKeyFor(path);
  return source === null ? null : (path.split("/").at(1) ?? null);
}

function summary(path: string): SignalSummary {
  const sourceKey = sourceKeyFor(path);
  const localPath = localPathFor(path);
  if (sourceKey === null || localPath === null) {
    throw new Error(`Expected source-backed path: ${path}`);
  }
  return {
    signal_id: `id:${path}`,
    source_id: `source:${sourceKey}`,
    source_key: sourceKey,
    local_path: localPath,
    path,
    unit: null,
    point_count: "2",
    t_min: 0,
    t_max: 1,
    last_value: null,
  };
}

describe("panel markup", () => {
  it("offers no mode selection", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
      },
    );
    const panel = new PanelView("panel", {} as PanelCallbacks);
    expect(panel.element.querySelectorAll(".mode-pill")).toHaveLength(0);
    expect(panel.element.querySelector(".xy-drop-strip")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("keeps legend controls from triggering a panel-focus rebuild", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
      },
    );
    const onFocus = vi.fn();
    const panel = new PanelView("panel", {
      onFocus,
    } as unknown as PanelCallbacks);
    panel.element
      .querySelector(".plot-series-legend")
      ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(onFocus).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("releases its chart host without disposing the panel", () => {
    const dispose = vi.fn();
    const chartHostElement = document.createElement("div");
    const view = Object.create(PanelView.prototype) as {
      gpu: GpuContext | null;
      chartHost: { dispose(): void } | null;
      chartHostReady: Promise<{ dispose(): void } | null> | null;
      pendingChartRender: object | null;
      chartHostElement: HTMLElement;
      disposed: boolean;
      releaseGpu(): void;
    };
    view.gpu = {} as GpuContext;
    view.chartHost = { dispose };
    view.chartHostReady = Promise.resolve(view.chartHost);
    view.pendingChartRender = {};
    view.chartHostElement = chartHostElement;
    view.disposed = false;

    view.releaseGpu();

    expect(dispose).toHaveBeenCalledOnce();
    expect(view.gpu).toBeNull();
    expect(view.chartHost).toBeNull();
    expect(view.chartHostReady).toBeNull();
    expect(view.pendingChartRender).not.toBeNull();
    expect(chartHostElement.hidden).toBe(true);
    expect(view.disposed).toBe(false);
  });
});

const gestureLayout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: 0, max: 10 },
  yRange: { min: 0, max: 10 },
};

function visible(path: string): RenderSeries {
  return {
    ref: {
      source_key: sourceKeyFor(path) ?? "",
      channel: localPathFor(path) ?? path,
    },
    path,
    display: "focus",
    hue: 1,
    dash: "solid",
    width: 1.4,
    opacity: 1,
    visible: true,
    focused: true,
    overridden: false,
    overrideFields: { color: false, dash: false, width: false },
  };
}

function timeState(series: RenderSeries[]): RenderPanelState {
  return {
    id: "panel",
    title: "Time",
    axis_style: "gutter",
    color_by: "source",
    dash_by: null,
    width_by: null,
    line_width: 1.4,
    ghost_opacity: 0.5,
    ghost_mode: "all",
    legend_state: "keys",
    legend_position: null,
    legend_size: null,
    legend_anchor: null,
    legend_hint_dismissed: false,
    bindings: [],
    overrides: [],
    focus: [],
    series,
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

describe("panel series", () => {
  it("uses a fallback-safe maximize glyph", () => {
    expect(MAXIMIZE_GLYPH).toBe("↗");
  });

  it("keeps the panel member cap available for ordinary series", () => {
    expect(MAX_SERIES_PER_PANEL).toBe(64);
  });

  describe("plot gestures", () => {
    it("uses shift-click for focus and alt-click for mute", () => {
      const onFocusToggle = vi.fn();
      const onMuteSeries = vi.fn();
      const callbacks = {
        onFocusToggle,
        onMuteSeries,
      } as unknown as PanelCallbacks;
      const view = Object.create(PanelView.prototype) as unknown as {
        callbacks: PanelCallbacks;
        chartHost: { layout(): PlotLayout } | null;
        lastState: RenderPanelState;
        preparedPlot: PreparedPlot;
        hitAdapter: PreparedPlot["hitAdapter"];
        plotClick(
          x: number,
          y: number,
          modifiers: { alt: boolean; shift: boolean },
        ): void;
      };
      const series = visible("run_01/temp");
      view.callbacks = callbacks;
      view.chartHost = { layout: () => gestureLayout };
      view.lastState = timeState([series]);
      view.preparedPlot = {
        annotationAt: () => null,
        hitAdapter: {
          seriesAt: () => ({ path: series.path, distance: 0 }),
        },
      } as unknown as PreparedPlot;
      view.hitAdapter = view.preparedPlot.hitAdapter;

      view.plotClick(50, 50, { alt: false, shift: false });
      expect(onFocusToggle).not.toHaveBeenCalled();
      expect(onMuteSeries).not.toHaveBeenCalled();

      view.plotClick(50, 50, { alt: false, shift: true });
      expect(onFocusToggle).toHaveBeenCalledTimes(1);

      view.plotClick(50, 50, { alt: true, shift: false });
      expect(onMuteSeries).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps annotation pinning on plain click while shift-click bypasses it", () => {
    const onPinAnnotation = vi.fn();
    const onFocusToggle = vi.fn();
    const callbacks = {
      onPinAnnotation,
      onFocusToggle,
    } as unknown as PanelCallbacks;
    const series = visible("run_01/temp");
    const view = Object.create(PanelView.prototype) as unknown as {
      callbacks: PanelCallbacks;
      chartHost: { layout(): PlotLayout } | null;
      lastState: RenderPanelState;
      preparedPlot: PreparedPlot;
      hitAdapter: PreparedPlot["hitAdapter"];
      plotClick(
        x: number,
        y: number,
        modifiers: { alt: boolean; shift: boolean },
      ): void;
    };
    view.callbacks = callbacks;
    view.chartHost = { layout: () => gestureLayout };
    view.lastState = timeState([series]);
    view.preparedPlot = {
      annotationAt: () => ({
        path: series.path,
        anchor: 1,
        pinnedValue: 2,
      }),
      resolveAnnotation: () => null,
      hitAdapter: { seriesAt: () => ({ path: series.path, distance: 0 }) },
    } as unknown as PreparedPlot;
    view.hitAdapter = view.preparedPlot.hitAdapter;

    view.plotClick(50, 50, { alt: false, shift: false });
    expect(onPinAnnotation).toHaveBeenCalledTimes(1);
    expect(onFocusToggle).not.toHaveBeenCalled();

    view.plotClick(50, 50, { alt: false, shift: true });
    expect(onPinAnnotation).toHaveBeenCalledTimes(1);
    expect(onFocusToggle).toHaveBeenCalledTimes(1);
  });

  it("parses signal drag paths", () => {
    expect(
      parseSignalPayload(JSON.stringify({ paths: ["a/alt", "b/alt"] })),
    ).toEqual(["a/alt", "b/alt"]);
    expect(parseSignalPayload("not json")).toEqual(["not json"]);
    expect(parseSignalPayload(JSON.stringify({ paths: [1] }))).toEqual([]);
  });

  it("parses signal drag refs", () => {
    expect(
      parseSignalRefsPayload(
        JSON.stringify({
          refs: [{ source_key: "run-01", channel: "temp" }],
          paths: ["run-01/temp"],
        }),
      ),
    ).toEqual([{ source_key: "run-01", channel: "temp" }]);
    expect(parseSignalRefsPayload("not json")).toEqual([]);
    expect(
      parseSignalRefsPayload(JSON.stringify({ refs: [{ source_key: 1 }] })),
    ).toEqual([]);
  });

  it("parses named set drag payloads", () => {
    expect(parseSetPayload(JSON.stringify({ set_id: "set-3" }))).toBe("set-3");
    expect(parseSetPayload(JSON.stringify({ set_id: 3 }))).toBeNull();
    expect(parseSetPayload("not json")).toBeNull();
  });

  it("builds bounded matrix roster rows with selector filtering", () => {
    const catalog = Catalog.build(
      ["run_01", "run_02", "run_03"].flatMap((source) =>
        ["temp", "speed"].map((channel) => ({
          signal_id: `${source}-${channel}`,
          source_id: `k${source.slice(-2).replace(/^0/, "")}`,
          source_key: `k${source.slice(-2).replace(/^0/, "")}`,
          local_path: channel,
          path: `${source}/${channel}`,
          unit: channel === "temp" ? "K" : "m/s",
          point_count: "2",
          t_min: 0,
          t_max: 1,
          last_value: null,
        })),
      ),
    );
    const state = timeState([
      visible("run_01/temp"),
      visible("run_01/speed"),
      visible("run_02/temp"),
      visible("run_03/temp"),
    ]);
    state.focus = [
      {
        kind: "source",
        ref: null,
        source_key: "k2",
        channel: null,
      },
    ];
    expect(matrixLegendRows(catalog, state, "source")).toEqual([
      expect.objectContaining({
        value: "run_01",
        count: 2,
        selector: "* @ run_01",
      }),
      expect.objectContaining({
        value: "run_02",
        count: 1,
        focused: true,
      }),
      expect.objectContaining({ value: "run_03", count: 1 }),
    ]);
    expect(
      matrixLegendRows(catalog, state, "channel", "temp @ *").map(
        (row) => row.value,
      ),
    ).toEqual(["temp"]);
    expect(
      matrixLegendRows(catalog, state, "source", "run_02").map(
        (row) => row.value,
      ),
    ).toEqual(["run_02"]);
    expect(
      matrixLegendRows(catalog, state, "source", "run_0*").map(
        (row) => row.value,
      ),
    ).toEqual(["run_01", "run_02", "run_03"]);
    expect(
      matrixLegendRows(catalog, state, "channel", "/ spe").map(
        (row) => row.value,
      ),
    ).toEqual(["speed"]);
  });

  it("keeps only the first eight focus chips and reports overflow", () => {
    const catalog = Catalog.build(
      Array.from({ length: 10 }, (_, index) => ({
        signal_id: `run_0${String(index + 1)}-temp`,
        source_id: `k${String(index + 1)}`,
        source_key: `k${String(index + 1)}`,
        local_path: "temp",
        path: `run_0${String(index + 1)}/temp`,
        unit: null,
        point_count: "2",
        t_min: 0,
        t_max: 1,
        last_value: null,
      })),
    );
    const state = timeState(
      Array.from({ length: 10 }, (_, index) =>
        visible(`run_0${String(index + 1)}/temp`),
      ),
    );
    state.focus = state.series.map(
      (series): FocusEntry => ({
        kind: "series",
        ref: series.ref,
        source_key: null,
        channel: null,
      }),
    );
    const result = focusChips(catalog, state);
    expect(result.chips).toHaveLength(8);
    expect(result.overflow).toBe(2);
  });

  it("uses the in-plot keys as the only legend surface", () => {
    const catalog = Catalog.build([
      summary("run_07/temp"),
      summary("run_08/temp"),
    ]);
    const state = timeState([
      visible("run_07/temp"),
      { ...visible("run_08/temp"), display: "ghost", focused: false },
    ]);
    state.focus = [
      {
        kind: "series",
        ref: state.series[0]?.ref ?? null,
        source_key: null,
        channel: "temp",
      },
    ];
    state.ghost_mode = "ghost";
    const onLegendLayout = vi.fn();
    const view = Object.create(PanelView.prototype) as unknown as {
      callbacks: Pick<
        PanelCallbacks,
        | "catalog"
        | "onFocusToggle"
        | "onFocusSolo"
        | "onMuteSeries"
        | "onMuteSelector"
        | "onLegendLayout"
      >;
      element: HTMLElement;
      plotLegendPosition: { x: number; y: number } | null;
      plotLegendSize: { width: number; height: number } | null;
      plotLegendAnchor: null;
      updateLegend(current: RenderPanelState): void;
    };
    view.callbacks = {
      catalog: () => catalog,
      onFocusToggle: vi.fn(),
      onFocusSolo: vi.fn(),
      onMuteSeries: vi.fn(),
      onMuteSelector: vi.fn(),
      onLegendLayout,
    };
    Object.assign(view, { id: "panel" });
    view.plotLegendPosition = null;
    view.plotLegendSize = null;
    view.plotLegendAnchor = null;
    view.element = document.createElement("article");
    view.element.innerHTML =
      '<div class="plot-wrap"><div class="plot-series-legend"></div></div>';
    view.updateLegend(state);
    expect(view.element.querySelector(".panel-legend-strip")).toBeNull();
    expect(
      view.element.querySelector(".plot-legend-row")?.textContent,
    ).toContain("run_07");
    expect(view.element.querySelector(".plot-legend-footer")?.textContent).toBe(
      "1 ghosts ▾0 overrides ▾",
    );
    view.element
      .querySelector<HTMLButtonElement>(".plot-legend-footer button")
      ?.click();
    expect(onLegendLayout).toHaveBeenCalledWith("panel", { state: "roster" });
  });

  it("persists resize and keyboard movement without a hide control", () => {
    const paths = Array.from(
      { length: 8 },
      (_, index) => `run_${String(index + 1).padStart(2, "0")}/temp`,
    );
    const catalog = Catalog.build(paths.map(summary));
    const state = timeState(paths.map(visible));
    state.focus = state.series.map((series) => ({
      kind: "series",
      ref: series.ref,
      source_key: null,
      channel: series.ref.channel,
    }));
    const onLegendLayout = vi.fn();
    const view = Object.create(PanelView.prototype) as unknown as {
      callbacks: Pick<
        PanelCallbacks,
        | "catalog"
        | "onFocusToggle"
        | "onFocusSolo"
        | "onMuteSeries"
        | "onMuteSelector"
        | "onLegendLayout"
      >;
      element: HTMLElement;
      plotLegendPosition: { x: number; y: number } | null;
      plotLegendSize: { width: number; height: number } | null;
      plotLegendAnchor: null;
      plotLegendNearRightEdge(legend: HTMLElement): boolean;
      plotLegendTouchesRightEdge(legend: HTMLElement): boolean;
      updatePlotLegend(current: RenderPanelState): void;
    };
    view.callbacks = {
      catalog: () => catalog,
      onFocusToggle: vi.fn(),
      onFocusSolo: vi.fn(),
      onMuteSeries: vi.fn(),
      onMuteSelector: vi.fn(),
      onLegendLayout,
    };
    Object.assign(view, { id: "panel" });
    view.element = document.createElement("article");
    view.element.innerHTML =
      '<div class="plot-wrap"><div class="plot-series-legend"></div></div>';
    view.plotLegendPosition = null;
    view.plotLegendSize = null;
    view.plotLegendAnchor = null;
    const wrap = view.element.querySelector<HTMLElement>(".plot-wrap");
    const legend = view.element.querySelector<HTMLElement>(
      ".plot-series-legend",
    );
    if (wrap === null || legend === null) throw new Error("Legend is missing");
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    } as DOMRect);
    vi.spyOn(legend, "getBoundingClientRect").mockReturnValue({
      left: 172,
      top: 8,
      width: 220,
      height: 180,
    } as DOMRect);

    view.updatePlotLegend(state);
    expect(legend.querySelectorAll(".plot-legend-row")).toHaveLength(8);
    expect(
      legend.querySelector(".plot-legend-focus-rows")?.children,
    ).toHaveLength(8);
    expect(view.plotLegendNearRightEdge(legend)).toBe(true);
    expect(view.plotLegendTouchesRightEdge(legend)).toBe(true);
    legend
      .querySelector<HTMLButtonElement>(".plot-legend-resize-bottom")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(onLegendLayout).toHaveBeenCalledWith(
      "panel",
      expect.objectContaining({ state: "rail", size: [160, 196] }),
    );
    legend
      .querySelector<HTMLButtonElement>(".plot-legend-drag")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(legend.style.left).toBe("164px");
    legend
      .querySelector<HTMLButtonElement>(".plot-legend-drag")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(onLegendLayout).toHaveBeenCalledWith(
      "panel",
      expect.objectContaining({ state: "rail", position: null }),
    );
    expect(legend.querySelector(".plot-legend-hide")).toBeNull();
  });

  it("reflows around a full-height rail and returns it to floating", () => {
    const paths = Array.from(
      { length: 12 },
      (_, index) => `run_${String(index + 1).padStart(2, "0")}/temp`,
    );
    const state = timeState(paths.map(visible));
    state.legend_state = "rail";
    state.legend_size = [180, 240];
    const onLegendLayout = vi.fn();
    const view = Object.create(PanelView.prototype) as unknown as {
      id: string;
      callbacks: Pick<
        PanelCallbacks,
        | "catalog"
        | "onFocusToggle"
        | "onFocusSolo"
        | "onMuteSeries"
        | "onMuteSelector"
        | "onLegendLayout"
      >;
      element: HTMLElement;
      plotLegendPosition: null;
      plotLegendSize: null;
      plotLegendAnchor: null;
      updatePlotLegend(current: RenderPanelState): void;
    };
    view.id = "panel";
    view.callbacks = {
      catalog: () => Catalog.build(paths.map(summary)),
      onFocusToggle: vi.fn(),
      onFocusSolo: vi.fn(),
      onMuteSeries: vi.fn(),
      onMuteSelector: vi.fn(),
      onLegendLayout,
    };
    view.element = document.createElement("article");
    view.element.innerHTML = `<div class="plot-wrap">
      <div class="chart-host"></div>
      <canvas class="overlay-canvas"></canvas>
      <div class="plot-series-legend"></div>
      <div class="panel-empty"></div>
    </div>`;
    view.plotLegendPosition = null;
    view.plotLegendSize = null;
    view.plotLegendAnchor = null;
    const wrap = view.element.querySelector<HTMLElement>(".plot-wrap");
    const legend = view.element.querySelector<HTMLElement>(
      ".plot-series-legend",
    );
    if (wrap === null || legend === null) throw new Error("Legend is missing");
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 500,
      top: 0,
      width: 500,
      height: 300,
    } as DOMRect);
    vi.spyOn(legend, "getBoundingClientRect").mockReturnValue({
      left: 320,
      right: 500,
      top: 0,
      width: 180,
      height: 300,
    } as DOMRect);

    view.updatePlotLegend(state);
    expect(wrap.classList.contains("legend-rail")).toBe(true);
    expect(wrap.style.getPropertyValue("--plot-legend-rail-width")).toBe(
      "180px",
    );
    expect(legend.style.height).toBe("100%");
    expect(legend.querySelector(".plot-legend-roster")).not.toBeNull();
    legend.querySelector<HTMLButtonElement>(".plot-legend-undock")?.click();
    expect(onLegendLayout).toHaveBeenCalledWith("panel", {
      state: "roster",
      position: null,
      size: [180, 180],
      anchor: "top_right",
    });

    state.legend_size = [0, 300];
    view.updatePlotLegend(state);
    expect(wrap.classList.contains("legend-rail-collapsed")).toBe(true);
    expect(wrap.style.getPropertyValue("--plot-legend-rail-width")).toBe("5px");
    expect(legend.dataset.collapsed).toBe("true");
    onLegendLayout.mockClear();
    legend
      .querySelector<HTMLButtonElement>(".plot-legend-resize-left")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(onLegendLayout).toHaveBeenCalledWith("panel", {
      state: "rail",
      position: null,
      size: [225, 300],
      anchor: null,
    });

    onLegendLayout.mockClear();
    state.legend_state = "badge";
    state.legend_size = null;
    view.updatePlotLegend(state);
    legend
      .querySelector<HTMLButtonElement>(".plot-legend-badge-drag")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(onLegendLayout).toHaveBeenCalledWith(
      "panel",
      expect.objectContaining({ state: "rail", position: null }),
    );

    state.series = [];
    view.updatePlotLegend(state);
    expect(legend.dataset.state).toBeUndefined();
    expect(legend.dataset.collapsed).toBeUndefined();
    expect(wrap.classList.contains("legend-rail")).toBe(false);
  });

  it("scrolls and searches the inline source roster", () => {
    const paths = Array.from(
      { length: 100 },
      (_, index) => `run_${String(index + 1).padStart(3, "0")}/temp`,
    );
    const state = timeState(paths.map(visible));
    state.legend_state = "roster";
    const view = Object.create(PanelView.prototype) as unknown as {
      id: string;
      callbacks: Pick<
        PanelCallbacks,
        | "catalog"
        | "onFocusToggle"
        | "onFocusSolo"
        | "onMuteSeries"
        | "onMuteSelector"
        | "onLegendLayout"
      >;
      element: HTMLElement;
      plotLegendPosition: null;
      plotLegendSize: null;
      plotLegendAnchor: null;
      refreshPlotLegendRoster(): void;
      updatePlotLegend(current: RenderPanelState): void;
    };
    view.id = "panel";
    view.callbacks = {
      catalog: () => Catalog.build(paths.map(summary)),
      onFocusToggle: vi.fn(),
      onFocusSolo: vi.fn(),
      onMuteSeries: vi.fn(),
      onMuteSelector: vi.fn(),
      onLegendLayout: vi.fn(),
    };
    view.element = document.createElement("article");
    view.element.innerHTML =
      '<div class="plot-wrap"><div class="plot-series-legend"></div></div>';
    view.plotLegendPosition = null;
    view.plotLegendSize = null;
    view.plotLegendAnchor = null;
    view.updatePlotLegend(state);
    const rows = view.element.querySelector<HTMLElement>(
      ".plot-legend-roster-rows",
    );
    const viewport = view.element.querySelector<HTMLElement>(
      ".plot-legend-roster-viewport",
    );
    const search = view.element.querySelector<HTMLInputElement>(
      ".plot-legend-search",
    );
    if (rows === null || viewport === null || search === null)
      throw new Error("Roster is missing");
    expect(viewport.style.height).toBe("2400px");
    const initialRows = viewport.children.length;
    Object.defineProperty(rows, "clientHeight", { value: 480 });
    view.refreshPlotLegendRoster();
    expect(viewport.children.length).toBeGreaterThan(initialRows);
    rows.scrollTop = 2176;
    rows.dispatchEvent(new Event("scroll"));
    expect(viewport.lastElementChild?.textContent).toContain("run_100");

    search.value = "* @ run_100";
    search.dispatchEvent(new Event("input"));
    expect(rows.scrollTop).toBe(0);
    expect(viewport.querySelectorAll(".plot-legend-roster-row")).toHaveLength(
      1,
    );
    expect(viewport.textContent).toContain("run_100");
  });

  it("groups pick bindings and counts live query and set members", () => {
    const catalog = Catalog.build(
      ["run_01", "run_02", "run_03"].flatMap((source) =>
        ["temp", "speed"].map((channel) => ({
          signal_id: `${source}-${channel}`,
          source_id: `k${source.slice(-1)}`,
          source_key: `k${source.slice(-1)}`,
          local_path: channel,
          path: `${source}/${channel}`,
          unit: null,
          point_count: "2",
          t_min: 0,
          t_max: 1,
          last_value: null,
        })),
      ),
    );
    const state = timeState([visible("run_01/temp")]);
    state.bindings = [
      {
        kind: "pick",
        selector: null,
        refs: [
          { source_key: "k1", channel: "temp" },
          { source_key: "k2", channel: "temp" },
          { source_key: "k3", channel: "speed" },
        ],
        set_id: null,
      },
      { kind: "query", selector: "temp", refs: [], set_id: null },
      { kind: "set", selector: null, refs: [], set_id: "live" },
    ];
    expect(
      bindingChipEntries(catalog, state, [
        {
          id: "live",
          name: "Live temps",
          kind: "query",
          selector: "temp",
          refs: [],
        },
      ]),
    ).toEqual([
      expect.objectContaining({ label: "temp ×2", bindingIndex: 0 }),
      expect.objectContaining({ label: "speed ×1", bindingIndex: 0 }),
      expect.objectContaining({ label: "temp · 3", bindingIndex: 1 }),
      expect.objectContaining({ label: "★ Live temps · 3", bindingIndex: 2 }),
    ]);
  });
});

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { SignalSummary } from "../generated/protocol";
import type { FocusEntry, PanelState } from "../generated/session";
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
  effectiveAxisStyle,
  legendTokenLabel,
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

describe("effectiveAxisStyle", () => {
  it("forces gutter for time mode where ChartGPU always draws gutter axes", () => {
    expect(effectiveAxisStyle("time", "inline")).toBe("gutter");
    expect(effectiveAxisStyle("time", "gutter")).toBe("gutter");
  });
});

describe("panel markup", () => {
  it("offers no mode selection", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const panel = new PanelView("panel", {} as PanelCallbacks);
    expect(panel.element.querySelectorAll(".mode-pill")).toHaveLength(0);
    expect(panel.element.querySelector(".xy-drop-strip")).toBeNull();
    panel.dispose();
    vi.unstubAllGlobals();
  });

  it("releases its chart host without disposing the panel", () => {
    const dispose = vi.fn();
    const chartHostElement = document.createElement("div");
    const view = Object.create(PanelView.prototype) as {
      gpu: GpuContext | null;
      chartBanks: { dispose(): void } | null;
      pendingChartRenders: Map<string, object>;
      chartHostElement: HTMLElement;
      disposed: boolean;
      releaseGpu(): void;
    };
    view.gpu = {} as GpuContext;
    view.chartBanks = { dispose };
    view.pendingChartRenders = new Map([["detail", {}]]);
    view.chartHostElement = chartHostElement;
    view.disposed = false;

    view.releaseGpu();

    expect(dispose).toHaveBeenCalledOnce();
    expect(view.gpu).toBeNull();
    expect(view.chartBanks).toBeNull();
    expect(view.pendingChartRenders.size).toBe(1);
    expect(chartHostElement.hidden).toBe(true);
    expect(view.disposed).toBe(false);
  });

  it("resizes presentation banks when the window device scale changes", () => {
    const onResized = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal("devicePixelRatio", 1);
    const view = new PanelView("panel", {
      onResized,
    } as unknown as PanelCallbacks);
    const resize = vi.fn();
    const dispose = vi.fn();
    (
      view as unknown as {
        chartBanks: {
          resize(): void;
          layout(): PlotLayout | null;
          dispose(): void;
        } | null;
      }
    ).chartBanks = { resize, layout: () => null, dispose };

    vi.stubGlobal("devicePixelRatio", 2);
    window.dispatchEvent(new Event("resize"));

    expect(resize).toHaveBeenCalledOnce();
    expect(onResized).toHaveBeenCalledWith("panel");
    view.dispose();
    vi.unstubAllGlobals();
  });

  it("defers an observed resize until an active gesture finishes", () => {
    let notifyResize = (): void => {
      throw new Error("resize observer was not created");
    };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this);
        }
        observe(): void {}
        disconnect(): void {}
        unobserve(): void {}
      },
    );
    const onResized = vi.fn();
    const onGesture = vi.fn();
    const view = new PanelView("panel", {
      onResized,
      onGesture,
    } as unknown as PanelCallbacks);
    const resize = vi.fn();
    const dispose = vi.fn();
    (
      view as unknown as {
        chartBanks: {
          resize(): void;
          layout(): PlotLayout | null;
          dispose(): void;
        } | null;
      }
    ).chartBanks = { resize, layout: () => null, dispose };
    const interactions = (
      view as unknown as {
        interactions: { isDragging(): boolean };
      }
    ).interactions;
    const dragging = vi.spyOn(interactions, "isDragging").mockReturnValue(true);

    notifyResize();

    expect(resize).not.toHaveBeenCalled();
    expect(onResized).not.toHaveBeenCalled();
    dragging.mockReturnValue(false);
    (
      view as unknown as {
        handleGesture(hint: string | null): void;
      }
    ).handleGesture(null);
    expect(resize).toHaveBeenCalledOnce();
    expect(onResized).toHaveBeenCalledWith("panel");
    expect(onGesture).toHaveBeenCalledWith("panel", null);
    view.dispose();
    vi.unstubAllGlobals();
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
  };
}

function timeState(series: RenderSeries[]): RenderPanelState {
  return {
    id: "panel",
    title: "Time",
    mode: "time",
    axis_style: "gutter",
    color_by: "source",
    ghost_mode: "all",
    split_by: "none",
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
  };
}

describe("panel series", () => {
  it("uses a fallback-safe maximize glyph", () => {
    expect(MAXIMIZE_GLYPH).toBe("↗");
  });

  it("keeps the panel member cap available for ordinary series", () => {
    expect(MAX_SERIES_PER_PANEL).toBe(64);
  });

  describe.each(["time"] as const)("%s plot gestures", (mode) => {
    it("uses shift-click for focus and alt-click for mute", () => {
      const onFocusToggle = vi.fn();
      const onMuteSeries = vi.fn();
      const callbacks = {
        onFocusToggle,
        onMuteSeries,
      } as unknown as PanelCallbacks;
      const view = Object.create(PanelView.prototype) as unknown as {
        callbacks: PanelCallbacks;
        chartBanks: { layout(): PlotLayout | null } | null;
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
      view.chartBanks = { layout: () => gestureLayout };
      view.lastState = { ...timeState([series]), mode };
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
      chartBanks: { layout(): PlotLayout | null } | null;
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
    view.chartBanks = { layout: () => gestureLayout };
    view.lastState = timeState([series]);
    view.preparedPlot = {
      annotationAt: () => ({
        path: series.path,
        domain: "time",
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

  it("compresses a focused dimension into a value plus remainder count", () => {
    const catalog = Catalog.build(
      Array.from({ length: 12 }, (_, index) => ({
        signal_id: `run-${String(index + 1)}-temp`,
        source_id: `k${String(index + 1)}`,
        source_key: `k${String(index + 1)}`,
        local_path: "temp",
        path: `run_${String(index + 1).padStart(2, "0")}/temp`,
        unit: "K",
        point_count: "2",
        t_min: 0,
        t_max: 1,
        last_value: null,
      })),
    );
    const state = timeState(
      Array.from({ length: 12 }, (_, index) =>
        visible(`run_${String(index + 1).padStart(2, "0")}/temp`),
      ),
    );
    state.focus = [
      { kind: "channel", ref: null, source_key: null, channel: "temp" },
    ];
    expect(legendTokenLabel(catalog, state, "channel", 12)).toBe("temp +11 ▾");
    state.focus = [];
    expect(legendTokenLabel(catalog, state, "channel", 12)).toBe("12 ▾");
  });

  it("renders one dash key per rendered channel in a focused source chip", () => {
    const catalog = Catalog.build([
      summary("run_07/temp"),
      summary("run_07/temp_sp"),
    ]);
    const state = timeState([
      visible("run_07/temp"),
      visible("run_07/temp_sp"),
    ]);
    state.focus = [
      { kind: "source", ref: null, source_key: "k7", channel: null },
    ];
    const view = Object.create(PanelView.prototype) as unknown as {
      callbacks: Pick<PanelCallbacks, "catalog">;
      focusChipElements(current: RenderPanelState): HTMLElement[];
    };
    view.callbacks = { catalog: () => catalog };
    const [chip] = view.focusChipElements(state);
    expect(chip?.querySelectorAll(".matrix-focus-key")).toHaveLength(2);
  });

  it("shows line-style state and opens a ghost-filtered roster", () => {
    const catalog = Catalog.build([
      summary("run_07/temp"),
      summary("run_08/temp"),
    ]);
    const state = timeState([
      visible("run_07/temp"),
      { ...visible("run_08/temp"), display: "ghost", focused: false },
    ]);
    state.ghost_mode = "ghost";
    const view = Object.create(PanelView.prototype) as unknown as {
      callbacks: Pick<PanelCallbacks, "catalog">;
      element: HTMLElement;
      updateLegend(current: RenderPanelState): void;
    };
    view.callbacks = { catalog: () => catalog };
    view.element = document.createElement("article");
    view.element.innerHTML =
      '<div class="panel-legend"></div><span class="panel-gesture-hint"></span>';
    view.updateLegend(state);
    expect(view.element.querySelector(".panel-gesture-hint")?.textContent).toBe(
      "· line style flat · hover explore · ⇧click focus · ⌥ mute · esc clear",
    );
    state.overrides = [
      {
        target_ref: { source_key: "run-07", channel: "temp" },
        target_selector: null,
        color_slot: null,
        dash: "dash",
        width: null,
        opacity: null,
        visible: null,
      },
    ];
    view.updateLegend(state);
    expect(
      view.element.querySelector(".panel-gesture-hint")?.textContent,
    ).toContain("line style ◆ overridden");
    const ghost = view.element.querySelector<HTMLButtonElement>(
      ".legend-ghost-token",
    );
    expect(ghost?.textContent).toBe("1 ghosts ▾");
    ghost?.click();
    expect(
      view.element.querySelector<HTMLElement>(".matrix-roster")?.dataset.filter,
    ).toBe("ghost");
    expect(
      view.element.querySelector(".matrix-roster-row")?.textContent,
    ).toContain("run_08");
  });

  it("lays out style rules with a palette, static line rules, and override actions", () => {
    const catalog = Catalog.build([summary("run_07/temp")]);
    const state = timeState([visible("run_07/temp")]);
    state.overrides = [
      {
        target_ref: { source_key: "k7", channel: "temp" },
        target_selector: null,
        color_slot: 2,
        dash: null,
        width: 2.5,
        opacity: null,
        visible: null,
      },
    ];
    const onSetColorBy = vi.fn();
    const onRemoveOverride = vi.fn();
    const onClearOverrides = vi.fn();
    const view = Object.create(PanelView.prototype) as unknown as {
      id: string;
      callbacks: Pick<
        PanelCallbacks,
        | "catalog"
        | "namedSets"
        | "pathForRef"
        | "onSetColorBy"
        | "onRemoveOverride"
        | "onClearOverrides"
      >;
      element: HTMLElement;
      lastInputState: PanelState;
      openRulesPopover(current: RenderPanelState, anchor: HTMLElement): void;
    };
    view.id = "panel-1";
    view.callbacks = {
      catalog: () => catalog,
      namedSets: () => [],
      pathForRef: (ref) => `${ref.source_key}/${ref.channel}`,
      onSetColorBy,
      onRemoveOverride,
      onClearOverrides,
    };
    view.element = document.createElement("article");
    const anchor = document.createElement("button");
    view.element.append(anchor);
    view.lastInputState = {
      ...state,
    } as unknown as PanelState;
    view.openRulesPopover(state, anchor);

    expect(
      view.element.querySelector(".rules-popover-title")?.textContent,
    ).toBe("STYLE RULES — PANEL 1");
    expect(view.element.querySelectorAll(".rules-rule-row")).toHaveLength(3);
    expect(view.element.querySelectorAll(".rules-palette-swatch")).toHaveLength(
      8,
    );
    expect(view.element.querySelector(".rules-rule-static")?.textContent).toBe(
      "dash ← — flat",
    );
    expect(view.element.querySelector(".rules-override-key")?.textContent).toBe(
      "color",
    );
    expect(
      view.element.querySelector(".rules-override-target")?.textContent,
    ).toBe("k7/temp");
    expect(
      view.element.querySelector(".rules-override-fields")?.textContent,
    ).toBe("width 2.5 · highlight");
    view.element
      .querySelector<HTMLButtonElement>(".rules-override-row button")
      ?.click();
    expect(onRemoveOverride).toHaveBeenCalledWith("panel-1", 0);
    view.openRulesPopover(state, anchor);
    view.element.querySelector<HTMLButtonElement>(".rules-revert-all")?.click();
    expect(onClearOverrides).toHaveBeenCalledWith("panel-1");
    view.openRulesPopover(state, anchor);
    view.element
      .querySelector<HTMLButtonElement>(".rules-color-dimension")
      ?.click();
    expect(view.element.querySelectorAll(".rules-dimension")).toHaveLength(5);
    view.element
      .querySelector<HTMLButtonElement>(
        '.rules-dimension[data-dimension="channel"]',
      )
      ?.click();
    expect(onSetColorBy).toHaveBeenCalledWith("panel-1", "channel");
    view.openRulesPopover(state, anchor);
    view.element
      .querySelector<HTMLButtonElement>(".rules-channel-shortcut")
      ?.click();
    expect(onSetColorBy).toHaveBeenCalledWith("panel-1", "channel");
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

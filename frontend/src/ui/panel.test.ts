import { describe, expect, it, vi } from "vitest";
import type {
  SampleResponse,
  SampleSeries,
  SignalSummary,
} from "../generated/protocol";
import type { FocusEntry, PanelState } from "../generated/session";
import type { PathRenderOptions, PlotPath } from "../render/canvas-renderer";
import { Catalog } from "../app/catalog";
import type { PreparedPlot } from "../app/plot-capabilities";
import type { PlotLayout } from "../app/plot-math";

import { AppShell } from "./app-shell";
import {
  MAX_SERIES_PER_PANEL,
  MAXIMIZE_GLYPH,
  PanelView,
  bindingChipEntries,
  focusHeaderLabel,
  focusChips,
  matrixLegendRows,
  parseSetPayload,
  parseSignalPayload,
  type RenderPanelState,
  type RenderSeries,
  xChipLabel,
} from "./panel";
import type { PanelCallbacks } from "./panel";

function sample(
  path: string,
  values: number[],
  unit: string | null = null,
): SampleSeries {
  return {
    signal_id: path,
    signal_path: path,
    unit,
    time: [0, 1],
    values,
    stride: 1,
  };
}

function response(...series: SampleSeries[]): SampleResponse {
  return { request_id: "test", series };
}

function sourceKeyFor(path: string): string | null {
  const match = /^run_0*(\d+)\//.exec(path);
  return match === null ? null : `k${String(match[1])}`;
}

function localPathFor(path: string): string | null {
  const source = sourceKeyFor(path);
  return source === null ? null : (path.split("/").at(1) ?? null);
}

const xyCallbacks = { localPathFor, sourceKeyFor };

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

function xyState(xSignal: string, series: RenderSeries[]): RenderPanelState {
  return {
    id: "panel",
    title: "XY",
    mode: "xy",
    axis_style: "gutter",
    color_axis: "none",
    color_by: "source",
    ghost_mode: "all",
    split_by: "none",
    x_signal: xSignal,
    color_signal: null,
    color_by_time: false,
    bindings: [],
    overrides: [],
    focus: [],
    series,
    y_range: null,
    x_range: null,
    x_label: null,
    y_label: null,
    c_label: null,
    time_window: null,
    annotations: [],
    show_stats: false,
  };
}

function sessionXyState(
  xSignal: string,
  series: RenderSeries[],
  colorSignal: string | null,
): PanelState {
  const ref = (path: string) => {
    const [prefix, ...channel] = path.split("/");
    const sourcePrefix = prefix ?? "";
    return {
      source_key:
        sourceKeyFor(`${sourcePrefix}/${channel.join("/")}`) ?? sourcePrefix,
      channel: channel.join("/"),
    };
  };
  return {
    id: "panel",
    title: "XY",
    mode: "xy",
    axis_style: "gutter",
    x_ref: ref(xSignal),
    color_axis: colorSignal === null ? "none" : "signal",
    color_ref: colorSignal === null ? null : ref(colorSignal),
    bindings: [
      {
        kind: "pick",
        selector: null,
        refs: series.map((entry) => ref(entry.path)),
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
  };
}

interface PanelProbe {
  callbacks: typeof xyCallbacks;
  renderer: {
    renderPaths(paths: readonly PlotPath[], options: PathRenderOptions): number;
  };
  renderedPaths: readonly PlotPath[];
  renderedOptions: PathRenderOptions | null;
  xyTraces: Array<{
    path: string;
    trace: { time: number[]; x: number[]; y: number[] };
  }>;
  resolvePlotRanges(): {
    x: { min: number; max: number };
    y: { min: number; max: number };
  };
  renderXy(
    state: RenderPanelState,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number;
}

function panelProbe(): PanelProbe {
  const view = Object.create(PanelView.prototype) as PanelProbe;
  view.callbacks = xyCallbacks;
  view.renderedPaths = [];
  view.renderedOptions = null;
  view.renderer = {
    renderPaths(paths, options) {
      view.renderedPaths = paths;
      view.renderedOptions = options;
      return 1;
    },
  };
  view.resolvePlotRanges = () => ({
    x: { min: 0, max: 1 },
    y: { min: 0, max: 1 },
  });
  return view;
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

interface AppShellProbe {
  workspace: {
    derived(): { path: string }[];
    namedSets(): never[];
  };
  signals: SignalSummary[];
  signalsByPath: Map<string, SignalSummary>;
  catalog: Catalog;
  panelSignalIds(panel: PanelState): { ids: string[]; missing: string[] };
}

function appShellProbe(...signals: SignalSummary[]): AppShellProbe {
  const shell = Object.create(AppShell.prototype) as AppShellProbe;
  shell.workspace = {
    derived: () => [{ path: "derived/score" }],
    namedSets: () => [],
  };
  shell.signals = signals;
  shell.signalsByPath = new Map(signals.map((entry) => [entry.path, entry]));
  shell.catalog = Catalog.build(signals);
  return shell;
}

describe("panel series", () => {
  it("uses a fallback-safe maximize glyph", () => {
    expect(MAXIMIZE_GLYPH).toBe("↗");
  });

  it("keeps the panel member cap available for ordinary series", () => {
    expect(MAX_SERIES_PER_PANEL).toBe(64);
  });

  describe.each(["time", "xy", "fft", "histogram"] as const)(
    "%s plot gestures",
    (mode) => {
      it("uses shift-click for focus and alt-click for mute", () => {
        const onFocusToggle = vi.fn();
        const onMuteSeries = vi.fn();
        const callbacks = {
          onFocusToggle,
          onMuteSeries,
        } as unknown as PanelCallbacks;
        const view = Object.create(PanelView.prototype) as unknown as {
          callbacks: PanelCallbacks;
          renderer: { lastLayout(): PlotLayout };
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
        view.renderer = { lastLayout: () => gestureLayout };
        view.lastState = { ...xyState("run_01/temp", [series]), mode };
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
    },
  );

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
      renderer: { lastLayout(): PlotLayout };
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
    view.renderer = { lastLayout: () => gestureLayout };
    view.lastState = xyState("run_01/temp", [series]);
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

  it("parses named set drag payloads", () => {
    expect(parseSetPayload(JSON.stringify({ set_id: "set-3" }))).toBe("set-3");
    expect(parseSetPayload(JSON.stringify({ set_id: 3 }))).toBeNull();
    expect(parseSetPayload("not json")).toBeNull();
  });

  it("omits the trace when a source lacks the X local path instead of cross-pairing", () => {
    const xSeries = sample("run_01/temp", [10, 20]);
    const samples = response(
      xSeries,
      sample("run_01/alt", [1, 2]),
      sample("run_02/alt", [3, 4]),
    );
    const view = panelProbe();

    view.renderXy(
      xyState("run_01/temp", [visible("run_01/alt"), visible("run_02/alt")]),
      samples,
      { t0: 0, t1: 1 },
    );

    expect(view.xyTraces).toEqual([
      {
        path: "run_01/alt",
        colorIndex: 0,
        dash: "solid",
        width: 1.4,
        trace: { time: [0, 1], x: [10, 20], y: [1, 2] },
      },
    ]);
  });

  it("derived Y pairs against x_signal directly", () => {
    const xSeries = sample("run_01/temp", [10, 20]);
    const samples = response(xSeries, sample("derived/score", [1, 2]));
    const view = panelProbe();

    view.renderXy(xyState("run_01/temp", [visible("derived/score")]), samples, {
      t0: 0,
      t1: 1,
    });

    expect(view.xyTraces).toEqual([
      {
        path: "derived/score",
        colorIndex: 0,
        dash: "solid",
        width: 1.4,
        trace: { time: [0, 1], x: [10, 20], y: [1, 2] },
      },
    ]);
  });

  it("colors each trace from its own source's color signal", () => {
    const samples = response(
      sample("run_01/t", [0, 1]),
      sample("run_01/temp", [10, 20]),
      sample("run_01/alt", [1, 2]),
      sample("run_02/t", [0, 1]),
      sample("run_02/temp", [100, 200]),
      sample("run_02/alt", [3, 4]),
    );
    const state = xyState("run_01/t", [
      visible("run_01/alt"),
      visible("run_02/alt"),
    ]);
    state.color_signal = "run_01/temp";
    const view = panelProbe();

    view.renderXy(state, samples, { t0: 0, t1: 1 });

    expect(view.renderedPaths[3]?.colorValues).toEqual([90 / 190, 1]);
  });

  it("leaves a trace uncolored when its source lacks the color local path", () => {
    const samples = response(
      sample("run_01/t", [0, 1]),
      sample("run_01/temp", [10, 20]),
      sample("run_01/alt", [1, 2]),
      sample("run_02/t", [0, 1]),
      sample("run_02/alt", [3, 4]),
    );
    const state = xyState("run_01/t", [
      visible("run_01/alt"),
      visible("run_02/alt"),
    ]);
    state.color_signal = "run_01/temp";
    const view = panelProbe();

    view.renderXy(state, samples, { t0: 0, t1: 1 });

    expect(view.renderedPaths[2]?.colorValues).toEqual([0, 1]);
    expect(view.renderedPaths[3]?.colorValues).toBeUndefined();
  });

  it("uses the selected color signal directly for a derived Y trace", () => {
    const samples = response(
      sample("run_01/t", [0, 1]),
      sample("run_01/temp", [10, 20]),
      sample("derived/score", [1, 2]),
    );
    const state = xyState("run_01/t", [visible("derived/score")]);
    state.color_signal = "run_01/temp";
    const view = panelProbe();

    view.renderXy(state, samples, { t0: 0, t1: 1 });

    expect(view.renderedPaths[1]?.colorValues).toEqual([0, 1]);
  });

  it("uses local paths for multi-source XY axis and color labels", () => {
    const samples = response(
      sample("run_01/t", [0, 1], "s"),
      sample("run_01/temp", [10, 20], "C"),
      sample("run_01/alt", [1, 2]),
      sample("run_02/t", [0, 1], "s"),
      sample("run_02/temp", [30, 40], "C"),
      sample("run_02/alt", [3, 4]),
    );
    const state = xyState("run_01/t", [
      visible("run_01/alt"),
      visible("run_02/alt"),
    ]);
    state.color_signal = "run_01/temp";
    const view = panelProbe();

    view.renderXy(state, samples, { t0: 0, t1: 1 });

    expect(view.renderedOptions?.xLabel).toBe("t (s)");
    expect(view.renderedOptions?.colorbar?.label).toBe("temp (C)");
    expect(xChipLabel(state.color_signal, state.series, xyCallbacks)).toBe(
      "temp",
    );

    state.x_label = "phase";
    state.c_label = "temperature";
    view.renderXy(state, samples, { t0: 0, t1: 1 });

    expect(view.renderedOptions?.xLabel).toBe("phase");
    expect(view.renderedOptions?.colorbar?.label).toBe("temperature");
  });

  it("requests each source's resolved color signal for XY samples", () => {
    const shell = appShellProbe(
      summary("run_01/t"),
      summary("run_01/temp"),
      summary("run_01/alt"),
      summary("run_02/t"),
      summary("run_02/temp"),
      summary("run_02/alt"),
    );
    const state = sessionXyState(
      "run_01/t",
      [visible("run_01/alt"), visible("run_02/alt"), visible("derived/score")],
      "run_01/temp",
    );

    expect(shell.panelSignalIds(state)).toEqual({
      ids: [
        "id:run_01/t",
        "id:run_01/alt",
        "id:run_02/alt",
        "id:run_02/t",
        "id:run_01/temp",
        "id:run_02/temp",
      ],
      missing: [],
    });
  });

  it("x chip shows the local path when visible series span multiple sources", () => {
    expect(
      xChipLabel(
        "run_01/temp",
        [visible("run_01/alt"), visible("run_02/alt")],
        xyCallbacks,
      ),
    ).toBe("temp");
    expect(
      xChipLabel("run_01/temp", [visible("run_01/alt")], xyCallbacks),
    ).toBe("run_01/temp");
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
    const state = xyState("run_01/temp", [
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
    const state = xyState(
      "run_01/temp",
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
    const state = xyState("run_01/temp", [visible("run_01/temp")]);
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

  it("reports the first focused series and its stack position", () => {
    const state = xyState("run_01/temp", [
      visible("run_01/temp"),
      visible("run_02/temp"),
    ]);
    state.focus = [
      {
        kind: "series",
        ref: state.series[1]?.ref ?? null,
        source_key: null,
        channel: null,
      },
      {
        kind: "series",
        ref: state.series[0]?.ref ?? null,
        source_key: null,
        channel: null,
      },
    ];
    expect(focusHeaderLabel(state)).toEqual({
      label: "run_02/temp",
      position: "1/2",
    });
  });
});

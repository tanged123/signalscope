import { describe, expect, it } from "vitest";
import type {
  SampleResponse,
  SampleSeries,
  SignalSummary,
} from "../generated/protocol";
import type { PanelState } from "../generated/session";
import type { PathRenderOptions, PlotPath } from "../render/canvas-renderer";
import { Catalog } from "../app/catalog";

import { AppShell } from "./app-shell";
import {
  MAX_SERIES_PER_PANEL,
  MAXIMIZE_GLYPH,
  PanelView,
  parseSignalPayload,
  type RenderPanelState,
  type RenderSeries,
  xChipLabel,
} from "./panel";

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
  if (path.startsWith("run_01/")) return "k1";
  if (path.startsWith("run_02/")) return "k2";
  return null;
}

function localPathFor(path: string): string | null {
  const source = sourceKeyFor(path);
  return source === null ? null : (path.split("/").at(1) ?? null);
}

const xyCallbacks = { localPathFor, sourceKeyFor };

function visible(path: string): RenderSeries {
  return {
    ref: {
      source_key: sourceKeyFor(path) ?? "",
      channel: localPathFor(path) ?? path,
    },
    path,
    color_slot: 1,
    dash: "solid",
    width: 1.4,
    visible: true,
    focused: true,
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

  it("parses signal drag paths", () => {
    expect(
      parseSignalPayload(JSON.stringify({ paths: ["a/alt", "b/alt"] })),
    ).toEqual(["a/alt", "b/alt"]);
    expect(parseSignalPayload("not json")).toEqual(["not json"]);
    expect(parseSignalPayload(JSON.stringify({ paths: [1] }))).toEqual([]);
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
});

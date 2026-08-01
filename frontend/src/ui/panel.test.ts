import { describe, expect, it } from "vitest";
import type {
  SampleResponse,
  SampleSeries,
  SignalSummary,
} from "../generated/protocol";
import type { PanelState, SeriesState } from "../generated/session";
import type { PathRenderOptions, PlotPath } from "../render/canvas-renderer";

import { AppShell } from "./app-shell";
import {
  BUNDLE_DRAG_TYPE,
  MAX_SERIES_PER_PANEL,
  MAXIMIZE_GLYPH,
  PanelView,
  SIGNAL_DRAG_TYPE,
  bundleXSignal,
  parseBundlePayload,
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

function visible(path: string): SeriesState {
  return { path, color_slot: 1, dash: "solid", width: 1.4, visible: true };
}

function xyState(xSignal: string, series: SeriesState[]): PanelState {
  return {
    id: "panel",
    title: "XY",
    mode: "xy",
    axis_style: "gutter",
    x_signal: xSignal,
    color_signal: null,
    color_by_time: false,
    series,
    highlighted_sources: [],
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
    state: PanelState,
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
  workspace: { derived(): { path: string }[] };
  signals: SignalSummary[];
  signalsByPath: Map<string, SignalSummary>;
  panelSignalIds(panel: PanelState): { ids: string[]; missing: string[] };
}

function appShellProbe(...signals: SignalSummary[]): AppShellProbe {
  const shell = Object.create(AppShell.prototype) as AppShellProbe;
  shell.workspace = { derived: () => [{ path: "derived/score" }] };
  shell.signals = signals;
  shell.signalsByPath = new Map(signals.map((entry) => [entry.path, entry]));
  return shell;
}

describe("panel series", () => {
  it("uses a fallback-safe maximize glyph", () => {
    expect(MAXIMIZE_GLYPH).toBe("↗");
  });

  it("keeps the panel member cap available for ordinary series", () => {
    expect(MAX_SERIES_PER_PANEL).toBe(64);
  });

  it("bundle drag type is distinct from the signal drag type", () => {
    expect(BUNDLE_DRAG_TYPE).not.toBe(SIGNAL_DRAG_TYPE);
    expect(BUNDLE_DRAG_TYPE.startsWith("application/x-signalscope")).toBe(true);
  });

  it("parses only string-array bundle member payloads", () => {
    expect(
      parseBundlePayload(
        JSON.stringify({
          local_path: "alt",
          member_paths: ["a/alt", "b/alt"],
        }),
      ),
    ).toEqual({ member_paths: ["a/alt", "b/alt"] });
    expect(parseBundlePayload("not json")).toBeNull();
    expect(
      parseBundlePayload(JSON.stringify({ member_paths: [1] })),
    ).toBeNull();
    expect(parseBundlePayload(JSON.stringify({}))).toBeNull();
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
    const state = xyState("run_01/t", [
      visible("run_01/alt"),
      visible("run_02/alt"),
      visible("derived/score"),
    ]);
    state.color_signal = "run_01/temp";

    expect(shell.panelSignalIds(state)).toEqual({
      ids: [
        "id:run_01/t",
        "id:run_01/alt",
        "id:run_02/alt",
        "id:run_02/t",
        "id:run_01/temp",
        "id:run_02/temp",
      ],
      missing: ["derived/score"],
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

  it("uses a bundle's sorted-first member as X when dropped on the strip", () => {
    expect(bundleXSignal(["run_02/alt", "run_01/alt"], true)).toBe(
      "run_01/alt",
    );
    expect(bundleXSignal(["run_02/alt", "run_01/alt"], false)).toBeUndefined();
  });
});

// Guards the geometryFor prepare-cache composition: a style-only change
// arrives with identity-stable tiles/samples (the app-shell caches hit), so
// the cached geometry must still be invalidated for modes that bake styles
// into prepare output.
import { describe, expect, it } from "vitest";
import type { EnvelopeBin, SampleResponse } from "../generated/protocol";
import { binColumnsFromWire } from "../app/bin-columns";
import type { ColumnarTileResponse } from "../app/bin-columns";
import type { PlotPath, RenderOptions } from "../render/canvas-renderer";
import { PanelView } from "./panel";
import type { RenderPanelState } from "./panel";

const callbacks = {
  sourceKeyFor: (path: string) => path.split("/")[0] ?? null,
  localPathFor: (path: string) => path.split("/").slice(1).join("/") || null,
};

function renderSeries(path: string, hue: number) {
  return {
    ref: { source_key: "run_0001", channel: "a" },
    path,
    display: "focus",
    hue,
    dash: "solid",
    width: 1.4,
    opacity: 1,
    visible: true,
    focused: false,
    overridden: false,
  };
}

function state(mode: string, paths: string[], hue: number): RenderPanelState {
  return {
    id: "panel",
    title: "T",
    mode,
    axis_style: "gutter",
    x_signal: null,
    color_signal: null,
    color_by_time: false,
    bindings: [],
    overrides: [],
    focus: [],
    series: paths.map((path) => renderSeries(path, hue)),
    y_range: null,
    x_range: null,
    x_label: null,
    y_label: null,
    c_label: null,
    time_window: null,
    annotations: [],
    show_stats: false,
    color_axis: "none",
    color_by: "source",
    ghost_mode: "all",
    split_by: "none",
    axis_equal: false,
  } as unknown as RenderPanelState;
}

function bin(t0: number, t1: number, v: number): EnvelopeBin {
  return {
    t0,
    t1,
    first: v,
    last: v,
    min: v,
    max: v,
    sum: v,
    sum_sq: v * v,
    finite_count: "1",
    sample_count: "1",
    has_gap: false,
  };
}

function tiles(paths: string[]): ColumnarTileResponse {
  return {
    requestId: "r",
    series: paths.map((path, index) => ({
      signalId: String(index),
      signalPath: path,
      unit: null,
      level: 0,
      bins: binColumnsFromWire([bin(0, 1, index), bin(1, 2, index + 1)]),
    })),
  } as ColumnarTileResponse;
}

interface Probe {
  prepCache: unknown;
  callbacks: typeof callbacks;
  emphasizePaths: null;
  preparedPlot: unknown;
  xyTraces: unknown;
  domainSeries: unknown;
  hasColorbar: unknown;
  lastBinOptions: RenderOptions | null;
  lastPaths: readonly PlotPath[] | null;
  renderer: unknown;
  resolvePlotRanges(): {
    x: { min: number; max: number };
    y: { min: number; max: number };
  };
  setModeEmpty(empty: boolean, note: string): void;
  renderForMode(
    state: RenderPanelState,
    tiles: ColumnarTileResponse | null,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number;
}

function probe(): Probe {
  const view = Object.create(PanelView.prototype) as Probe;
  view.prepCache = null;
  view.callbacks = callbacks;
  view.emphasizePaths = null;
  view.lastBinOptions = null;
  view.lastPaths = null;
  view.renderer = {
    render(_response: unknown, _xRange: unknown, options: RenderOptions) {
      view.lastBinOptions = options;
      return 1;
    },
    renderPaths(paths: readonly PlotPath[]) {
      view.lastPaths = paths;
      return 1;
    },
  };
  view.resolvePlotRanges = () => ({
    x: { min: 0, max: 2 },
    y: { min: 0, max: 3 },
  });
  view.setModeEmpty = () => undefined;
  return view;
}

describe("prepare cache vs style-only changes", () => {
  it("time mode re-renders with the new hue despite identical tiles", () => {
    const view = probe();
    const shared = tiles(["run_0001/a"]);
    const window = { t0: 0, t1: 2 };
    view.renderForMode(state("time", ["run_0001/a"], 1), shared, null, window);
    expect(view.lastBinOptions?.styles?.[0]?.hue).toBe(1);
    view.renderForMode(state("time", ["run_0001/a"], 4), shared, null, window);
    expect(view.lastBinOptions?.styles?.[0]?.hue).toBe(4);
  });

  it("xy mode re-renders with the new hue despite identical samples", () => {
    const view = probe();
    const samples = {
      request_id: "r",
      series: [
        {
          signal_path: "run_0001/x",
          unit: "V",
          time: [0, 1, 2],
          values: [1, 2, 3],
          stride: 1,
        },
        {
          signal_path: "run_0001/y",
          unit: "V",
          time: [0, 1, 2],
          values: [2, 3, 4],
          stride: 1,
        },
      ],
    } as unknown as SampleResponse;
    const window = { t0: 0, t1: 2 };
    const withHue = (hue: number) =>
      ({
        ...state("xy", ["run_0001/y"], hue),
        x_signal: "run_0001/x",
      }) as RenderPanelState;
    view.renderForMode(withHue(1), null, samples, window);
    expect(view.lastPaths?.[1]?.hue).toBe(1);
    view.renderForMode(withHue(4), null, samples, window);
    expect(view.lastPaths?.[1]?.hue).toBe(4);
  });
});

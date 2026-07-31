import { describe, expect, it } from "vitest";
import type { SampleResponse, SampleSeries } from "../generated/protocol";
import type { PanelState, SeriesState } from "../generated/session";

import {
  BUNDLE_DRAG_TYPE,
  MAX_SERIES_PER_PANEL,
  PanelView,
  SIGNAL_DRAG_TYPE,
  bundleXSignal,
  parseBundlePayload,
  xChipLabel,
} from "./panel";

function sample(path: string, values: number[]): SampleSeries {
  return {
    signal_id: path,
    signal_path: path,
    unit: null,
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
  renderer: { renderPaths(): number };
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
  view.renderer = { renderPaths: () => 1 };
  view.resolvePlotRanges = () => ({
    x: { min: 0, max: 1 },
    y: { min: 0, max: 1 },
  });
  return view;
}

describe("panel series", () => {
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

import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../../generated/protocol";
import {
  binColumnsFromWire,
  type ColumnarTileResponse,
} from "../../app/bin-columns";
import type { FrameInput, PrepareInput } from "./contract";
import { timeModule } from "./time";

const callbacks = {
  sourceKeyFor: (path: string) => path.split("/")[0] ?? null,
  localPathFor: (path: string) => path.split("/").slice(1).join("/") || null,
};

function renderSeries(path: string) {
  return {
    ref: { source_key: "run_0001", channel: "a" },
    path,
    display: "focus",
    hue: 1,
    dash: "solid",
    width: 1.4,
    opacity: 1,
    visible: true,
    focused: false,
    overridden: false,
  };
}

function state(paths: string[]) {
  return {
    id: "panel",
    title: "Time",
    mode: "time",
    axis_style: "gutter",
    x_signal: null,
    color_signal: null,
    color_by_time: false,
    bindings: [],
    overrides: [],
    focus: [],
    series: paths.map(renderSeries),
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
  } as unknown as Parameters<typeof timeModule.prepare>[0]["state"];
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

const frame: FrameInput = {
  window: { t0: 0, t1: 2 },
  emphasizePaths: null,
  resolveRanges: () => ({ x: { min: 0, max: 2 }, y: { min: 0, max: 3 } }),
};

describe("timeModule", () => {
  it("prepare filters hidden series out of the response", () => {
    const input: PrepareInput = {
      state: {
        ...state(["run_0001/a", "run_0001/b"]),
        series: [
          renderSeries("run_0001/a"),
          { ...renderSeries("run_0001/b"), visible: false },
        ],
      } as PrepareInput["state"],
      tiles: tiles(["run_0001/a", "run_0001/b"]),
      contextTiles: null,
      samples: null,
      callbacks,
    };
    const geometry = timeModule.prepare(input);
    expect(geometry.shown?.series.map((tile) => tile.signalPath)).toEqual([
      "run_0001/a",
    ]);
  });

  it("projects bins with per-series styles and emphasis indices", () => {
    const input: PrepareInput = {
      state: state(["run_0001/a", "run_0001/b"]),
      tiles: tiles(["run_0001/a", "run_0001/b"]),
      contextTiles: null,
      samples: null,
      callbacks,
    };
    const geometry = timeModule.prepare(input);
    const result = timeModule.project(geometry, input, {
      ...frame,
      emphasizePaths: new Set(["run_0001/b"]),
    });
    expect(result.plot.kind).toBe("bins");
    if (result.plot.kind !== "bins") return;
    expect(result.plot.response.series).toHaveLength(2);
    expect(result.plot.options.styles).toHaveLength(2);
    expect(result.plot.options.styles?.[0]).toEqual({
      hue: 1,
      dash: "solid",
      width: 1.4,
      alpha: 1,
    });
    expect(result.plot.options.emphasisIndices).toEqual([1]);
    expect(result.plot.options.xLabel).toBe("time (s)");
    expect(result.prepared).not.toBeNull();
  });

  it("configKey moves when only a series style changes", () => {
    const base = state(["run_0001/a"]);
    const restyled = {
      ...base,
      series: [{ ...renderSeries("run_0001/a"), hue: 4 }],
    } as typeof base;
    expect(timeModule.configKey(restyled)).not.toBe(timeModule.configKey(base));
  });

  it("returns empty with no tiles", () => {
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      contextTiles: null,
      samples: null,
      callbacks,
    };
    const result = timeModule.project(timeModule.prepare(input), input, frame);
    expect(result.plot.kind).toBe("empty");
    expect(result.prepared).toBeNull();
  });
});

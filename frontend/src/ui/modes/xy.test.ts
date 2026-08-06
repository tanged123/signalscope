import { describe, expect, it } from "vitest";
import type { SampleResponse, SampleSeries } from "../../generated/protocol";
import type { FrameInput, PrepareInput } from "./contract";
import { flattenTrace, xyModule } from "./xy";

const callbacks = {
  sourceKeyFor: (path: string) => path.split("/")[0] ?? null,
  localPathFor: (path: string) => path.split("/").slice(1).join("/") || null,
};

function renderSeries(path: string) {
  return {
    ref: { source_key: "run_0001", channel: "response" },
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
    title: "XY",
    mode: "xy",
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
    axis_equal: false,
  } as unknown as Parameters<typeof xyModule.prepare>[0]["state"];
}

function xyState(xSignal: string, paths: string[]) {
  return {
    ...state(paths),
    mode: "xy",
    x_signal: xSignal,
  } as Parameters<typeof xyModule.prepare>[0]["state"];
}

function series(path: string, time: number[], values: number[]): SampleSeries {
  return {
    signal_path: path,
    unit: "V",
    time,
    values,
    stride: 1,
  } as SampleSeries;
}

const frame: FrameInput = {
  window: { t0: 0, t1: 1 },
  emphasizePaths: null,
  resolveRanges: () => ({ x: { min: 0, max: 4 }, y: { min: 0, max: 4 } }),
};

describe("xyModule", () => {
  const samples = {
    request_id: "r",
    series: [
      series("run_0001/command", [0, 1, 2], [1, 2, 3]),
      series("run_0001/response", [0, 1, 2], [2, 3, 4]),
    ],
  } as SampleResponse;

  function input(): PrepareInput {
    return {
      state: xyState("run_0001/command", ["run_0001/response"]),
      tiles: null,
      samples,
      callbacks,
    };
  }

  it("projects the dimmed full trajectory under the lit windowed one", () => {
    const prep = input();
    const geometry = xyModule.prepare(prep);
    const result = xyModule.project(geometry, prep, frame);
    expect(result.plot.kind).toBe("paths");
    if (result.plot.kind !== "paths") return;
    expect(result.plot.paths).toHaveLength(2);
    const [dimmed, lit] = result.plot.paths;
    expect(dimmed?.dimmed).toBe(true);
    expect(dimmed?.width).toBe(1.2);
    const firstEntry = geometry.entries[0];
    expect(firstEntry).toBeDefined();
    if (firstEntry === undefined) return;
    expect(dimmed?.points).toEqual(flattenTrace(firstEntry.trace, null));
    expect(lit?.markers).toBe(true);
    expect(lit?.width).toBeCloseTo(1.4 + 0.4);
    // Window [0,1] lifts the pen on the sample at t=2.
    expect(lit?.points).toEqual([1, 2, 2, 3, Number.NaN, Number.NaN]);
    expect(result.xyTraces).toHaveLength(1);
    expect(result.hasColorbar).toBe(false);
    expect(result.plot.options.yLabel).toContain("V");
  });

  it("keeps trace and dimmed identity across frames (prepare not re-run)", () => {
    const prep = input();
    const geometry = xyModule.prepare(prep);
    const first = xyModule.project(geometry, prep, frame);
    const second = xyModule.project(geometry, prep, {
      ...frame,
      window: { t0: 1, t1: 2 },
    });
    if (first.plot.kind !== "paths" || second.plot.kind !== "paths") {
      throw new Error("expected paths");
    }
    expect(second.plot.paths[0]?.points).toBe(first.plot.paths[0]?.points);
    expect(second.xyTraces?.[0]?.trace).toBe(first.xyTraces?.[0]?.trace);
  });

  it("returns empty without an x signal or samples", () => {
    const noSamples: PrepareInput = { ...input(), samples: null };
    expect(
      xyModule.project(xyModule.prepare(noSamples), noSamples, frame).plot.kind,
    ).toBe("empty");
    const noX: PrepareInput = {
      ...input(),
      state: { ...input().state, x_signal: null },
    } as PrepareInput;
    const result = xyModule.project(xyModule.prepare(noX), noX, frame);
    expect(result.plot.kind).toBe("empty");
    expect(result.xyTraces).toEqual([]);
  });
});

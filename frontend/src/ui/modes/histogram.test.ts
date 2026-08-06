import { describe, expect, it } from "vitest";
import type { SampleResponse, SampleSeries } from "../../generated/protocol";
import { histogram } from "../../app/histogram";
import type { FrameInput, PrepareInput } from "./contract";
import { histogramModule } from "./histogram";

function series(path: string, time: number[], values: number[]): SampleSeries {
  return {
    signal_path: path,
    unit: "V",
    time,
    values,
    stride: 1,
  } as SampleSeries;
}

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
    title: "H",
    mode: "histogram",
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
  } as unknown as Parameters<typeof histogramModule.prepare>[0]["state"];
}

const frame: FrameInput = {
  window: { t0: 0, t1: 10 },
  emphasizePaths: null,
  resolveRanges: () => ({ x: { min: 0, max: 4 }, y: { min: 0, max: 5 } }),
};

describe("histogramModule", () => {
  it("projects the staircase outline the old renderHistogram produced", () => {
    const samples = {
      request_id: "r",
      series: [series("run_0001/a", [0, 1, 2, 3], [1, 1, 3, 3])],
    } as SampleResponse;
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples,
      callbacks,
    };
    const geometry = histogramModule.prepare(input);
    const result = histogramModule.project(geometry, input, frame);
    expect(result.plot.kind).toBe("paths");
    if (result.plot.kind !== "paths") return;
    expect(result.plot.paths).toHaveLength(1);
    // Reproduce the expected staircase from the same histogram() the module
    // must call — this pins the wiring, not the math.
    const binned = histogram([[1, 1, 3, 3]]);
    expect(binned).not.toBeNull();
    if (binned === null) return;
    const edges = binned.edges;
    const counts = binned.counts[0] ?? [];
    const expected: number[] = [edges[0] ?? 0, 0];
    counts.forEach((count, bin) => {
      expected.push(edges[bin] ?? 0, count, edges[bin + 1] ?? 0, count);
    });
    expected.push(edges[edges.length - 1] ?? 0, 0);
    expect(result.plot.paths[0]?.points).toEqual(expected);
    expect(result.plot.options.yLabel).toBe("sample count");
    expect(result.emptyState).toEqual({
      empty: false,
      note: "No values in view.",
    });
    expect(result.prepared).not.toBeNull();
  });

  it("returns the empty state when the window excludes every sample", () => {
    const samples = {
      request_id: "r",
      series: [series("run_0001/a", [100, 101], [1, 2])],
    } as SampleResponse;
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples,
      callbacks,
    };
    const result = histogramModule.project(
      histogramModule.prepare(input),
      input,
      frame,
    );
    expect(result.plot.kind).toBe("empty");
    expect(result.emptyState).toEqual({
      empty: true,
      note: "No values in view.",
    });
    expect(result.prepared).toBeNull();
  });

  it("returns silent empty when samples are null", () => {
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples: null,
      callbacks,
    };
    const result = histogramModule.project(
      histogramModule.prepare(input),
      input,
      frame,
    );
    expect(result.plot.kind).toBe("empty");
    expect(result.emptyState).toBeUndefined();
  });
});

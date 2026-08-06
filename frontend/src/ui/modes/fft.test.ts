import { describe, expect, it } from "vitest";
import type { SampleResponse, SampleSeries } from "../../generated/protocol";
import { spectrum } from "../../app/spectrum";
import type { FrameInput, PrepareInput } from "./contract";
import { fftModule } from "./fft";

function series(path: string, time: number[], values: number[]): SampleSeries {
  return {
    signal_path: path,
    unit: null,
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
    title: "FFT",
    mode: "fft",
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
  } as unknown as Parameters<typeof fftModule.prepare>[0]["state"];
}

const frame: FrameInput = {
  window: { t0: 0, t1: 1 },
  emphasizePaths: null,
  resolveRanges: () => ({ x: { min: 1, max: 100 }, y: { min: -120, max: 0 } }),
};

describe("fftModule", () => {
  it("projects the spectrum path the old renderSpectra produced", () => {
    const n = 128;
    const time = Array.from({ length: n }, (_, index) => index / (n - 1));
    const values = time.map((t) => Math.sin(2 * Math.PI * 8 * t));
    const source: SampleSeries = {
      signal_path: "run_0001/a",
      unit: null,
      time,
      values,
      stride: 1,
    } as SampleSeries;
    const samples = { request_id: "r", series: [source] } as SampleResponse;
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples,
      callbacks,
    };
    const result = fftModule.project(fftModule.prepare(input), input, frame);
    expect(result.plot.kind).toBe("paths");
    if (result.plot.kind !== "paths") return;
    const expected = spectrum(source, 0, 1);
    expect(expected).not.toBeNull();
    if (expected === null) return;
    const points: number[] = [];
    expected.frequency.forEach((frequency, index) => {
      points.push(frequency, expected.amplitudeDb[index] ?? -120);
    });
    expect(result.plot.paths[0]?.points).toEqual(points);
    expect(result.plot.options.xScale).toBe("log");
    expect(result.plot.options.yLabel).toBe("amplitude (dB)");
    expect(result.domainSeries).toHaveLength(1);
    expect(result.domainSeries?.[0]?.x).toEqual(expected.frequency);
    expect(result.emptyState).toEqual({
      empty: false,
      note: "Not enough samples in view.",
    });
  });

  it("reports the empty state when no series has enough samples", () => {
    const samples = {
      request_id: "r",
      series: [
        {
          signal_path: "run_0001/a",
          unit: null,
          time: [0, 0.5, 1],
          values: [1, 2, 3],
          stride: 1,
        } as SampleSeries,
      ],
    } as SampleResponse;
    const input: PrepareInput = {
      state: state(["run_0001/a"]),
      tiles: null,
      samples,
      callbacks,
    };
    const result = fftModule.project(fftModule.prepare(input), input, frame);
    expect(result.plot.kind).toBe("empty");
    expect(result.emptyState).toEqual({
      empty: true,
      note: "Not enough samples in view.",
    });
    // The old body still built preparedPlot from zero series before bailing.
    expect(result.prepared).not.toBeNull();
  });
});

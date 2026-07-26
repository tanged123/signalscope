import { describe, expect, it } from "vitest";
import type { SampleSeries } from "../generated/protocol";
import { pairSamples, traceExtent } from "./xy";

function series(path: string, time: number[], values: number[]): SampleSeries {
  return {
    signal_id: "1",
    signal_path: path,
    unit: null,
    time,
    values,
    stride: 1,
  };
}

describe("pairSamples", () => {
  it("keeps an identical timebase without resampling", () => {
    const x = series("x", [0, 1, 2], [10, 20, 30]);
    const y = series("y", [0, 1, 2], [1, 2, 3]);
    expect(pairSamples(x, y)).toEqual({
      time: [0, 1, 2],
      x: [10, 20, 30],
      y: [1, 2, 3],
    });
  });

  it("interpolates y onto the x timebase", () => {
    const x = series("x", [0, 1, 2], [0, 1, 2]);
    const y = series("y", [0, 2], [0, 20]);
    expect(pairSamples(x, y)).toEqual({
      time: [0, 1, 2],
      x: [0, 1, 2],
      y: [0, 10, 20],
    });
  });

  it("emits NaN where the y signal has no coverage", () => {
    const x = series("x", [0, 5], [0, 5]);
    const y = series("y", [1, 2], [1, 2]);
    const paired = pairSamples(x, y);
    expect(Number.isNaN(paired.y[0] ?? 0)).toBe(true);
    expect(Number.isNaN(paired.y[1] ?? 0)).toBe(true);
  });
});

describe("traceExtent", () => {
  it("pads a finite extent by six percent", () => {
    const trace = { time: [0, 1, 2], x: [0, 10, 20], y: [-1, 0, 1] };
    expect(traceExtent([trace], "x", 0, 2)).toEqual([-1.2, 21.2]);
  });

  it("expands a degenerate extent and ignores samples outside the window", () => {
    const trace = { time: [0, 1, 2], x: [5, 5, 999], y: [0, 0, 0] };
    expect(traceExtent([trace], "x", 0, 1)).toEqual([4, 6]);
  });

  it("returns null when nothing is finite", () => {
    const trace = { time: [0], x: [Number.NaN], y: [Number.NaN] };
    expect(traceExtent([trace], "x", 0, 1)).toBeNull();
  });
});

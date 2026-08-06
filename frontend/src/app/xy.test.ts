import { describe, expect, it } from "vitest";
import type { SampleResponse, SampleSeries } from "../generated/protocol";
import {
  buildSeriesIndex,
  pairSamples,
  seriesIndexKey,
  traceExtent,
  XyPrepCache,
} from "./xy";

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

function indexedSeries(path: string, values: number[]): SampleSeries {
  return {
    signal_path: path,
    unit: null,
    time: values.map((_, index) => index),
    values,
    stride: 1,
  } as SampleSeries;
}

const callbacks = {
  sourceKeyFor: (path: string) => path.split("/")[0] ?? null,
  localPathFor: (path: string) => path.split("/").slice(1).join("/") || null,
};

describe("buildSeriesIndex", () => {
  it("indexes by source and local path, first match winning", () => {
    const a = indexedSeries("run_0001/command", [1]);
    const duplicate = indexedSeries("run_0001/command", [2]);
    const b = indexedSeries("run_0002/command", [3]);
    const index = buildSeriesIndex([a, duplicate, b], callbacks);
    expect(index.get(seriesIndexKey("run_0001", "command"))).toBe(a);
    expect(index.get(seriesIndexKey("run_0002", "command"))).toBe(b);
    expect(index.size).toBe(2);
  });
});

describe("XyPrepCache", () => {
  const samples = {
    request_id: "r1",
    series: [
      indexedSeries("run_0001/command", [1, 2]),
      indexedSeries("run_0001/response", [3, 4]),
    ],
  } as SampleResponse;

  it("reuses traces and dimmed points while samples and key are unchanged", () => {
    const cache = new XyPrepCache();
    cache.sync(samples, "key", callbacks);
    let pairs = 0;
    const pair = () => {
      pairs += 1;
      return { time: [0, 1], x: [1, 2], y: [3, 4] };
    };
    const first = cache.trace("run_0001/response", pair);
    cache.sync(samples, "key", callbacks);
    const second = cache.trace("run_0001/response", pair);
    expect(second).toBe(first);
    expect(pairs).toBe(1);

    let flattens = 0;
    const flatten = () => {
      flattens += 1;
      return [1, 3, 2, 4];
    };
    const dimmedFirst = cache.dimmedPoints("run_0001/response", first, flatten);
    cache.sync(samples, "key", callbacks);
    expect(cache.dimmedPoints("run_0001/response", first, flatten)).toBe(
      dimmedFirst,
    );
    expect(flattens).toBe(1);
  });

  it("drops everything when the response or the key changes", () => {
    const cache = new XyPrepCache();
    cache.sync(samples, "key", callbacks);
    let pairs = 0;
    const pair = () => {
      pairs += 1;
      return { time: [0], x: [1], y: [3] };
    };
    cache.trace("run_0001/response", pair);
    cache.sync(samples, "other-key", callbacks);
    cache.trace("run_0001/response", pair);
    expect(pairs).toBe(2);
    const other = { ...samples, request_id: "r2" } as SampleResponse;
    cache.sync(other, "other-key", callbacks);
    cache.trace("run_0001/response", pair);
    expect(pairs).toBe(3);
  });

  it("caches null colour columns without recomputing", () => {
    const cache = new XyPrepCache();
    cache.sync(samples, "key", callbacks);
    let computes = 0;
    const compute = () => {
      computes += 1;
      return null;
    };
    expect(cache.colorColumn("run_0001/response", compute)).toBeNull();
    expect(cache.colorColumn("run_0001/response", compute)).toBeNull();
    expect(computes).toBe(1);
  });
});

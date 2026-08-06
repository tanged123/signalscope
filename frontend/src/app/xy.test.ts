import { describe, expect, it } from "vitest";
import type { EnvelopeBin, SampleSeries } from "../generated/protocol";
import { binColumnsFromWire, type ColumnarTile } from "./bin-columns";
import {
  buildSeriesIndex,
  buildTileIndex,
  pairTileTrace,
  pairSamples,
  seriesIndexKey,
  tilesAligned,
  traceExtent,
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

function envelopeBin(
  t0: number,
  t1: number,
  first: number,
  last: number,
  hasGap = false,
): EnvelopeBin {
  return {
    t0,
    t1,
    first,
    last,
    min: Math.min(first, last),
    max: Math.max(first, last),
    sum: first + last,
    sum_sq: first * first + last * last,
    finite_count: "2",
    sample_count: "2",
    has_gap: hasGap,
  };
}

function columnarTile(
  path: string,
  level: number,
  bins: EnvelopeBin[],
): ColumnarTile {
  return {
    signalId: path,
    signalPath: path,
    unit: "V",
    level,
    bins: binColumnsFromWire(bins),
  };
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

describe("tilesAligned", () => {
  const base = [envelopeBin(0, 1, 1, 2), envelopeBin(1, 2, 2, 3)];

  it("accepts same level, count, and bucket timestamps", () => {
    expect(
      tilesAligned(
        columnarTile("run_0001/command", 3, base),
        columnarTile("run_0001/response", 3, base),
      ),
    ).toBe(true);
  });

  it("rejects level, count, or timestamp mismatches", () => {
    expect(
      tilesAligned(columnarTile("a", 3, base), columnarTile("b", 4, base)),
    ).toBe(false);
    expect(
      tilesAligned(
        columnarTile("a", 3, base),
        columnarTile("b", 3, base.slice(0, 1)),
      ),
    ).toBe(false);
    expect(
      tilesAligned(
        columnarTile("a", 3, base),
        columnarTile("b", 3, [
          envelopeBin(0, 1, 1, 2),
          envelopeBin(1, 2.5, 2, 3),
        ]),
      ),
    ).toBe(false);
  });
});

describe("pairTileTrace", () => {
  it("threads the trajectory through first/last pairs in index order", () => {
    const x = columnarTile("run_0001/command", 2, [
      envelopeBin(0, 1, 10, 11),
      envelopeBin(1, 2, 11, 12),
    ]);
    const y = columnarTile("run_0001/response", 2, [
      envelopeBin(0, 1, 20, 21),
      envelopeBin(1, 2, 21, 22),
    ]);
    const paired = pairTileTrace(x, y, null);
    expect(paired).not.toBeNull();
    if (paired === null) return;
    expect(paired.trace.time).toEqual([0, 1, 1, 2]);
    expect(paired.trace.x).toEqual([10, 11, 11, 12]);
    expect(paired.trace.y).toEqual([20, 21, 21, 22]);
    expect(paired.colors).toBeNull();
  });

  it("collapses degenerate level-0 buckets to single points", () => {
    const x = columnarTile("a", 0, [envelopeBin(0, 0, 10, 10)]);
    const y = columnarTile("b", 0, [envelopeBin(0, 0, 20, 20)]);
    const paired = pairTileTrace(x, y, null);
    expect(paired?.trace.time).toEqual([0]);
    expect(paired?.trace.x).toEqual([10]);
    expect(paired?.trace.y).toEqual([20]);
  });

  it("a gap on either signal lifts the pen with a NaN vertex", () => {
    const x = columnarTile("a", 2, [
      envelopeBin(0, 1, 10, 11),
      envelopeBin(1, 2, 11, 12, true),
    ]);
    const y = columnarTile("b", 2, [
      envelopeBin(0, 1, 20, 21),
      envelopeBin(1, 2, 21, 22),
    ]);
    const paired = pairTileTrace(x, y, null);
    expect(paired).not.toBeNull();
    if (paired === null) return;
    expect(paired.trace.x).toEqual([10, 11, Number.NaN, 11, 12]);
    expect(paired.trace.y).toEqual([20, 21, Number.NaN, 21, 22]);
  });

  it("returns null for misaligned pairs and misaligned color tiles", () => {
    const x = columnarTile("a", 2, [envelopeBin(0, 1, 10, 11)]);
    const y = columnarTile("b", 3, [envelopeBin(0, 1, 20, 21)]);
    expect(pairTileTrace(x, y, null)).toBeNull();
    const yOk = columnarTile("b", 2, [envelopeBin(0, 1, 20, 21)]);
    const colorBad = columnarTile("c", 5, [envelopeBin(0, 1, 1, 1)]);
    expect(pairTileTrace(x, yOk, colorBad)).toBeNull();
  });

  it("carries aligned color values parallel to the points", () => {
    const bins = [envelopeBin(0, 1, 1, 2)];
    const paired = pairTileTrace(
      columnarTile("a", 1, bins),
      columnarTile("b", 1, [envelopeBin(0, 1, 5, 6)]),
      columnarTile("c", 1, [envelopeBin(0, 1, 7, 8)]),
    );
    expect(paired?.colors).toEqual([7, 8]);
  });
});

describe("buildTileIndex", () => {
  it("indexes tiles by source and local path, first wins", () => {
    const a = columnarTile("run_0001/command", 0, []);
    const b = columnarTile("run_0002/command", 0, []);
    const index = buildTileIndex([a, b], callbacks);
    expect(index.get(seriesIndexKey("run_0001", "command"))).toBe(a);
    expect(index.get(seriesIndexKey("run_0002", "command"))).toBe(b);
  });
});

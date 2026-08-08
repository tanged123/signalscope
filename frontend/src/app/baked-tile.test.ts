import { describe, expect, it } from "vitest";
import type { BakedLevel, EnvelopeBin } from "../generated/protocol";
import { sliceBakedTile } from "./baked-tile";
import { pointBreakBefore, pointTime, pointValue } from "./tile-points";

function bin(time: number): EnvelopeBin {
  return {
    t0: time,
    t1: time,
    first: time,
    last: time,
    min: time,
    max: time,
    sum: time,
    sum_sq: time * time,
    finite_count: "1",
    sample_count: "1",
    has_gap: false,
  };
}

function level(): BakedLevel {
  return {
    level: 0,
    source_start: "10",
    source_end: "14",
    origin: 100,
    bins: [bin(100), bin(101), bin(102), bin(103)],
    points: [
      { time: 100, value: 1, source_index: "10", break_before: false },
      { time: 101, value: 2, source_index: "11", break_before: false },
      { time: 102, value: 3, source_index: "12", break_before: true },
      { time: 103, value: 4, source_index: "13", break_before: false },
    ],
  };
}

describe("sliceBakedTile", () => {
  it("repackages partial bins with selected source metadata", () => {
    const sliced = sliceBakedTile(level(), 1, 3, 101.5, 102.5);
    expect(sliced.sourceStart).toBe("11");
    expect(sliced.sourceEnd).toBe("14");
    expect(sliced.origin).toBe(101);
    expect(sliced.points.count).toBe(3);
    expect(pointTime(sliced.points, sliced.origin, 0)).toBe(101);
    expect(pointValue(sliced.points, 1)).toBe(3);
    expect(pointBreakBefore(sliced.points, 1)).toBe(true);
  });

  it("returns an empty range with a stable source origin", () => {
    const sliced = sliceBakedTile(level(), 2, 2, 200, 201);
    expect(sliced.sourceStart).toBe("12");
    expect(sliced.sourceEnd).toBe("12");
    expect(sliced.origin).toBe(0);
    expect(sliced.points.count).toBe(0);
  });
});

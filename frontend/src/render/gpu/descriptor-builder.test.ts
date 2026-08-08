import { describe, expect, it } from "vitest";
import {
  buildCpuSegmentDescriptors,
  prepareSegmentDirectories,
  type SegmentDirectory,
} from "./descriptor-builder";

function directory(
  seriesSlot: number,
  sourceStart: string,
  pointOffset: number,
  pointCount: number,
  breaks: readonly boolean[] = [],
): SegmentDirectory {
  return { page: 0, pointOffset, pointCount, seriesSlot, sourceStart, breaks };
}

describe("segment directories", () => {
  it("sorts by slot, exact source start, and point order", () => {
    const prepared = prepareSegmentDirectories([
      directory(2, "9007199254740993", 20, 3),
      directory(1, "10", 0, 2),
      directory(1, "2", 10, 3),
    ]);
    expect(
      prepared.map((entry) => [entry.seriesSlot, entry.sourceStart]),
    ).toEqual([
      [1, "2"],
      [1, "10"],
      [2, "9007199254740993"],
    ]);
  });

  it("emits contiguous non-break candidate ranges and stable source order", () => {
    const prepared = prepareSegmentDirectories([
      directory(0, "0", 100, 4, [false, true, false, false]),
    ]);
    expect(buildCpuSegmentDescriptors(prepared)).toEqual([
      { firstPoint: 101, secondPoint: 102, seriesSlot: 0, sourceOrder: 0 },
      { firstPoint: 102, secondPoint: 103, seriesSlot: 0, sourceOrder: 1 },
    ]);
  });
});

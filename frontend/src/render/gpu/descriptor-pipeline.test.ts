import { describe, expect, it } from "vitest";
import {
  buildCpuSegmentDescriptors,
  prepareSegmentDirectories,
  type SegmentDirectory,
} from "./descriptor-builder";
import {
  descriptorFixtureResult,
  GpuDescriptorPipeline,
  runDescriptorFixture,
} from "./descriptor-pipeline";

function directory(
  seriesSlot: number,
  sourceStart: string,
  pointOffset: number,
  pointCount: number,
  breaks: readonly boolean[],
): SegmentDirectory {
  return { page: 0, pointOffset, pointCount, seriesSlot, sourceStart, breaks };
}

describe("GPU descriptor pipeline", () => {
  it("keeps the CPU descriptor oracle stable across duplicate extrema and gaps", () => {
    const prepared = prepareSegmentDirectories([
      directory(1, "10", 20, 4, [false, false, true, true]),
      directory(0, "10", 0, 3, [false, false, false]),
      directory(1, "10", 30, 3, [false, true, false]),
    ]);
    expect(buildCpuSegmentDescriptors(prepared)).toEqual([
      { firstPoint: 0, secondPoint: 1, seriesSlot: 0, sourceOrder: 0 },
      { firstPoint: 1, secondPoint: 2, seriesSlot: 0, sourceOrder: 1 },
      { firstPoint: 20, secondPoint: 21, seriesSlot: 1, sourceOrder: 2 },
      { firstPoint: 31, secondPoint: 32, seriesSlot: 1, sourceOrder: 3 },
    ]);
  });

  it("exposes the GPU-owned buffer contract", () => {
    expect(GpuDescriptorPipeline).toBeDefined();
    expect(descriptorFixtureResult).toBeDefined();
    expect(runDescriptorFixture).toBeDefined();
  });
});

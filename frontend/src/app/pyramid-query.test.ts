import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { queryAdaptivePyramidRange } from "./pyramid-query";

function bin(t0: number, t1: number): EnvelopeBin {
  return {
    t0,
    t1,
    first: t0,
    last: t1,
    min: t0,
    max: t1,
    sum: t0,
    sum_sq: t0 * t0,
    finite_count: "1",
    sample_count: "1",
    has_gap: false,
  };
}

function buildLevels(levelZero: EnvelopeBin[]): EnvelopeBin[][] {
  const levels = [levelZero];
  let current = levelZero;
  while (current.length > 1) {
    const next: EnvelopeBin[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index];
      const right = current[index + 1];
      if (left === undefined) continue;
      next.push(
        right === undefined
          ? left
          : {
              t0: left.t0,
              t1: right.t1,
              first: left.first,
              last: right.last,
              min: Math.min(left.min ?? Infinity, right.min ?? Infinity),
              max: Math.max(left.max ?? -Infinity, right.max ?? -Infinity),
              sum: left.sum + right.sum,
              sum_sq: left.sum_sq + right.sum_sq,
              finite_count: String(
                Number(left.finite_count) + Number(right.finite_count),
              ),
              sample_count: String(
                Number(left.sample_count) + Number(right.sample_count),
              ),
              has_gap: left.has_gap || right.has_gap,
            },
      );
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

describe("queryAdaptivePyramidRange", () => {
  it("selects an overview level with neighbouring bins", () => {
    const levels = buildLevels(
      Array.from({ length: 100 }, (_, time) => bin(time, time)),
    );

    expect(queryAdaptivePyramidRange(levels, 0, 99, 20)).toEqual({
      level: 2,
      start: 0,
      end: 25,
    });
  });

  it("refines a narrow window to level zero", () => {
    const levels = buildLevels(
      Array.from({ length: 100 }, (_, time) => bin(time, time)),
    );

    expect(queryAdaptivePyramidRange(levels, 40, 50, 20).level).toBe(0);
  });

  it("refines irregular overview bins until their span fits a pixel", () => {
    const levelZero = Array.from({ length: 100 }, (_, index) => {
      const time = index * 2 + (index >= 50 ? 5 : 0);
      return bin(time, time);
    });
    const levels = buildLevels(levelZero);
    const range = queryAdaptivePyramidRange(levels, 0, 203, 20);

    expect(range.level).toBeGreaterThan(0);
    const pixelSpan = (203 - 0) / 20;
    const selectedLevel = levels[range.level];
    if (selectedLevel === undefined) throw new Error("missing selected level");
    for (const selected of selectedLevel.slice(range.start, range.end)) {
      expect(selected.t1 - selected.t0).toBeLessThanOrEqual(pixelSpan);
    }
  });
});

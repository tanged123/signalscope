import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { visibleStats } from "./stats";

function bin(t0: number, t1: number, values: number[]): EnvelopeBin {
  const finite = values.filter(Number.isFinite);
  return {
    t0,
    t1,
    first: finite[0] ?? null,
    last: finite[finite.length - 1] ?? null,
    min: finite.length === 0 ? null : Math.min(...finite),
    max: finite.length === 0 ? null : Math.max(...finite),
    sum: finite.reduce((total, value) => total + value, 0),
    sum_sq: finite.reduce((total, value) => total + value * value, 0),
    finite_count: String(finite.length),
    sample_count: String(values.length),
    has_gap: finite.length !== values.length,
  };
}

test("visibleStats aggregates overlapping finite bins", () => {
  const bins = [bin(0, 1, [1, 3]), bin(1, 2, [5, 7]), bin(2, 3, [100, 100])];
  const stats = visibleStats(bins, 0, 1.5);
  expect(stats.min).toBe(1);
  expect(stats.max).toBe(7);
  expect(stats.mean).toBeCloseTo(4, 12);
  expect(stats.rms).toBeCloseTo(Math.sqrt(84 / 4), 12);
  expect(visibleStats(bins, 5, 6)).toEqual({
    min: null,
    max: null,
    mean: null,
    rms: null,
  });
});

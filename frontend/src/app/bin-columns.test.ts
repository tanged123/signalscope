import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import {
  binColumnsFromWire,
  binColumnsFromWireRange,
  columnsStats,
  columnsValueAtTime,
  columnsYExtent,
} from "./bin-columns";

function bin(
  t0: number,
  t1: number,
  values: readonly number[],
  hasGap = false,
): EnvelopeBin {
  const finite = values.filter(Number.isFinite);
  return {
    t0,
    t1,
    first: finite[0] ?? null,
    last: finite.at(-1) ?? null,
    min: finite.length === 0 ? null : Math.min(...finite),
    max: finite.length === 0 ? null : Math.max(...finite),
    sum: finite.reduce((total, value) => total + value, 0),
    sum_sq: finite.reduce((total, value) => total + value * value, 0),
    finite_count: String(finite.length),
    sample_count: String(values.length),
    has_gap: hasGap,
  };
}

test("columnsYExtent ignores absent extrema", () => {
  const columns = binColumnsFromWire([
    bin(0, 1, [2, 5]),
    bin(1, 2, [Number.NaN, Number.NaN], true),
    bin(2, 3, [-4, -1]),
  ]);
  expect(columnsYExtent(columns)).toEqual({ min: -4, max: 5 });
  expect(columnsYExtent(binColumnsFromWire([bin(0, 1, [Number.NaN])]))).toBe(
    null,
  );
  expect(columnsYExtent(columns, { t0: 0, t1: 1.5 })).toEqual({
    min: 2,
    max: 5,
  });
  expect(columnsYExtent(columns, { t0: 3.1, t1: 4 })).toBe(null);
});

test("bin columns can decode only a wire window", () => {
  const columns = binColumnsFromWireRange(
    [bin(0, 1, [1]), bin(1, 2, [2]), bin(2, 3, [3])],
    1,
    3,
  );
  expect(columns.count).toBe(2);
  expect([...columns.t0]).toEqual([1, 2]);
  expect([...columns.last]).toEqual([2, 3]);
});

test("columnsStats aggregates overlapping finite bins", () => {
  const columns = binColumnsFromWire([
    bin(0, 1, [1, 3]),
    bin(1, 2, [5, 7]),
    bin(2, 3, [100, 100]),
  ]);
  expect(columnsStats(columns, 0, 1.5)).toEqual({
    min: 1,
    max: 7,
    mean: 4,
    rms: Math.sqrt(84 / 4),
    n: 4,
  });
  expect(columnsStats(columns, 5, 6)).toEqual({
    min: null,
    max: null,
    mean: null,
    rms: null,
    n: 0,
  });
});

test("columnsValueAtTime interpolates bins and respects gaps", () => {
  const columns = binColumnsFromWire([
    bin(0, 1, [0, 10]),
    bin(1, 2, [10, 20]),
    bin(2, 3, [Number.NaN, Number.NaN], true),
  ]);
  expect(columnsValueAtTime(columns, 0.5)).toBeCloseTo(5, 9);
  expect(columnsValueAtTime(columns, 1.25)).toBeCloseTo(12.5, 9);
  expect(columnsValueAtTime(columns, 2.5)).toBeNull();
});

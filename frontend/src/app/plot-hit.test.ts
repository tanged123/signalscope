import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import type { PlotLayout } from "./plot-math";
import { nearestLine, nearestVertex } from "./plot-hit";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: 0, max: 10 },
  yRange: { min: 0, max: 10 },
};

function bin(t0: number, t1: number, first: number, last: number): EnvelopeBin {
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
    has_gap: false,
  };
}

test("nearestVertex snaps globally within its threshold", () => {
  const hit = nearestVertex(
    [{ path: "a/b", bins: [bin(0, 1, 5, 6), bin(1, 2, 6, 2)] }],
    layout,
    22,
    78,
    14,
  );
  expect(hit).toMatchObject({ path: "a/b", time: 2, value: 2 });
  expect(nearestVertex([], layout, 20, 80, 14)).toBeNull();
});

test("nearestLine hits the rendered envelope within a pixel tolerance", () => {
  const hit = nearestLine(
    [{ path: "a/b", bins: [bin(4, 6, 5, 7)] }],
    layout,
    51,
    45,
    6,
  );
  expect(hit?.path).toBe("a/b");
  expect(hit?.distance).toBe(1);
  expect(nearestLine([], layout, 50, 50, 6)).toBeNull();
});

test("nearestLine does not connect bins across a gap", () => {
  const first = { ...bin(0, 1, 2, 2), has_gap: true };
  const second = bin(9, 10, 8, 8);

  expect(
    nearestLine([{ path: "a/b", bins: [first, second] }], layout, 50, 50, 8),
  ).toBeNull();
});

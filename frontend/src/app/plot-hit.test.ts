import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import type { PlotLayout } from "./plot-math";
import { nearestVertex } from "./plot-hit";

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

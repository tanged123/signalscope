import { expect, it } from "vitest";
import type { PlotLayout } from "./plot-math";
import { nearestXyPoint } from "./xy-hit";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: 0, max: 10 },
  yRange: { min: 0, max: 10 },
};

const traces = [
  {
    path: "a",
    trace: { time: [0, 1, 2], x: [1, 5, 9], y: [1, 5, 9] },
  },
];

it("finds the nearest vertex within the radius", () => {
  // Data (5,5) projects to pixel (50, 50).
  const hit = nearestXyPoint(traces, layout, 52, 48, 40);
  expect(hit).toEqual({ path: "a", index: 1, time: 1, x: 5, y: 5 });
});

it("returns null beyond the radius", () => {
  expect(nearestXyPoint(traces, layout, 60, 50, 1)).toBeNull();
});

it("skips non-finite vertices", () => {
  const broken = [
    {
      path: "a",
      trace: { time: [0, 1], x: [Number.NaN, 5], y: [Number.NaN, 5] },
    },
  ];
  expect(nearestXyPoint(broken, layout, 50, 50, 40)?.index).toBe(1);
});

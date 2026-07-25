import { expect, test } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import {
  formatValue,
  invertX,
  invertY,
  logTicks,
  panRange,
  pinchRange,
  projectX,
  valueAtTime,
  wheelZoomFactor,
  zoomDragMode,
  zoomRange,
  type PlotLayout,
} from "./plot-math";

const layout: PlotLayout = {
  plot: { x: 52, y: 8, width: 500, height: 300 },
  xRange: { min: 10, max: 60 },
  yRange: { min: -100, max: 100 },
};

function bin(
  t0: number,
  t1: number,
  first: number | null,
  last: number | null,
  gap = false,
): EnvelopeBin {
  return {
    t0,
    t1,
    first,
    last,
    min: first === null ? last : first,
    max: last === null ? first : last,
    sum: 0,
    sum_sq: 0,
    finite_count: "0",
    sample_count: "1",
    has_gap: gap,
  };
}

test("projection inversion, zoom and pan preserve plot ranges", () => {
  for (const time of [10, 25, 59.5]) {
    expect(invertX(layout, projectX(layout, time))).toBeCloseTo(time, 9);
  }
  expect(invertY(layout, 8)).toBeCloseTo(100, 9);
  expect(invertY(layout, 308)).toBeCloseTo(-100, 9);
  expect(zoomRange({ min: 0, max: 100 }, 0.5, 50)).toEqual({
    min: 25,
    max: 75,
  });
  expect(panRange({ min: 5, max: 15 }, -2)).toEqual({ min: 3, max: 13 });
  expect(wheelZoomFactor(-240)).toBeLessThan(1);
  expect(wheelZoomFactor(240)).toBeGreaterThan(1);
});

test("pins both pinch anchors under their fingers", () => {
  // Anchors 10 and 20 are held at pixels 100 and 300 inside a plot
  // spanning pixels 0…400, so the visible range becomes 5…25.
  expect(pinchRange(10, 20, 100, 300, 0, 400)).toEqual({ min: 5, max: 25 });
});

test("refuses a degenerate pinch", () => {
  expect(pinchRange(10, 10, 100, 300, 0, 400)).toBeNull();
  expect(pinchRange(10, 20, 100, 100, 0, 400)).toBeNull();
});

test("projects and inverts a log x axis", () => {
  const logLayout: PlotLayout = {
    plot: { x: 0, y: 0, width: 300, height: 100 },
    xRange: { min: 1, max: 1000 },
    yRange: { min: 0, max: 1 },
    xScale: "log",
  };
  expect(projectX(logLayout, 1)).toBeCloseTo(0, 6);
  expect(projectX(logLayout, 10)).toBeCloseTo(100, 6);
  expect(projectX(logLayout, 1000)).toBeCloseTo(300, 6);
  expect(invertX(logLayout, 200)).toBeCloseTo(100, 6);
});

test("emits decade ticks for a log range", () => {
  expect(logTicks(0.5, 1200)).toEqual([1, 10, 100, 1000]);
  expect(logTicks(0, -1)).toEqual([]);
});

test("zoom drags snap only strongly directional rectangles to one axis", () => {
  expect(zoomDragMode(200, 5)).toBe("x");
  expect(zoomDragMode(5, 200)).toBe("y");
  expect(zoomDragMode(200, 80)).toBe("xy");
  expect(zoomDragMode(80, 200)).toBe("xy");
});

test("valueAtTime interpolates drawn vertices and respects gaps", () => {
  const bins = [
    bin(0, 1, 0, 10),
    bin(1, 2, 10, 20),
    bin(2, 3, null, null, true),
  ];
  expect(valueAtTime(bins, 0.5)).toBeCloseTo(5, 9);
  expect(valueAtTime(bins, 1.25)).toBeCloseTo(12.5, 9);
  expect(valueAtTime(bins, 2.5)).toBeNull();
});

test("valueAtTime interpolates between zero-width level-zero bins", () => {
  const bins = [bin(0, 0, 0, 0), bin(1, 1, 10, 10), bin(2, 2, 20, 20)];
  expect(valueAtTime(bins, 0.5)).toBeCloseTo(5, 9);
  expect(valueAtTime(bins, 1.25)).toBeCloseTo(12.5, 9);
  expect(valueAtTime(bins, -0.1)).toBeNull();
  expect(valueAtTime(bins, 2.1)).toBeNull();
});

test("formatValue uses spec precision and minus glyph", () => {
  expect(formatValue(null)).toBe("—");
  expect(formatValue(223.456789)).toBe("223.4568");
  expect(formatValue(-149.281)).toBe("−149.2810");
  expect(formatValue(1_234_567)).toBe("1.235e+6");
});

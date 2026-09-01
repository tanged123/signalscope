import { expect, test } from "vitest";
import { binColumnsFromWire } from "./bin-columns";
import type { Annotation } from "../generated/session";
import type { PlotLayout } from "./plot-math";
import { prepareTimePlot } from "./plot-capabilities";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: 0, max: 10 },
  yRange: { min: 0, max: 10 },
};

function annotation(
  anchor: number,
  pinnedValue: number,
  path = "demo/y",
): Annotation {
  return {
    id: String(anchor),
    series_path: path,
    anchor,
    pinned_value: pinnedValue,
    label: "",
  };
}

test("time capabilities link cursors and expose raw visible statistics", () => {
  const plot = prepareTimePlot({
    series: [
      {
        path: "demo/y",
        colorIndex: 0,
        bins: binColumnsFromWire([
          {
            t0: 0,
            t1: 5,
            first: 2,
            last: 4,
            min: 2,
            max: 4,
            sum: 6,
            sum_sq: 20,
            finite_count: "2",
            sample_count: "2",
            has_gap: false,
          },
        ]),
      },
    ],
    window: { t0: 0, t1: 5 },
  });

  expect(plot.interaction.cursorLink).toBe("time");
  expect(plot.autoRanges()).toEqual({
    x: [0, 5],
    y: [1.88, 4.12],
  });
  expect(plot.cursorAt(layout, { x: 50, y: 50 }, 12)?.x).toBeCloseTo(5);
  expect(plot.resolveAnnotation(annotation(2.5, 3))).toMatchObject({
    x: 2.5,
    y: 3,
  });
  expect(plot.stats()[0]?.items).toEqual([
    { label: "min", value: 2, unit: null },
    { label: "max", value: 4, unit: null },
    { label: "mean", value: 3, unit: null },
    { label: "rms", value: Math.sqrt(10), unit: null },
    { label: "n", value: 2, unit: null },
  ]);
});

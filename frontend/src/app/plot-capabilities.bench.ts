import { bench, describe } from "vitest";
import { prepareLine2DPlot, type Line2DPlotInput } from "./plot-capabilities";

const count = 6_000;
const input: Line2DPlotInput = {
  anchor: Float64Array.from({ length: count }, (_, i) => i),
  x: Float64Array.from({ length: count }, (_, i) => Math.sin(i / 100)),
  series: Array.from({ length: 1_000 }, (_, run) => ({
    path: `run/${String(run)}`,
    unit: null,
    colorIndex: run % 8,
    values: Float64Array.from({ length: count }, (_, i) =>
      Math.cos(i / 100 + run / 1_000),
    ),
  })),
  window: { t0: 0, t1: count - 1 },
};

describe("Line2D automatic ranges: 1000 lines, 6 million retained rows", () => {
  bench("refresh with unchanged columns and source-time window", () => {
    prepareLine2DPlot(input).autoRanges();
  });
});

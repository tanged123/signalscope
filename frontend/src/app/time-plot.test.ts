import { describe, expect, it } from "vitest";

import { binColumnsFromWire } from "./bin-columns";
import { prepareTimePlot } from "./time-plot";

const bins = binColumnsFromWire([
  {
    t0: 0,
    t1: 1,
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
]);

describe("prepareTimePlot", () => {
  it("prepares time ranges and resolves time annotations", () => {
    const plot = prepareTimePlot({
      series: [{ path: "run/speed", colorIndex: 0, bins }],
      window: { t0: 0, t1: 1 },
    });

    expect(plot.autoRange()).toEqual({ x: [0, 1], y: [1.88, 4.12] });
    expect(
      plot.resolveAnnotation({
        id: "a",
        series_path: "run/speed",
        anchor: 0.5,
        pinned_value: 3,
        label: "",
      }),
    ).toMatchObject({ x: 0.5, y: 3 });
  });
});

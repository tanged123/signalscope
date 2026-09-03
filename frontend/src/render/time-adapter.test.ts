import { describe, expect, it } from "vitest";
import { binColumnsFromWire } from "../app/bin-columns";
import { line2DFromTimeTiles } from "./time-adapter";

describe("time tile adapter", () => {
  it("creates a generic line input without losing tile identity", () => {
    const bins = binColumnsFromWire([
      {
        t0: 12,
        t1: 13,
        first: 1,
        last: 2,
        min: 1,
        max: 2,
        sum: 3,
        sum_sq: 5,
        finite_count: "2",
        sample_count: "2",
        has_gap: false,
      },
    ]);
    const response = {
      requestId: "tiles-1",
      series: [
        {
          signalId: "signal-1",
          signalPath: "run/value",
          unit: "V",
          level: 1,
          bins,
        },
      ],
    };

    const input = line2DFromTimeTiles(response, {
      xRange: { min: 12, max: 14 },
      yRange: [0, 3],
      xLabel: "time (s)",
      yLabel: "value (V)",
      axisStyle: "gutter",
    });

    expect(input.xOrigin).toBe(12);
    expect(input.series[0]).toMatchObject({
      id: "signal-1",
      name: "run/value",
      style: { hue: null, dash: "solid" },
    });
    expect(input.series[0]?.data).toEqual(new Float32Array([0, 1, 1, 2]));
    expect(input.axes).toEqual({
      x: { label: "time (s)" },
      y: { label: "value (V)" },
      style: "gutter",
    });
  });
});

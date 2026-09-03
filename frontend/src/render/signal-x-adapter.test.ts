import { describe, expect, it } from "vitest";
import type { Line2DResponse } from "../app/line-binary";
import { line2DFromSignalX, prepareSignalXLine } from "./signal-x-adapter";

function response(): Line2DResponse {
  return {
    requestId: "request",
    level: 2,
    anchor: new Float64Array([0, 1, 2]),
    x: {
      signalId: "1",
      signalPath: "run/x",
      unit: "m",
      values: new Float64Array([1_000_000, Number.NaN, 1_000_002]),
    },
    ys: [
      {
        signalId: "2",
        signalPath: "run/y",
        unit: "V",
        values: new Float64Array([3, 4, 5]),
      },
    ],
  };
}

describe("signal-X line adapter", () => {
  it("creates a generic Line2D input with local-X precision and gaps", () => {
    const source = response();
    const input = line2DFromSignalX(source, {
      window: { t0: 0, t1: 2 },
      xRange: { min: 999_999, max: 1_000_003 },
      yRange: [0, 6],
      xLabel: "run/x (m)",
      yLabel: "value (V)",
      axisStyle: "inline",
    });

    expect(input.xOrigin).toBe(1_000_000);
    expect(input.series[0]).toMatchObject({
      id: "2",
      name: "run/y",
      style: { hue: null, dash: "solid" },
    });
    expect(Array.from(input.series[0]?.data ?? [])).toEqual([
      0,
      3,
      0,
      Number.NaN,
      2,
      5,
    ]);
    expect(input.axes).toEqual({
      x: { label: "run/x (m)" },
      y: { label: "value (V)" },
      style: "inline",
    });
  });

  it("prepares the same immutable feed used by publication", () => {
    const source = response();
    prepareSignalXLine(source, { t0: 0, t1: 2 });
    const options = {
      window: { t0: 0, t1: 2 },
      xRange: { min: 0, max: 1 },
      yRange: [0, 1] as const,
      xLabel: "x",
      yLabel: "y",
      axisStyle: "gutter" as const,
    };

    const first = line2DFromSignalX(source, options);
    const second = line2DFromSignalX(source, options);
    expect(second.series[0]?.data).toBe(first.series[0]?.data);
  });

  it("gaps padded rows outside the selected source-time window", () => {
    const base = response();
    const source = {
      ...base,
      x: { ...base.x, values: new Float64Array([10, 11, 12]) },
    };
    const input = line2DFromSignalX(source, {
      window: { t0: 1, t1: 2 },
      xRange: { min: 10, max: 12 },
      yRange: [0, 6],
      xLabel: "x",
      yLabel: "y",
      axisStyle: "gutter",
    });

    expect(Array.from(input.series[0]?.data ?? [])).toEqual([
      0,
      Number.NaN,
      1,
      4,
      2,
      5,
    ]);
  });
});

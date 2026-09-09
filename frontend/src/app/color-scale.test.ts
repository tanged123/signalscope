import { expect, test } from "vitest";
import { colorFraction, resolveColorScale } from "./color-scale";
import {
  DEFAULT_CONTOUR,
  sampleContour,
  compileContour,
  CONTOUR_PALETTES,
} from "./palettes";
import { colorAttributes } from "../render/color-attributes";
import { line2DFromSignalX } from "../render/signal-x-adapter";
import { line2dFamily } from "./line2d-family";
import type { Line2DResponse } from "./line-binary";
import type { ColorAxis } from "../generated/session";

const axis: ColorAxis = {
  source: { kind: "time" },
  range: null,
  label: null,
  scale: null,
};

test("log C uses positive domains, geometric spacing, and separate cached colors", () => {
  const data = response([-1, 0, 1, 10, 100]);
  const window = { t0: -1, t1: 3 };
  const linear = resolveColorScale(data, axis, window, "C");
  const log = resolveColorScale(data, { ...axis, scale: "log" }, window, "C");
  expect(linear.range).toEqual([-1, 100]);
  expect(log.range).toEqual([1, 100]);
  expect(colorFraction(10, [1, 100], "log")).toBeCloseTo(0.5);
  const values = Float64Array.from([-1, 0, 1, 10, 100]);
  const colors = colorAttributes(values, log);
  expect(colors[3]).toBe(-1);
  expect(colors[7]).toBe(-1);
  expect(Array.from(colors.slice(12, 16))).toEqual(
    Array.from(Float32Array.from(sampleContour(DEFAULT_CONTOUR, 0.5))),
  );
  const changed = colorAttributes(values, { ...log, scale: "linear" });
  expect(changed).not.toBe(colors);
  expect(colorAttributes(values, { ...log, scale: "linear" })).toBe(changed);
  expect(resolveColorScale(data, axis, window, "C").range).toEqual([-1, 100]);
  expect(
    resolveColorScale(
      response([-1, 0, -1, 0, NaN]),
      { ...axis, scale: "log" },
      window,
      "C",
    ).range,
  ).toBeNull();
});
function response(colors: number[]): Line2DResponse {
  return {
    requestId: "r",
    level: 0,
    anchor: Float64Array.from([-1, 0, 1, 2, 3]),
    x: {
      signalId: "1",
      signalPath: "x",
      unit: null,
      values: Float64Array.from([0, 1, 2, 1, 0]),
    },
    ys: [
      {
        signalId: "2",
        signalPath: "y",
        unit: null,
        values: Float64Array.from([1, 2, 3, 4, 5]),
        color: {
          signalId: "3",
          signalPath: "temperature",
          unit: "K",
          values: Float64Array.from(colors),
        },
      },
    ],
  };
}

test("automatic color limits share visible traces and exclude padded source-time rows", () => {
  const data = response([-999, 2, NaN, 5, 999]);
  const other = response([0, -10, 3, 9, 0])
    .ys[0] as Line2DResponse["ys"][number];
  const scale = resolveColorScale(
    { ...data, ys: [...data.ys, other] },
    axis,
    { t0: 0, t1: 2 },
    "temperature (K)",
  );
  expect(scale).toEqual({ label: "temperature (K)", range: [-10, 9] });
  expect(resolveColorScale(data, axis, { t0: 0, t1: 2 }, "C").range).toEqual([
    2, 5,
  ]);
  expect(resolveColorScale(data, axis, { t0: 2, t1: 2 }, "C").range).toEqual([
    5, 5,
  ]);
});

test("fixed limits clamp, constants use the midpoint, and missing samples use neutral segments", () => {
  const data = response([NaN, 2, 3, 5, Infinity]);
  const scale = resolveColorScale(
    data,
    { ...axis, range: [2, 3], label: "heat" },
    { t0: 0, t1: 2 },
    "C",
  );
  const values = data.ys[0]?.color?.values ?? new Float64Array();
  const colors = colorAttributes(values, scale);
  expect(colors[3]).toBe(-1);
  expect([...colors.slice(4, 8)]).toEqual([
    ...Float32Array.from(sampleContour(DEFAULT_CONTOUR, 0)),
  ]);
  expect([...colors.slice(12, 16)]).toEqual([
    ...Float32Array.from(sampleContour(DEFAULT_CONTOUR, 1)),
  ]);
  expect(colors[19]).toBe(-1);
  expect(colorAttributes(values, { ...scale })).toBe(colors);
  expect(colorFraction(9, [9, 9])).toBe(0.5);
  expect(colorFraction(0, [-Number.MAX_VALUE, Number.MAX_VALUE])).toBe(0.5);
  expect(colorFraction(1e15 + 1, [1e15, 1e15 + 2])).toBe(0.5);
  expect(
    resolveColorScale(
      response([NaN, NaN, NaN, NaN, NaN]),
      axis,
      { t0: 0, t1: 2 },
      "C",
    ).range,
  ).toBeNull();
});

test("colored feeds preserve XY geometry and attribute identity during viewport changes", () => {
  const data = response([0, 1, 2, 3, 4]);
  const options = {
    window: { t0: 0, t1: 2 },
    xRange: { min: 0, max: 2 },
    yRange: [0, 5] as const,
    xLabel: "X",
    yLabel: "Y",
    axisStyle: "gutter" as const,
    colorScale: { label: "C", range: [0, 4] as const },
  };
  const first = line2DFromSignalX(data, options);
  const second = line2DFromSignalX(data, {
    ...options,
    xRange: { min: 1, max: 2 },
  });
  expect(second.series[0]?.data).toBe(first.series[0]?.data);
  expect(second.series[0]?.pointColors).toBe(first.series[0]?.pointColors);
  expect(first.series).toHaveLength(1);
  const contour = compileContour(CONTOUR_PALETTES.gray.stops);
  const recolored = line2DFromSignalX(data, { ...options, contour });
  expect(recolored.series[0]?.data).toBe(first.series[0]?.data);
  expect(recolored.series[0]?.pointColors).not.toBe(
    first.series[0]?.pointColors,
  );
  expect([...(recolored.series[0]?.pointColors?.slice(0, 4) ?? [])]).toEqual([
    0, 0, 0, 1,
  ]);
  expect(
    line2DFromSignalX(data, { ...options, contour }).series[0]?.pointColors,
  ).toBe(recolored.series[0]?.pointColors);
  expect(first.series[0]?.pointColors).toHaveLength(20);
});

test("time X with color retains linked-time interaction", () => {
  const data = response([0, 1, 2, 3, 4]);
  const family = line2dFamily({
    kind: "signal",
    response: { ...data, timeX: true, x: { ...data.x, values: data.anchor } },
  }).prepare({
    series: [],
    window: { t0: 0, t1: 2 },
    axisStyle: "gutter",
    xLabel: null,
    yLabel: null,
    colorAxis: axis,
  });
  expect(family.plot.interaction.xAxis).toBe("linked-time");
  expect(family.plot.interaction.cursorLink).toBe("time");
});

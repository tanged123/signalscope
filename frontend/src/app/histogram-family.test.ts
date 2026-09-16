import { expect, test } from "vitest";
import type { HistogramResponse } from "../generated/protocol";
import type { Annotation } from "../generated/session";
import { histogramFamily } from "./histogram-family";
import { projectX, projectY, type PlotLayout } from "./plot-math";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: -1, max: 2 },
  yRange: { min: 0, max: 4 },
};

function response(
  overrides: Partial<HistogramResponse> = {},
): HistogramResponse {
  return {
    request_id: "hist-1",
    window: { t0: 10, t1: 20 },
    edges: [-1, 0, 1, 2],
    series: [
      {
        signal_id: "signal-1",
        signal_path: "run/value",
        unit: "V",
        counts: ["2", "3", "0"],
        finite_count: "5",
        excluded_count: "1",
      },
    ],
    ...overrides,
  };
}

function prepared(data = response(), visible = true) {
  return histogramFamily({ kind: "histogram", response: data }).prepare({
    series: [
      {
        path: "run/value",
        hue: 0,
        visible,
      },
    ],
    axisStyle: "gutter",
    xLabel: null,
    yLabel: null,
    colorCount: 8,
  });
}

test("histogram family outlines every bin down to the baseline", () => {
  const family = prepared();
  const request = family.makeInput(
    { x: { min: -1, max: 2 }, y: { min: 0, max: 4 } },
    [{ hue: 0, dash: "solid", width: 1, alpha: 1 }],
  );
  expect(request.xOrigin).toBe(-1);
  expect(Array.from(request.series[0]?.data ?? [])).toEqual([
    0, 0, 0, 2, 1, 2, 1, 0, 1, 0, 1, 3, 2, 3, 2, 0, 2, 0, 2, 0, 3, 0, 3, 0,
  ]);
  expect(request.axes).toEqual({
    x: { label: "value (V)", scale: "linear" },
    y: { label: "sample count", scale: "linear" },
    style: "gutter",
  });
  expect(family.plot.interaction).toMatchObject({
    xAxis: "local",
    cursorLink: "local",
    windowNote: "source window [10.0000, 20.0000] s",
  });
});

test("cursor reports the selected interval and exact count text", () => {
  const family = prepared(
    response({
      series: [
        {
          signal_id: "signal-1",
          signal_path: "run/value",
          unit: "V",
          counts: ["9007199254740993", "3", "0"],
          finite_count: "9007199254740996",
          excluded_count: "0",
        },
      ],
    }),
  );
  const cursor = family.plot.cursorAt(
    layout,
    { x: projectX(layout, -0.5), y: projectY(layout, 1) },
    20,
  );
  expect(cursor).toMatchObject({
    heading: "value [−1.0000, 0.0000)",
    link: "local",
  });
  expect(cursor?.rows[0]).toMatchObject({
    value: 9007199254740992,
    exactValue: "9007199254740993",
  });
});

test("annotations resolve their source value to the current bin", () => {
  const family = prepared();
  const hit = family.plot.annotationAt(
    layout,
    { x: projectX(layout, -0.5), y: projectY(layout, 2) },
    4,
  );
  expect(hit).toMatchObject({
    path: "run/value",
    anchor: -0.5,
    x: -0.5,
    pinnedValue: 2,
    histogramWindow: [10, 20],
    histogramBinCount: 3,
  });
  const annotation: Annotation = {
    id: "tip-1",
    series_path: "run/value",
    anchor: -0.25,
    pinned_x: -0.25,
    pinned_value: 99,
    label: "",
    offset: [10, -10],
    histogram_window: [0, 5],
    histogram_bin_count: 12,
  };
  expect(family.plot.resolveAnnotation(annotation)).toMatchObject({
    x: -0.5,
    y: 2,
    summary: "[−1.0000, 0.0000) · 2",
  });
});

test("empty distributions retain finite axes and do not invent observations", () => {
  const family = prepared(response({ edges: [], series: [] }));
  const ranges = family.plot.autoRanges();
  expect(ranges.x?.every(Number.isFinite)).toBe(true);
  expect(ranges.y?.every(Number.isFinite)).toBe(true);
  expect(family.plot.cursorAt(layout, { x: 50, y: 50 }, 4)).toBeNull();
  expect(family.plot.annotationAt(layout, { x: 50, y: 50 }, 4)).toBeNull();
});

test("camera and style preparation retain immutable step feeds", () => {
  const data = response();
  const first = prepared(data).makeInput(
    { x: { min: -1, max: 2 }, y: { min: 0, max: 4 } },
    [],
  );
  const next = prepared(data).makeInput(
    { x: { min: 0, max: 1 }, y: { min: 1, max: 3 } },
    [{ hue: 1, dash: "dash", width: 2, alpha: 1 }],
  );
  expect(next.series[0]?.data).toBe(first.series[0]?.data);
  const replacement = prepared(response()).makeInput(
    { x: { min: 0, max: 1 }, y: { min: 1, max: 3 } },
    [],
  );
  expect(replacement.series[0]?.data).not.toBe(first.series[0]?.data);
});

test("log axes pack logarithmic coordinates while retaining exact count inspection", () => {
  const data = response({
    edges: [1, 50.5, 100],
    series: [
      {
        signal_id: "1",
        signal_path: "run/value",
        unit: "V",
        counts: ["1", "100"],
        finite_count: "101",
        excluded_count: "0",
      },
    ],
  });
  const family = histogramFamily({ kind: "histogram", response: data }).prepare(
    {
      series: [],
      axisStyle: "gutter",
      xLabel: null,
      yLabel: null,
      xScale: "log",
      yScale: "log",
    },
  );
  const input = family.makeInput(
    { x: { min: 1, max: 100 }, y: { min: 1, max: 100 } },
    [],
  );
  expect(input.xOrigin).toBe(0);
  expect(input.series[0]?.data[0]).toBe(0);
  expect(input.series[0]?.data[1]).toBe(0);
  expect(input.series[0]?.data[12]).toBe(2);
  expect(input.series[0]?.data[13]).toBe(2);
  expect(
    family.plot.stats()[0]?.items.find((item) => item.label === "n")?.value,
  ).toBe(101);
});

test("hiding every series produces no plotted rows", () => {
  expect(prepared(response(), false).plotted).toEqual([]);
});

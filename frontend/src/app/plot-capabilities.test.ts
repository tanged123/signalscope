import { expect, test } from "vitest";
import { binColumnsFromWire } from "./bin-columns";
import type { Annotation } from "../generated/session";
import type { PlotLayout } from "./plot-math";
import {
  prepareFftPlot,
  prepareHistogramPlot,
  prepareTimePlot,
  prepareXyPlot,
  type PreparedPlot,
  type ResolvedAnnotation,
} from "./plot-capabilities";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 100 },
  xRange: { min: 0, max: 10 },
  yRange: { min: 0, max: 10 },
};

function annotation(
  domain: Annotation["domain"],
  anchor: number,
  pinnedValue: number,
  path = "demo/y",
): Annotation {
  return {
    id: `${domain}-${String(anchor)}`,
    series_path: path,
    domain,
    anchor,
    pinned_value: pinnedValue,
    label: "",
  };
}

function mustResolve(
  plot: PreparedPlot,
  value: Annotation,
): ResolvedAnnotation {
  const resolved = plot.resolveAnnotation(value);
  expect(resolved).not.toBeNull();
  if (resolved === null) throw new Error("annotation did not resolve");
  return resolved;
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

  expect(plot.domain).toBe("time");
  expect(plot.interaction.cursorLink).toBe("time");
  expect(plot.autoRanges()).toEqual({
    x: [0, 5],
    y: [1.88, 4.12],
  });
  expect(plot.cursorAt(layout, { x: 50, y: 50 }, 12)?.x).toBeCloseTo(5);
  expect(plot.resolveAnnotation(annotation("time", 2.5, 3))).toMatchObject({
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

test("prepareTimePlot scans bins for extents only when autoRanges is called", () => {
  const bins = binColumnsFromWire([
    {
      t0: 0,
      t1: 1,
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
  let minReads = 0;
  const counted = new Proxy(bins, {
    get(target, property, receiver) {
      if (property === "min") minReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const plot = prepareTimePlot({
    series: [{ path: "run_0001/response", colorIndex: 0, bins: counted }],
    window: { t0: 0, t1: 1 },
  });
  expect(minReads).toBe(0);
  plot.autoRanges();
  const afterFirst = minReads;
  expect(afterFirst).toBeGreaterThan(0);
  plot.autoRanges();
  expect(minReads).toBe(afterFirst);
});

test("XY capabilities share time anchors and report X, Y and C statistics", () => {
  const plot = prepareXyPlot({
    x: { path: "demo/x", values: [1, 3, 5] },
    series: [
      {
        path: "demo/y",
        colorIndex: 1,
        trace: { time: [0, 1, 2], x: [1, 3, 5], y: [2, 4, 8] },
        colorValues: [10, 20, 30],
      },
    ],
    color: { path: "demo/c" },
    window: { t0: 0, t1: 2 },
  });

  expect(plot.domain).toBe("time");
  expect(plot.interaction.cursorLink).toBe("time");
  const automatic = plot.autoRanges();
  expect(automatic.x?.[0]).toBeCloseTo(0.76);
  expect(automatic.x?.[1]).toBeCloseTo(5.24);
  expect(automatic.y?.[0]).toBeCloseTo(1.64);
  expect(automatic.y?.[1]).toBeCloseTo(8.36);
  expect(plot.resolveAnnotation(annotation("time", 1, 4))).toMatchObject({
    x: 3,
    y: 4,
  });
  expect(plot.stats().map((group) => group.label)).toEqual([
    "x · demo/x",
    "y · demo/y",
    "c · demo/c",
  ]);
  expect(
    plot.delta([
      mustResolve(plot, annotation("time", 0, 2)),
      mustResolve(plot, annotation("time", 2, 8)),
    ])?.label,
  ).toBe("Δt 2.0000 s · Δx 4.0000 · Δy 6.0000 · Δc 20.0000");
});

test("series hit adapters use rendered traces and skip invisible series", () => {
  const xy = prepareXyPlot({
    x: { path: "demo/x", values: [0, 5, 10] },
    series: [
      {
        path: "hidden/y",
        colorIndex: 0,
        visible: false,
        trace: { time: [0, 1, 2], x: [0, 5, 10], y: [0, 5, 10] },
        colorValues: null,
      },
      {
        path: "visible/y",
        colorIndex: 1,
        visible: true,
        trace: { time: [0, 1, 2], x: [0, 5, 10], y: [10, 5, 0] },
        colorValues: null,
      },
    ],
    color: null,
    window: { t0: 0, t1: 2 },
  });

  expect(xy.hitAdapter.seriesAt(layout, 50, 50, 2)).toEqual({
    path: "visible/y",
    distance: 0,
  });
  expect(xy.hitAdapter.seriesAt(layout, 0, 100, 2)).toBeNull();
});

test("FFT and histogram hit adapters select rendered traces", () => {
  const fft = prepareFftPlot({
    series: [
      {
        path: "hidden/spectrum",
        colorIndex: 0,
        visible: false,
        frequency: [0, 5, 10],
        amplitudeDb: [0, 10, 0],
      },
      {
        path: "visible/spectrum",
        colorIndex: 1,
        frequency: [0, 5, 10],
        amplitudeDb: [10, 0, 10],
      },
    ],
  });
  expect(fft.hitAdapter.seriesAt(layout, 25, 50, 1)).toEqual({
    path: "visible/spectrum",
    distance: 0,
  });
  expect(fft.hitAdapter.seriesAt(layout, 50, 50, 1)).toBeNull();

  const histogram = prepareHistogramPlot({
    edges: [0, 5, 10],
    series: [
      {
        path: "hidden/histogram",
        colorIndex: 0,
        visible: false,
        counts: [2, 8],
        sourceValues: [],
      },
      {
        path: "visible/histogram",
        colorIndex: 1,
        counts: [2, 8],
        sourceValues: [],
      },
    ],
  });
  expect(histogram.hitAdapter.seriesAt(layout, 25, 80, 1)).toEqual({
    path: "visible/histogram",
    distance: 0,
  });
  expect(histogram.hitAdapter.seriesAt(layout, 75, 50, 1)).toBeNull();
});

test("XY hit adapters report the projected point distance", () => {
  const xy = prepareXyPlot({
    x: { path: "demo/x", values: [5] },
    series: [
      {
        path: "demo/y",
        colorIndex: 0,
        trace: { time: [0], x: [5], y: [5] },
        colorValues: null,
      },
    ],
    color: null,
    window: { t0: 0, t1: 1 },
  });

  expect(xy.hitAdapter.seriesAt(layout, 53, 54, 6)).toEqual({
    path: "demo/y",
    distance: 5,
  });
});

test("XY capabilities sample colour on the focused trace's timebase", () => {
  const plot = prepareXyPlot({
    x: { path: "demo/x", values: [1, 3, 6, 8] },
    series: [
      {
        path: "demo/first",
        colorIndex: 0,
        trace: { time: [0, 2], x: [1, 3], y: [1, 3] },
        colorValues: [10, 30],
      },
      {
        path: "demo/second",
        colorIndex: 1,
        trace: { time: [1, 2, 3], x: [6, 7, 8], y: [6, 7, 8] },
        colorValues: [100, 200, 300],
      },
    ],
    color: { path: "demo/c" },
    window: { t0: 0, t1: 3 },
  });

  const cursor = plot.cursorAt(layout, { x: 70, y: 30 }, 5);
  expect(cursor?.rows.find((row) => row.label === "c · demo/c")?.value).toBe(
    200,
  );
  expect(
    plot.resolveAnnotation(annotation("time", 2, 7, "demo/second"))?.colorValue,
  ).toBe(200);
  expect(
    plot.delta([
      mustResolve(plot, annotation("time", 1, 6, "demo/second")),
      mustResolve(plot, annotation("time", 3, 8, "demo/second")),
    ])?.label,
  ).toContain("Δc 200.0000");
});

test("FFT capabilities retain frequency anchors and follow recomputed spectra", () => {
  const first = prepareFftPlot({
    series: [
      {
        path: "demo/y",
        colorIndex: 2,
        frequency: [1, 2, 3],
        amplitudeDb: [-20, -3, -10],
      },
    ],
  });
  const pin = annotation("frequency", 2, -3);
  const recomputed = prepareFftPlot({
    series: [
      {
        path: "demo/y",
        colorIndex: 2,
        frequency: [1, 2, 3],
        amplitudeDb: [-30, -6, -12],
      },
    ],
  });

  expect(first.interaction.cursorLink).toBe("local");
  expect(first.autoRanges()).toEqual({ x: [1, 3], y: [-90, 3] });
  expect(first.resolveAnnotation(pin)?.y).toBe(-3);
  expect(recomputed.resolveAnnotation(pin)?.y).toBe(-6);
  expect(recomputed.stats()[0]?.items).toEqual([
    { label: "peak f", value: 2, unit: "Hz" },
    { label: "peak", value: -6, unit: "dB" },
    { label: "span", value: 2, unit: "Hz" },
    { label: "bins", value: 3, unit: null },
  ]);
  expect(
    recomputed.delta([
      mustResolve(recomputed, annotation("frequency", 1, -30)),
      mustResolve(recomputed, annotation("frequency", 3, -12)),
    ])?.label,
  ).toBe("Δf 2.0000 Hz · ΔdB 18.0000");
});

test("histogram capabilities retain source anchors and resolve current bins", () => {
  const plot = prepareHistogramPlot({
    edges: [0, 5, 10],
    series: [
      {
        path: "demo/y",
        colorIndex: 3,
        counts: [2, 4],
        sourceValues: [1, 2, 7, 8, 9, 10],
      },
    ],
  });
  const resolved = plot.resolveAnnotation(annotation("distribution", 7, 4));

  expect(plot.interaction.cursorLink).toBe("local");
  expect(plot.autoRanges()).toEqual({ x: [0, 10], y: [0, 4.24] });
  expect(resolved).toMatchObject({ x: 7.5, y: 4 });
  expect(plot.stats()[0]?.items).toEqual([
    { label: "min", value: 1, unit: null },
    { label: "max", value: 10, unit: null },
    { label: "mean", value: 37 / 6, unit: null },
    { label: "rms", value: Math.sqrt(299 / 6), unit: null },
    { label: "n", value: 6, unit: null },
    { label: "bins", value: 2, unit: null },
  ]);
  expect(
    plot.delta([
      mustResolve(plot, annotation("distribution", 2, 2)),
      mustResolve(plot, annotation("distribution", 7, 4)),
    ])?.label,
  ).toBe("Δvalue 5.0000 · Δcount 2.0000");
  expect(plot.annotationAt(layout, { x: 70, y: 95 }, 14)).toBeNull();
  expect(plot.annotationAt(layout, { x: 70, y: 60 }, 14)).toMatchObject({
    path: "demo/y",
    domain: "distribution",
    anchor: 7,
    pinnedValue: 4,
  });
  expect(plot.resolveAnnotation(annotation("frequency", 7, 4))).toBeNull();
});

test("all plot adapters report unavailable automatic ranges without finite data", () => {
  expect(
    prepareTimePlot({
      series: [],
      window: { t0: 0, t1: 5 },
    }).autoRanges(),
  ).toEqual({ x: null, y: null });
  expect(
    prepareXyPlot({
      x: { path: "demo/x", values: [] },
      series: [],
      color: null,
      window: { t0: 0, t1: 5 },
    }).autoRanges(),
  ).toEqual({ x: null, y: null });
  expect(prepareFftPlot({ series: [] }).autoRanges()).toEqual({
    x: null,
    y: null,
  });
  expect(prepareHistogramPlot({ edges: [], series: [] }).autoRanges()).toEqual({
    x: null,
    y: null,
  });
});

import { expect, test } from "vitest";
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
        bins: [
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
        ],
      },
    ],
    window: { t0: 0, t1: 5 },
  });

  expect(plot.domain).toBe("time");
  expect(plot.interaction.cursorLink).toBe("time");
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

test("XY capabilities share time anchors and report X, Y and C statistics", () => {
  const plot = prepareXyPlot({
    x: { path: "demo/x", values: [1, 3, 5] },
    series: [
      {
        path: "demo/y",
        colorIndex: 1,
        trace: { time: [0, 1, 2], x: [1, 3, 5], y: [2, 4, 8] },
      },
    ],
    color: { path: "demo/c", values: [10, 20, 30] },
  });

  expect(plot.domain).toBe("time");
  expect(plot.interaction.cursorLink).toBe("time");
  expect(plot.resolveAnnotation(annotation("time", 1, 4))).toMatchObject({
    x: 3,
    y: 4,
  });
  expect(plot.stats().map((group) => group.label)).toEqual([
    "x · demo/x",
    "y · demo/y",
    "c · demo/c",
  ]);
  expect(plot.delta([
    mustResolve(plot, annotation("time", 0, 2)),
    mustResolve(plot, annotation("time", 2, 8)),
  ])?.label).toBe("Δt 2.0000 s · Δx 4.0000 · Δy 6.0000 · Δc 20.0000");
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
  const resolved = plot.resolveAnnotation(
    annotation("distribution", 7, 4),
  );

  expect(plot.interaction.cursorLink).toBe("local");
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
  expect(
    plot.resolveAnnotation(annotation("frequency", 7, 4)),
  ).toBeNull();
});

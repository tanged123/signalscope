import { expect, test } from "vitest";
import { binColumnsFromWire } from "./bin-columns";
import type { Annotation } from "../generated/session";
import { projectX, projectY, type PlotLayout } from "./plot-math";
import {
  prepareLine2DPlot,
  prepareTimePlot,
  type Line2DPlotInput,
} from "./plot-capabilities";

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
    pinned_x: null,
    pinned_value: pinnedValue,
    label: "",
    offset: [10, -10],
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

function lineInput(overrides: Partial<Line2DPlotInput> = {}): Line2DPlotInput {
  return {
    anchor: new Float64Array([0, 1, 2, 3]),
    x: new Float64Array([1, 3, 2, 4]),
    series: [
      {
        path: "demo/y",
        label: "Y",
        unit: "V",
        colorIndex: 0,
        values: new Float64Array([2, 6, 4, 8]),
      },
    ],
    window: { t0: 0, t1: 3 },
    ...overrides,
  };
}

function lineAnnotation(
  anchor: number,
  pinnedValue: number,
  path = "demo/y",
): Annotation {
  return annotation(anchor, pinnedValue, path);
}

test("Line2D reuses immutable extents across preparations and invalidates every coordinate input", () => {
  const input = lineInput();
  let reads = 0;
  const original = input.series[0];
  if (original === undefined) throw new Error("missing test column");
  const values = new Proxy(original.values, {
    get(target, property) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, target) as unknown;
    },
  });
  const source = { ...input, series: [{ ...original, values }] };
  const ranges = prepareLine2DPlot(source).autoRanges();
  expect(reads).toBe(values.length);
  reads = 0;
  expect(
    prepareLine2DPlot({
      ...source,
      series: [{ ...original, values, colorIndex: 7 }],
    }).autoRanges(),
  ).toEqual(ranges);
  expect(reads).toBe(0);

  for (const changed of [
    { ...source, window: { t0: 1, t1: 2 } },
    { ...source, x: new Float64Array([9, 8, 7, 6]) },
    { ...source, anchor: new Float64Array([4, 5, 6, 7]) },
    {
      ...source,
      series: [
        {
          ...original,
          values,
          x: new Float64Array([4, 3, 2, 1]),
          anchor: new Float64Array([0, 1, 2, 8]),
        },
      ],
    },
  ]) {
    reads = 0;
    const actual = prepareLine2DPlot(changed).autoRanges();
    expect(reads).toBe(values.length);
    const uncached = {
      ...changed,
      series: changed.series.map((series) => ({
        ...series,
        values: original.values.slice(),
      })),
    };
    expect(actual).toEqual(prepareLine2DPlot(uncached).autoRanges());
    // Alternating panels/windows replace the entry instead of accumulating it.
    expect(prepareLine2DPlot(source).autoRanges()).toEqual(ranges);
  }
  const replaced = {
    ...source,
    series: [{ ...original, values: new Float64Array([9, 8, 7, 6]) }],
  };
  expect(prepareLine2DPlot(replaced).autoRanges()).not.toEqual(ranges);
});

test("Line2D uses finite paired rows for local automatic ranges", () => {
  const plot = prepareLine2DPlot(lineInput());

  expect(plot.interaction).toMatchObject({
    xAxis: "local",
    cursorLink: "local",
  });
  const ranges = plot.autoRanges();
  expect(ranges.x?.[0]).toBeCloseTo(0.82);
  expect(ranges.x?.[1]).toBeCloseTo(4.18);
  expect(ranges.y?.[0]).toBeCloseTo(1.64);
  expect(ranges.y?.[1]).toBeCloseTo(8.36);
});

test("Line2D cursor scans non-monotonic X and returns paired markers", () => {
  const plot = prepareLine2DPlot(lineInput());
  const xPixel = projectX(layout, 2);
  const cursor = plot.cursorAt(
    layout,
    {
      x: xPixel,
      y: projectY(layout, 4),
    },
    40,
  );

  expect(cursor).toMatchObject({
    x: 2,
    heading: "x = 2.0000",
    link: "local",
  });
  expect(cursor?.rows).toEqual([
    { path: "demo/y", label: "Y", value: 4, unit: "V", colorIndex: 0 },
  ]);
  expect(cursor?.markers).toEqual([{ x: 2, y: 4, colorIndex: 0 }]);
});

test("Line2D cursor uses screen distance to disambiguate duplicate X values", () => {
  const plot = prepareLine2DPlot(
    lineInput({
      x: new Float64Array([2, 2, 4, 5]),
      series: [
        {
          path: "demo/y",
          unit: null,
          colorIndex: 0,
          values: new Float64Array([1, 9, 4, 5]),
        },
      ],
    }),
  );
  const cursor = plot.cursorAt(
    layout,
    {
      x: projectX(layout, 2),
      y: projectY(layout, 9),
    },
    40,
  );

  expect(cursor?.x).toBe(2);
  expect(cursor?.rows[0]?.value).toBe(9);
  expect(cursor?.markers).toEqual([{ x: 2, y: 9, colorIndex: 0 }]);
});

test("Line2D picks non-monotonic segments and vertices in screen space", () => {
  const plot = prepareLine2DPlot(lineInput());
  const first = {
    x: projectX(layout, 3),
    y: projectY(layout, 6),
  };
  const second = {
    x: projectX(layout, 2),
    y: projectY(layout, 4),
  };
  const lineHit = plot.hitAdapter.seriesAt(
    layout,
    (first.x + second.x) / 2,
    (first.y + second.y) / 2,
    1,
  );
  expect(lineHit).toMatchObject({ path: "demo/y", distance: 0 });

  const vertex = plot.annotationAt(layout, { x: second.x, y: second.y }, 1);
  expect(vertex).toEqual({
    path: "demo/y",
    anchor: 2,
    x: 2,
    pinnedValue: 4,
  });
});

test("Line2D gaps and nonfinite values break strokes and picks", () => {
  const plot = prepareLine2DPlot(
    lineInput({
      x: new Float64Array([0, 1, Number.NaN, 3, 4]),
      anchor: new Float64Array([0, 1, 2, 3, 4]),
      series: [
        {
          path: "demo/y",
          unit: null,
          colorIndex: 0,
          values: new Float64Array([0, 1, 2, 3, 4]),
        },
      ],
      window: { t0: 0, t1: 4 },
    }),
  );
  const midpoint = {
    x: projectX(layout, 2),
    y: projectY(layout, 2),
  };

  expect(
    plot.hitAdapter.seriesAt(layout, midpoint.x, midpoint.y, 2),
  ).toBeNull();
  expect(plot.annotationAt(layout, midpoint, 2)).toBeNull();
  const yGapPlot = prepareLine2DPlot(
    lineInput({
      anchor: new Float64Array([0, 1, 2, 3, 4]),
      x: new Float64Array([0, 1, 2, 3, 4]),
      series: [
        {
          path: "demo/y",
          unit: null,
          colorIndex: 0,
          values: new Float64Array([0, 1, Number.NaN, 3, 4]),
        },
      ],
      window: { t0: 0, t1: 4 },
    }),
  );
  expect(
    yGapPlot.hitAdapter.seriesAt(layout, midpoint.x, midpoint.y, 2),
  ).toBeNull();
  expect(yGapPlot.annotationAt(layout, midpoint, 2)).toBeNull();
  const ranges = plot.autoRanges();
  expect(ranges.x?.[0]).toBeCloseTo(-0.24);
  expect(ranges.x?.[1]).toBeCloseTo(4.24);
  expect(ranges.y?.[0]).toBeCloseTo(-0.24);
  expect(ranges.y?.[1]).toBeCloseTo(4.24);
});

test("Line2D resolves annotations by source anchor to current plotted values", () => {
  const plot = prepareLine2DPlot(lineInput());

  expect(plot.resolveAnnotation(lineAnnotation(2, 100))).toMatchObject({
    x: 2,
    y: 4,
    colorIndex: 0,
    summary: "2.0000 · 4.0000",
  });
  expect(plot.resolveAnnotation(lineAnnotation(9, 100))).toMatchObject({
    x: 4,
    y: 8,
    summary: "4.0000 · 8.0000",
  });
});

test("Line2D reports exact reduced extrema but no raw aggregate statistics", () => {
  const plot = prepareLine2DPlot(lineInput());

  expect(plot.stats()[0]?.items).toEqual([
    { label: "min", value: 2, unit: null },
    { label: "max", value: 8, unit: null },
    { label: "mean", value: null, unit: null },
    { label: "rms", value: null, unit: null },
    { label: "n", value: null, unit: null },
  ]);
});

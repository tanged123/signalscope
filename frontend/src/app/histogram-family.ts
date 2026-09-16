import type { HistogramResponse, HistogramSeries } from "../generated/protocol";
import type { Annotation } from "../generated/session";
import {
  formatValue,
  paddedExtent,
  projectX,
  projectY,
  invertX,
  axisCoordinate,
  type AxisScale,
  type PlotLayout,
  type Range,
} from "./plot-math";
import type {
  AnnotationAnchor,
  PlotCursor,
  PlotInteractionPolicy,
  PreparedPlot,
  ResolvedAnnotation,
  SeriesHitAdapter,
} from "./plot-capabilities";
import type { AxisStyle } from "../generated/session";
import type { Line2DRenderInput } from "../render/line2d";
import { hueIndex, type SeriesStroke } from "../render/plot-theme";
import { createFeedCache } from "../render/line2d-adapter";

const HISTOGRAM_POLICY: PlotInteractionPolicy = {
  xAxis: "local",
  cursorLink: "local",
  pan: new Set(["x", "y"]),
  zoom: new Set(["x", "y", "box"]),
  fit: true,
  stickyAutoY: false,
  windowNote: "source window",
};

interface HistogramFamilySeries {
  path: string;
  hue: number | null;
  visible: boolean;
}

interface HistogramFamilyContext {
  series: readonly HistogramFamilySeries[];
  axisStyle: AxisStyle;
  xLabel: string | null;
  yLabel: string | null;
  colorCount?: number;
  xScale?: AxisScale | null;
  yScale?: AxisScale | null;
}

interface PreparedHistogramFamily {
  plotted: readonly { signalPath: string; unit: string | null }[];
  plot: PreparedPlot;
  makeInput(
    ranges: { x: Range; y: Range },
    styles: readonly SeriesStroke[],
  ): Line2DRenderInput;
}

export interface HistogramPanelResponse {
  kind: "histogram";
  response: HistogramResponse;
  identity?: string;
  pending?: boolean;
  captured?: boolean;
}

interface HistogramFamily {
  prepare(context: HistogramFamilyContext): PreparedHistogramFamily;
}

/** Presentation for exact count results in the histogram's value domain. */
export function histogramFamily(data: HistogramPanelResponse): HistogramFamily {
  return {
    prepare(context) {
      const byPath = new Map(
        context.series.map((series) => [series.path, series]),
      );
      const shown = data.response.series.filter(
        (series) => byPath.get(series.signal_path)?.visible ?? true,
      );
      const xScale = context.xScale ?? "linear";
      const yScale = context.yScale ?? "linear";
      const originEdge = data.response.edges.find((edge) =>
        Number.isFinite(axisCoordinate(edge, xScale)),
      );
      const xOrigin =
        originEdge === undefined ? 0 : axisCoordinate(originEdge, xScale);
      const columns = shown.map((series) =>
        columnCache(
          series,
          { edges: data.response.edges, xScale, yScale, xOrigin },
          () =>
            histogramColumn(
              series,
              data.response.edges,
              xScale,
              yScale,
              xOrigin,
            ),
        ),
      );
      const plotted = shown.map((series) => ({
        signalPath: series.signal_path,
        unit: series.unit,
      }));
      return {
        plotted,
        plot: prepareHistogramPlot({
          edges: data.response.edges,
          series: columns.map((column, index) => ({
            ...column,
            path: shown[index]?.signal_path ?? column.path,
            colorIndex: colorIndex(
              byPath.get(shown[index]?.signal_path ?? "")?.hue,
              context.colorCount,
            ),
          })),
          xScale: context.xScale ?? "linear",
          yScale: context.yScale ?? "linear",
          window: data.response.window,
          windowNote: histogramWindowNote(data),
        }),
        makeInput: (ranges, styles) => ({
          xOrigin,
          series: columns.map((column, index) => ({
            id: shown[index]?.signal_id ?? column.path,
            name: shown[index]?.signal_path ?? column.path,
            data: column.data,
            style: styles[index] ?? {
              hue: null,
              dash: "solid",
              width: 1,
              alpha: 1,
            },
          })),
          xRange: ranges.x,
          yRange: [ranges.y.min, ranges.y.max],
          axes: {
            x: {
              label: context.xLabel ?? histogramXLabel(shown),
              scale: context.xScale ?? "linear",
            },
            y: {
              label: context.yLabel ?? "sample count",
              scale: context.yScale ?? "linear",
            },
            style: context.axisStyle,
          },
        }),
      };
    },
  };
}

interface HistogramColumn {
  path: string;
  unit: string | null;
  counts: bigint[];
  data: Float32Array;
  finiteCount: string;
  excludedCount: string;
}

const columnCache = createFeedCache<
  HistogramSeries,
  {
    edges: readonly number[];
    xScale: AxisScale;
    yScale: AxisScale;
    xOrigin: number;
  },
  HistogramColumn
>(
  (a, b) =>
    a.edges === b.edges &&
    a.xScale === b.xScale &&
    a.yScale === b.yScale &&
    a.xOrigin === b.xOrigin,
);

function histogramColumn(
  series: HistogramSeries,
  edges: readonly number[],
  xScale: AxisScale,
  yScale: AxisScale,
  xOrigin: number,
): HistogramColumn {
  const bins = Math.max(0, edges.length - 1);
  const counts = series.counts.map((value) => BigInt(value));
  const data = new Float32Array(bins * 8);
  // Zero counts have no logarithm; log plots use one sample as the baseline.
  const baseline = 0;
  for (let index = 0; index < bins; index += 1) {
    const left = edges[index] as number;
    const right = edges[index + 1] as number;
    const count = renderCount(counts[index] as bigint);
    const offset = index * 8;
    const leftX = axisCoordinate(left, xScale);
    const rightX = axisCoordinate(right, xScale);
    const y = axisCoordinate(count, yScale);
    data[offset] = Number.isFinite(leftX) ? leftX - xOrigin : 0;
    data[offset + 1] = Number.isFinite(leftX) ? baseline : NaN;
    data[offset + 2] = data[offset] as number;
    data[offset + 3] = Number.isFinite(leftX) ? y : NaN;
    data[offset + 4] = Number.isFinite(rightX) ? rightX - xOrigin : 0;
    data[offset + 5] = Number.isFinite(rightX) ? y : NaN;
    data[offset + 6] = data[offset + 4] as number;
    data[offset + 7] = Number.isFinite(rightX) ? baseline : NaN;
  }
  return {
    path: series.signal_path,
    unit: series.unit,
    counts,
    data,
    finiteCount: series.finite_count,
    excludedCount: series.excluded_count,
  };
}

function prepareHistogramPlot(input: {
  edges: readonly number[];
  series: readonly (HistogramColumn & { colorIndex: number })[];
  xScale: AxisScale;
  yScale: AxisScale;
  window: { t0: number; t1: number };
  windowNote: string;
}): PreparedPlot {
  const columns = input.series;
  const xMin = input.edges[0] ?? 0;
  const xMax = input.edges[input.edges.length - 1] ?? 1;
  const maximum = columns.reduce(
    (max, column) =>
      column.counts.reduce(
        (inner, count) => Math.max(inner, renderCount(count)),
        max,
      ),
    0,
  );
  const yRange = histogramYExtent(maximum, input.yScale);
  const visible = (): readonly (HistogramColumn & { colorIndex: number })[] =>
    columns;
  const binAt = (value: number): number => {
    if (
      input.edges.length === 0 ||
      !Number.isFinite(value) ||
      value < xMin ||
      value > xMax
    )
      return -1;
    if (value === xMax) return input.edges.length - 2;
    let low = 0;
    let high = input.edges.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((input.edges[middle + 1] as number) <= value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const countFor = (column: HistogramColumn, index: number): bigint =>
    column.counts[index] as bigint;
  const xForBin = (index: number): number =>
    (input.edges[index] as number) / 2 + (input.edges[index + 1] as number) / 2;
  const annotation = (entry: Annotation): ResolvedAnnotation | null => {
    const column = columns.find(
      (candidate) => candidate.path === entry.series_path,
    );
    if (column === undefined) return null;
    const index = binAt(entry.anchor);
    if (index < 0) return null;
    const x = xForBin(index);
    const value = renderCount(countFor(column, index));
    if (
      !Number.isFinite(axisCoordinate(x, input.xScale)) ||
      !Number.isFinite(axisCoordinate(value, input.yScale))
    )
      return null;
    return {
      annotation: entry,
      x,
      y: value,
      colorIndex: column.colorIndex,
      summary: `${histogramInterval(input.edges, index)} · ${countText(countFor(column, index))}`,
      exactValue: countText(countFor(column, index)),
      colorValue: null,
    };
  };
  const nearest = (
    layout: PlotLayout,
    px: number,
    py: number,
    threshold: number,
  ): { path: string; index: number; distance: number } | null => {
    let best: { path: string; index: number; distance: number } | null = null;
    let bestSquared = threshold * threshold;
    for (const column of visible()) {
      for (let index = 0; index < column.counts.length; index += 1) {
        const left = projectX(layout, input.edges[index] as number);
        const right = projectX(layout, input.edges[index + 1] as number);
        const y = projectY(layout, renderCount(countFor(column, index)));
        const horizontal = segmentDistanceSquared(left, y, right, y, px, py);
        const nextY =
          index + 1 < column.counts.length
            ? projectY(layout, renderCount(countFor(column, index + 1)))
            : y;
        const vertical = segmentDistanceSquared(right, y, right, nextY, px, py);
        const squared = Math.min(horizontal, vertical);
        if (squared <= bestSquared) {
          bestSquared = squared;
          best = { path: column.path, index, distance: Math.sqrt(squared) };
        }
      }
    }
    return best;
  };
  const hitAdapter: SeriesHitAdapter = {
    seriesAt(layout, x, y, threshold) {
      const hit = nearest(layout, x, y, threshold);
      return hit === null ? null : { path: hit.path, distance: hit.distance };
    },
  };
  return {
    interaction: {
      ...HISTOGRAM_POLICY,
      windowNote: input.windowNote,
    },
    hitAdapter,
    autoRanges() {
      return {
        x:
          input.xScale === "log"
            ? paddedExtent(
                input.edges.find((edge) => edge > 0) ?? 1,
                xMax > 0 ? xMax : 10,
                "log",
              )
            : paddedExtent(xMin, xMax, input.xScale),
        y: yRange,
      };
    },
    cursorAt(layout, point) {
      const x = invertX(layout, point.x);
      const index = binAt(x);
      if (index < 0) return null;
      const rows = visible().map((column) => {
        const count = countFor(column, index);
        return {
          path: column.path,
          label: column.path,
          value: renderCount(count),
          exactValue: countText(count),
          unit: null,
          colorIndex: column.colorIndex,
        };
      });
      return {
        x,
        heading: `value ${histogramInterval(input.edges, index)}`,
        rows,
        markers: rows.map((row) => ({
          x,
          y: row.value,
          colorIndex: row.colorIndex,
        })),
        link: "local",
      } satisfies PlotCursor;
    },
    annotationAt(layout, point, radius): AnnotationAnchor | null {
      const hit = nearest(layout, point.x, point.y, radius);
      if (hit === null) return null;
      const x = xForBin(hit.index);
      return {
        path: hit.path,
        anchor: x,
        x,
        pinnedValue: renderCount(
          countFor(
            columns.find(
              (column) => column.path === hit.path,
            ) as HistogramColumn,
            hit.index,
          ),
        ),
        histogramWindow: [input.window.t0, input.window.t1],
        histogramBinCount: input.edges.length - 1,
      };
    },
    resolveAnnotation: annotation,
    stats() {
      return columns.map((column) => ({
        label: column.path,
        items: [
          { label: "min", value: null, unit: column.unit },
          { label: "max", value: null, unit: column.unit },
          { label: "mean", value: null, unit: column.unit },
          { label: "rms", value: null, unit: column.unit },
          {
            label: "n",
            value: Number(column.finiteCount),
            exactValue: column.finiteCount,
            unit: null,
          },
        ],
      }));
    },
  };
}

function histogramWindowNote(data: HistogramPanelResponse): string {
  const source =
    data.captured === true ? "captured source window" : "source window";
  const interval = `[${formatValue(data.response.window.t0)}, ${formatValue(data.response.window.t1)}] s`;
  return `${data.pending === true ? "updating · " : ""}${source} ${interval}`;
}

function colorIndex(hue: number | null | undefined, count?: number): number {
  return hue === null || hue === undefined ? 0 : hueIndex(hue, count);
}

function renderCount(value: bigint): number {
  return Number(value);
}

function countText(value: bigint): string {
  return value.toString();
}

function histogramYExtent(maximum: number, scale: AxisScale): [number, number] {
  if (scale === "log")
    return [Math.max(1, maximum / 100), Math.max(2, maximum * 1.06)];
  return maximum <= 0 ? [0, 1] : [0, Math.max(1, maximum * 1.06)];
}

function histogramXLabel(series: readonly HistogramSeries[]): string {
  const units = [...new Set(series.map((entry) => entry.unit))];
  return units.length === 1 && units[0] != null
    ? `value (${units[0]})`
    : "value";
}

function histogramInterval(edges: readonly number[], index: number): string {
  const left = edges[index] as number;
  const right = edges[index + 1] as number;
  const closing = index === edges.length - 2 ? "]" : ")";
  return `[${formatValue(left)}, ${formatValue(right)}${closing}`;
}

function segmentDistanceSquared(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  px: number,
  py: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const denominator = dx * dx + dy * dy;
  const fraction =
    denominator === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((px - x0) * dx + (py - y0) * dy) / denominator),
        );
  const x = x0 + fraction * dx;
  const y = y0 + fraction * dy;
  return (x - px) ** 2 + (y - py) ** 2;
}

import type { Annotation } from "../generated/session";
import {
  columnsStats,
  columnsValueAtTime,
  columnsYExtent,
  type BinColumns,
} from "./bin-columns";
import { nearestLine, nearestVertex } from "./plot-hit";
import {
  formatValue,
  invertX,
  paddedExtent,
  projectX,
  projectY,
  type PlotLayout,
} from "./plot-math";

interface PlotPoint {
  x: number;
  y: number;
}

export interface PlotInteractionPolicy {
  xAxis: "linked-time" | "local";
  cursorLink: "time" | "local";
  pan: ReadonlySet<"x" | "y">;
  zoom: ReadonlySet<"x" | "y" | "box">;
  fit: boolean;
  stickyAutoY: boolean;
  windowNote: string | null;
}

interface PlotReadingRow {
  path: string;
  label: string;
  value: number;
  unit: string | null;
  colorIndex: number;
}

export interface PlotCursor {
  x: number;
  heading: string;
  rows: readonly PlotReadingRow[];
  markers: readonly PlotMarker[];
  link: "time" | "local";
}

export interface AnnotationAnchor {
  path: string;
  anchor: number;
  x: number;
  pinnedValue: number;
}

export interface ResolvedAnnotation {
  annotation: Annotation;
  x: number;
  y: number;
  colorIndex: number;
  summary: string;
  colorValue: number | null;
}

interface PlotMarker {
  x: number;
  y: number;
  colorIndex: number;
}

interface PlotStat {
  label: string;
  value: number | null;
  unit: string | null;
}

interface PlotStatGroup {
  label: string;
  items: readonly PlotStat[];
}

interface SeriesHit {
  path: string;
  distance: number;
}

export interface SeriesHitAdapter {
  seriesAt(
    layout: PlotLayout,
    x: number,
    y: number,
    threshold: number,
  ): SeriesHit | null;
}

export interface PreparedPlot {
  readonly interaction: PlotInteractionPolicy;
  readonly hitAdapter: SeriesHitAdapter;
  autoRanges(): {
    x: readonly [number, number] | null;
    y: readonly [number, number] | null;
  };
  cursorAt(
    layout: PlotLayout,
    point: PlotPoint,
    radius: number,
  ): PlotCursor | null;
  annotationAt(
    layout: PlotLayout,
    point: PlotPoint,
    radius: number,
  ): AnnotationAnchor | null;
  resolveAnnotation(annotation: Annotation): ResolvedAnnotation | null;
  stats(): readonly PlotStatGroup[];
}

interface PreparedSeries {
  path: string;
  colorIndex: number;
  visible?: boolean;
}

export interface TimePlotInput {
  series: readonly (PreparedSeries & { bins: BinColumns })[];
  window: { t0: number; t1: number };
}

/** One plotted Y column in a correspondence-preserving Line2D response. */
interface Line2DPlotSeries {
  path: string;
  label?: string;
  unit: string | null;
  colorIndex: number;
  values: Float64Array;
  anchor?: Float64Array;
  x?: Float64Array;
  visible?: boolean;
}

/**
 * Transport-independent input for a plot of Y columns against one X column.
 * `anchor` remains the source-time coordinate used for windowing and tips;
 * rows are never joined by their plotted X values.
 */
export interface Line2DPlotInput {
  linkedTime?: boolean | undefined;
  anchor: Float64Array;
  x: Float64Array;
  series: readonly Line2DPlotSeries[];
  window: { t0: number; t1: number };
}

type SeriesExtent = { min: number; max: number } | null;

export const TIME_POLICY: PlotInteractionPolicy = {
  xAxis: "linked-time",
  cursorLink: "time",
  pan: new Set(["x", "y"]),
  zoom: new Set(["x", "y", "box"]),
  fit: true,
  stickyAutoY: true,
  windowNote: null,
};

/** Interaction policy for a Line2D plot whose X coordinate is signal-local. */
const LINE2D_POLICY: PlotInteractionPolicy = {
  xAxis: "local",
  cursorLink: "local",
  pan: new Set(["x", "y"]),
  zoom: new Set(["x", "y", "box"]),
  fit: true,
  stickyAutoY: true,
  windowNote: null,
};

export function prepareTimePlot(input: TimePlotInput): PreparedPlot {
  let extents: SeriesExtent[] | null = null;
  const seriesExtents = (): SeriesExtent[] =>
    (extents ??= input.series.map((series) =>
      columnsYExtent(series.bins, input.window),
    ));
  const resolve = (annotation: Annotation): ResolvedAnnotation | null => {
    const series = input.series.find(
      (entry) => entry.path === annotation.series_path,
    );
    if (series === undefined) return null;
    return resolved(
      annotation,
      annotation.anchor,
      annotation.pinned_value,
      series.colorIndex,
    );
  };
  return {
    interaction: TIME_POLICY,
    hitAdapter: {
      seriesAt(layout, x, y, threshold) {
        const hit = nearestLine(
          input.series
            .filter((series) => series.visible !== false)
            .map((series) => ({ path: series.path, bins: series.bins })),
          layout,
          x,
          y,
          threshold,
        );
        return hit === null ? null : { path: hit.path, distance: hit.distance };
      },
    },
    autoRanges() {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const extent of seriesExtents()) {
        if (extent === null) continue;
        min = Math.min(min, extent.min);
        max = Math.max(max, extent.max);
      }
      const y = paddedExtent(min, max);
      return y === null
        ? { x: null, y: null }
        : { x: [input.window.t0, input.window.t1], y };
    },
    cursorAt(layout, point) {
      const x = invertX(layout, point.x);
      const rows = input.series.flatMap((series) => {
        const value = columnsValueAtTime(series.bins, x);
        return value === null
          ? []
          : [reading(series.path, value, null, series.colorIndex)];
      });
      return cursor(x, `t = ${formatValue(x)} s`, rows, "time");
    },
    annotationAt(layout, point, radius) {
      const hit = nearestVertex(
        input.series.map((series) => ({
          path: series.path,
          bins: series.bins,
        })),
        layout,
        point.x,
        point.y,
        radius,
      );
      return hit === null
        ? null
        : {
            path: hit.path,
            anchor: hit.time,
            x: hit.time,
            pinnedValue: hit.value,
          };
    },
    resolveAnnotation: resolve,
    stats() {
      return input.series.map((series) => {
        const stats = columnsStats(
          series.bins,
          input.window.t0,
          input.window.t1,
        );
        return statsGroup(series.path, [
          stat("min", stats.min),
          stat("max", stats.max),
          stat("mean", stats.mean),
          stat("rms", stats.rms),
          stat("n", stats.n),
        ]);
      });
    },
  };
}

/**
 * Prepares correspondence-preserving arbitrary-X Line2D data.
 *
 * The source anchor is used only to select the active time window and to keep
 * annotations stable. All picking and cursor work projects the paired X/Y
 * values into screen space, so X need not be monotonic.
 */
export function prepareLine2DPlot(input: Line2DPlotInput): PreparedPlot {
  validateLine2DInput(input);
  const visibleSeries = (): readonly Line2DPlotSeries[] =>
    input.series.filter((series) => series.visible !== false);
  const inWindow = (series: Line2DPlotSeries, index: number): boolean => {
    const anchor = (series.anchor ?? input.anchor)[index] as number;
    return (
      Number.isFinite(anchor) &&
      anchor >= input.window.t0 &&
      anchor <= input.window.t1
    );
  };
  const rowFor = (series: Line2DPlotSeries, index: number): XYPoint | null => {
    if (!inWindow(series, index)) return null;
    const x = (series.x ?? input.x)[index] as number;
    const y = series.values[index] as number;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  };
  const resolve = (annotation: Annotation): ResolvedAnnotation | null => {
    const series = input.series.find(
      (entry) => entry.path === annotation.series_path,
    );
    if (series === undefined) return null;
    if (annotation.pinned_x !== null) {
      return resolved(
        annotation,
        annotation.pinned_x,
        annotation.pinned_value,
        series.colorIndex,
      );
    }
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < series.values.length; index += 1) {
      const anchor = (series.anchor ?? input.anchor)[index] as number;
      if (!Number.isFinite(anchor)) continue;
      const distance = Math.abs(anchor - annotation.anchor);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    if (nearestIndex < 0) return null;
    const row = rowFor(series, nearestIndex);
    return row === null
      ? null
      : resolved(annotation, row.x, row.y, series.colorIndex);
  };
  return {
    interaction: input.linkedTime === true ? TIME_POLICY : LINE2D_POLICY,
    hitAdapter: {
      seriesAt(layout, x, y, threshold) {
        let best: SeriesHit | null = null;
        let bestSquared = threshold * threshold;
        for (const series of visibleSeries()) {
          let previous: ScreenXYPoint | null = null;
          for (let index = 0; index < series.values.length; index += 1) {
            const row = rowFor(series, index);
            if (row === null) {
              previous = null;
              continue;
            }
            const current = {
              x: projectX(layout, row.x),
              y: projectY(layout, row.y),
            };
            if (previous !== null) {
              const hit = segmentHit(previous, current, x, y);
              if (hit.squared <= bestSquared && best === null) {
                bestSquared = hit.squared;
                best = {
                  path: series.path,
                  distance: Math.sqrt(hit.squared),
                };
              } else if (hit.squared < bestSquared) {
                bestSquared = hit.squared;
                best = {
                  path: series.path,
                  distance: Math.sqrt(hit.squared),
                };
              }
            }
            previous = current;
          }
        }
        return best;
      },
    },
    autoRanges() {
      let xMin = Number.POSITIVE_INFINITY;
      let xMax = Number.NEGATIVE_INFINITY;
      let yMin = Number.POSITIVE_INFINITY;
      let yMax = Number.NEGATIVE_INFINITY;
      for (const series of input.series) {
        for (let index = 0; index < series.values.length; index += 1) {
          const row = rowFor(series, index);
          if (row === null) continue;
          xMin = Math.min(xMin, row.x);
          xMax = Math.max(xMax, row.x);
          yMin = Math.min(yMin, row.y);
          yMax = Math.max(yMax, row.y);
        }
      }
      return {
        x: paddedExtent(xMin, xMax),
        y: paddedExtent(yMin, yMax),
      };
    },
    cursorAt(layout, point) {
      if (input.linkedTime === true) {
        const x = invertX(layout, point.x);
        const rows = visibleSeries().flatMap((series) => {
          let best: XYPoint | null = null;
          for (let index = 0; index < series.values.length; index += 1) {
            const row = rowFor(series, index);
            if (
              row !== null &&
              (best === null || Math.abs(row.x - x) < Math.abs(best.x - x))
            )
              best = row;
          }
          return best === null
            ? []
            : [
                reading(
                  series.path,
                  best.y,
                  series.unit,
                  series.colorIndex,
                  series.label ?? series.path,
                ),
              ];
        });
        return cursor(x, `t = ${formatValue(x)} s`, rows, "time");
      }
      let nearestX: number | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      let nearestIndex = -1;
      let nearestSeries: Line2DPlotSeries | null = null;
      for (const series of visibleSeries()) {
        for (let index = 0; index < series.values.length; index += 1) {
          const row = rowFor(series, index);
          if (row === null) continue;
          const dx = projectX(layout, row.x) - point.x;
          const dy = projectY(layout, row.y) - point.y;
          const distance = dx * dx + dy * dy;
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestX = row.x;
            nearestIndex = index;
            nearestSeries = series;
          }
        }
      }
      if (nearestX === null || nearestIndex < 0 || nearestSeries === null)
        return null;
      const rows = visibleSeries().flatMap((series) => {
        if (
          (series.anchor ?? input.anchor) !==
            (nearestSeries.anchor ?? input.anchor) ||
          (series.x ?? input.x) !== (nearestSeries.x ?? input.x)
        )
          return [];
        const row = rowFor(series, nearestIndex);
        return row === null
          ? []
          : [
              reading(
                series.path,
                row.y,
                series.unit,
                series.colorIndex,
                series.label ?? series.path,
              ),
            ];
      });
      return {
        x: nearestX,
        heading: `x = ${formatValue(nearestX)}`,
        rows,
        markers: rows.map((row) => ({
          x: nearestX,
          y: row.value,
          colorIndex: row.colorIndex,
        })),
        link: "local",
      };
    },
    annotationAt(layout, point, radius) {
      let best: AnnotationAnchor | null = null;
      let bestSquared = radius * radius;
      for (const series of input.series) {
        for (let index = 0; index < series.values.length; index += 1) {
          const row = rowFor(series, index);
          if (row === null) continue;
          const dx = projectX(layout, row.x) - point.x;
          const dy = projectY(layout, row.y) - point.y;
          const squared = dx * dx + dy * dy;
          if (squared < bestSquared) {
            bestSquared = squared;
            best = {
              path: series.path,
              anchor: (series.anchor ?? input.anchor)[index] as number,
              x: row.x,
              pinnedValue: row.y,
            };
          }
        }
      }
      return best;
    },
    resolveAnnotation: resolve,
    stats() {
      return input.series.map((series) => {
        let min: number | null = null;
        let max: number | null = null;
        for (let index = 0; index < series.values.length; index += 1) {
          const row = rowFor(series, index);
          if (row === null) continue;
          min = min === null ? row.y : Math.min(min, row.y);
          max = max === null ? row.y : Math.max(max, row.y);
        }
        return statsGroup(series.path, [
          stat("min", min),
          stat("max", max),
          stat("mean", null),
          stat("rms", null),
          stat("n", null),
        ]);
      });
    },
  };
}

interface XYPoint {
  x: number;
  y: number;
}

interface ScreenXYPoint {
  x: number;
  y: number;
}

function validateLine2DInput(input: Line2DPlotInput): void {
  if (input.anchor.length !== input.x.length) {
    throw new Error("Line2D anchor and X columns must have equal lengths");
  }
  for (const series of input.series) {
    if (
      series.values.length !== (series.anchor ?? input.anchor).length ||
      series.values.length !== (series.x ?? input.x).length
    ) {
      throw new Error(`Line2D Y column ${series.path} has a mismatched length`);
    }
  }
}

function segmentHit(
  first: ScreenXYPoint,
  second: ScreenXYPoint,
  px: number,
  py: number,
): { squared: number; fraction: number } {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const lengthSquared = dx * dx + dy * dy;
  const fraction =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((px - first.x) * dx + (py - first.y) * dy) / lengthSquared,
          ),
        );
  const x = first.x + dx * fraction;
  const y = first.y + dy * fraction;
  return { squared: (x - px) ** 2 + (y - py) ** 2, fraction };
}

function cursor(
  x: number,
  heading: string,
  rows: readonly PlotReadingRow[],
  link: "time" | "local",
): PlotCursor {
  return {
    x,
    heading,
    rows,
    markers: rows.map((row) => ({
      x,
      y: row.value,
      colorIndex: row.colorIndex,
    })),
    link,
  };
}

function reading(
  path: string,
  value: number,
  unit: string | null,
  colorIndex: number,
  label = path,
): PlotReadingRow {
  return { path, label, value, unit, colorIndex };
}

function resolved(
  annotation: Annotation,
  x: number,
  y: number,
  colorIndex: number,
): ResolvedAnnotation {
  return {
    annotation,
    x,
    y,
    colorIndex,
    summary: `${formatValue(x)} · ${formatValue(y)}`,
    colorValue: null,
  };
}

function stat(
  label: string,
  value: number | null | undefined,
  unit: string | null = null,
): PlotStat {
  return { label, value: value ?? null, unit };
}

function statsGroup(label: string, items: readonly PlotStat[]): PlotStatGroup {
  return { label, items };
}

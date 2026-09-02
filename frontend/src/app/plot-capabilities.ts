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

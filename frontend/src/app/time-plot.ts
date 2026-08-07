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

export interface PlotCursor {
  x: number;
  heading: string;
  rows: readonly PlotReadingRow[];
  markers: readonly PlotMarker[];
  link: "time";
}

export interface PlotInteractionPolicy {
  xAxis: "linked-time" | "local";
  cursorLink: "time" | "local";
  pan: ReadonlySet<"x" | "y">;
  zoom: ReadonlySet<"x" | "y" | "box">;
  fit: boolean;
  stickyAutoY: boolean;
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
}

export interface PlotStat {
  label: string;
  value: number | null;
  unit: string | null;
}

export interface PlotStatGroup {
  label: string;
  items: readonly PlotStat[];
}

export interface PlotDelta {
  label: string;
  first: { x: number; y: number };
  second: { x: number; y: number };
}

export interface SeriesHit {
  path: string;
  distance: number;
}

export interface PreparedTimePlot {
  readonly interaction: PlotInteractionPolicy;
  autoRange(): {
    x: readonly [number, number];
    y: readonly [number, number];
  } | null;
  cursorAt(
    layout: PlotLayout,
    point: { x: number; y: number },
  ): PlotCursor | null;
  annotationAt(
    layout: PlotLayout,
    point: { x: number; y: number },
    radius: number,
  ): AnnotationAnchor | null;
  resolveAnnotation(annotation: Annotation): ResolvedAnnotation | null;
  stats(): readonly PlotStatGroup[];
  delta(resolved: readonly ResolvedAnnotation[]): PlotDelta | null;
  seriesAt(
    layout: PlotLayout,
    x: number,
    y: number,
    threshold: number,
  ): SeriesHit | null;
}

export const TIME_PLOT_INTERACTION: PlotInteractionPolicy = {
  xAxis: "linked-time",
  cursorLink: "time",
  pan: new Set(["x", "y"]),
  zoom: new Set(["x", "y", "box"]),
  fit: true,
  stickyAutoY: true,
};

export interface TimePlotInput {
  series: readonly {
    path: string;
    colorIndex: number;
    bins: BinColumns;
    visible?: boolean;
  }[];
  window: { t0: number; t1: number };
}

interface PlotReadingRow {
  path: string;
  label: string;
  value: number;
  unit: string | null;
  colorIndex: number;
}

interface PlotMarker {
  path: string;
  x: number;
  y: number;
  colorIndex: number;
}

export function prepareTimePlot(input: TimePlotInput): PreparedTimePlot {
  let extents: readonly ReturnType<typeof columnsYExtent>[] | null = null;
  const yExtents = (): readonly ReturnType<typeof columnsYExtent>[] => {
    extents ??= input.series.map((series) =>
      columnsYExtent(series.bins, input.window),
    );
    return extents;
  };
  const resolve = (annotation: Annotation): ResolvedAnnotation | null => {
    const series = input.series.find(
      (entry) => entry.path === annotation.series_path,
    );
    if (series === undefined) return null;
    const y = columnsValueAtTime(series.bins, annotation.anchor);
    return y === null
      ? null
      : {
          annotation,
          x: annotation.anchor,
          y,
          colorIndex: series.colorIndex,
          summary: `${formatValue(annotation.anchor)} · ${formatValue(y)}`,
        };
  };
  return {
    interaction: TIME_PLOT_INTERACTION,
    autoRange() {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const extent of yExtents()) {
        if (extent === null) continue;
        min = Math.min(min, extent.min);
        max = Math.max(max, extent.max);
      }
      const y = paddedExtent(min, max);
      return y === null ? null : { x: [input.window.t0, input.window.t1], y };
    },
    cursorAt(layout, point) {
      const x = invertX(layout, point.x);
      const rows = input.series.flatMap((series) => {
        const value = columnsValueAtTime(series.bins, x);
        return value === null
          ? []
          : [
              {
                path: series.path,
                label: series.path,
                value,
                unit: null,
                colorIndex: series.colorIndex,
              },
            ];
      });
      return {
        x,
        heading: `t = ${formatValue(x)} s`,
        rows,
        markers: rows.map((row) => ({
          path: row.path,
          x,
          y: row.value,
          colorIndex: row.colorIndex,
        })),
        link: "time",
      };
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
        : { path: hit.path, anchor: hit.time, pinnedValue: hit.value };
    },
    resolveAnnotation: resolve,
    stats() {
      return input.series.map((series) => {
        const stats = columnsStats(
          series.bins,
          input.window.t0,
          input.window.t1,
        );
        return {
          label: series.path,
          items: [
            stat("min", stats.min),
            stat("max", stats.max),
            stat("mean", stats.mean),
            stat("rms", stats.rms),
            stat("n", stats.n),
          ],
        };
      });
    },
    delta(items) {
      const first = items[items.length - 2];
      const second = items[items.length - 1];
      if (first === undefined || second === undefined) return null;
      const deltaT = second.x - first.x;
      const deltaY = second.y - first.y;
      const parts = [
        `Δt ${formatValue(deltaT)} s`,
        `Δy ${formatValue(deltaY)}`,
      ];
      if (deltaT !== 0) parts.push(`slope ${formatValue(deltaY / deltaT)}/s`);
      return {
        label: parts.join(" · "),
        first: { x: first.x, y: first.y },
        second: { x: second.x, y: second.y },
      };
    },
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
  };
}

function stat(
  label: string,
  value: number | null | undefined,
  unit: string | null = null,
): PlotStat {
  return { label, value: value ?? null, unit };
}

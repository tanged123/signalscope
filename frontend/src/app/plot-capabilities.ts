import type {
  Annotation,
  AnnotationDomain,
  PanelMode,
} from "../generated/session";
import {
  columnsStats,
  columnsValueAtTime,
  columnsYExtent,
  type BinColumns,
} from "./bin-columns";
import { nearestLine, nearestVertex, segmentHit } from "./plot-hit";
import {
  formatValue,
  invertX,
  paddedExtent,
  projectX,
  projectY,
  type PlotLayout,
} from "./plot-math";
import { lerpSample, traceExtent, type XyTrace } from "./xy";
import { nearestXyPoint } from "./xy-hit";

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
  domain: AnnotationDomain;
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

export interface PlotDelta {
  label: string;
  first: PlotPoint;
  second: PlotPoint;
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
  readonly domain: AnnotationDomain;
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
  delta(resolved: readonly ResolvedAnnotation[]): PlotDelta | null;
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

export interface XyPlotInput {
  x: { path: string; values: readonly number[] };
  series: readonly (PreparedSeries & {
    trace: XyTrace;
    colorValues: readonly number[] | null;
  })[];
  color: { path: string } | null;
  window: { t0: number; t1: number };
}

export interface FftPlotInput {
  series: readonly (PreparedSeries & {
    frequency: readonly number[];
    amplitudeDb: readonly number[];
  })[];
}

export interface HistogramPlotInput {
  edges: readonly number[];
  series: readonly (PreparedSeries & {
    counts: readonly number[];
    sourceValues: readonly number[];
  })[];
}

const POLICIES: Record<PanelMode, PlotInteractionPolicy> = {
  time: {
    xAxis: "linked-time",
    cursorLink: "time",
    pan: new Set(["x", "y"]),
    zoom: new Set(["x", "y", "box"]),
    fit: true,
    stickyAutoY: true,
    windowNote: null,
  },
  xy: {
    xAxis: "local",
    cursorLink: "time",
    pan: new Set(["x", "y"]),
    zoom: new Set(["x", "y", "box"]),
    fit: true,
    stickyAutoY: false,
    windowNote: null,
  },
  fft: {
    xAxis: "local",
    cursorLink: "local",
    pan: new Set(["x", "y"]),
    zoom: new Set(["x", "y", "box"]),
    fit: true,
    stickyAutoY: false,
    windowNote: "window: visible t",
  },
  histogram: {
    xAxis: "local",
    cursorLink: "local",
    pan: new Set(["x", "y"]),
    zoom: new Set(["x", "y", "box"]),
    fit: true,
    stickyAutoY: false,
    windowNote: "window: visible t",
  },
};

export function policyFor(mode: PanelMode): PlotInteractionPolicy {
  return POLICIES[mode];
}

export function prepareTimePlot(input: TimePlotInput): PreparedPlot {
  const extents = input.series.map((series) => columnsYExtent(series.bins));
  const resolve = (annotation: Annotation): ResolvedAnnotation | null => {
    if (annotation.domain !== "time") return null;
    const series = input.series.find(
      (entry) => entry.path === annotation.series_path,
    );
    if (series === undefined) return null;
    const y = columnsValueAtTime(series.bins, annotation.anchor);
    if (y === null) return null;
    return resolved(annotation, annotation.anchor, y, series.colorIndex);
  };
  return {
    domain: "time",
    interaction: POLICIES.time,
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
      for (const extent of extents) {
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
            domain: "time",
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
    delta(items) {
      return timeDelta(lastTwo(items));
    },
  };
}

export function prepareXyPlot(input: XyPlotInput): PreparedPlot {
  const resolve = (annotation: Annotation): ResolvedAnnotation | null => {
    if (annotation.domain !== "time") return null;
    const series = input.series.find(
      (entry) => entry.path === annotation.series_path,
    );
    if (series === undefined) return null;
    const x = lerpSample(series.trace.time, series.trace.x, annotation.anchor);
    const y = lerpSample(series.trace.time, series.trace.y, annotation.anchor);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const colorValue =
      input.color === null || series.colorValues === null
        ? null
        : lerpSample(series.trace.time, series.colorValues, annotation.anchor);
    return {
      ...resolved(annotation, x, y, series.colorIndex),
      colorValue: Number.isFinite(colorValue) ? colorValue : null,
    };
  };
  return {
    domain: "time",
    interaction: POLICIES.xy,
    hitAdapter: {
      seriesAt(layout, x, y, threshold) {
        const hit = nearestXyPoint(
          input.series.filter((series) => series.visible !== false),
          layout,
          x,
          y,
          threshold,
        );
        return hit === null
          ? null
          : {
              path: hit.path,
              distance: Math.hypot(
                projectX(layout, hit.x) - x,
                projectY(layout, hit.y) - y,
              ),
            };
      },
    },
    autoRanges() {
      const traces = input.series.map((series) => series.trace);
      const x = traceExtent(traces, "x", input.window.t0, input.window.t1);
      const y = traceExtent(traces, "y", input.window.t0, input.window.t1);
      return x === null || y === null ? { x: null, y: null } : { x, y };
    },
    cursorAt(layout, point, radius) {
      const hit = nearestXyPoint(
        input.series,
        layout,
        point.x,
        point.y,
        radius,
      );
      if (hit === null) return null;
      const hitColor =
        input.series.find((series) => series.path === hit.path)?.colorIndex ??
        0;
      const rows = [
        reading(input.x.path, hit.x, null, hitColor, `x · ${input.x.path}`),
        ...input.series.map((series) =>
          reading(
            series.path,
            lerpSample(series.trace.time, series.trace.y, hit.time),
            null,
            series.colorIndex,
            `y · ${series.path}`,
          ),
        ),
      ];
      if (input.color !== null) {
        const hitSeries = input.series.find(
          (series) => series.path === hit.path,
        );
        rows.push(
          reading(
            input.color.path,
            hitSeries?.colorValues === null ||
              hitSeries?.colorValues === undefined
              ? Number.NaN
              : lerpSample(
                  hitSeries.trace.time,
                  hitSeries.colorValues,
                  hit.time,
                ),
            null,
            hitColor,
            `c · ${input.color.path}`,
          ),
        );
      }
      return cursor(hit.time, `t = ${formatValue(hit.time)} s`, rows, "time");
    },
    annotationAt(layout, point, radius) {
      const hit = nearestXyPoint(
        input.series,
        layout,
        point.x,
        point.y,
        radius,
      );
      return hit === null
        ? null
        : {
            path: hit.path,
            domain: "time",
            anchor: hit.time,
            pinnedValue: hit.y,
          };
    },
    resolveAnnotation: resolve,
    stats() {
      const xStats = numericStats(input.x.values);
      const groups = [
        statsGroup(`x · ${input.x.path}`, statItems(xStats)),
        ...input.series.map((series) =>
          statsGroup(
            `y · ${series.path}`,
            statItems(numericStats(series.trace.y)),
          ),
        ),
      ];
      if (input.color !== null) {
        const colorStats = numericStats(
          input.series.flatMap((series) => series.colorValues ?? []),
        );
        groups.push(
          statsGroup(`c · ${input.color.path}`, [
            stat("min", colorStats.min),
            stat("max", colorStats.max),
          ]),
        );
      }
      return groups;
    },
    delta(items) {
      const pair = lastTwo(items);
      if (pair === null) return null;
      const [first, second] = pair;
      const parts = [
        `Δt ${formatValue(second.annotation.anchor - first.annotation.anchor)} s`,
        `Δx ${formatValue(second.x - first.x)}`,
        `Δy ${formatValue(second.y - first.y)}`,
      ];
      if (first.colorValue !== null && second.colorValue !== null) {
        parts.push(`Δc ${formatValue(second.colorValue - first.colorValue)}`);
      }
      return delta(parts, first, second);
    },
  };
}

export function prepareFftPlot(input: FftPlotInput): PreparedPlot {
  const resolve = (annotation: Annotation): ResolvedAnnotation | null => {
    if (annotation.domain !== "frequency") return null;
    const series = input.series.find(
      (entry) => entry.path === annotation.series_path,
    );
    if (series === undefined) return null;
    const y = lerpSample(
      series.frequency,
      series.amplitudeDb,
      annotation.anchor,
    );
    return Number.isFinite(y)
      ? resolved(annotation, annotation.anchor, y, series.colorIndex)
      : null;
  };
  return {
    domain: "frequency",
    interaction: POLICIES.fft,
    hitAdapter: {
      seriesAt(layout, x, y, threshold) {
        return nearestPolyline(
          input.series
            .filter((series) => series.visible !== false)
            .map((series) => ({
              path: series.path,
              x: series.frequency,
              y: series.amplitudeDb,
            })),
          layout,
          x,
          y,
          threshold,
        );
      },
    },
    autoRanges() {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const series of input.series) {
        const count = Math.min(
          series.frequency.length,
          series.amplitudeDb.length,
        );
        for (let index = 0; index < count; index += 1) {
          const frequency = series.frequency[index] ?? Number.NaN;
          const amplitude = series.amplitudeDb[index] ?? Number.NaN;
          if (!Number.isFinite(frequency) || !Number.isFinite(amplitude)) {
            continue;
          }
          min = Math.min(min, frequency);
          max = Math.max(max, frequency);
        }
      }
      return Number.isFinite(min) && Number.isFinite(max) && min < max
        ? { x: [min, max], y: [-90, 3] }
        : { x: null, y: null };
    },
    cursorAt(layout, point) {
      const x = invertX(layout, point.x);
      const rows = input.series.map((series) =>
        reading(
          series.path,
          lerpSample(series.frequency, series.amplitudeDb, x),
          "dB",
          series.colorIndex,
        ),
      );
      return cursor(x, `f = ${formatValue(x)} Hz`, rows, "local");
    },
    annotationAt(layout, point, radius) {
      return transformedHit(
        input.series.map((series) => ({
          path: series.path,
          colorIndex: series.colorIndex,
          x: series.frequency,
          y: series.amplitudeDb,
        })),
        "frequency",
        layout,
        point,
        radius,
      );
    },
    resolveAnnotation: resolve,
    stats() {
      return input.series.map((series) => {
        let peakIndex = -1;
        let peak = Number.NEGATIVE_INFINITY;
        series.amplitudeDb.forEach((value, index) => {
          if (Number.isFinite(value) && value > peak) {
            peak = value;
            peakIndex = index;
          }
        });
        const first = series.frequency[0] ?? null;
        const last = series.frequency[series.frequency.length - 1] ?? null;
        return statsGroup(series.path, [
          stat(
            "peak f",
            peakIndex < 0 ? null : series.frequency[peakIndex],
            "Hz",
          ),
          stat("peak", peakIndex < 0 ? null : peak, "dB"),
          stat(
            "span",
            first === null || last === null ? null : last - first,
            "Hz",
          ),
          stat("bins", series.frequency.length),
        ]);
      });
    },
    delta(items) {
      const pair = lastTwo(items);
      if (pair === null) return null;
      const [first, second] = pair;
      return delta(
        [
          `Δf ${formatValue(second.x - first.x)} Hz`,
          `ΔdB ${formatValue(second.y - first.y)}`,
        ],
        first,
        second,
      );
    },
  };
}

export function prepareHistogramPlot(input: HistogramPlotInput): PreparedPlot {
  const binAt = (value: number): number =>
    input.edges.findIndex(
      (edge, index) =>
        index < input.edges.length - 1 &&
        value >= edge &&
        (value < (input.edges[index + 1] ?? edge) ||
          (index === input.edges.length - 2 &&
            value <= (input.edges[index + 1] ?? edge))),
    );
  const resolve = (annotation: Annotation): ResolvedAnnotation | null => {
    if (annotation.domain !== "distribution") return null;
    const series = input.series.find(
      (entry) => entry.path === annotation.series_path,
    );
    const bin = binAt(annotation.anchor);
    if (series === undefined || bin < 0) return null;
    const low = input.edges[bin];
    const high = input.edges[bin + 1];
    const y = series.counts[bin];
    if (low === undefined || high === undefined || y === undefined) return null;
    return resolved(annotation, (low + high) / 2, y, series.colorIndex);
  };
  return {
    domain: "distribution",
    interaction: POLICIES.histogram,
    hitAdapter: {
      seriesAt(layout, x, y, threshold) {
        return nearestPolyline(
          input.series
            .filter((series) => series.visible !== false)
            .map((series) => {
              const points = histogramPoints(input.edges, series.counts);
              return {
                path: series.path,
                x: points.filter((_, index) => index % 2 === 0),
                y: points.filter((_, index) => index % 2 === 1),
              };
            }),
          layout,
          x,
          y,
          threshold,
        );
      },
    },
    autoRanges() {
      const first = input.edges[0];
      const last = input.edges[input.edges.length - 1];
      let peak = Number.NEGATIVE_INFINITY;
      for (const series of input.series) {
        for (const count of series.counts) {
          if (Number.isFinite(count)) peak = Math.max(peak, count);
        }
      }
      return first !== undefined &&
        last !== undefined &&
        Number.isFinite(first) &&
        Number.isFinite(last) &&
        first < last &&
        Number.isFinite(peak)
        ? { x: [first, last], y: [0, Math.max(1, peak) * 1.06] }
        : { x: null, y: null };
    },
    cursorAt(layout, point) {
      const x = invertX(layout, point.x);
      const bin = binAt(x);
      if (bin < 0) return null;
      const low = input.edges[bin] ?? x;
      const high = input.edges[bin + 1] ?? x;
      const rows = input.series.map((series) =>
        reading(
          series.path,
          series.counts[bin] ?? 0,
          "samples",
          series.colorIndex,
        ),
      );
      return cursor(
        x,
        `bin ${formatValue(low)} – ${formatValue(high)}`,
        rows,
        "local",
      );
    },
    annotationAt(layout, point, radius) {
      const x = invertX(layout, point.x);
      const bin = binAt(x);
      if (bin < 0) return null;
      let best: AnnotationAnchor | null = null;
      let bestDistance = radius;
      for (const series of input.series) {
        const count = series.counts[bin] ?? 0;
        const distance = Math.abs(projectY(layout, count) - point.y);
        if (distance > bestDistance) continue;
        bestDistance = distance;
        best = {
          path: series.path,
          domain: "distribution",
          anchor: x,
          pinnedValue: count,
        };
      }
      return best;
    },
    resolveAnnotation: resolve,
    stats() {
      return input.series.map((series) =>
        statsGroup(series.path, [
          ...statItems(numericStats(series.sourceValues)),
          stat("bins", Math.max(0, input.edges.length - 1)),
        ]),
      );
    },
    delta(items) {
      const pair = lastTwo(items);
      if (pair === null) return null;
      const [first, second] = pair;
      return delta(
        [
          `Δvalue ${formatValue(second.annotation.anchor - first.annotation.anchor)}`,
          `Δcount ${formatValue(second.y - first.y)}`,
        ],
        first,
        second,
      );
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

function nearestPolyline(
  series: readonly {
    path: string;
    x: readonly number[];
    y: readonly number[];
  }[],
  layout: PlotLayout,
  px: number,
  py: number,
  threshold: number,
): SeriesHit | null {
  let best: SeriesHit | null = null;
  let bestSquared = threshold * threshold;
  for (const entry of series) {
    let previous: { x: number; y: number } | null = null;
    const count = Math.min(entry.x.length, entry.y.length);
    for (let index = 0; index < count; index += 1) {
      const valueX = entry.x[index] ?? Number.NaN;
      const valueY = entry.y[index] ?? Number.NaN;
      if (!Number.isFinite(valueX) || !Number.isFinite(valueY)) {
        previous = null;
        continue;
      }
      const current = {
        x: projectX(layout, valueX),
        y: projectY(layout, valueY),
      };
      if (previous !== null) {
        const hit = segmentHit(previous, current, px, py).squared;
        if (hit <= bestSquared) {
          bestSquared = hit;
          best = { path: entry.path, distance: Math.sqrt(hit) };
        }
      }
      previous = current;
    }
  }
  return best;
}

function histogramPoints(
  edges: readonly number[],
  counts: readonly number[],
): number[] {
  const points: number[] = [];
  points.push(edges[0] ?? 0, 0);
  counts.forEach((count, index) => {
    points.push(edges[index] ?? 0, count, edges[index + 1] ?? 0, count);
  });
  points.push(edges[edges.length - 1] ?? 0, 0);
  return points;
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

function transformedHit(
  series: readonly {
    path: string;
    colorIndex: number;
    x: readonly number[];
    y: readonly number[];
  }[],
  domain: AnnotationDomain,
  layout: PlotLayout,
  point: PlotPoint,
  radius: number,
  anchorOverride?: number,
): AnnotationAnchor | null {
  let best: AnnotationAnchor | null = null;
  let bestDistance = radius;
  for (const entry of series) {
    const count = Math.min(entry.x.length, entry.y.length);
    for (let index = 0; index < count; index += 1) {
      const x = entry.x[index] ?? Number.NaN;
      const y = entry.y[index] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const distance = Math.hypot(
        projectX(layout, x) - point.x,
        projectY(layout, y) - point.y,
      );
      if (distance > bestDistance) continue;
      bestDistance = distance;
      best = {
        path: entry.path,
        domain,
        anchor: anchorOverride ?? x,
        pinnedValue: y,
      };
    }
  }
  return best;
}

function numericStats(values: readonly number[]): {
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
  count: number;
} {
  let min: number | null = null;
  let max: number | null = null;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    min = min === null ? value : Math.min(min, value);
    max = max === null ? value : Math.max(max, value);
    sum += value;
    sumSq += value * value;
    count += 1;
  }
  return {
    min,
    max,
    mean: count === 0 ? null : sum / count,
    rms: count === 0 ? null : Math.sqrt(sumSq / count),
    count,
  };
}

function statItems(summary: ReturnType<typeof numericStats>): PlotStat[] {
  return [
    stat("min", summary.min),
    stat("max", summary.max),
    stat("mean", summary.mean),
    stat("rms", summary.rms),
    stat("n", summary.count),
  ];
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

function lastTwo(
  items: readonly ResolvedAnnotation[],
): readonly [ResolvedAnnotation, ResolvedAnnotation] | null {
  const first = items[items.length - 2];
  const second = items[items.length - 1];
  return first === undefined || second === undefined ? null : [first, second];
}

function timeDelta(
  pair: readonly [ResolvedAnnotation, ResolvedAnnotation] | null,
): PlotDelta | null {
  if (pair === null) return null;
  const [first, second] = pair;
  const deltaT = second.x - first.x;
  const deltaY = second.y - first.y;
  const parts = [`Δt ${formatValue(deltaT)} s`, `Δy ${formatValue(deltaY)}`];
  if (deltaT !== 0) parts.push(`slope ${formatValue(deltaY / deltaT)}/s`);
  return delta(parts, first, second);
}

function delta(
  parts: readonly string[],
  first: ResolvedAnnotation,
  second: ResolvedAnnotation,
): PlotDelta {
  return {
    label: parts.join(" · "),
    first: { x: first.x, y: first.y },
    second: { x: second.x, y: second.y },
  };
}

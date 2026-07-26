import type { EnvelopeBin } from "../generated/protocol";
import type {
  Annotation,
  AnnotationDomain,
  PanelMode,
} from "../generated/session";
import { nearestVertex } from "./plot-hit";
import {
  formatValue,
  invertX,
  projectX,
  projectY,
  valueAtTime,
  type PlotLayout,
} from "./plot-math";
import { visibleStats } from "./stats";
import { lerpSample, type XyTrace } from "./xy";
import { nearestXyPoint } from "./xy-hit";

export interface PlotPoint {
  x: number;
  y: number;
}

export interface PlotFrame {
  kind: "tiles" | "paths" | "empty";
}

export interface PlotInteractionPolicy {
  xAxis: "linked-time" | "local";
  cursorLink: "time" | "local";
  pan: ReadonlySet<"x" | "y">;
  zoom: ReadonlySet<"x" | "y" | "box">;
  fit: boolean;
  windowNote: string | null;
}

export interface PlotReadingRow {
  path: string;
  label: string;
  value: number;
  unit: string | null;
  colorIndex: number;
}

export interface PlotCursor {
  domain: AnnotationDomain;
  x: number;
  heading: string;
  rows: readonly PlotReadingRow[];
  markers: readonly PlotMarker[];
  link: "time" | "local";
  interval: readonly [number, number] | null;
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

export interface PlotMarker {
  x: number;
  y: number;
  colorIndex: number;
}

export interface PlotStat {
  label: string;
  value: number | null;
  unit: string | null;
}

export interface PlotStatGroup {
  key: string;
  label: string;
  colorIndex: number | null;
  items: readonly PlotStat[];
}

export interface PlotDelta {
  label: string;
  first: PlotPoint;
  second: PlotPoint;
}

export interface PreparedPlot {
  readonly mode: PanelMode;
  readonly domain: AnnotationDomain;
  readonly frame: PlotFrame;
  readonly interaction: PlotInteractionPolicy;
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

export interface PreparedSeries {
  path: string;
  colorIndex: number;
}

export interface TimePlotInput {
  series: readonly (PreparedSeries & { bins: readonly EnvelopeBin[] })[];
  window: { t0: number; t1: number };
}

export interface XyPlotInput {
  x: { path: string; values: readonly number[] };
  series: readonly (PreparedSeries & {
    trace: XyTrace;
    colorValues: readonly number[] | null;
  })[];
  color: { path: string } | null;
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
    windowNote: null,
  },
  xy: {
    xAxis: "local",
    cursorLink: "time",
    pan: new Set(["x", "y"]),
    zoom: new Set(["x", "y", "box"]),
    fit: true,
    windowNote: null,
  },
  fft: {
    xAxis: "local",
    cursorLink: "local",
    pan: new Set(["x", "y"]),
    zoom: new Set(["x", "y", "box"]),
    fit: true,
    windowNote: "window: visible t",
  },
  histogram: {
    xAxis: "local",
    cursorLink: "local",
    pan: new Set(),
    zoom: new Set(),
    fit: true,
    windowNote: "window: visible t",
  },
};

export function policyFor(mode: PanelMode): PlotInteractionPolicy {
  return POLICIES[mode];
}

export function prepareTimePlot(input: TimePlotInput): PreparedPlot {
  const resolve = (annotation: Annotation): ResolvedAnnotation | null => {
    if (annotation.domain !== "time") return null;
    const series = input.series.find(
      (entry) => entry.path === annotation.series_path,
    );
    if (series === undefined) return null;
    const y = valueAtTime(series.bins, annotation.anchor);
    if (y === null) return null;
    return resolved(annotation, annotation.anchor, y, series.colorIndex);
  };
  return {
    mode: "time",
    domain: "time",
    frame: { kind: "tiles" },
    interaction: POLICIES.time,
    cursorAt(layout, point) {
      const x = invertX(layout, point.x);
      const rows = input.series.flatMap((series) => {
        const value = valueAtTime(series.bins, x);
        return value === null
          ? []
          : [reading(series.path, value, null, series.colorIndex)];
      });
      return cursor("time", x, `t = ${formatValue(x)} s`, rows, "time");
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
        const stats = visibleStats(
          series.bins,
          input.window.t0,
          input.window.t1,
        );
        return statsGroup(series.path, series.path, series.colorIndex, [
          stat("min", stats.min),
          stat("max", stats.max),
          stat("mean", stats.mean),
          stat("rms", stats.rms),
          stat(
            "n",
            series.bins.reduce(
              (count, bin) =>
                bin.t1 < input.window.t0 || bin.t0 > input.window.t1
                  ? count
                  : count + Number(bin.finite_count),
              0,
            ),
          ),
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
    mode: "xy",
    domain: "time",
    frame: { kind: "paths" },
    interaction: POLICIES.xy,
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
      return cursor(
        "time",
        hit.time,
        `t = ${formatValue(hit.time)} s`,
        rows,
        "time",
      );
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
        statsGroup(
          input.x.path,
          `x · ${input.x.path}`,
          null,
          statItems(xStats),
        ),
        ...input.series.map((series) =>
          statsGroup(
            series.path,
            `y · ${series.path}`,
            series.colorIndex,
            statItems(numericStats(series.trace.y)),
          ),
        ),
      ];
      if (input.color !== null) {
        const colorStats = numericStats(
          input.series.flatMap((series) => series.colorValues ?? []),
        );
        groups.push(
          statsGroup(input.color.path, `c · ${input.color.path}`, null, [
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
    mode: "fft",
    domain: "frequency",
    frame: { kind: "paths" },
    interaction: POLICIES.fft,
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
      return cursor("frequency", x, `f = ${formatValue(x)} Hz`, rows, "local");
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
        return statsGroup(series.path, series.path, series.colorIndex, [
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
    mode: "histogram",
    domain: "distribution",
    frame: { kind: "paths" },
    interaction: POLICIES.histogram,
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
        "distribution",
        x,
        `bin ${formatValue(low)} – ${formatValue(high)}`,
        rows,
        "local",
        [low, high],
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
        statsGroup(series.path, series.path, series.colorIndex, [
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
  domain: AnnotationDomain,
  x: number,
  heading: string,
  rows: readonly PlotReadingRow[],
  link: "time" | "local",
  interval: readonly [number, number] | null = null,
): PlotCursor {
  return {
    domain,
    x,
    heading,
    rows,
    markers: rows.map((row) => ({
      x,
      y: row.value,
      colorIndex: row.colorIndex,
    })),
    link,
    interval,
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

function statsGroup(
  key: string,
  label: string,
  colorIndex: number | null,
  items: readonly PlotStat[],
): PlotStatGroup {
  return { key, label, colorIndex, items };
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

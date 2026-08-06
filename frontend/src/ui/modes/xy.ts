import type { SampleSeries } from "../../generated/protocol";
import {
  buildTileIndex,
  buildSeriesIndex,
  lerpSample,
  pairSamples,
  pairTileTrace,
  seriesIndexKey,
  type SeriesPathCallbacks,
  type XyTrace,
} from "../../app/xy";
import { prepareXyPlot } from "../../app/plot-capabilities";
import type { PathRenderOptions, PlotPath } from "../../render/canvas-renderer";
import type {
  PlotModeModule,
  PrepareInput,
  ProjectResult,
  XyTraceEntry,
} from "./contract";
import type { ColumnarTile } from "../../app/bin-columns";
import { axisName, colorIndexForHue, visibleSources, yLabel } from "./shared";

export interface XyGeometry {
  xSeries: SampleSeries | null;
  entries: XyTraceEntry[];
  /** flattenTrace(trace, null) per entry, parallel to `entries`. */
  dimmed: number[][];
  /** Raw colour column per entry, parallel to `entries`. */
  colorColumns: (number[] | null)[];
  /** Padded domain of the colour channel, null when no colour is active. */
  colorDomain: { min: number; max: number } | null;
  colorLabelUnit: string | null;
  /**
   * True when the panel had a resolved colour series (or colour-by-time),
   * even if every colour value was non-finite — the old code passed a
   * non-null `color` to prepareXyPlot in exactly that case.
   */
  hadColorSeries: boolean;
  /** Units of the visible y series in state order — the old yLabel input. */
  yUnits: (string | null)[];
  /** True when geometry came from aligned pyramid tiles. */
  envelope: boolean;
  /** Set when neither tiles nor samples could serve the panel. */
  needsSampleFallback: boolean;
}

/**
 * Flattens a trace to renderer vertices. A `window` restricts output to that
 * time span; vertices outside become NaN so the pen lifts rather than
 * bridging the gap.
 */
export function flattenTrace(
  trace: XyTrace,
  window: { t0: number; t1: number } | null,
): number[] {
  const points: number[] = [];
  for (let index = 0; index < trace.time.length; index += 1) {
    const time = trace.time[index] ?? Number.NaN;
    const inside = window === null || (time >= window.t0 && time <= window.t1);
    points.push(
      inside ? (trace.x[index] ?? Number.NaN) : Number.NaN,
      inside ? (trace.y[index] ?? Number.NaN) : Number.NaN,
    );
  }
  return points;
}

function resolveXSeries(
  index: ReadonlyMap<string, SampleSeries>,
  xSeries: SampleSeries,
  xSignal: string,
  yPath: string,
  callbacks: SeriesPathCallbacks,
): SampleSeries | undefined {
  const xLocal = callbacks.localPathFor(xSignal);
  if (xLocal === null) return xSeries;
  const sourceKey = callbacks.sourceKeyFor(yPath);
  if (sourceKey === null) return xSeries;
  return index.get(seriesIndexKey(sourceKey, xLocal));
}

const EMPTY: XyGeometry = {
  xSeries: null,
  entries: [],
  dimmed: [],
  colorColumns: [],
  colorDomain: null,
  colorLabelUnit: null,
  hadColorSeries: false,
  yUnits: [],
  envelope: false,
  needsSampleFallback: false,
};

function prepareFromSamples({
  state,
  samples,
  callbacks,
}: PrepareInput): XyGeometry {
  if (samples === null || state.x_signal === null) return EMPTY;
  const byPath = new Map(
    samples.series.map((series) => [series.signal_path, series]),
  );
  const xSeries = byPath.get(state.x_signal);
  if (xSeries === undefined) return EMPTY;
  const index = buildSeriesIndex(samples.series, callbacks);
  const entries: XyTraceEntry[] = [];
  for (const series of state.series) {
    if (!series.visible) continue;
    const ySeries = byPath.get(series.path);
    if (ySeries === undefined) continue;
    const resolved = resolveXSeries(
      index,
      xSeries,
      state.x_signal,
      series.path,
      callbacks,
    );
    if (resolved === undefined) continue;
    entries.push({
      path: series.path,
      colorIndex: colorIndexForHue(series.hue),
      hue: series.hue,
      dash: series.dash,
      width: series.width,
      opacity: series.opacity,
      trace: pairSamples(resolved, ySeries),
    });
  }
  if (entries.length === 0) return { ...EMPTY, xSeries };
  const colorSeries: "time" | SampleSeries | null = state.color_by_time
    ? "time"
    : state.color_signal === null
      ? null
      : (byPath.get(state.color_signal) ?? null);
  const cLocal =
    state.color_signal === null
      ? null
      : callbacks.localPathFor(state.color_signal);
  const resolveColor = (yPath: string): SampleSeries | null => {
    if (colorSeries === null || colorSeries === "time") return null;
    if (cLocal === null) return colorSeries;
    const sourceKey = callbacks.sourceKeyFor(yPath);
    if (sourceKey === null) return colorSeries;
    return index.get(seriesIndexKey(sourceKey, cLocal)) ?? null;
  };
  const colorFor = (yPath: string, trace: XyTrace): number[] | null => {
    if (colorSeries === null) return null;
    if (colorSeries === "time") return [...trace.time];
    const resolved = resolveColor(yPath);
    if (resolved === null) return null;
    return trace.time.map((time) =>
      lerpSample(resolved.time, resolved.values, time),
    );
  };
  const colorColumns = entries.map((entry) =>
    colorFor(entry.path, entry.trace),
  );
  let colorMin = Number.POSITIVE_INFINITY;
  let colorMax = Number.NEGATIVE_INFINITY;
  for (const column of colorColumns) {
    for (const value of column ?? []) {
      if (!Number.isFinite(value)) continue;
      colorMin = Math.min(colorMin, value);
      colorMax = Math.max(colorMax, value);
    }
  }
  const hasColor =
    colorSeries !== null &&
    Number.isFinite(colorMin) &&
    Number.isFinite(colorMax);
  const colorPadding =
    hasColor && colorMin === colorMax
      ? Math.max(1, Math.abs(colorMin) * 0.05)
      : 0;
  return {
    xSeries,
    entries,
    dimmed: entries.map((entry) => flattenTrace(entry.trace, null)),
    colorColumns,
    colorDomain: hasColor
      ? { min: colorMin - colorPadding, max: colorMax + colorPadding }
      : null,
    colorLabelUnit:
      colorSeries !== null && colorSeries !== "time" ? colorSeries.unit : null,
    hadColorSeries: colorSeries !== null,
    yUnits: state.series
      .filter((series) => series.visible)
      .map((series) => byPath.get(series.path)?.unit ?? null),
    envelope: false,
    needsSampleFallback: false,
  };
}

function prepareFromTiles(input: PrepareInput): XyGeometry | null {
  const { state, tiles, contextTiles, callbacks } = input;
  if (tiles === null || contextTiles === null || state.x_signal === null) {
    return null;
  }
  const byPath = new Map(tiles.series.map((tile) => [tile.signalPath, tile]));
  const contextByPath = new Map(
    contextTiles.series.map((tile) => [tile.signalPath, tile]),
  );
  const xTile = byPath.get(state.x_signal);
  if (xTile === undefined) return null;
  const index = buildTileIndex(tiles.series, callbacks);
  const contextIndex = buildTileIndex(contextTiles.series, callbacks);
  const xLocal = callbacks.localPathFor(state.x_signal);
  const cLocal =
    state.color_signal === null
      ? null
      : callbacks.localPathFor(state.color_signal);
  const colorConfigured = state.color_by_time || state.color_signal !== null;
  const entries: XyTraceEntry[] = [];
  const dimmed: number[][] = [];
  const colorColumns: (number[] | null)[] = [];
  for (const series of state.series) {
    if (!series.visible) continue;
    const yTile = byPath.get(series.path);
    const yContext = contextByPath.get(series.path);
    if (yTile === undefined || yContext === undefined) continue;
    const resolveTile = (
      map: ReadonlyMap<string, ColumnarTile>,
      fallback: ColumnarTile,
      local: string | null,
    ): ColumnarTile | undefined => {
      if (local === null) return fallback;
      const sourceKey = callbacks.sourceKeyFor(series.path);
      if (sourceKey === null) return fallback;
      return map.get(seriesIndexKey(sourceKey, local));
    };
    const xPaired = resolveTile(index, xTile, xLocal);
    const xPairedContext = resolveTile(
      contextIndex,
      contextByPath.get(state.x_signal) ?? xTile,
      xLocal,
    );
    if (xPaired === undefined || xPairedContext === undefined) continue;
    const colorTile =
      state.color_signal === null || state.color_by_time
        ? null
        : (resolveTile(
            index,
            byPath.get(state.color_signal) ?? xTile,
            cLocal,
          ) ?? null);
    if (
      state.color_signal !== null &&
      !state.color_by_time &&
      colorTile === null
    ) {
      return null;
    }
    const paired = pairTileTrace(xPaired, yTile, colorTile);
    const pairedContext = pairTileTrace(xPairedContext, yContext, null);
    if (paired === null || pairedContext === null) return null;
    entries.push({
      path: series.path,
      colorIndex: colorIndexForHue(series.hue),
      hue: series.hue,
      dash: series.dash,
      width: series.width,
      opacity: series.opacity,
      trace: paired.trace,
    });
    dimmed.push(flattenTrace(pairedContext.trace, null));
    colorColumns.push(
      state.color_by_time ? [...paired.trace.time] : paired.colors,
    );
  }
  if (entries.length === 0) return null;
  let colorMin = Number.POSITIVE_INFINITY;
  let colorMax = Number.NEGATIVE_INFINITY;
  for (const column of colorColumns) {
    for (const value of column ?? []) {
      if (!Number.isFinite(value)) continue;
      colorMin = Math.min(colorMin, value);
      colorMax = Math.max(colorMax, value);
    }
  }
  const hasColor =
    colorConfigured && Number.isFinite(colorMin) && Number.isFinite(colorMax);
  const colorPadding =
    hasColor && colorMin === colorMax
      ? Math.max(1, Math.abs(colorMin) * 0.05)
      : 0;
  return {
    xSeries: {
      signal_path: state.x_signal,
      unit: xTile.unit,
      time: [],
      values: entries[0]?.trace.x ?? [],
      stride: 1,
    } as unknown as SampleSeries,
    entries,
    dimmed,
    colorColumns,
    colorDomain: hasColor
      ? { min: colorMin - colorPadding, max: colorMax + colorPadding }
      : null,
    colorLabelUnit: null,
    hadColorSeries: colorConfigured,
    yUnits: state.series
      .filter((series) => series.visible)
      .map((series) => byPath.get(series.path)?.unit ?? null),
    envelope: true,
    needsSampleFallback: false,
  };
}

export const xyModule: PlotModeModule<XyGeometry> = {
  mode: "xy",
  data: { reduction: "envelope", windows: ["context", "visible"] },
  // Styles must be part of the key: prepare bakes them into `entries`, so a
  // style-only change (an override, say) has to invalidate the framework's
  // geometry cache even though tiles and samples keep identity.
  configKey: (state) =>
    [
      state.x_signal ?? "",
      state.color_by_time ? "time" : (state.color_signal ?? ""),
      ...state.series
        .filter((series) => series.visible)
        .map((series) =>
          [
            series.path,
            series.hue,
            series.dash,
            series.width,
            series.opacity,
          ].join(":"),
        ),
    ].join("\u0000"),
  prepare(input) {
    const fromTiles = prepareFromTiles(input);
    if (fromTiles !== null) return fromTiles;
    if (input.samples !== null) return prepareFromSamples(input);
    if (input.tiles !== null) {
      return { ...EMPTY, needsSampleFallback: true };
    }
    return EMPTY;
  },
  project(geometry, { state, callbacks }, frame): ProjectResult {
    if (geometry.needsSampleFallback) {
      return {
        plot: { kind: "empty" },
        prepared: null,
        xyTraces: [],
        needsSampleFallback: true,
      };
    }
    if (geometry.entries.length === 0 || geometry.xSeries === null) {
      return { plot: { kind: "empty" }, prepared: null, xyTraces: [] };
    }
    if (state.x_signal === null) {
      return { plot: { kind: "empty" }, prepared: null, xyTraces: [] };
    }
    const window = frame.window;
    const xLocal = callbacks.localPathFor(state.x_signal);
    const hasColor = geometry.colorDomain !== null;
    const colorDomainMin = geometry.colorDomain?.min ?? 0;
    const colorDomainMax = geometry.colorDomain?.max ?? 1;
    const colorSpan = colorDomainMax - colorDomainMin;
    const prepared = prepareXyPlot({
      x: { path: state.x_signal, values: geometry.xSeries.values },
      series: geometry.entries.map((entry, index) => ({
        ...entry,
        colorValues: geometry.colorColumns[index] ?? null,
      })),
      color: geometry.hadColorSeries
        ? {
            path: state.color_by_time ? "time" : (state.color_signal ?? ""),
          }
        : null,
      window,
    });
    const ranges = frame.resolveRanges(prepared);
    if (ranges === null) {
      return {
        plot: { kind: "empty" },
        prepared,
        xyTraces: geometry.entries,
        hasColorbar: hasColor,
      };
    }
    const paths: PlotPath[] = [];
    geometry.entries.forEach((entry, index) => {
      // Whole trajectory dimmed underneath, the windowed part lit on top.
      paths.push({
        points: geometry.dimmed[index] ?? [],
        hue: entry.hue,
        dash: "solid",
        width: 1.2,
        alpha: entry.opacity,
        dimmed: true,
      });
    });
    geometry.entries.forEach((entry, index) => {
      const colorValues = geometry.colorColumns[index];
      paths.push({
        points: flattenTrace(entry.trace, window),
        hue: entry.hue,
        dash: entry.dash,
        width: entry.width + 0.4,
        alpha: entry.opacity,
        markers: true,
        ...(hasColor && colorValues !== null && colorValues !== undefined
          ? {
              colorValues: colorValues.map(
                (value) => (value - colorDomainMin) / colorSpan,
              ),
            }
          : {}),
      });
    });
    const sources = visibleSources(state.series, callbacks);
    const localLabels = sources.size > 1;
    const cLocal =
      state.color_signal === null
        ? null
        : callbacks.localPathFor(state.color_signal);
    const options: PathRenderOptions = {
      xLabel:
        state.x_label ??
        axisName(
          localLabels && xLocal !== null ? xLocal : state.x_signal,
          geometry.xSeries.unit,
        ),
      yLabel: state.y_label ?? yLabel(geometry.yUnits),
      xRange: [ranges.x.min, ranges.x.max],
      yRange: [ranges.y.min, ranges.y.max],
      axisStyle: state.axis_style,
      ...(state.axis_equal ? { equalAspect: true } : {}),
      ...(hasColor
        ? {
            colorbar: {
              min: colorDomainMin,
              max: colorDomainMax,
              label:
                state.c_label ??
                (state.color_by_time
                  ? "t (s)"
                  : axisName(
                      localLabels && cLocal !== null
                        ? cLocal
                        : (state.color_signal ?? ""),
                      geometry.colorLabelUnit,
                    )),
            },
          }
        : {}),
    };
    return {
      plot: { kind: "paths", paths, options },
      prepared,
      xyTraces: geometry.entries,
      hasColorbar: hasColor,
    };
  },
};

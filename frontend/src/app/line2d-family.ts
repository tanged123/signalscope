import type { AxisStyle } from "../generated/session";
import { line2DFromSignalX } from "../render/signal-x-adapter";
import { line2DFromTimeTiles } from "../render/time-adapter";
import type { Line2DRenderInput } from "../render/line2d";
import { hueIndex, type SeriesStroke } from "../render/plot-theme";
import type { PanelLineResponse } from "./line-presentation-controller";
import {
  prepareLine2DPlot,
  prepareTimePlot,
  type PreparedPlot,
} from "./plot-capabilities";
import type { Range } from "./plot-math";

interface FamilySeries {
  path: string;
  hue: number | null;
  visible: boolean;
}

interface FamilyContext {
  series: readonly FamilySeries[];
  window: { t0: number; t1: number };
  axisStyle: AxisStyle;
  xLabel: string | null;
  yLabel: string | null;
}

interface PreparedLine2DFamily {
  plotted: readonly { signalPath: string; unit: string | null }[];
  plot: PreparedPlot;
  makeInput(
    ranges: { x: Range; y: Range },
    styles: readonly SeriesStroke[],
  ): Line2DRenderInput;
}

interface Line2DFamily {
  prepare(context: FamilyContext): PreparedLine2DFamily;
}

export function line2dFamily(data: PanelLineResponse): Line2DFamily {
  return data.kind === "time" ? timeFamily(data) : signalXFamily(data);
}

function timeFamily(
  data: Extract<PanelLineResponse, { kind: "time" }>,
): Line2DFamily {
  return {
    prepare: (context) => {
      const byPath = new Map(
        context.series.map((series) => [series.path, series]),
      );
      const shown = data.response.series.filter(
        (series) => byPath.get(series.signalPath)?.visible ?? true,
      );
      return {
        plotted: shown,
        plot: prepareTimePlot({
          series: shown.map((tile) => ({
            path: tile.signalPath,
            colorIndex: colorIndex(byPath.get(tile.signalPath)?.hue),
            bins: tile.bins,
          })),
          window: context.window,
        }),
        makeInput: (ranges, styles) =>
          line2DFromTimeTiles(
            { requestId: data.response.requestId, series: shown },
            {
              xRange: ranges.x,
              yRange: [ranges.y.min, ranges.y.max],
              xLabel: context.xLabel ?? "time (s)",
              yLabel: context.yLabel ?? signalAxisLabel(shown, "Y signals"),
              styles,
              axisStyle: context.axisStyle,
            },
          ),
      };
    },
  };
}

function signalXFamily(
  data: Extract<PanelLineResponse, { kind: "signal" }>,
): Line2DFamily {
  return {
    prepare: (context) => {
      const byPath = new Map(
        context.series.map((series) => [series.path, series]),
      );
      const shown = data.response.ys.filter(
        (series) => byPath.get(series.signalPath)?.visible ?? true,
      );
      return {
        plotted: shown,
        plot: prepareLine2DPlot({
          anchor: data.response.anchor,
          x: data.response.x.values,
          series: shown.map((column) => ({
            path: column.signalPath,
            label: column.signalPath,
            unit: column.unit,
            colorIndex: colorIndex(byPath.get(column.signalPath)?.hue),
            values: column.values,
            anchor: column.coordinates?.anchor ?? data.response.anchor,
            x: column.coordinates?.x.values ?? data.response.x.values,
          })),
          window: context.window,
        }),
        makeInput: (ranges, styles) =>
          line2DFromSignalX(
            { ...data.response, ys: shown },
            {
              window: context.window,
              xRange: ranges.x,
              yRange: [ranges.y.min, ranges.y.max],
              xLabel:
                context.xLabel ??
                signalAxisLabel(
                  shown.map(
                    (column) => column.coordinates?.x ?? data.response.x,
                  ),
                  "X signals",
                ),
              yLabel: context.yLabel ?? signalAxisLabel(shown, "Y signals"),
              styles,
              axisStyle: context.axisStyle,
            },
          ),
      };
    },
  };
}

function colorIndex(hue: number | null | undefined): number {
  return hue === null || hue === undefined ? 0 : hueIndex(hue);
}

function signalAxisLabel(
  columns: readonly { signalPath: string; unit: string | null }[],
  fallback: string,
): string {
  const paths = [...new Set(columns.map((column) => column.signalPath))];
  const channels = [
    ...new Set(paths.map((path) => path.slice(path.indexOf("/") + 1))),
  ];
  const name =
    paths.length === 1
      ? paths[0]
      : channels.length === 1
        ? channels[0]
        : fallback;
  const units = [...new Set(columns.map((column) => column.unit))];
  const unit = units.length === 1 ? units[0] : null;
  return unit === null || unit === undefined
    ? (name ?? fallback)
    : `${name ?? fallback} (${unit})`;
}

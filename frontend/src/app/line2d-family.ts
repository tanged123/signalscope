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
              yLabel:
                context.yLabel ?? valueLabel(shown.map((item) => item.unit)),
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
                axisLabel(data.response.x.signalPath, data.response.x.unit),
              yLabel:
                context.yLabel ?? valueLabel(shown.map((item) => item.unit)),
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

function valueLabel(units: readonly (string | null)[]): string {
  const distinct = new Set(
    units.filter((unit): unit is string => unit !== null),
  );
  const [only] = distinct;
  return distinct.size === 1 && only !== undefined
    ? `value (${only})`
    : "value";
}

function axisLabel(path: string, unit: string | null): string {
  return unit === null ? path : `${path} (${unit})`;
}

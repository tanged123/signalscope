import type { ColumnarTileResponse } from "../../app/bin-columns";
import { prepareTimePlot } from "../../app/plot-capabilities";
import type { RenderOptions } from "../../render/canvas-renderer";
import type { RenderSeries } from "../panel";
import type { PlotModeModule, ProjectResult } from "./contract";
import { colorIndexForHue, yLabel } from "./shared";

export interface TimeGeometry {
  shown: ColumnarTileResponse | null;
  bySeries: Map<string, RenderSeries>;
}

export const timeModule: PlotModeModule<TimeGeometry> = {
  mode: "time",
  data: { reduction: "envelope", windows: [] },
  configKey: (state) =>
    state.series
      .map((series) => `${series.path}:${String(series.visible ? 1 : 0)}`)
      .join("\u0000"),
  prepare({ state, tiles }) {
    const bySeries = new Map(
      state.series.map((series) => [series.path, series]),
    );
    if (tiles === null || state.series.length === 0) {
      return { shown: null, bySeries };
    }
    const shown = tiles.series.filter(
      (tile) => bySeries.get(tile.signalPath)?.visible ?? true,
    );
    return { shown: { requestId: tiles.requestId, series: shown }, bySeries };
  },
  project(geometry, { state }, frame): ProjectResult {
    if (geometry.shown === null) {
      return { plot: { kind: "empty" }, prepared: null };
    }
    const { bySeries } = geometry;
    const shown = geometry.shown.series;
    const prepared = prepareTimePlot({
      series: shown.map((tile) => {
        const series = bySeries.get(tile.signalPath);
        return {
          path: tile.signalPath,
          colorIndex: colorIndexForHue(series?.hue ?? 1),
          bins: tile.bins,
        };
      }),
      window: frame.window,
    });
    const seriesKey = state.series.map((series) => series.path).join("\u0000");
    const ranges = frame.resolveRanges(prepared, seriesKey);
    if (ranges === null) return { plot: { kind: "empty" }, prepared };
    const options: RenderOptions = {
      xLabel: state.x_label ?? "time (s)",
      yLabel: state.y_label ?? yLabel(shown.map((tile) => tile.unit)),
      yRange: [ranges.y.min, ranges.y.max],
      axisStyle: state.axis_style,
      styles: shown.map((tile) => {
        const series = bySeries.get(tile.signalPath);
        return {
          hue: series?.hue ?? null,
          dash: series?.dash ?? "solid",
          width: series?.width ?? 1.4,
          alpha: series?.opacity ?? 1,
        };
      }),
      ...(frame.emphasizePaths !== null
        ? {
            emphasisIndices: shown.flatMap((tile, index) =>
              frame.emphasizePaths?.has(tile.signalPath) ? [index] : [],
            ),
          }
        : {}),
    };
    return {
      plot: {
        kind: "bins",
        response: geometry.shown,
        xRange: ranges.x,
        options,
      },
      prepared,
    };
  },
};

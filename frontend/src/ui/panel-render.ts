import { line2dFamily } from "../app/line2d-family";
import type { PanelLineResponse } from "../app/line-presentation-controller";
import type { Range } from "../app/plot-math";
import { DEFAULT_PANEL_LINE_WIDTH } from "../app/style-defaults";
import type { ChartRenderRequest } from "../render/chart-host";
import { resolvePalette, type SeriesStroke } from "../render/plot-theme";
import type { RenderPanelState } from "./panel";

export function preparePanelRender(
  state: Pick<
    RenderPanelState,
    | "series"
    | "axis_style"
    | "x_label"
    | "y_label"
    | "color_axis"
    | "axis_equal"
  >,
  data: PanelLineResponse,
  window: { t0: number; t1: number },
  emphasizePaths: ReadonlySet<string> | null,
) {
  const palette = resolvePalette();
  const family = line2dFamily(data).prepare({
    colorCount: palette.series.length,
    contour: palette.contour,
    series: state.series,
    window,
    axisStyle: state.axis_style,
    xLabel: state.x_label,
    yLabel: state.y_label,
    colorAxis: state.color_axis,
  });
  const bySeries = new Map(state.series.map((series) => [series.path, series]));
  const styles: SeriesStroke[] = family.plotted.map((item) => {
    const series = bySeries.get(item.signalPath);
    return {
      hue: series?.hue ?? null,
      dash: series?.dash ?? "solid",
      width:
        (series?.width ?? DEFAULT_PANEL_LINE_WIDTH) +
        (series?.focused === true ? 1 : 0),
      alpha: series?.opacity ?? 1,
    };
  });
  const emphasisIndices =
    emphasizePaths === null
      ? []
      : family.plotted.flatMap((item, index) =>
          emphasizePaths.has(item.signalPath) ? [index] : [],
        );
  return {
    plot: family.plot,
    plotted: family.plotted,
    makeRequest: (ranges: { x: Range; y: Range }): ChartRenderRequest => ({
      ...family.makeInput(ranges, styles),
      axisEqual: state.axis_equal === true,
      emphasisIndices,
      palette,
    }),
  };
}

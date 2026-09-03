import type { ColumnarTileResponse } from "../app/bin-columns";
import { DEFAULT_PANEL_LINE_WIDTH } from "../app/style-defaults";
import {
  cachedFeed,
  prepareResponseFeeds,
  responseTimeReference,
} from "./m4-feed";
import type { Line2DRenderInput } from "./line2d";
import type { SeriesStroke } from "./plot-theme";

export interface TimeLine2DInputOptions extends Pick<
  Line2DRenderInput,
  "xRange" | "yRange"
> {
  xLabel: string;
  yLabel: string;
  styles?: readonly SeriesStroke[];
  axisStyle: "gutter" | "inline";
}

/** Convert the current time-tile response into the generic line input. */
export function line2DFromTimeTiles(
  response: ColumnarTileResponse,
  options: TimeLine2DInputOptions,
): Line2DRenderInput {
  const xOrigin = responseTimeReference(response);
  return {
    xOrigin,
    series: response.series.map((tile, index) => ({
      id: tile.signalId,
      name: tile.signalPath,
      data: cachedFeed(tile.bins, xOrigin),
      style: options.styles?.[index] ?? {
        hue: null,
        dash: "solid",
        width: DEFAULT_PANEL_LINE_WIDTH,
        alpha: 1,
      },
    })),
    xRange: options.xRange,
    yRange: options.yRange,
    axes: {
      x: { label: options.xLabel },
      y: { label: options.yLabel },
      style: options.axisStyle,
    },
  };
}

/** Warm the same tile feeds consumed by line2DFromTimeTiles. */
export function prepareTimeTiles(response: ColumnarTileResponse): void {
  prepareResponseFeeds(response);
}

import type { ColumnarTileResponse } from "../app/bin-columns";
import {
  cachedFeed,
  prepareResponseFeeds,
  responseTimeReference,
} from "./m4-feed";
import type { Line2DRenderInput } from "./line2d";
import {
  line2DAxes,
  strokeAt,
  type Line2DAdapterOptions,
} from "./line2d-adapter";

export type TimeLine2DInputOptions = Line2DAdapterOptions;

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
      style: strokeAt(options, index),
    })),
    xRange: options.xRange,
    yRange: options.yRange,
    axes: line2DAxes(options),
  };
}

/** Warm the same tile feeds consumed by line2DFromTimeTiles. */
export function prepareTimeTiles(response: ColumnarTileResponse): void {
  prepareResponseFeeds(response);
}

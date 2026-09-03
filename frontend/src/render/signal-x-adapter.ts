import type { Line2DResponse } from "../app/line-binary";
import type { Range } from "../app/plot-math";
import { DEFAULT_PANEL_LINE_WIDTH } from "../app/style-defaults";
import type { Line2DRenderInput } from "./line2d";
import type { SeriesStroke } from "./plot-theme";

export interface SignalXLine2DInputOptions {
  window: { t0: number; t1: number };
  xRange: Range;
  yRange: readonly [number, number];
  xLabel: string;
  yLabel: string;
  styles?: readonly SeriesStroke[];
  axisStyle: "gutter" | "inline";
}

export function line2DFromSignalX(
  response: Line2DResponse,
  options: SignalXLine2DInputOptions,
): Line2DRenderInput {
  const xOrigin = signalXReference(response.x.values);
  return {
    xOrigin,
    series: response.ys.map((column, index) => {
      const data = cachedSignalXFeed(
        response.anchor,
        response.x.values,
        column.values,
        xOrigin,
        options.window,
      );
      return {
        id: column.signalId,
        name: column.signalPath,
        data,
        style: options.styles?.[index] ?? {
          hue: null,
          dash: "solid",
          width: DEFAULT_PANEL_LINE_WIDTH,
          alpha: 1,
        },
      };
    }),
    xRange: options.xRange,
    yRange: options.yRange,
    axes: {
      x: { label: options.xLabel },
      y: { label: options.yLabel },
      style: options.axisStyle,
    },
  };
}

export function prepareSignalXLine(
  response: Line2DResponse,
  window: { t0: number; t1: number },
): void {
  const xOrigin = signalXReference(response.x.values);
  for (const column of response.ys) {
    cachedSignalXFeed(
      response.anchor,
      response.x.values,
      column.values,
      xOrigin,
      window,
    );
  }
}

function signalXReference(values: Float64Array): number {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

const feedCache = new WeakMap<
  Float64Array,
  {
    anchor: Float64Array;
    x: Float64Array;
    xOrigin: number;
    t0: number;
    t1: number;
    feed: Float32Array;
  }
>();

function cachedSignalXFeed(
  anchor: Float64Array,
  x: Float64Array,
  y: Float64Array,
  xOrigin: number,
  window: { t0: number; t1: number },
): Float32Array {
  const cached = feedCache.get(y);
  if (
    cached?.anchor === anchor &&
    cached.x === x &&
    cached.xOrigin === xOrigin &&
    cached.t0 === window.t0 &&
    cached.t1 === window.t1
  ) {
    return cached.feed;
  }
  const feed = new Float32Array(x.length * 2);
  let previousX = 0;
  for (let index = 0; index < x.length; index += 1) {
    const anchorValue = anchor[index] as number;
    const xValue = x[index] as number;
    const yValue = y[index] as number;
    const inWindow = anchorValue >= window.t0 && anchorValue <= window.t1;
    if (inWindow && Number.isFinite(xValue)) previousX = xValue - xOrigin;
    feed[index * 2] = previousX;
    feed[index * 2 + 1] =
      inWindow && Number.isFinite(xValue) && Number.isFinite(yValue)
        ? yValue
        : Number.NaN;
  }
  feedCache.set(y, {
    anchor,
    x,
    xOrigin,
    t0: window.t0,
    t1: window.t1,
    feed,
  });
  return feed;
}

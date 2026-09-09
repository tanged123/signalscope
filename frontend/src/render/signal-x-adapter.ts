import { colorAttributes } from "./color-attributes";
import { axisCoordinate, type AxisScale } from "../app/plot-math";
import type { ColorScale } from "../app/color-scale";
import type { CompiledContour } from "../app/palettes";
import type { Line2DResponse } from "../app/line-binary";
import type { Line2DRenderInput } from "./line2d";
import {
  createFeedCache,
  line2DAxes,
  strokeAt,
  type Line2DAdapterOptions,
} from "./line2d-adapter";

export interface SignalXLine2DInputOptions extends Line2DAdapterOptions {
  window: { t0: number; t1: number };
  colorScale?: ColorScale | undefined;
  contour?: CompiledContour | undefined;
}

export function line2DFromSignalX(
  response: Line2DResponse,
  options: SignalXLine2DInputOptions,
): Line2DRenderInput {
  const xOrigin = signalXReference(response, options.xScale ?? "linear");
  return {
    xOrigin,
    colorScale: options.colorScale,
    series: response.ys.map((column, index) => {
      const data = cachedSignalXFeed(
        column.coordinates?.anchor ?? response.anchor,
        column.coordinates?.x.values ?? response.x.values,
        column.values,
        xOrigin,
        options.window,
        options.xScale ?? "linear",
        options.yScale ?? "linear",
      );
      return {
        id: column.signalId,
        name: column.signalPath,
        data,
        pointColors:
          column.color !== undefined && options.colorScale !== undefined
            ? colorAttributes(
                column.color.values,
                options.colorScale,
                options.contour,
              )
            : undefined,
        style: strokeAt(options, index),
      };
    }),
    xRange: options.xRange,
    yRange: options.yRange,
    axes: line2DAxes(options),
  };
}

export function prepareSignalXLine(
  response: Line2DResponse,
  window: { t0: number; t1: number },
): void {
  const xOrigin = signalXReference(response);
  for (const column of response.ys) {
    cachedSignalXFeed(
      column.coordinates?.anchor ?? response.anchor,
      column.coordinates?.x.values ?? response.x.values,
      column.values,
      xOrigin,
      window,
    );
  }
}

function signalXReference(
  response: Line2DResponse,
  scale: AxisScale = "linear",
): number {
  for (const column of response.ys) {
    for (const value of column.coordinates?.x.values ?? response.x.values) {
      const coordinate = axisCoordinate(value, scale);
      if (Number.isFinite(coordinate)) return coordinate;
    }
  }
  return 0;
}

interface SignalXFeedDescriptor {
  xScale: AxisScale;
  yScale: AxisScale;
  anchor: Float64Array;
  x: Float64Array;
  xOrigin: number;
  t0: number;
  t1: number;
}

const feed = createFeedCache<Float64Array, SignalXFeedDescriptor, Float32Array>(
  (left, right) =>
    left.anchor === right.anchor &&
    left.x === right.x &&
    left.xOrigin === right.xOrigin &&
    left.xScale === right.xScale &&
    left.yScale === right.yScale &&
    left.t0 === right.t0 &&
    left.t1 === right.t1,
);

function cachedSignalXFeed(
  anchor: Float64Array,
  x: Float64Array,
  y: Float64Array,
  xOrigin: number,
  window: { t0: number; t1: number },
  xScale: AxisScale = "linear",
  yScale: AxisScale = "linear",
): Float32Array {
  return feed(
    y,
    { anchor, x, xOrigin, t0: window.t0, t1: window.t1, xScale, yScale },
    () => buildSignalXFeed(anchor, x, y, xOrigin, window, xScale, yScale),
  );
}

function buildSignalXFeed(
  anchor: Float64Array,
  x: Float64Array,
  y: Float64Array,
  xOrigin: number,
  window: { t0: number; t1: number },
  xScale: AxisScale,
  yScale: AxisScale,
): Float32Array {
  const result = new Float32Array(x.length * 2);
  let previousX = 0;
  for (let index = 0; index < x.length; index += 1) {
    const anchorValue = anchor[index] as number;
    const xValue = axisCoordinate(x[index] as number, xScale);
    const yValue = axisCoordinate(y[index] as number, yScale);
    const inWindow = anchorValue >= window.t0 && anchorValue <= window.t1;
    if (inWindow && Number.isFinite(xValue)) previousX = xValue - xOrigin;
    result[index * 2] = previousX;
    result[index * 2 + 1] =
      inWindow && Number.isFinite(xValue) && Number.isFinite(yValue)
        ? yValue
        : Number.NaN;
  }
  return result;
}

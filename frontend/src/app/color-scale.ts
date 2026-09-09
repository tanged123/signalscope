import type { Line2DResponse } from "./line-binary";
import type { ColorAxis } from "../generated/session";
import { axisCoordinate, type AxisScale } from "./plot-math";

export interface ColorScale {
  scale?: AxisScale;
  label: string;
  range: readonly [number, number] | null;
}

export function colorFraction(
  value: number,
  [min, max]: readonly [number, number],
  scale: AxisScale = "linear",
): number {
  if (scale === "log") {
    return colorFraction(axisCoordinate(value, scale), [
      axisCoordinate(min, scale),
      axisCoordinate(max, scale),
    ]);
  }
  if (min === max) return 0.5;
  if (value <= min) return 0;
  if (value >= max) return 1;
  const span = max - min;
  return Number.isFinite(span)
    ? (value - min) / span
    : (value / 2 - min / 2) / (max / 2 - min / 2);
}

const domains = new WeakMap<
  Float64Array,
  {
    anchor: Float64Array;
    t0: number;
    t1: number;
    range: readonly [number, number] | null;
    scale: AxisScale;
  }
>();

export function resolveColorScale(
  response: Line2DResponse,
  axis: ColorAxis,
  window: { t0: number; t1: number },
  label: string,
): ColorScale {
  const scale = axis.scale ?? "linear";
  const result = (range: ColorScale["range"]): ColorScale => ({
    label: axis.label ?? label,
    range,
    ...(scale === "log" ? { scale } : {}),
  });
  if (axis.range !== null) return result(axis.range);
  let min = Infinity;
  let max = -Infinity;
  for (const column of response.ys) {
    const values = column.color?.values;
    if (values === undefined) continue;
    const anchor = column.coordinates?.anchor ?? response.anchor;
    let entry = domains.get(values);
    if (
      entry?.anchor !== anchor ||
      entry.t0 !== window.t0 ||
      entry.t1 !== window.t1 ||
      entry.scale !== scale
    ) {
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < values.length; i += 1) {
        const value = values[i] as number;
        const t = anchor[i] as number;
        if (
          t >= window.t0 &&
          t <= window.t1 &&
          Number.isFinite(value) &&
          (scale !== "log" || value > 0)
        ) {
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
      }
      entry = {
        anchor,
        ...window,
        scale,
        range: low <= high ? [low, high] : null,
      };
      domains.set(values, entry);
    }
    if (entry.range !== null) {
      min = Math.min(min, entry.range[0]);
      max = Math.max(max, entry.range[1]);
    }
  }
  return result(min <= max ? [min, max] : null);
}

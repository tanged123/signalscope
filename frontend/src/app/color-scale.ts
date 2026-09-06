import type { Line2DResponse } from "./line-binary";
import type { ColorAxis } from "../generated/session";

export interface ColorScale {
  label: string;
  range: readonly [number, number] | null;
}

// Viridis samples are independent of the theme's categorical palette.
const STOPS = [
  0x440154, 0x482475, 0x414487, 0x355f8d, 0x2a788e, 0x21918c, 0x22a884,
  0x44bf70, 0x7ad151, 0xbddf26, 0xfde725,
];

export function viridis(t: number): readonly [number, number, number, number] {
  const position = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const index = Math.min(STOPS.length - 2, Math.floor(position));
  const a = STOPS[index] as number;
  const b = STOPS[index + 1] as number;
  const f = position - index;
  const channel = (shift: number): number =>
    (((a >> shift) & 255) * (1 - f) + ((b >> shift) & 255) * f) / 255;
  return [channel(16), channel(8), channel(0), 1];
}

export function colorFraction(
  value: number,
  [min, max]: readonly [number, number],
): number {
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
  }
>();

export function resolveColorScale(
  response: Line2DResponse,
  axis: ColorAxis,
  window: { t0: number; t1: number },
  label: string,
): ColorScale {
  if (axis.range !== null)
    return { label: axis.label ?? label, range: axis.range };
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
      entry.t1 !== window.t1
    ) {
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < values.length; i += 1) {
        const value = values[i] as number;
        const t = anchor[i] as number;
        if (t >= window.t0 && t <= window.t1 && Number.isFinite(value)) {
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
      }
      entry = { anchor, ...window, range: low <= high ? [low, high] : null };
      domains.set(values, entry);
    }
    if (entry.range !== null) {
      min = Math.min(min, entry.range[0]);
      max = Math.max(max, entry.range[1]);
    }
  }
  return { label: axis.label ?? label, range: min <= max ? [min, max] : null };
}

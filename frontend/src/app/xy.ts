import type { SampleSeries } from "../generated/protocol";
import { paddedExtent } from "./plot-math";

/** One y signal paired onto an x signal's timebase. */
export interface XyTrace {
  time: number[];
  x: number[];
  y: number[];
}

function sameTimebase(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Linear sample of `values` at `query`, NaN outside the signal's coverage.
 *
 * The prototype held the endpoint value flat past each end. This returns NaN
 * instead so the stroke lifts: an XY trajectory drawn past a signal's data is
 * a fabricated segment, and the pyramid's gap invariants already commit this
 * codebase to breaking strokes rather than bridging absent data.
 *
 * Exported because the spectrum module resamples the same way.
 */
export function lerpSample(
  time: readonly number[],
  values: readonly number[],
  query: number,
): number {
  const count = time.length;
  if (count === 0) return Number.NaN;
  if (query < (time[0] ?? 0) || query > (time[count - 1] ?? 0)) {
    return Number.NaN;
  }
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((time[mid] ?? 0) < query) low = mid + 1;
    else high = mid;
  }
  if ((time[low] ?? 0) === query) return values[low] ?? Number.NaN;
  const previous = Math.max(0, low - 1);
  const span = (time[low] ?? 0) - (time[previous] ?? 0);
  if (span === 0) return values[low] ?? Number.NaN;
  const alpha = (query - (time[previous] ?? 0)) / span;
  const before = values[previous] ?? Number.NaN;
  const after = values[low] ?? Number.NaN;
  return before + (after - before) * alpha;
}

/** Pairs `y` against `x` on the x signal's timebase. */
export function pairSamples(x: SampleSeries, y: SampleSeries): XyTrace {
  if (sameTimebase(x.time, y.time)) {
    return { time: [...x.time], x: [...x.values], y: [...y.values] };
  }
  return {
    time: [...x.time],
    x: [...x.values],
    y: x.time.map((time) => lerpSample(y.time, y.values, time)),
  };
}

/**
 * The padded display extent of one axis across every trace, restricted to
 * samples inside `[t0, t1]`. Null when nothing finite falls in the window.
 */
export function traceExtent(
  traces: readonly XyTrace[],
  axis: "x" | "y",
  t0: number,
  t1: number,
): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const trace of traces) {
    const column = axis === "x" ? trace.x : trace.y;
    for (let index = 0; index < trace.time.length; index += 1) {
      const time = trace.time[index] ?? Number.NaN;
      if (time < t0 || time > t1) continue;
      const value = column[index] ?? Number.NaN;
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return paddedExtent(min, max);
}

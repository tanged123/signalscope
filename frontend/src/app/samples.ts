import type {
  EnvelopeBin,
  SampleResponse,
  SampleSeries,
} from "../generated/protocol";
import { lowerBound, upperBound } from "./binary-search";

export interface SampleSlice {
  time: number[];
  values: number[];
  stride: number;
}

/**
 * Linear sample of `values` at `query`, NaN outside the signal's coverage.
 *
 * The prototype held the endpoint value flat past each end. This returns NaN
 * instead so the stroke lifts when a plot extends past a signal's data range:
 * a fabricated segment, and the pyramid's gap invariants already commit this
 * codebase to breaking strokes rather than bridging absent data.
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

function sampleWindowBounds(
  time: readonly number[],
  t0: number,
  t1: number,
): [number, number] | null {
  const first = time[0];
  const last = time[time.length - 1];
  if (first === undefined || last === undefined || t1 < first || t0 > last) {
    return null;
  }
  const start = Math.max(0, lowerBound(time, t0) - 1);
  const end = Math.min(time.length, upperBound(time, t1) + 1);
  return start < end ? [start, end] : null;
}

/**
 * Mirror of `scope_core::compute::sample_window`. The index arithmetic is
 * protocol surface: `protocol/testdata/sample-conformance.json` locks this
 * against the Rust implementation so a snapshot decimates identically.
 */
export function sampleWindow(
  time: readonly number[],
  values: readonly number[],
  t0: number,
  t1: number,
  maxPoints: number,
): SampleSlice {
  const bounds = sampleWindowBounds(time, t0, t1);
  if (bounds === null) {
    return { time: [], values: [], stride: 1 };
  }
  const [start, end] = bounds;
  const span = end - start;
  const cap = Math.max(1, Math.trunc(maxPoints));
  const stride = Math.max(1, Math.ceil(span / cap));
  const pickedTime: number[] = [];
  const pickedValues: number[] = [];
  for (let index = start; index < end; index += stride) {
    pickedTime.push(time[index] ?? 0);
    pickedValues.push(values[index] ?? Number.NaN);
  }
  const lastTime = time[end - 1] ?? 0;
  if (pickedTime[pickedTime.length - 1] !== lastTime) {
    pickedTime.push(lastTime);
    pickedValues.push(values[end - 1] ?? Number.NaN);
  }
  return { time: pickedTime, values: pickedValues, stride };
}

/** Mirror of `scope_core::compute::sample_window_full`. */
export function sampleWindowFull(
  time: readonly number[],
  values: readonly number[],
  t0: number,
  t1: number,
): SampleSlice {
  const bounds = sampleWindowBounds(time, t0, t1);
  if (bounds === null) return { time: [], values: [], stride: 1 };
  const [start, end] = bounds;
  return {
    time: time.slice(start, end),
    values: values.slice(start, end),
    stride: 1,
  };
}

/**
 * Reads level-0 envelope bins back as raw samples. Bins are degenerate at
 * level 0 (`t0 === t1`, `first === last`), so this is exact there and a
 * bin-resolution approximation at any coarser level.
 */
export function binsToSamples(bins: readonly EnvelopeBin[]): {
  time: number[];
  values: number[];
} {
  const time: number[] = [];
  const values: number[] = [];
  for (const bin of bins) {
    time.push((bin.t0 + bin.t1) * 0.5);
    values.push(bin.first ?? Number.NaN);
  }
  return { time, values };
}

/**
 * Combines a coarse full-extent response with a detailed visible-window
 * response. Detail replaces the overlapping context interval so timestamps
 * are not double-rendered, while context remains on either side for the
 * dimmed plot.
 */
export function mergeSampleResponses(
  context: SampleResponse,
  detail: SampleResponse,
): SampleResponse {
  const coarseByPath = new Map(
    context.series.map((series) => [series.signal_path, series]),
  );
  const detailByPath = new Map(
    detail.series.map((series) => [series.signal_path, series]),
  );
  const paths = new Set([...coarseByPath.keys(), ...detailByPath.keys()]);
  const series: SampleSeries[] = [];
  for (const path of paths) {
    const coarse = coarseByPath.get(path);
    const fine = detailByPath.get(path);
    if (fine === undefined || fine.time.length === 0) {
      if (coarse !== undefined) series.push(coarse);
      continue;
    }
    if (coarse === undefined) {
      series.push(fine);
      continue;
    }
    const low = fine.time[0] ?? Number.NEGATIVE_INFINITY;
    const high = fine.time[fine.time.length - 1] ?? Number.POSITIVE_INFINITY;
    const time: number[] = [];
    const values: number[] = [];
    coarse.time.forEach((sampleTime, index) => {
      if (sampleTime >= low) return;
      time.push(sampleTime);
      values.push(coarse.values[index] ?? Number.NaN);
    });
    // Append rather than spread: a full response can be large enough to
    // overflow the call stack.
    for (let index = 0; index < fine.time.length; index += 1) {
      time.push(fine.time[index] ?? Number.NaN);
      values.push(fine.values[index] ?? Number.NaN);
    }
    coarse.time.forEach((sampleTime, index) => {
      if (sampleTime <= high) return;
      time.push(sampleTime);
      values.push(coarse.values[index] ?? Number.NaN);
    });
    series.push({
      ...fine,
      time,
      values,
      stride: Math.min(coarse.stride, fine.stride),
    });
  }
  return { request_id: detail.request_id, series };
}

import type {
  EnvelopeBin,
  SampleResponse,
  SampleSeries,
} from "../generated/protocol";

export interface SampleSlice {
  time: number[];
  values: number[];
  stride: number;
}

/** Index of the first entry not less than `value` in a sorted array. */
function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? 0) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Index of the first entry greater than `value` in a sorted array. */
function upperBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? 0) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
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
  const first = time[0];
  const last = time[time.length - 1];
  if (first === undefined || last === undefined || t1 < first || t0 > last) {
    return { time: [], values: [], stride: 1 };
  }
  const start = Math.max(0, lowerBound(time, t0) - 1);
  const end = Math.min(time.length, upperBound(time, t1) + 1);
  if (start >= end) return { time: [], values: [], stride: 1 };
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
 * dimmed XY trajectory.
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
    // Appended rather than argument-spread: `fine` can hold SAMPLE_CAP
    // elements, which spreading would push onto the call stack.
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

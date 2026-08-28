import {
  HAS_FIRST,
  HAS_GAP,
  HAS_LAST,
  HAS_MAX,
  HAS_MIN,
  type BinColumns,
} from "../app/bin-columns";
import type { ColumnarTileResponse } from "../app/bin-columns";

/**
 * Interleaved `[x0, y0, x1, y1, ...]` in single precision: the layout
 * ChartGPU bulk-copies into its staging buffer instead of packing element by
 * element. `x` is `time - tRef`; `y` is `NaN` at a gap.
 */
export type SeriesFeed = Float32Array;

export function m4Feed(columns: BinColumns, tRef: number): SeriesFeed {
  const feed = new Float32Array(vertexCount(columns) * 2);
  let length = 0;
  const appendGap = (time: number): void => {
    feed[length] = time - tRef;
    feed[length + 1] = Number.NaN;
    length += 2;
  };
  const append = (time: number, value: number): void => {
    if (!Number.isFinite(value)) return;
    feed[length] = time - tRef;
    feed[length + 1] = value;
    length += 2;
  };

  for (let index = 0; index < columns.count; index += 1) {
    const flags = columns.flags[index] as number;
    const midpoint =
      ((columns.t0[index] as number) + (columns.t1[index] as number)) / 2;
    if (columns.finiteCount[index] === 0) {
      appendGap(midpoint);
      continue;
    }
    const hasGap = (flags & HAS_GAP) !== 0;
    if (hasGap) appendGap(midpoint);
    const start = length;
    if (
      columns.sampleCount[index] === 1 &&
      columns.t0[index] === columns.t1[index]
    ) {
      append(columns.t0[index] as number, columns.first[index] as number);
    } else {
      const first =
        (flags & HAS_FIRST) !== 0
          ? (columns.first[index] as number)
          : Number.NaN;
      const min =
        (flags & HAS_MIN) !== 0 ? (columns.min[index] as number) : Number.NaN;
      const max =
        (flags & HAS_MAX) !== 0 ? (columns.max[index] as number) : Number.NaN;
      const last =
        (flags & HAS_LAST) !== 0 ? (columns.last[index] as number) : Number.NaN;
      if ((flags & HAS_FIRST) !== 0) {
        append(columns.t0[index] as number, first);
      }
      let emittedExtremum: number | null = null;
      if (
        (flags & HAS_MIN) !== 0 &&
        Number.isFinite(min) &&
        min !== first &&
        min !== last
      ) {
        append(midpoint, min);
        emittedExtremum = min;
      }
      if (
        (flags & HAS_MAX) !== 0 &&
        Number.isFinite(max) &&
        max !== first &&
        max !== last &&
        max !== emittedExtremum
      ) {
        append(midpoint, max);
      }
      if ((flags & HAS_LAST) !== 0) {
        append(columns.t1[index] as number, last);
      }
    }
    if (length === start) {
      appendGap(midpoint);
    }
    if (hasGap) appendGap(midpoint);
  }
  return feed.subarray(0, length);
}

function vertexCount(columns: BinColumns): number {
  let count = 0;
  for (let index = 0; index < columns.count; index += 1) {
    const flags = columns.flags[index] as number;
    const singleton =
      columns.sampleCount[index] === 1 &&
      columns.t0[index] === columns.t1[index];
    const hasGap = (flags & HAS_GAP) !== 0;
    if (columns.finiteCount[index] === 0) {
      count += 1;
      continue;
    }
    if (singleton) {
      count += 1 + (hasGap ? 2 : 0);
      continue;
    }
    const first =
      (flags & HAS_FIRST) !== 0 ? (columns.first[index] as number) : Number.NaN;
    const min =
      (flags & HAS_MIN) !== 0 ? (columns.min[index] as number) : Number.NaN;
    const max =
      (flags & HAS_MAX) !== 0 ? (columns.max[index] as number) : Number.NaN;
    const last =
      (flags & HAS_LAST) !== 0 ? (columns.last[index] as number) : Number.NaN;
    let finite = 0;
    if ((flags & HAS_FIRST) !== 0 && Number.isFinite(first)) finite += 1;
    let emittedExtremum: number | null = null;
    if (
      (flags & HAS_MIN) !== 0 &&
      Number.isFinite(min) &&
      min !== first &&
      min !== last
    ) {
      finite += 1;
      emittedExtremum = min;
    }
    if (
      (flags & HAS_MAX) !== 0 &&
      Number.isFinite(max) &&
      max !== first &&
      max !== last &&
      max !== emittedExtremum
    ) {
      finite += 1;
    }
    if ((flags & HAS_LAST) !== 0 && Number.isFinite(last)) finite += 1;
    count += finite === 0 ? 1 : finite;
    if (hasGap) count += 2;
  }
  return count;
}

const feedCache = new WeakMap<BinColumns, { tRef: number; feed: SeriesFeed }>();

export function cachedFeed(columns: BinColumns, tRef: number): SeriesFeed {
  const cached = feedCache.get(columns);
  if (cached !== undefined && cached.tRef === tRef) return cached.feed;
  const feed = m4Feed(columns, tRef);
  feedCache.set(columns, { tRef, feed });
  return feed;
}

export function responseTimeReference(response: ColumnarTileResponse): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const series of response.series) {
    if (series.bins.count === 0) continue;
    minimum = Math.min(minimum, series.bins.t0[0] as number);
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

export function prepareResponseFeeds(
  response: ColumnarTileResponse,
): readonly SeriesFeed[] {
  const tRef = responseTimeReference(response);
  return response.series.map((series) => cachedFeed(series.bins, tRef));
}

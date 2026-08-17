import {
  HAS_FIRST,
  HAS_GAP,
  HAS_LAST,
  HAS_MAX,
  HAS_MIN,
  type BinColumns,
} from "../app/bin-columns";

export interface SeriesFeed {
  x: Float64Array;
  y: Float64Array;
}

export function m4Feed(columns: BinColumns, tRef: number): SeriesFeed {
  const x = new Float64Array(vertexCount(columns));
  const y = new Float64Array(x.length);
  let length = 0;
  const appendGap = (time: number): void => {
    x[length] = time - tRef;
    y[length] = Number.NaN;
    length += 1;
  };
  const append = (time: number, value: number): void => {
    if (!Number.isFinite(value)) return;
    x[length] = time - tRef;
    y[length] = value;
    length += 1;
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
      if ((flags & HAS_FIRST) !== 0) {
        append(columns.t0[index] as number, columns.first[index] as number);
      }
      if ((flags & HAS_MIN) !== 0) {
        append(midpoint, columns.min[index] as number);
      }
      if ((flags & HAS_MAX) !== 0) {
        append(midpoint, columns.max[index] as number);
      }
      if ((flags & HAS_LAST) !== 0) {
        append(columns.t1[index] as number, columns.last[index] as number);
      }
    }
    if (length === start) {
      appendGap(midpoint);
    }
    if (hasGap) appendGap(midpoint);
  }
  return { x: x.subarray(0, length), y: y.subarray(0, length) };
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
    const finite =
      ((flags & HAS_FIRST) !== 0 &&
      Number.isFinite(columns.first[index] as number)
        ? 1
        : 0) +
      ((flags & HAS_MIN) !== 0 && Number.isFinite(columns.min[index] as number)
        ? 1
        : 0) +
      ((flags & HAS_MAX) !== 0 && Number.isFinite(columns.max[index] as number)
        ? 1
        : 0) +
      ((flags & HAS_LAST) !== 0 &&
      Number.isFinite(columns.last[index] as number)
        ? 1
        : 0);
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

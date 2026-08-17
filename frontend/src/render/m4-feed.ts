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
  const x = new Float64Array(columns.count * 5);
  const y = new Float64Array(columns.count * 5);
  let length = 0;
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
    const start = length;
    if (
      columns.sampleCount[index] === 1 &&
      columns.t0[index] === columns.t1[index]
    ) {
      const value = columns.first[index] as number;
      if (Number.isFinite(value)) {
        append(columns.t0[index] as number, value);
      } else {
        x[length] = midpoint - tRef;
        y[length] = Number.NaN;
        length += 1;
      }
      continue;
    }
    if (columns.finiteCount[index] === 0) {
      x[length] = midpoint - tRef;
      y[length] = Number.NaN;
      length += 1;
      continue;
    }
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
    if (length === start) {
      x[length] = midpoint - tRef;
      y[length] = Number.NaN;
      length += 1;
    }
    if ((flags & HAS_GAP) !== 0) {
      x[length] = midpoint - tRef;
      y[length] = Number.NaN;
      length += 1;
    }
  }
  return { x: x.subarray(0, length), y: y.subarray(0, length) };
}

const feedCache = new WeakMap<BinColumns, { tRef: number; feed: SeriesFeed }>();

export function cachedFeed(columns: BinColumns, tRef: number): SeriesFeed {
  const cached = feedCache.get(columns);
  if (cached !== undefined && cached.tRef === tRef) return cached.feed;
  const feed = m4Feed(columns, tRef);
  feedCache.set(columns, { tRef, feed });
  return feed;
}

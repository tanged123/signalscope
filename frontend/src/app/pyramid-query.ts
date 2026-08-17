import type { EnvelopeBin } from "../generated/protocol";

export interface PyramidQueryRange {
  level: number;
  start: number;
  end: number;
}

export function queryRawPyramidRange(
  levels: readonly EnvelopeBin[][],
  t0: number,
  t1: number,
): PyramidQueryRange {
  const raw = levels[0] ?? [];
  if (
    raw.length === 0 ||
    t1 < (raw[0] as EnvelopeBin).t0 ||
    t0 > (raw[raw.length - 1] as EnvelopeBin).t1
  ) {
    return { level: 0, start: 0, end: 0 };
  }
  const start = firstOverlapping(raw, t0);
  const end = pastLastOverlapping(raw, t1);
  return {
    level: 0,
    start: Math.max(0, start - 1),
    end: Math.min(raw.length, end + 1),
  };
}

/** First index whose bin ends at or after `t0` (partition point of t1 < t0). */
function firstOverlapping(level: readonly EnvelopeBin[], t0: number): number {
  let low = 0;
  let high = level.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((level[middle] as EnvelopeBin).t1 < t0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** First index whose bin starts after `t1` (partition point of t0 <= t1). */
function pastLastOverlapping(
  level: readonly EnvelopeBin[],
  t1: number,
): number {
  let low = 0;
  let high = level.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((level[middle] as EnvelopeBin).t0 <= t1) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

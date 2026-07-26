import type { EnvelopeBin } from "../generated/protocol";

export interface PyramidQueryResult {
  level: number;
  bins: EnvelopeBin[];
}

/**
 * Level selection identical to `scope_core::pyramid::Pyramid::query`: the
 * finest level whose overlapping bin count fits twice the pixel budget,
 * falling back to the coarsest. Guarded against drift by
 * `protocol/testdata/pyramid-conformance.json`, which the Rust
 * implementation generates and both hosts assert against.
 */
export function queryPyramid(
  levels: readonly EnvelopeBin[][],
  t0: number,
  t1: number,
  pixelWidth: number,
): PyramidQueryResult {
  const raw = levels[0] ?? [];
  if (
    raw.length === 0 ||
    t1 < (raw[0] as EnvelopeBin).t0 ||
    t0 > (raw[raw.length - 1] as EnvelopeBin).t1
  ) {
    return { level: 0, bins: [] };
  }
  const target = Math.max(1, Math.floor(pixelWidth)) * 2;
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index] ?? [];
    const start = firstOverlapping(level, t0);
    const end = pastLastOverlapping(level, t1);
    if (end - start <= target || index === levels.length - 1) {
      return {
        level: index,
        bins: level.slice(
          Math.max(0, start - 1),
          Math.min(level.length, end + 1),
        ),
      };
    }
  }
  return { level: 0, bins: [] };
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

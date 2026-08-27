import type { EnvelopeBin } from "../generated/protocol";

export interface PyramidQueryRange {
  level: number;
  start: number;
  end: number;
}

export function queryAdaptivePyramidRange(
  levels: readonly EnvelopeBin[][],
  t0: number,
  t1: number,
  pixelWidth: number,
): PyramidQueryRange {
  const pixels = Number.isFinite(pixelWidth)
    ? Math.max(1, Math.floor(pixelWidth))
    : 1;
  const target = 2 * pixels;
  const pixelSpan = (t1 - t0) / pixels;
  if (levels.length === 0) {
    return { level: 0, start: 0, end: 0 };
  }

  let level = levels.length - 1;
  for (let index = 0; index < levels.length; index += 1) {
    const range = overlappingRange(levels[index] ?? [], t0, t1);
    if (range.end - range.start <= target) {
      level = index;
      break;
    }
  }

  while (level > 0) {
    const range = overlappingRange(levels[level] ?? [], t0, t1);
    const bins = (levels[level] ?? []).slice(range.start, range.end);
    const fitsPixelFloor =
      range.end - range.start > pixels &&
      Number.isFinite(pixelSpan) &&
      bins.every((bin) => bin.t1 - bin.t0 <= pixelSpan);
    if (fitsPixelFloor) break;
    level -= 1;
  }

  const selected = overlappingRange(levels[level] ?? [], t0, t1);
  return {
    level,
    start: Math.max(0, selected.start - 1),
    end: Math.min((levels[level] ?? []).length, selected.end + 1),
  };
}

function overlappingRange(
  level: readonly EnvelopeBin[],
  t0: number,
  t1: number,
): { start: number; end: number } {
  if (
    level.length === 0 ||
    t1 < (level[0] as EnvelopeBin).t0 ||
    t0 > (level[level.length - 1] as EnvelopeBin).t1
  ) {
    return { start: 0, end: 0 };
  }
  return {
    start: firstOverlapping(level, t0),
    end: pastLastOverlapping(level, t1),
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

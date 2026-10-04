export interface PyramidQueryRange {
  level: number;
  start: number;
  end: number;
}

/** Bin time bounds of one pyramid level. */
export interface LevelTimes {
  readonly t0: ArrayLike<number>;
  readonly t1: ArrayLike<number>;
}

export function queryAdaptivePyramidRange(
  levels: readonly LevelTimes[],
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
    const range = overlappingRange(levels[index] as LevelTimes, t0, t1);
    if (range.end - range.start <= target) {
      level = index;
      break;
    }
  }

  while (level > 0) {
    const times = levels[level] as LevelTimes;
    const range = overlappingRange(times, t0, t1);
    let fitsPixelFloor =
      range.end - range.start > pixels && Number.isFinite(pixelSpan);
    for (
      let index = range.start;
      fitsPixelFloor && index < range.end;
      index += 1
    ) {
      fitsPixelFloor =
        (times.t1[index] as number) - (times.t0[index] as number) <= pixelSpan;
    }
    if (fitsPixelFloor) break;
    level -= 1;
  }

  const times = levels[level] as LevelTimes;
  const selected = overlappingRange(times, t0, t1);
  return {
    level,
    start: Math.max(0, selected.start - 1),
    end: Math.min(times.t0.length, selected.end + 1),
  };
}

function overlappingRange(
  level: LevelTimes,
  t0: number,
  t1: number,
): { start: number; end: number } {
  const count = level.t0.length;
  if (
    count === 0 ||
    t1 < (level.t0[0] as number) ||
    t0 > (level.t1[count - 1] as number)
  ) {
    return { start: 0, end: 0 };
  }
  return {
    start: firstOverlapping(level, t0),
    end: pastLastOverlapping(level, t1),
  };
}

/** First index whose bin ends at or after `t0` (partition point of t1 < t0). */
function firstOverlapping(level: LevelTimes, t0: number): number {
  let low = 0;
  let high = level.t1.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((level.t1[middle] as number) < t0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** First index whose bin starts after `t1` (partition point of t0 <= t1). */
function pastLastOverlapping(level: LevelTimes, t1: number): number {
  let low = 0;
  let high = level.t0.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((level.t0[middle] as number) <= t1) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

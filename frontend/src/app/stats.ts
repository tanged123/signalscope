import type { EnvelopeBin } from "../generated/protocol";

export interface SeriesStats {
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
}

export function visibleStats(
  bins: readonly EnvelopeBin[],
  t0: number,
  t1: number,
): SeriesStats {
  let min: number | null = null;
  let max: number | null = null;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (const bin of bins) {
    if (bin.t1 < t0 || bin.t0 > t1) continue;
    if (bin.min !== null) min = min === null ? bin.min : Math.min(min, bin.min);
    if (bin.max !== null) max = max === null ? bin.max : Math.max(max, bin.max);
    sum += bin.sum;
    sumSq += bin.sum_sq;
    count += Number(bin.finite_count);
  }
  return {
    min,
    max,
    mean: count > 0 ? sum / count : null,
    rms: count > 0 ? Math.sqrt(sumSq / count) : null,
  };
}

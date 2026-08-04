import type { EnvelopeBin } from "../generated/protocol";

export const HAS_FIRST = 1;
export const HAS_LAST = 2;
export const HAS_MIN = 4;
export const HAS_MAX = 8;
export const HAS_GAP = 16;

export interface BinColumns {
  readonly count: number;
  readonly t0: Float64Array;
  readonly t1: Float64Array;
  readonly first: Float64Array;
  readonly last: Float64Array;
  readonly min: Float64Array;
  readonly max: Float64Array;
  readonly sum: Float64Array;
  readonly sumSq: Float64Array;
  readonly sampleCount: Uint32Array;
  readonly finiteCount: Uint32Array;
  readonly flags: Uint8Array;
}

export interface ColumnarTile {
  signalId: string;
  signalPath: string;
  unit: string | null;
  level: number;
  bins: BinColumns;
}

export interface ColumnarTileResponse {
  requestId: string;
  series: ColumnarTile[];
}

export function binColumnsFromWire(bins: readonly EnvelopeBin[]): BinColumns {
  return binColumnsFromWireRange(bins, 0, bins.length);
}

export function binColumnsFromWireRange(
  bins: readonly EnvelopeBin[],
  start: number,
  end: number,
): BinColumns {
  const first = Math.max(0, Math.min(bins.length, start));
  const last = Math.max(first, Math.min(bins.length, end));
  const count = last - first;
  const columns: BinColumns = {
    count,
    t0: new Float64Array(count),
    t1: new Float64Array(count),
    first: new Float64Array(count),
    last: new Float64Array(count),
    min: new Float64Array(count),
    max: new Float64Array(count),
    sum: new Float64Array(count),
    sumSq: new Float64Array(count),
    sampleCount: new Uint32Array(count),
    finiteCount: new Uint32Array(count),
    flags: new Uint8Array(count),
  };
  for (let source = first; source < last; source += 1) {
    const index = source - first;
    const bin = bins[source] as EnvelopeBin;
    columns.t0[index] = bin.t0;
    columns.t1[index] = bin.t1;
    columns.first[index] = bin.first ?? Number.NaN;
    columns.last[index] = bin.last ?? Number.NaN;
    columns.min[index] = bin.min ?? Number.NaN;
    columns.max[index] = bin.max ?? Number.NaN;
    columns.sum[index] = bin.sum;
    columns.sumSq[index] = bin.sum_sq;
    columns.sampleCount[index] = Number(bin.sample_count);
    columns.finiteCount[index] = Number(bin.finite_count);
    columns.flags[index] =
      (bin.first === null ? 0 : HAS_FIRST) |
      (bin.last === null ? 0 : HAS_LAST) |
      (bin.min === null ? 0 : HAS_MIN) |
      (bin.max === null ? 0 : HAS_MAX) |
      (bin.has_gap ? HAS_GAP : 0);
  }
  return columns;
}

export function wireBinFromColumns(
  bins: BinColumns,
  index: number,
): EnvelopeBin {
  const flags = bins.flags[index] as number;
  return {
    t0: bins.t0[index] as number,
    t1: bins.t1[index] as number,
    first: flags & HAS_FIRST ? (bins.first[index] as number) : null,
    last: flags & HAS_LAST ? (bins.last[index] as number) : null,
    min: flags & HAS_MIN ? (bins.min[index] as number) : null,
    max: flags & HAS_MAX ? (bins.max[index] as number) : null,
    sum: bins.sum[index] as number,
    sum_sq: bins.sumSq[index] as number,
    finite_count: String(bins.finiteCount[index]),
    sample_count: String(bins.sampleCount[index]),
    has_gap: Boolean(flags & HAS_GAP),
  };
}

export function sliceColumns(
  bins: BinColumns,
  start: number,
  end: number,
): BinColumns {
  return {
    count: Math.max(0, end - start),
    t0: bins.t0.subarray(start, end),
    t1: bins.t1.subarray(start, end),
    first: bins.first.subarray(start, end),
    last: bins.last.subarray(start, end),
    min: bins.min.subarray(start, end),
    max: bins.max.subarray(start, end),
    sum: bins.sum.subarray(start, end),
    sumSq: bins.sumSq.subarray(start, end),
    sampleCount: bins.sampleCount.subarray(start, end),
    finiteCount: bins.finiteCount.subarray(start, end),
    flags: bins.flags.subarray(start, end),
  };
}

export function columnsYExtent(
  bins: BinColumns,
  window?: { t0: number; t1: number },
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < bins.count; index += 1) {
    if (
      window !== undefined &&
      ((bins.t1[index] as number) < window.t0 ||
        (bins.t0[index] as number) > window.t1)
    ) {
      continue;
    }
    const flags = bins.flags[index] as number;
    if (flags & HAS_MIN) min = Math.min(min, bins.min[index] as number);
    if (flags & HAS_MAX) max = Math.max(max, bins.max[index] as number);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

export function columnsStats(
  bins: BinColumns,
  t0: number,
  t1: number,
): {
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
  n: number;
} {
  let min: number | null = null;
  let max: number | null = null;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let index = 0; index < bins.count; index += 1) {
    const binT0 = bins.t0[index] as number;
    const binT1 = bins.t1[index] as number;
    if (binT1 < t0 || binT0 > t1) continue;
    const flags = bins.flags[index] as number;
    if (flags & HAS_MIN) {
      const value = bins.min[index] as number;
      min = min === null ? value : Math.min(min, value);
    }
    if (flags & HAS_MAX) {
      const value = bins.max[index] as number;
      max = max === null ? value : Math.max(max, value);
    }
    sum += bins.sum[index] as number;
    sumSq += bins.sumSq[index] as number;
    n += bins.finiteCount[index] as number;
  }
  return {
    min,
    max,
    mean: n > 0 ? sum / n : null,
    rms: n > 0 ? Math.sqrt(sumSq / n) : null,
    n,
  };
}

export function columnsValueAtTime(
  bins: BinColumns,
  time: number,
): number | null {
  if (bins.count === 0) return null;
  const center = (index: number): number =>
    ((bins.t0[index] as number) + (bins.t1[index] as number)) * 0.5;
  let low = 0;
  let high = bins.count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (center(middle) < time) low = middle + 1;
    else high = middle;
  }
  const nextT0 = bins.t0[low] as number;
  const nextT1 = bins.t1[low] as number;
  const nextFlags = bins.flags[low] as number;
  const nextCenter = center(low);
  if (time >= nextT0 && time <= nextT1 && nextT1 > nextT0) {
    if (!(nextFlags & HAS_FIRST) || !(nextFlags & HAS_LAST)) return null;
    const alpha = (time - nextT0) / (nextT1 - nextT0);
    return (
      (bins.first[low] as number) +
      ((bins.last[low] as number) - (bins.first[low] as number)) * alpha
    );
  }
  if (time === nextCenter) {
    return nextFlags & HAS_LAST ? (bins.last[low] as number) : null;
  }
  const previous = low - 1;
  if (
    previous < 0 ||
    !((bins.flags[previous] as number) & HAS_LAST) ||
    !(nextFlags & HAS_FIRST) ||
    nextFlags & HAS_GAP
  ) {
    return null;
  }
  const previousCenter = center(previous);
  if (
    time < previousCenter ||
    time > nextCenter ||
    nextCenter <= previousCenter
  ) {
    return null;
  }
  const alpha = (time - previousCenter) / (nextCenter - previousCenter);
  return (
    (bins.last[previous] as number) +
    ((bins.first[low] as number) - (bins.last[previous] as number)) * alpha
  );
}

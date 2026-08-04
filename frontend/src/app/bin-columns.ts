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
  const count = bins.length;
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
  for (const [index, bin] of bins.entries()) {
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

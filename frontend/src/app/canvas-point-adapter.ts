import {
  HAS_FIRST,
  HAS_GAP,
  HAS_LAST,
  HAS_MAX,
  HAS_MIN,
  type BinColumns,
  type ColumnarTile,
  type ColumnarTileResponse,
} from "./bin-columns";
import { pointBreakBefore, pointTime, pointValue } from "./tile-points";

const cache = new WeakMap<Uint8Array, BinColumns>();

/** Temporary phase-2 bridge for the Canvas renderer; phase 3 removes it. */
export function adaptCanvasPoints(
  response: ColumnarTileResponse,
): ColumnarTileResponse {
  return {
    ...response,
    series: response.series.map((tile) => ({
      ...tile,
      bins: canvasBinsFromPoints(tile),
    })),
  };
}

export function canvasBinsFromPoints(tile: ColumnarTile): BinColumns {
  const { points, origin } = tile;
  const cached = cache.get(points.bytes);
  if (cached !== undefined) return cached;

  const columns: BinColumns = {
    count: points.count,
    t0: new Float64Array(points.count),
    t1: new Float64Array(points.count),
    first: new Float64Array(points.count),
    last: new Float64Array(points.count),
    min: new Float64Array(points.count),
    max: new Float64Array(points.count),
    sum: new Float64Array(points.count),
    sumSq: new Float64Array(points.count),
    sampleCount: new Uint32Array(points.count),
    finiteCount: new Uint32Array(points.count),
    flags: new Uint8Array(points.count),
  };
  for (let index = 0; index < points.count; index += 1) {
    const time = pointTime(points, origin, index);
    const value = pointValue(points, index);
    columns.t0[index] = time;
    columns.t1[index] = time;
    columns.first[index] = value;
    columns.last[index] = value;
    columns.min[index] = value;
    columns.max[index] = value;
    columns.sum[index] = value;
    columns.sumSq[index] = value * value;
    columns.sampleCount[index] = 1;
    columns.finiteCount[index] = 1;
    columns.flags[index] =
      HAS_FIRST |
      HAS_LAST |
      HAS_MIN |
      HAS_MAX |
      (pointBreakBefore(points, index) ? HAS_GAP : 0);
  }
  cache.set(points.bytes, columns);
  return columns;
}

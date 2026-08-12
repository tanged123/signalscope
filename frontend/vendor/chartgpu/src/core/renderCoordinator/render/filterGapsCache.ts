/**
 * Cached `filterGaps` results for connectNulls series (P2-12).
 *
 * Keyed by series index + input data reference identity + point count.
 * When the same data array is prepared on consecutive frames with the same
 * length, the filtered result is reused (no allocation / re-scan).
 *
 * Point count is part of the key so streaming appends that mutate
 * `MutableXYColumns` under a stable object reference still recompute
 * after the series grows. Explicit invalidation is still required when
 * values are mutated in-place without a length change (update animation).
 *
 * Clear the cache when runtime series are re-inited, update-animation mutates
 * values under a stable ref, appends run, or series count changes.
 *
 * @module filterGapsCache
 */

import type { CartesianSeriesData, DataPoint } from '../../../config/types';
import { filterGaps, getPointCount } from '../../../data/cartesianData';

export type FilterGapsCache = Map<
  number,
  Readonly<{
    data: unknown;
    /** Point count at the time of filtering (guards same-ref append growth). */
    pointCount: number;
    filtered: ReadonlyArray<DataPoint>;
  }>
>;

export function createFilterGapsCache(): FilterGapsCache {
  return new Map();
}

/**
 * Returns filterGaps(data), reusing a cached array when `data` is the same
 * reference *and* has the same point count as the previous call for this
 * series index.
 */
export function getFilteredGapsCached(
  cache: FilterGapsCache,
  seriesIndex: number,
  data: CartesianSeriesData
): ReadonlyArray<DataPoint> {
  const pointCount = getPointCount(data);
  const hit = cache.get(seriesIndex);
  if (hit && hit.data === data && hit.pointCount === pointCount) {
    return hit.filtered;
  }
  const filtered = filterGaps(data);
  cache.set(seriesIndex, { data, pointCount, filtered });
  return filtered;
}

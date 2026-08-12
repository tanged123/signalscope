/**
 * Time-axis packing origin for line DataStore uploads.
 *
 * Shared by GPU-decimation and CPU prepare paths so FIFO time-axis offset
 * cannot drift between branches after the original oldest sample is dropped.
 *
 * @module resolveLinePackingXOffset
 * @internal
 */

import { getPointCount, getX, isStagingRingView, type CoordinatorCartesianData } from '../../../data/cartesianData';
import type { DataStore } from '../../../data/createDataStore';

type ResolveLinePackingXOffsetInput = {
  readonly data: CoordinatorCartesianData;
  readonly dataStore: Pick<DataStore, 'getSeriesXOffset'>;
  readonly seriesIndex: number;
  readonly xAxisType: string | undefined;
};

/**
 * Resolve the xOffset used for pack/setSeries and the line VS affine.
 */
export function resolveLinePackingXOffset(input: ResolveLinePackingXOffsetInput): {
  readonly packingXOffset: number;
  readonly xOffset: number;
} {
  const { data, dataStore, seriesIndex, xAxisType } = input;

  if (xAxisType !== 'time') {
    return { packingXOffset: 0, xOffset: 0 };
  }

  if (isStagingRingView(data)) {
    const o = data.xOffset;
    return { packingXOffset: o, xOffset: o };
  }

  const domainFirstX = (() => {
    const count = getPointCount(data);
    for (let k = 0; k < count; k++) {
      const x = getX(data, k);
      if (Number.isFinite(x)) return x;
    }
    return 0;
  })();

  let storeOffset: number | null = null;
  try {
    storeOffset = dataStore.getSeriesXOffset(seriesIndex);
  } catch {
    storeOffset = null;
  }

  const packingXOffset = storeOffset ?? domainFirstX;
  // Prefer store origin when series already exists (append / setSeries skip).
  const xOffset = storeOffset ?? packingXOffset;
  return { packingXOffset, xOffset };
}

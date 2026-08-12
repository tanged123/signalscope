/**
 * Staging thin-path helpers: zero-copy DataStore staging alias after append.
 *
 * Thin path = GPU append fast path (`fullRawLine` / `gpuDecimationRaw`). When
 * ranged append is live, coordinator runtime raw binds to DataStore Float32
 * staging (no dual-pack into RingXYColumns / growing MutableXYColumns).
 *
 * Eligibility is simply the append fast path (`canUseFastPath` / canRangedAppendLine).
 * FIFO maxPoints and unbounded growth are both dual-pack-free on that path.
 * Hit-test dual-store (F64) is independent of thin-path eligibility.
 *
 * @module stagingThinPath
 * @internal
 */

import { isStagingRingView } from '../../../data/cartesianData';

/**
 * After a thin-path rebind failure (DataStore throw post-append), demote any
 * live StagingRingView so dual-pack fallthrough can re-sync with the store.
 * Non-staging raw is returned unchanged.
 */
export function demoteStagingViewAfterRebindFailure<T>(raw: T | null): T | null {
  if (raw != null && isStagingRingView(raw)) {
    return null;
  }
  return raw;
}

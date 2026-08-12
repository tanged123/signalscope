/**
 * Stable integer category key for stacked bar segments.
 *
 * Shared by bar domain packing (`createBarRenderer`) and bar hit-testing
 * (`findNearestPoint`) so drawn stacks and hit targets agree.
 *
 * Prefer domain `round(x / categoryStep)` (scale-independent). Fall back to
 * range-space category buckets, then quantized domain.
 */
export function bucketStackedXKey(
  xCenterPx: number,
  categoryWidthPx: number,
  xDomain: number,
  categoryStep: number
): number {
  if (Number.isFinite(categoryStep) && categoryStep > 0 && Number.isFinite(xDomain)) {
    return Math.round(xDomain / categoryStep);
  }
  if (Number.isFinite(categoryWidthPx) && categoryWidthPx > 0 && Number.isFinite(xCenterPx)) {
    return Math.round(xCenterPx / categoryWidthPx);
  }
  return Math.round(xDomain * 1e6);
}

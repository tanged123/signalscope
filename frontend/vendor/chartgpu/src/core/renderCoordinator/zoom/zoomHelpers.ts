/**
 * Zoom helper utilities.
 * @module zoomHelpers
 */

import type { ZoomRange } from '../../../interaction/createZoomState';

/**
 * Full-span zoom check (0.5% edge tolerance). Single source of truth.
 */
export function isFullSpanZoom(zoomRange: ZoomRange | null | undefined): boolean {
  if (zoomRange == null) return true;
  const { start, end } = zoomRange;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
  const TOLERANCE = 0.5;
  return start <= TOLERANCE && end >= 100 - TOLERANCE;
}

import { paddedExtent } from "../app/plot-math";

interface Extent {
  min: number | null;
  max: number | null;
}

export function isUsableYRange(
  range: readonly [number, number] | null | undefined,
): range is [number, number] {
  if (range === null || range === undefined) return false;
  const [min, max] = range;
  return Number.isFinite(min) && Number.isFinite(max) && min < max;
}

/** Padded extent of the supplied bins, or null when none carry finite data. */
export function autoYRange(bins: readonly Extent[]): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const bin of bins) {
    if (bin.min !== null && Number.isFinite(bin.min)) {
      min = Math.min(min, bin.min);
    }
    if (bin.max !== null && Number.isFinite(bin.max)) {
      max = Math.max(max, bin.max);
    }
  }
  return paddedExtent(min, max);
}

/**
 * Resolve serialized user intent or a sticky view-local autoscale.
 *
 * Panning and time zoom do not change a latched automatic range. Changing the
 * panel's series set resets it; empty first frames never become the latch.
 */
export class YAxisPolicy {
  private key = "";
  private sticky: [number, number] | null = null;

  resolve(
    seriesKey: string,
    bins: () => readonly Extent[],
    serialized: readonly [number, number] | null,
  ): [number, number] {
    if (isUsableYRange(serialized)) return [serialized[0], serialized[1]];
    if (seriesKey !== this.key) {
      this.key = seriesKey;
      this.sticky = null;
    }
    this.sticky ??= autoYRange(bins());
    return this.sticky ?? [-1, 1];
  }

  reset(): void {
    this.key = "";
    this.sticky = null;
  }
}

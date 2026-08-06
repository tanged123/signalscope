export function isUsableYRange(
  range: readonly [number, number] | null | undefined,
): range is [number, number] {
  if (range === null || range === undefined) return false;
  const [min, max] = range;
  return Number.isFinite(min) && Number.isFinite(max) && min < max;
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
    automatic: () => readonly [number, number] | null,
    serialized: readonly [number, number] | null,
  ): [number, number] | null {
    if (isUsableYRange(serialized)) return [serialized[0], serialized[1]];
    if (seriesKey !== this.key) {
      this.key = seriesKey;
      this.sticky = null;
    }
    if (this.sticky === null) {
      const next = automatic();
      if (isUsableYRange(next)) this.sticky = [next[0], next[1]];
    }
    return this.sticky;
  }

  reset(): void {
    this.key = "";
    this.sticky = null;
  }
}

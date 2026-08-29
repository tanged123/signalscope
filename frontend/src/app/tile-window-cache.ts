import type { BinColumns, ColumnarTileResponse } from "./bin-columns";

export interface CachedPanelTiles {
  response: ColumnarTileResponse;
  window: { t0: number; t1: number };
  pixelWidth: number;
  requestedDevicePixels: number;
  idsKey: string;
}

export type TileCacheLookup =
  | { kind: "current"; response: ColumnarTileResponse }
  | { kind: "stale"; response: ColumnarTileResponse }
  | { kind: "miss" };

interface SeriesResolution {
  level: number;
  maxBinSpan: number;
}

type CacheEntry = CachedPanelTiles & {
  resolutions: readonly SeriesResolution[];
};

export class TileWindowCache {
  private readonly entries = new Map<string, CacheEntry>();

  static padWindow(t0: number, t1: number): { t0: number; t1: number } {
    const span = t1 - t0;
    if (!(span > 0) || !Number.isFinite(span)) return { t0, t1 };
    const grid = 2 ** Math.ceil(Math.log2(span));
    const start = Math.floor(t0 / grid) * grid;
    return { t0: start, t1: start + 2 * grid };
  }

  /**
   * The `pixel_width` a padded request must ask for so the visible slice
   * still carries the density the panel asked for. `padWindow` widens the
   * request 2x-4x; without this correction the sliced response renders at a
   * quarter to a half of pixel resolution and the trace reads as a staircase.
   */
  static requestPixelWidth(
    cssWidth: number,
    devicePixelRatio: number,
    visible: { t0: number; t1: number },
    padded: { t0: number; t1: number },
  ): number;
  static requestPixelWidth(
    cssWidth: number,
    visible: { t0: number; t1: number },
    padded: { t0: number; t1: number },
  ): number;
  static requestPixelWidth(
    cssWidth: number,
    devicePixelRatioOrVisible: number | { t0: number; t1: number },
    visibleOrPadded: { t0: number; t1: number },
    paddedArgument?: { t0: number; t1: number },
  ): number {
    const devicePixelRatio =
      typeof devicePixelRatioOrVisible === "number"
        ? devicePixelRatioOrVisible
        : 1;
    const visible =
      typeof devicePixelRatioOrVisible === "number"
        ? visibleOrPadded
        : devicePixelRatioOrVisible;
    const padded =
      typeof devicePixelRatioOrVisible === "number"
        ? paddedArgument
        : visibleOrPadded;
    if (padded === undefined) return Math.max(1, Math.ceil(cssWidth));
    const physical = Math.max(
      1,
      Math.ceil(
        Number.isFinite(cssWidth) && Number.isFinite(devicePixelRatio)
          ? cssWidth * devicePixelRatio
          : 1,
      ),
    );
    const visibleSpan = visible.t1 - visible.t0;
    const paddedSpan = padded.t1 - padded.t0;
    if (
      !Number.isFinite(visibleSpan) ||
      !Number.isFinite(paddedSpan) ||
      visibleSpan <= 0 ||
      paddedSpan <= visibleSpan
    ) {
      return physical;
    }
    return Math.ceil(physical * (paddedSpan / visibleSpan));
  }

  get(panelId: string): CachedPanelTiles | null {
    return this.entries.get(panelId) ?? null;
  }

  lookup(
    panelId: string,
    idsKey: string,
    visible: { t0: number; t1: number },
    devicePixelWidth: number,
  ): TileCacheLookup {
    const entry = this.entries.get(panelId);
    if (
      entry === undefined ||
      entry.idsKey !== idsKey ||
      visible.t0 < entry.window.t0 ||
      visible.t1 > entry.window.t1
    ) {
      return { kind: "miss" };
    }

    const pixels = Number.isFinite(devicePixelWidth)
      ? Math.max(1, Math.floor(devicePixelWidth))
      : 1;
    const visibleSpan = visible.t1 - visible.t0;
    const pixelSpan = visibleSpan / pixels;
    const current = entry.resolutions.every((resolution, index) => {
      if (resolution.level === 0) return true;
      const series = entry.response.series[index];
      return (
        series !== undefined &&
        Number.isFinite(pixelSpan) &&
        pixelSpan > 0 &&
        countVisibleBins(series.bins, visible) > pixels &&
        resolution.maxBinSpan <= pixelSpan
      );
    });
    return current
      ? { kind: "current", response: entry.response }
      : { kind: "stale", response: entry.response };
  }

  /**
   * Returns the padded response for a covered viewport by reference. The
   * presentation layer bounds itself by the visible window instead.
   */
  hit(
    panelId: string,
    idsKey: string,
    pixelWidth: number,
    t0: number,
    t1: number,
  ): ColumnarTileResponse | null {
    const entry = this.entries.get(panelId);
    if (
      entry === undefined ||
      entry.idsKey !== idsKey ||
      entry.pixelWidth !== pixelWidth ||
      t0 < entry.window.t0 ||
      t1 > entry.window.t1
    ) {
      return null;
    }
    return entry.response;
  }

  store(
    panelId: string,
    entry: CachedPanelTiles | Omit<CachedPanelTiles, "requestedDevicePixels">,
  ): void {
    const requestedDevicePixels =
      "requestedDevicePixels" in entry
        ? entry.requestedDevicePixels
        : Math.max(1, Math.ceil(entry.pixelWidth));
    this.entries.set(panelId, {
      ...entry,
      requestedDevicePixels,
      resolutions: entry.response.series.map((series) => ({
        level: series.level,
        maxBinSpan: maxBinSpan(series.bins),
      })),
    });
  }

  invalidate(panelId?: string): void {
    if (panelId === undefined) this.entries.clear();
    else this.entries.delete(panelId);
  }
}

function maxBinSpan(bins: BinColumns): number {
  let max = 0;
  for (let index = 0; index < bins.count; index += 1) {
    const span = (bins.t1[index] as number) - (bins.t0[index] as number);
    if (!Number.isFinite(span)) return Number.POSITIVE_INFINITY;
    max = Math.max(max, span);
  }
  return max;
}

function countVisibleBins(
  bins: BinColumns,
  visible: { t0: number; t1: number },
): number {
  const start = firstBinEndingAtOrAfter(bins, visible.t0);
  const end = firstBinStartingAfter(bins, visible.t1);
  return Math.max(0, end - start);
}

function firstBinEndingAtOrAfter(bins: BinColumns, t0: number): number {
  let low = 0;
  let high = bins.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((bins.t1[middle] as number) < t0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstBinStartingAfter(bins: BinColumns, t1: number): number {
  let low = 0;
  let high = bins.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((bins.t0[middle] as number) <= t1) low = middle + 1;
    else high = middle;
  }
  return low;
}

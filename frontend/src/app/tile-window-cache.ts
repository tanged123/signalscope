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

interface PanelEntries {
  overview: CacheEntry;
  detail: CacheEntry | null;
  current: CacheEntry;
}

export class TileWindowCache {
  private readonly entries = new Map<string, PanelEntries>();

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
  ): number {
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
    return this.entries.get(panelId)?.current ?? null;
  }

  lookup(
    panelId: string,
    idsKey: string,
    visible: { t0: number; t1: number },
    devicePixelWidth: number,
  ): TileCacheLookup {
    const pixels = Number.isFinite(devicePixelWidth)
      ? Math.max(1, Math.floor(devicePixelWidth))
      : 1;
    const visibleSpan = visible.t1 - visible.t0;
    const pixelSpan = visibleSpan / pixels;
    const candidates = this.coveringEntries(panelId, idsKey, visible);
    const current = candidates.find((entry) =>
      entry.resolutions.every((resolution, index) => {
        if (resolution.level === 0) return true;
        const series = entry.response.series[index];
        return (
          series !== undefined &&
          Number.isFinite(pixelSpan) &&
          pixelSpan > 0 &&
          countVisibleBins(series.bins, visible) > pixels &&
          resolution.maxBinSpan <= pixelSpan
        );
      }),
    );
    if (current !== undefined) {
      return { kind: "current", response: current.response };
    }
    const stale = candidates[0];
    return stale === undefined
      ? { kind: "miss" }
      : { kind: "stale", response: stale.response };
  }

  covering(
    panelId: string,
    idsKey: string,
    visible: { t0: number; t1: number },
  ): ColumnarTileResponse | null {
    return this.coveringEntries(panelId, idsKey, visible)[0]?.response ?? null;
  }

  coveringCurrent(
    panelId: string,
    visible: { t0: number; t1: number },
  ): ColumnarTileResponse | null {
    const entries = this.entries.get(panelId);
    return entries === undefined
      ? null
      : this.covering(panelId, entries.current.idsKey, visible);
  }

  store(
    panelId: string,
    entry: CachedPanelTiles | Omit<CachedPanelTiles, "requestedDevicePixels">,
  ): void {
    const requestedDevicePixels =
      "requestedDevicePixels" in entry
        ? entry.requestedDevicePixels
        : Math.max(1, Math.ceil(entry.pixelWidth));
    const cached: CacheEntry = {
      ...entry,
      requestedDevicePixels,
      resolutions: entry.response.series.map((series) => ({
        level: series.level,
        maxBinSpan: maxBinSpan(series.bins),
      })),
    };
    const existing = this.entries.get(panelId);
    if (existing === undefined || existing.overview.idsKey !== cached.idsKey) {
      this.entries.set(panelId, {
        overview: cached,
        detail: null,
        current: cached,
      });
      return;
    }
    const overviewSpan = windowSpan(existing.overview.window);
    const cachedSpan = windowSpan(cached.window);
    if (cachedSpan >= overviewSpan) {
      const detail =
        cachedSpan > overviewSpan
          ? (existing.detail ?? existing.overview)
          : existing.detail;
      this.entries.set(panelId, { overview: cached, detail, current: cached });
      return;
    }
    this.entries.set(panelId, {
      overview: existing.overview,
      detail: cached,
      current: cached,
    });
  }

  binCount(excludingPanelIds: ReadonlySet<string> = new Set()): number {
    let count = 0;
    for (const [panelId, entries] of this.entries) {
      if (excludingPanelIds.has(panelId)) continue;
      for (const entry of uniqueEntries(entries)) count += entryBinCount(entry);
    }
    return count;
  }

  retainedBinCount(replacingPanelIds: ReadonlySet<string>): number {
    let count = 0;
    for (const [panelId, entries] of this.entries) {
      const retained = uniqueEntries(entries).map(entryBinCount);
      count += replacingPanelIds.has(panelId)
        ? Math.max(0, ...retained)
        : retained.reduce((sum, bins) => sum + bins, 0);
    }
    return count;
  }

  invalidate(panelId?: string): void {
    if (panelId === undefined) this.entries.clear();
    else this.entries.delete(panelId);
  }

  private coveringEntries(
    panelId: string,
    idsKey: string,
    visible: { t0: number; t1: number },
  ): CacheEntry[] {
    const entries = this.entries.get(panelId);
    if (entries === undefined) return [];
    return uniqueEntries(entries)
      .filter(
        (entry) =>
          entry.idsKey === idsKey &&
          visible.t0 >= entry.window.t0 &&
          visible.t1 <= entry.window.t1,
      )
      .sort(
        (left, right) => windowSpan(left.window) - windowSpan(right.window),
      );
  }
}

function uniqueEntries(entries: PanelEntries): CacheEntry[] {
  return entries.detail === null || entries.detail === entries.overview
    ? [entries.overview]
    : [entries.detail, entries.overview];
}

function windowSpan(window: { t0: number; t1: number }): number {
  const span = window.t1 - window.t0;
  return Number.isFinite(span) && span > 0 ? span : 0;
}

function entryBinCount(entry: CacheEntry): number {
  return entry.response.series.reduce(
    (count, series) => count + series.bins.count,
    0,
  );
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

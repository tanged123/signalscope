import { sliceColumns, type ColumnarTileResponse } from "./bin-columns";

export interface CachedPanelTiles {
  response: ColumnarTileResponse;
  window: { t0: number; t1: number };
  pixelWidth: number;
  idsKey: string;
}

export class TileWindowCache {
  private readonly entries = new Map<string, CachedPanelTiles>();

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
    panelWidth: number,
    visible: { t0: number; t1: number },
    padded: { t0: number; t1: number },
  ): number {
    const visibleSpan = visible.t1 - visible.t0;
    const paddedSpan = padded.t1 - padded.t0;
    if (
      !Number.isFinite(visibleSpan) ||
      !Number.isFinite(paddedSpan) ||
      visibleSpan <= 0 ||
      paddedSpan <= visibleSpan
    ) {
      return panelWidth;
    }
    return Math.ceil(panelWidth * (paddedSpan / visibleSpan));
  }

  get(panelId: string): CachedPanelTiles | null {
    return this.entries.get(panelId) ?? null;
  }

  slice(
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
    const series = [];
    for (const tile of entry.response.series) {
      const start = firstOverlapping(tile.bins.t1, t0);
      const end = pastLastOverlapping(tile.bins.t0, t1);
      const sliceStart = Math.max(0, start - 1);
      const sliceEnd = Math.min(tile.bins.count, end + 1);
      if (sliceEnd - sliceStart > 4 * pixelWidth + 2) return null;
      series.push({
        ...tile,
        bins: sliceColumns(tile.bins, sliceStart, sliceEnd),
      });
    }
    return { ...entry.response, series };
  }

  store(panelId: string, entry: CachedPanelTiles): void {
    this.entries.set(panelId, entry);
  }

  invalidate(panelId?: string): void {
    if (panelId === undefined) this.entries.clear();
    else this.entries.delete(panelId);
  }
}

function firstOverlapping(t1: ArrayLike<number>, t0: number): number {
  let low = 0;
  let high = t1.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((t1[middle] as number) < t0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function pastLastOverlapping(t0: ArrayLike<number>, t1: number): number {
  let low = 0;
  let high = t0.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((t0[middle] as number) <= t1) low = middle + 1;
    else high = middle;
  }
  return low;
}

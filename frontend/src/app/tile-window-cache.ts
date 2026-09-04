import type { BinColumns, ColumnarTileResponse } from "./bin-columns";
import { lowerBound, upperBound } from "./binary-search";
import type { Line2DResponse } from "./line-binary";

export interface WindowBounds {
  readonly t0: number;
  readonly t1: number;
}

interface CachedWindowResponse<Response> {
  response: Response;
  window: WindowBounds;
  pixelWidth: number;
  requestedDevicePixels: number;
  idsKey: string;
}

export type CachedPanelTiles = CachedWindowResponse<ColumnarTileResponse>;

type WindowCacheLookup<Response> =
  | { kind: "current"; response: Response }
  | { kind: "stale"; response: Response }
  | { kind: "miss" };

interface WindowResponseResolution<Response> {
  readonly level: number;
  readonly maxSpan: number;
  readonly visibleCount: (response: Response, visible: WindowBounds) => number;
}

interface WindowResponseProfile<Response> {
  readonly resolutions: readonly WindowResponseResolution<Response>[];
  readonly resourceUnits: number;
}

interface WindowResponseAdapter<Response> {
  profile(response: Response): WindowResponseProfile<Response>;
}

interface CacheEntry<Response> extends CachedWindowResponse<Response> {
  readonly profile: WindowResponseProfile<Response>;
}

interface PanelEntries<Response> {
  readonly overview: CacheEntry<Response>;
  readonly detail: CacheEntry<Response> | null;
  readonly current: CacheEntry<Response>;
}

/**
 * Window-aware cache for one response family.
 *
 * Every panel retains one covering overview and its latest detail response.
 * Adapters provide the family-specific resolution and resource accounting, so
 * lookup and replacement semantics do not need to be reimplemented for each
 * plot transport.
 */
class WindowResponseCache<Response> {
  private readonly entries = new Map<string, PanelEntries<Response>>();

  constructor(private readonly adapter: WindowResponseAdapter<Response>) {}

  static padWindow(t0: number, t1: number): WindowBounds {
    return padWindow(t0, t1);
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
    visible: WindowBounds,
    padded: WindowBounds,
  ): number {
    return requestPixelWidth(cssWidth, devicePixelRatio, visible, padded);
  }

  get(panelId: string): CachedWindowResponse<Response> | null {
    return this.entries.get(panelId)?.current ?? null;
  }

  lookup(
    panelId: string,
    idsKey: string,
    visible: WindowBounds,
    devicePixelWidth: number,
  ): WindowCacheLookup<Response> {
    const pixels = Number.isFinite(devicePixelWidth)
      ? Math.max(1, Math.floor(devicePixelWidth))
      : 1;
    const visibleSpan = visible.t1 - visible.t0;
    const pixelSpan = visibleSpan / pixels;
    const candidates = this.coveringEntries(panelId, idsKey, visible);
    const current = candidates.find((entry) =>
      entry.profile.resolutions.every((resolution) => {
        if (resolution.level === 0) return true;
        return (
          Number.isFinite(pixelSpan) &&
          pixelSpan > 0 &&
          resolution.visibleCount(entry.response, visible) > pixels &&
          resolution.maxSpan <= pixelSpan
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
    visible: WindowBounds,
  ): Response | null {
    return this.coveringEntries(panelId, idsKey, visible)[0]?.response ?? null;
  }

  coveringCurrent(panelId: string, visible: WindowBounds): Response | null {
    const entries = this.entries.get(panelId);
    return entries === undefined
      ? null
      : this.covering(panelId, entries.current.idsKey, visible);
  }

  store(
    panelId: string,
    entry:
      | CachedWindowResponse<Response>
      | Omit<CachedWindowResponse<Response>, "requestedDevicePixels">,
  ): void {
    const requestedDevicePixels =
      "requestedDevicePixels" in entry
        ? entry.requestedDevicePixels
        : Math.max(1, Math.ceil(entry.pixelWidth));
    const cached: CacheEntry<Response> = {
      ...entry,
      requestedDevicePixels,
      profile: this.adapter.profile(entry.response),
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

  resourceUnitCount(
    excludingPanelIds: ReadonlySet<string> = new Set(),
  ): number {
    let count = 0;
    for (const [panelId, entries] of this.entries) {
      if (excludingPanelIds.has(panelId)) continue;
      for (const entry of uniqueEntries(entries))
        count += entry.profile.resourceUnits;
    }
    return count;
  }

  retainedResourceUnitCount(replacingPanelIds: ReadonlySet<string>): number {
    let count = 0;
    for (const [panelId, entries] of this.entries) {
      const retained = uniqueEntries(entries).map(
        (entry) => entry.profile.resourceUnits,
      );
      count += replacingPanelIds.has(panelId)
        ? Math.max(0, ...retained)
        : retained.reduce((sum, units) => sum + units, 0);
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
    visible: WindowBounds,
  ): CacheEntry<Response>[] {
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

export class TileWindowCache extends WindowResponseCache<ColumnarTileResponse> {
  constructor() {
    super(tileResponseAdapter);
  }

  static padWindow(t0: number, t1: number): WindowBounds {
    return padWindow(t0, t1);
  }

  static requestPixelWidth(
    cssWidth: number,
    devicePixelRatio: number,
    visible: WindowBounds,
    padded: WindowBounds,
  ): number {
    return requestPixelWidth(cssWidth, devicePixelRatio, visible, padded);
  }

  binCount(excludingPanelIds: ReadonlySet<string> = new Set()): number {
    return this.resourceUnitCount(excludingPanelIds);
  }

  retainedBinCount(replacingPanelIds: ReadonlySet<string>): number {
    return this.retainedResourceUnitCount(replacingPanelIds);
  }
}

export class Line2DWindowCache extends WindowResponseCache<Line2DResponse> {
  constructor() {
    super(line2DResponseAdapter);
  }

  static padWindow(t0: number, t1: number): WindowBounds {
    return padWindow(t0, t1);
  }

  static requestPixelWidth(
    cssWidth: number,
    devicePixelRatio: number,
    visible: WindowBounds,
    padded: WindowBounds,
  ): number {
    return requestPixelWidth(cssWidth, devicePixelRatio, visible, padded);
  }
}

const tileResponseAdapter: WindowResponseAdapter<ColumnarTileResponse> = {
  profile(response) {
    return {
      resolutions: response.series.map((series) => ({
        level: series.level,
        maxSpan: maxBinSpan(series.bins),
        visibleCount: (
          currentResponse: ColumnarTileResponse,
          visible: WindowBounds,
        ) => {
          const currentSeries = currentResponse.series.find(
            (candidate) => candidate.signalId === series.signalId,
          );
          return currentSeries === undefined
            ? 0
            : countVisibleBins(currentSeries.bins, visible);
        },
      })),
      resourceUnits: response.series.reduce(
        (count, series) => count + series.bins.count,
        0,
      ),
    };
  },
};

const line2DResponseAdapter: WindowResponseAdapter<Line2DResponse> = {
  profile(response) {
    return {
      resolutions: [
        {
          level: response.level,
          maxSpan: maxAnchorSpan(response.anchor),
          visibleCount: (
            currentResponse: Line2DResponse,
            visible: WindowBounds,
          ) => countVisibleAnchors(currentResponse.anchor, visible),
        },
      ],
      resourceUnits: response.anchor.length * (response.ys.length + 2),
    };
  },
};

function uniqueEntries<Response>(
  entries: PanelEntries<Response>,
): CacheEntry<Response>[] {
  return entries.detail === null || entries.detail === entries.overview
    ? [entries.overview]
    : [entries.detail, entries.overview];
}

function windowSpan(window: WindowBounds): number {
  const span = window.t1 - window.t0;
  return Number.isFinite(span) && span > 0 ? span : 0;
}

function padWindow(t0: number, t1: number): WindowBounds {
  const span = t1 - t0;
  if (!(span > 0) || !Number.isFinite(span)) return { t0, t1 };
  const grid = 2 ** Math.ceil(Math.log2(span));
  const start = Math.floor(t0 / grid) * grid;
  return { t0: start, t1: start + 2 * grid };
}

function requestPixelWidth(
  cssWidth: number,
  devicePixelRatio: number,
  visible: WindowBounds,
  padded: WindowBounds,
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

function maxBinSpan(bins: BinColumns): number {
  let max = 0;
  for (let index = 0; index < bins.count; index += 1) {
    const span = (bins.t1[index] as number) - (bins.t0[index] as number);
    if (!Number.isFinite(span)) return Number.POSITIVE_INFINITY;
    max = Math.max(max, span);
  }
  return max;
}

function countVisibleBins(bins: BinColumns, visible: WindowBounds): number {
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

function maxAnchorSpan(anchor: Float64Array): number {
  let max = 0;
  for (let index = 1; index < anchor.length; index += 1) {
    const span = (anchor[index] as number) - (anchor[index - 1] as number);
    if (!Number.isFinite(span)) return Number.POSITIVE_INFINITY;
    max = Math.max(max, span);
  }
  return max;
}

function countVisibleAnchors(
  anchor: Float64Array,
  visible: WindowBounds,
): number {
  if (!Number.isFinite(visible.t0) || !Number.isFinite(visible.t1)) return 0;
  const start = lowerBound(anchor, visible.t0);
  const end = upperBound(anchor, visible.t1);
  return Math.max(0, end - start);
}

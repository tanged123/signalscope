import type { BinColumns, ColumnarTileResponse } from "./bin-columns";
import type { PreparedTileBank, TileBankRole } from "./prepared-tile-bank";

export interface CachedPanelTiles {
  response: ColumnarTileResponse;
  window: { t0: number; t1: number };
  pixelWidth: number;
  requestedDevicePixels: number;
  idsKey: string;
}

export type BankLookup =
  | { kind: "current"; bank: PreparedTileBank }
  | { kind: "stale"; bank: PreparedTileBank }
  | { kind: "miss" };

export type TileCacheLookup =
  | { kind: "current"; response: ColumnarTileResponse }
  | { kind: "stale"; response: ColumnarTileResponse }
  | { kind: "miss" };

export interface CachedBankResidency {
  panelId: string;
  bankId: string;
  role: TileBankRole;
  cpuBytes: number;
  selected: boolean;
  pinned: boolean;
  lastUsed: number;
}

interface SeriesResolution {
  level: number;
  maxBinSpan: number;
}

interface CacheEntry {
  panelId: string;
  bank: PreparedTileBank;
  pinned: boolean;
  lastUsed: number;
  resolutions: readonly SeriesResolution[];
  legacy?: CachedPanelTiles;
}

type LegacyStoreEntry =
  | CachedPanelTiles
  | Omit<CachedPanelTiles, "requestedDevicePixels">;

export class TileWindowCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly selectedByPanel = new Map<string, string>();
  private clock = 0;

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

  lookup(
    panelId: string,
    role: TileBankRole,
    idsKey: string,
    visible: { t0: number; t1: number },
    density: number,
  ): BankLookup;
  lookup(
    panelId: string,
    idsKey: string,
    visible: { t0: number; t1: number },
    devicePixelWidth: number,
  ): TileCacheLookup;
  lookup(
    panelId: string,
    roleOrIdsKey: string,
    idsKeyOrVisible: string | { t0: number; t1: number },
    visibleOrPixelWidth: { t0: number; t1: number } | number,
    density?: number,
  ): BankLookup | TileCacheLookup {
    if (typeof idsKeyOrVisible === "string") {
      return this.lookupBank(
        panelId,
        roleOrIdsKey as TileBankRole,
        idsKeyOrVisible,
        visibleOrPixelWidth as { t0: number; t1: number },
        density ?? 1,
      );
    }
    return this.lookupLegacy(
      panelId,
      roleOrIdsKey,
      idsKeyOrVisible,
      visibleOrPixelWidth as number,
    );
  }

  overview(panelId: string, idsKey: string): PreparedTileBank | null {
    const candidate = this.entriesFor(panelId)
      .filter(
        (entry) =>
          entry.bank.role === "overview" && entry.bank.idsKey === idsKey,
      )
      .sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (candidate === undefined) return null;
    this.touch(candidate);
    return candidate.bank;
  }

  store(panelId: string, bank: PreparedTileBank, pinned: boolean): void;
  store(panelId: string, entry: LegacyStoreEntry): void;
  store(
    panelId: string,
    bankOrEntry: PreparedTileBank | LegacyStoreEntry,
    pinned = false,
  ): void {
    if (isPreparedTileBank(bankOrEntry)) {
      this.storeBank(panelId, bankOrEntry, pinned);
      return;
    }
    this.storeLegacy(panelId, bankOrEntry);
  }

  setSelected(panelId: string, bankId: string): void {
    const entry = this.entriesFor(panelId).find(
      (candidate) => candidate.bank.id === bankId,
    );
    if (entry === undefined) return;
    this.selectedByPanel.set(panelId, bankId);
    this.touch(entry);
  }

  cpuBytes(): number {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.bank.cpuBytes;
    return bytes;
  }

  residentBanks(): readonly CachedBankResidency[] {
    return [...this.entries.values()].map((entry) => ({
      panelId: entry.panelId,
      bankId: entry.bank.id,
      role: entry.bank.role,
      cpuBytes: entry.bank.cpuBytes,
      selected: this.selectedByPanel.get(entry.panelId) === entry.bank.id,
      pinned: entry.pinned,
      lastUsed: entry.lastUsed,
    }));
  }

  evictCpuBank(panelId: string, role: TileBankRole): PreparedTileBank | null {
    const selected = this.selectedByPanel.get(panelId);
    const candidate = this.entriesFor(panelId)
      .filter(
        (entry) =>
          entry.bank.role === role &&
          !entry.pinned &&
          entry.bank.id !== selected,
      )
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (candidate === undefined) return null;
    this.entries.delete(entryKey(panelId, candidate.bank.id));
    return candidate.bank;
  }

  evictCpu(
    bytesNeeded: number,
    activePanelIds: readonly string[],
  ): PreparedTileBank[] {
    if (!(bytesNeeded > 0)) return [];
    const active = new Set(activePanelIds);
    const candidates = [...this.entries.values()]
      .filter((entry) => {
        if (entry.pinned) return false;
        if (entry.bank.role === "overview" && active.has(entry.panelId)) {
          return false;
        }
        if (
          active.has(entry.panelId) &&
          this.selectedByPanel.get(entry.panelId) === entry.bank.id
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const categoryDelta =
          evictionCategory(a, active) - evictionCategory(b, active);
        return categoryDelta || a.lastUsed - b.lastUsed;
      });

    const evicted: PreparedTileBank[] = [];
    let freed = 0;
    for (const candidate of candidates) {
      if (freed >= bytesNeeded) break;
      this.entries.delete(entryKey(candidate.panelId, candidate.bank.id));
      evicted.push(candidate.bank);
      freed += candidate.bank.cpuBytes;
    }
    return evicted;
  }

  get(panelId: string): CachedPanelTiles | null {
    const entry = this.entriesFor(panelId).sort(
      (a, b) => b.lastUsed - a.lastUsed,
    )[0];
    if (entry === undefined) return null;
    return entry.legacy ?? legacyEntryFromBank(entry.bank);
  }

  hit(
    panelId: string,
    idsKey: string,
    pixelWidth: number,
    t0: number,
    t1: number,
  ): ColumnarTileResponse | null {
    const entry = this.entriesFor(panelId).find(
      (candidate) =>
        candidate.bank.idsKey === idsKey &&
        candidate.bank.requestedPixelWidth === pixelWidth &&
        t0 >= candidate.bank.window.t0 &&
        t1 <= candidate.bank.window.t1,
    );
    return entry?.bank.response ?? null;
  }

  invalidate(panelId?: string): void {
    if (panelId === undefined) {
      this.entries.clear();
      this.selectedByPanel.clear();
      return;
    }
    for (const entry of this.entriesFor(panelId)) {
      this.entries.delete(entryKey(panelId, entry.bank.id));
    }
    this.selectedByPanel.delete(panelId);
  }

  private lookupBank(
    panelId: string,
    role: TileBankRole,
    idsKey: string,
    visible: { t0: number; t1: number },
    density: number,
  ): BankLookup {
    const candidates = this.entriesFor(panelId)
      .filter(
        (entry) =>
          entry.bank.role === role &&
          entry.bank.idsKey === idsKey &&
          covers(entry.bank.window, visible),
      )
      .sort((a, b) => b.lastUsed - a.lastUsed);
    const current = candidates.find((entry) =>
      isCurrent(entry, visible, density),
    );
    if (current !== undefined) {
      this.touch(current);
      return { kind: "current", bank: current.bank };
    }
    const stale = candidates[0];
    if (stale === undefined) return { kind: "miss" };
    this.touch(stale);
    return { kind: "stale", bank: stale.bank };
  }

  private lookupLegacy(
    panelId: string,
    idsKey: string,
    visible: { t0: number; t1: number },
    devicePixelWidth: number,
  ): TileCacheLookup {
    const candidates = this.entriesFor(panelId)
      .filter(
        (entry) =>
          entry.legacy?.idsKey === idsKey &&
          entry.legacy.window.t0 <= visible.t0 &&
          entry.legacy.window.t1 >= visible.t1,
      )
      .sort((a, b) => b.lastUsed - a.lastUsed);
    const entry = candidates[0];
    if (entry === undefined) return { kind: "miss" };
    const pixels = Number.isFinite(devicePixelWidth)
      ? Math.max(1, Math.floor(devicePixelWidth))
      : 1;
    const visibleSpan = visible.t1 - visible.t0;
    const pixelSpan = visibleSpan / pixels;
    const current = entry.resolutions.every((resolution, index) => {
      if (resolution.level === 0) return true;
      const series = entry.bank.response.series[index];
      return (
        series !== undefined &&
        Number.isFinite(pixelSpan) &&
        pixelSpan > 0 &&
        countVisibleBins(series.bins, visible) > pixels &&
        resolution.maxBinSpan <= pixelSpan
      );
    });
    this.touch(entry);
    return current
      ? { kind: "current", response: entry.bank.response }
      : { kind: "stale", response: entry.bank.response };
  }

  private storeBank(
    panelId: string,
    bank: PreparedTileBank,
    pinned: boolean,
  ): void {
    this.entries.set(entryKey(panelId, bank.id), {
      panelId,
      bank,
      pinned,
      lastUsed: ++this.clock,
      resolutions: bank.response.series.map((series) => ({
        level: series.level,
        maxBinSpan: maxBinSpan(series.bins),
      })),
    });
  }

  private storeLegacy(panelId: string, entry: LegacyStoreEntry): void {
    const requestedDevicePixels =
      "requestedDevicePixels" in entry
        ? entry.requestedDevicePixels
        : Math.max(1, Math.ceil(entry.pixelWidth));
    const bank: PreparedTileBank = Object.freeze({
      id: `legacy:${panelId}:${++this.clock}`,
      role: "detail",
      response: entry.response,
      window: Object.freeze({ ...entry.window }),
      visibleWindow: Object.freeze({ ...entry.window }),
      idsKey: entry.idsKey,
      density: 2,
      requestedPixelWidth: requestedDevicePixels,
      feeds: Object.freeze([]),
      cpuBytes: responseBytes(entry.response),
    });
    this.entries.set(entryKey(panelId, bank.id), {
      panelId,
      bank,
      pinned: false,
      lastUsed: this.clock,
      resolutions: entry.response.series.map((series) => ({
        level: series.level,
        maxBinSpan: maxBinSpan(series.bins),
      })),
      legacy: {
        ...entry,
        requestedDevicePixels,
      },
    });
  }

  private entriesFor(panelId: string): CacheEntry[] {
    return [...this.entries.values()].filter(
      (entry) => entry.panelId === panelId,
    );
  }

  private touch(entry: CacheEntry): void {
    entry.lastUsed = ++this.clock;
  }
}

function isPreparedTileBank(
  value: PreparedTileBank | LegacyStoreEntry,
): value is PreparedTileBank {
  return "role" in value && "feeds" in value && "cpuBytes" in value;
}

function entryKey(panelId: string, bankId: string): string {
  return `${panelId}\u0000${bankId}`;
}

function covers(
  window: { t0: number; t1: number },
  visible: { t0: number; t1: number },
): boolean {
  return (
    Number.isFinite(visible.t0) &&
    Number.isFinite(visible.t1) &&
    visible.t0 >= window.t0 &&
    visible.t1 <= window.t1
  );
}

function isCurrent(
  entry: CacheEntry,
  visible: { t0: number; t1: number },
  density: number,
): boolean {
  if (entry.bank.density < normalizeDensity(density)) return false;
  const visibleSpan = visible.t1 - visible.t0;
  if (!(visibleSpan > 0) || !Number.isFinite(visibleSpan)) return false;
  const projectedBinSpan =
    visibleSpan / Math.max(1, entry.bank.requestedPixelWidth);
  return entry.resolutions.every((resolution) => {
    if (resolution.level === 0) return true;
    return (
      Number.isFinite(projectedBinSpan) &&
      projectedBinSpan > 0 &&
      resolution.maxBinSpan <= projectedBinSpan
    );
  });
}

function normalizeDensity(density: number): number {
  return Number.isFinite(density) && density > 0 ? density : 1;
}

function evictionCategory(entry: CacheEntry, active: Set<string>): number {
  if (active.has(entry.panelId) && entry.bank.role === "detail") return 0;
  if (!active.has(entry.panelId) && entry.bank.role === "detail") return 1;
  if (!active.has(entry.panelId) && entry.bank.role === "overview") return 2;
  return 3;
}

function legacyEntryFromBank(bank: PreparedTileBank): CachedPanelTiles {
  return {
    response: bank.response,
    window: bank.window,
    pixelWidth: bank.requestedPixelWidth,
    requestedDevicePixels: bank.requestedPixelWidth,
    idsKey: bank.idsKey,
  };
}

function responseBytes(response: ColumnarTileResponse): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const series of response.series) {
    const columns = series.bins;
    buffers.add(columns.t0.buffer);
    buffers.add(columns.t1.buffer);
    buffers.add(columns.first.buffer);
    buffers.add(columns.last.buffer);
    buffers.add(columns.min.buffer);
    buffers.add(columns.max.buffer);
    buffers.add(columns.sum.buffer);
    buffers.add(columns.sumSq.buffer);
    buffers.add(columns.sampleCount.buffer);
    buffers.add(columns.finiteCount.buffer);
    buffers.add(columns.flags.buffer);
  }
  let bytes = 0;
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
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

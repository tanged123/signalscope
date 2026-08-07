import type { ArenaSlice, GpuArena } from "./arena";
import type { PackedPointStream } from "../../app/tile-points";

export interface TileKey {
  readonly signalId: string;
  readonly level: number;
  readonly sourceStart: string;
  readonly generation: number;
}

export interface ResidencyTile extends TileKey {
  readonly sourceEnd: string;
  readonly origin: number;
  readonly seriesSlot: number;
  readonly coarse: boolean;
  readonly points: PackedPointStream;
}

export interface ResidentTile {
  readonly key: string;
  readonly points: ArenaSlice;
  readonly pointCount: number;
  readonly origin: number;
  readonly seriesSlot: number;
  readonly sourceStart: string;
  readonly sourceEnd: string;
  readonly coarse: boolean;
  readonly forceBreakFirst?: boolean;
  readonly breaks?: readonly boolean[];
}

interface Entry {
  resident: ResidentTile;
  visible: boolean;
  pinned: boolean;
  lastUsed: number;
}

export class GpuResidency {
  private readonly entries = new Map<string, Entry>();
  private readonly budgetBytes: number;
  private usedBytes = 0;
  private tick = 0;

  constructor(
    private readonly arena: GpuArena,
    options: { budgetBytes?: number } = {},
  ) {
    const minimum = arena.pageBytes * 2;
    this.budgetBytes =
      options.budgetBytes ??
      Math.max(minimum, Math.min(512 * 1024 * 1024, arena.pageBytes * 8));
  }

  upload(tile: ResidencyTile): ResidentTile {
    const key = tileKey(tile);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.lastUsed = ++this.tick;
      return existing.resident;
    }
    const slice = this.allocate(tile.points.bytes.byteLength);
    this.arena.write(slice, tile.points.bytes);
    const resident: ResidentTile = {
      key,
      points: slice,
      pointCount: tile.points.count,
      origin: tile.origin,
      seriesSlot: tile.seriesSlot,
      sourceStart: tile.sourceStart,
      sourceEnd: tile.sourceEnd,
      coarse: tile.coarse,
      forceBreakFirst: tile.points.forceBreakFirst,
      breaks: pointBreaks(tile.points),
    };
    this.entries.set(key, {
      resident,
      visible: true,
      pinned: tile.coarse,
      lastUsed: ++this.tick,
    });
    this.usedBytes += slice.size;
    return resident;
  }

  setVisible(key: string, visible: boolean): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      entry.visible = visible;
      entry.lastUsed = ++this.tick;
    }
  }

  pin(key: string, pinned: boolean): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) entry.pinned = pinned;
  }

  get(key: string): ResidentTile | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    entry.lastUsed = ++this.tick;
    return entry.resident;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  visible(): ResidentTile[] {
    return [...this.entries.values()]
      .filter((entry) => entry.visible)
      .sort(
        (left, right) => left.resident.seriesSlot - right.resident.seriesSlot,
      )
      .map((entry) => entry.resident);
  }

  clear(): void {
    for (const entry of this.entries.values())
      this.arena.release(entry.resident.points);
    this.entries.clear();
    this.usedBytes = 0;
  }

  private allocate(size: number): ArenaSlice {
    while (this.usedBytes + size > this.budgetBytes) {
      const candidate = [...this.entries.values()]
        .filter((entry) => !entry.pinned)
        .sort(
          (left, right) =>
            Number(left.visible) - Number(right.visible) ||
            left.lastUsed - right.lastUsed,
        )[0];
      if (candidate === undefined)
        throw new Error("GPU residency budget exhausted");
      this.entries.delete(candidate.resident.key);
      this.arena.release(candidate.resident.points);
      this.usedBytes -= candidate.resident.points.size;
    }
    return this.arena.allocate(size);
  }
}

export function tileKey(tile: TileKey): string {
  return `${tile.signalId}/${String(tile.level)}/${tile.sourceStart}/${String(tile.generation)}`;
}

function pointBreaks(points: ResidencyTile["points"]): boolean[] {
  const view = new DataView(
    points.bytes.buffer,
    points.bytes.byteOffset,
    points.bytes.byteLength,
  );
  return Array.from({ length: points.count }, (_, index) =>
    index === 0
      ? points.forceBreakFirst
      : (view.getUint32(index * 16 + 8, true) & 1) !== 0,
  );
}

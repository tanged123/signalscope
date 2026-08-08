import type { ArenaSlice, GpuArena } from "./arena";
import type { PackedPointStream } from "../../app/tile-points";
import type { GpuMetrics } from "./metrics";

export interface TileIdentity {
  readonly signalId: string;
  readonly level: number;
  readonly sourceStart: string;
  readonly sourceEnd: string;
}

export interface ResidencyTile extends TileIdentity {
  readonly origin: number;
  readonly seriesSlot: number;
  readonly coarse: boolean;
  readonly points: PackedPointStream;
}

export interface ResidencySelection {
  readonly generation: number;
  readonly keys: readonly string[];
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
  generation: number;
  coverageStart: number;
  coverageEnd: number;
  visible: boolean;
  pinned: boolean;
  lastUsed: number;
}

export class GpuResidency {
  private readonly entries = new Map<string, Entry>();
  private readonly budgetBytes: number;
  private usedBytes = 0;
  private tick = 0;
  private activeGeneration = -1;
  private selectedKeys = new Set<string>();

  constructor(
    private readonly arena: GpuArena,
    options: { budgetBytes?: number; metrics?: GpuMetrics } = {},
  ) {
    this.metrics = options.metrics;
    const minimum = arena.pageBytes * 2;
    this.budgetBytes =
      options.budgetBytes ??
      Math.max(minimum, Math.min(512 * 1024 * 1024, arena.pageBytes * 8));
  }

  private readonly metrics: GpuMetrics | undefined;

  upload(tile: ResidencyTile): ResidentTile {
    const [resident] = this.stage(0, [tile]);
    if (resident === undefined) throw new Error("GPU tile upload failed");
    this.select(0, [resident.key]);
    return resident;
  }

  uploadBatch(tiles: readonly ResidencyTile[]): ResidentTile[] {
    const staged = this.stage(0, tiles);
    const selected = this.select(
      0,
      staged.map((tile) => tile.key),
    );
    return [...selected];
  }

  stage(
    generation: number,
    tiles: readonly ResidencyTile[],
  ): readonly ResidentTile[] {
    if (generation < this.activeGeneration) return [];
    const incoming = uniqueTiles(tiles);
    const missing = incoming.filter((tile) => !this.entries.has(tileKey(tile)));
    const required = missing.reduce(
      (total, tile) => total + allocationSize(tile.points.bytes.byteLength),
      0,
    );
    this.makeRoom(required, generation);
    const staged: ResidentTile[] = [];
    for (const tile of incoming) {
      const key = tileKey(tile);
      const existing = this.entries.get(key);
      if (existing !== undefined) {
        existing.generation = generation;
        existing.lastUsed = ++this.tick;
        staged.push(existing.resident);
        continue;
      }
      const slice = this.arena.allocate(tile.points.bytes.byteLength);
      this.arena.write(slice, tile.points.bytes);
      this.metrics?.recordUpload(tile.points.bytes.byteLength);
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
        generation,
        coverageStart: streamPointTime(tile, 0),
        coverageEnd: streamPointTime(tile, tile.points.count - 1),
        visible: false,
        pinned: false,
        lastUsed: ++this.tick,
      });
      this.usedBytes += slice.size;
      this.metrics?.setResident(this.usedBytes, this.arena.pageCount);
      staged.push(resident);
    }
    this.activeGeneration = Math.max(this.activeGeneration, generation);
    return staged;
  }

  select(generation: number, keys: readonly string[]): readonly ResidentTile[] {
    if (generation < this.activeGeneration) return this.visible();
    const uniqueKeys = [...new Set(keys)];
    const entries = uniqueKeys.map((key) => this.entries.get(key));
    if (entries.some((entry) => entry === undefined)) return this.visible();
    for (const key of this.selectedKeys) {
      const entry = this.entries.get(key);
      if (entry !== undefined) entry.visible = false;
    }
    this.selectedKeys = new Set(uniqueKeys);
    for (const entry of entries) {
      if (entry === undefined) continue;
      entry.visible = true;
      entry.pinned = entry.resident.coarse;
      entry.generation = generation;
      entry.lastUsed = ++this.tick;
    }
    this.activeGeneration = generation;
    return entries.map((entry) => {
      if (entry === undefined)
        throw new Error("GPU residency selection changed");
      return entry.resident;
    });
  }

  discardGeneration(generation: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.generation !== generation || this.selectedKeys.has(key))
        continue;
      this.remove(key);
    }
  }

  covers(keys: readonly string[], t0: number, t1: number): boolean {
    if (!(t1 >= t0)) return false;
    return keys.every((key) => {
      const entry = this.entries.get(key);
      if (entry === undefined || !this.selectedKeys.has(key)) return false;
      return entry.coverageStart <= t0 && entry.coverageEnd >= t1;
    });
  }

  setVisible(key: string, visible: boolean): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      entry.visible = visible;
      if (visible) this.selectedKeys.add(key);
      else this.selectedKeys.delete(key);
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
    this.selectedKeys.clear();
    this.activeGeneration = -1;
    this.usedBytes = 0;
    this.metrics?.setResident(0, 0);
  }

  dropDevice(): void {
    this.entries.clear();
    this.selectedKeys.clear();
    this.activeGeneration = -1;
    this.usedBytes = 0;
    this.metrics?.setResident(0, 0);
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.arena.release(entry.resident.points);
    this.usedBytes -= entry.resident.points.size;
    this.metrics?.setResident(this.usedBytes, this.arena.pageCount);
  }

  private makeRoom(required: number, generation: number): void {
    if (required <= 0 || this.usedBytes + required <= this.budgetBytes) return;
    const candidates = [...this.entries.values()]
      .sort(
        (left, right) =>
          evictionRank(left, this.selectedKeys, generation) -
            evictionRank(right, this.selectedKeys, generation) ||
          left.lastUsed - right.lastUsed,
      )
      .filter(
        (entry) => evictionRank(entry, this.selectedKeys, generation) < 4,
      );
    let available = this.budgetBytes - this.usedBytes;
    const evictions: Entry[] = [];
    for (const candidate of candidates) {
      if (available >= required) break;
      evictions.push(candidate);
      available += candidate.resident.points.size;
    }
    if (available < required) {
      throw new Error("GPU residency batch exceeds panel budget");
    }
    for (const candidate of evictions) {
      this.remove(candidate.resident.key);
      this.selectedKeys.delete(candidate.resident.key);
    }
  }
}

export function tileKey(tile: TileIdentity): string {
  return `${tile.signalId}/${String(tile.level)}/${tile.sourceStart}`;
}

function uniqueTiles(tiles: readonly ResidencyTile[]): ResidencyTile[] {
  const result: ResidencyTile[] = [];
  const seen = new Set<string>();
  for (const tile of tiles) {
    if (tile.points.count === 0) continue;
    const key = tileKey(tile);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tile);
  }
  return result;
}

function allocationSize(bytes: number): number {
  return Math.max(256, Math.ceil(bytes / 256) * 256);
}

function evictionRank(
  entry: Entry,
  selectedKeys: ReadonlySet<string>,
  generation: number,
): number {
  if (entry.pinned) return 4;
  const selected = selectedKeys.has(entry.resident.key);
  const superseded = entry.generation !== generation;
  if (!selected && !entry.resident.coarse) return 0;
  if (!selected && entry.resident.coarse) return 1;
  if (selected && !entry.resident.coarse && superseded) return 2;
  if (selected && !entry.resident.coarse) return 3;
  return 4;
}

function streamPointTime(tile: ResidencyTile, index: number): number {
  const view = new DataView(
    tile.points.bytes.buffer,
    tile.points.bytes.byteOffset + index * 16,
    4,
  );
  return tile.origin + view.getFloat32(0, true);
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

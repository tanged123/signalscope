import type { ResidentTile } from "./residency";

export interface SegmentDescriptor {
  readonly firstPoint: number;
  readonly secondPoint: number;
  readonly seriesSlot: number;
  readonly sourceOrder: number;
}

export interface SegmentDirectory {
  readonly page: number;
  readonly pointOffset: number;
  readonly pointCount: number;
  readonly seriesSlot: number;
  readonly sourceStart: string;
  readonly breaks: readonly boolean[];
}

export interface PreparedDirectory extends SegmentDirectory {
  readonly candidates: SegmentDescriptor[];
}

export function prepareSegmentDirectories(
  directories: readonly SegmentDirectory[],
): PreparedDirectory[] {
  const sorted = [...directories].sort(
    (left, right) =>
      left.seriesSlot - right.seriesSlot ||
      compareU64(left.sourceStart, right.sourceStart) ||
      left.pointOffset - right.pointOffset,
  );
  let sourceOrder = 0;
  return sorted.map((directory) => {
    const candidates: SegmentDescriptor[] = [];
    for (let index = 0; index + 1 < directory.pointCount; index += 1) {
      if (directory.breaks[index + 1] === true) continue;
      candidates.push({
        firstPoint: directory.pointOffset + index,
        secondPoint: directory.pointOffset + index + 1,
        seriesSlot: directory.seriesSlot,
        sourceOrder,
      });
      sourceOrder += 1;
    }
    return { ...directory, candidates };
  });
}

export function directoryFromResident(tile: ResidentTile): SegmentDirectory {
  return {
    page: tile.points.page,
    pointOffset: tile.points.offset / 16,
    pointCount: tile.pointCount,
    seriesSlot: tile.seriesSlot,
    sourceStart: tile.sourceStart,
    breaks: tile.breaks ?? [],
  };
}

function compareU64(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

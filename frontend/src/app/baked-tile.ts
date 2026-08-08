import type { BakedLevel } from "../generated/protocol";
import {
  POINT_STRIDE,
  validatePointStream,
  type PackedPointStream,
} from "./tile-points";

export interface SlicedBakedTile {
  readonly sourceStart: string;
  readonly sourceEnd: string;
  readonly origin: number;
  readonly points: PackedPointStream;
}

export function sliceBakedTile(
  level: BakedLevel,
  startBin: number,
  endBin: number,
  t0: number,
  t1: number,
): SlicedBakedTile {
  const firstBin = Math.max(0, Math.min(level.bins.length, startBin));
  const lastBin = Math.max(firstBin, Math.min(level.bins.length, endBin));
  const width = level.level >= 64 ? 1n << 64n : 1n << BigInt(level.level);
  const rangeStart = BigInt(level.source_start) + BigInt(firstBin) * width;
  const computedEnd = BigInt(level.source_start) + BigInt(lastBin) * width;
  const levelEnd = BigInt(level.source_end);
  const rangeEnd = computedEnd < levelEnd ? computedEnd : levelEnd;
  const rangeIndexes = level.points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => {
      const sourceIndex = BigInt(point.source_index);
      return sourceIndex >= rangeStart && sourceIndex < rangeEnd;
    })
    .map(({ index }) => index);
  if (rangeIndexes.length === 0) {
    return {
      sourceStart: rangeStart.toString(),
      sourceEnd: rangeStart.toString(),
      origin: 0,
      points: emptyPoints(),
    };
  }
  let candidateStart = rangeIndexes[0] ?? 0;
  let candidateEnd = (rangeIndexes.at(-1) ?? -1) + 1;
  if (
    candidateStart > 0 &&
    (level.points[candidateStart - 1]?.time ?? Number.NEGATIVE_INFINITY) <= t0
  ) {
    candidateStart -= 1;
  }
  if (
    candidateEnd < level.points.length &&
    (level.points[candidateEnd]?.time ?? Number.POSITIVE_INFINITY) >= t1
  ) {
    candidateEnd += 1;
  }
  const candidates = level.points
    .slice(candidateStart, candidateEnd)
    .map((point, index) => ({ point, index: candidateStart + index }));

  if (candidates.length === 0) {
    return {
      sourceStart: rangeStart.toString(),
      sourceEnd: rangeStart.toString(),
      origin: 0,
      points: emptyPoints(),
    };
  }

  let start = candidates.findIndex(({ point }) => point.time >= t0);
  if (start < 0) start = candidates.length;
  start = Math.max(0, start - 1);
  let end = candidates.findIndex(({ point }) => point.time > t1);
  if (end < 0) end = candidates.length;
  end = Math.min(candidates.length, end + 1);

  const selected = candidates.slice(start, end);
  if (selected.length === 0) {
    return {
      sourceStart: rangeStart.toString(),
      sourceEnd: rangeStart.toString(),
      origin: 0,
      points: emptyPoints(),
    };
  }

  const origin = selected[0]?.point.time ?? 0;
  const bytes = new Uint8Array(selected.length * POINT_STRIDE);
  const view = new DataView(bytes.buffer);
  for (const [index, { point }] of selected.entries()) {
    const timeOffset = Math.fround(point.time - origin);
    const value = Math.fround(point.value);
    if (
      !Number.isFinite(point.time) ||
      !Number.isFinite(point.value) ||
      !Number.isFinite(timeOffset) ||
      !Number.isFinite(value)
    ) {
      throw new Error("baked point is not representable in packed form");
    }
    const offset = index * POINT_STRIDE;
    view.setFloat32(offset, timeOffset, true);
    view.setFloat32(offset + 4, value, true);
    view.setUint32(offset + 8, point.break_before ? 1 : 0, true);
  }
  const firstSource = BigInt(selected[0]?.point.source_index ?? "0");
  const lastSource = BigInt(
    selected[selected.length - 1]?.point.source_index ?? firstSource.toString(),
  );
  return {
    sourceStart: firstSource.toString(),
    sourceEnd: (lastSource + 1n).toString(),
    origin,
    points: {
      ...validatePointStream(bytes, selected.length),
      forceBreakFirst:
        (selected[0]?.index ?? 0) > 0 ||
        (selected[0]?.point.break_before ?? false),
    },
  };
}

function emptyPoints(): PackedPointStream {
  return { count: 0, bytes: new Uint8Array(), forceBreakFirst: false };
}

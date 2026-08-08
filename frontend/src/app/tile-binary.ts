import { PROTOCOL_VERSION } from "../generated/protocol";
import type { BinColumns, ColumnarTileResponse } from "./bin-columns";
import { POINT_STRIDE, validatePointStream } from "./tile-points";

if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
  throw new Error("big-endian host unsupported");
}

const MAGIC = 0x42545353;
const FIXED_SERIES_BYTES = 48;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function decodeTileResponse(
  buffer: ArrayBuffer,
  requestId: string,
): ColumnarTileResponse {
  const view = new DataView(buffer);
  if (view.byteLength < 16) {
    throw new Error("truncated tile binary header");
  }
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error("invalid tile binary magic");
  }
  const version = view.getUint32(4, true);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(
      `unsupported tile binary version ${String(version)}; expected ${String(PROTOCOL_VERSION)}`,
    );
  }
  const seriesCount = view.getUint32(8, true);
  if (view.getUint32(12, true) !== 0) {
    throw new Error("nonzero tile binary reserved header");
  }
  let offset = 16;
  const series: ColumnarTileResponse["series"] = [];
  for (let index = 0; index < seriesCount; index += 1) {
    need(view, offset, FIXED_SERIES_BYTES);
    const signalId = view.getBigUint64(offset, true).toString();
    const level = view.getUint32(offset + 8, true);
    const count = view.getUint32(offset + 12, true);
    const pointCount = view.getUint32(offset + 16, true);
    const pathLength = view.getUint16(offset + 20, true);
    const unitLength = view.getUint16(offset + 22, true);
    const sourceStart = view.getBigUint64(offset + 24, true).toString();
    const sourceEnd = view.getBigUint64(offset + 32, true).toString();
    const origin = view.getFloat64(offset + 40, true);
    if (BigInt(sourceStart) > BigInt(sourceEnd) || !Number.isFinite(origin)) {
      throw new Error("invalid tile source range or origin");
    }
    offset += FIXED_SERIES_BYTES;
    need(view, offset, pathLength + (unitLength === 0xffff ? 0 : unitLength));
    let path: string;
    try {
      path = UTF8.decode(new Uint8Array(buffer, offset, pathLength));
    } catch {
      throw new Error("signal path is not valid UTF-8");
    }
    offset += pathLength;
    let unit: string | null;
    if (unitLength === 0xffff) {
      unit = null;
    } else {
      try {
        unit = UTF8.decode(new Uint8Array(buffer, offset, unitLength));
      } catch {
        throw new Error("unit is not valid UTF-8");
      }
    }
    offset += unitLength === 0xffff ? 0 : unitLength;
    offset = align8AndValidate(view, offset);

    need(view, offset, count * 73);
    const columns: Omit<BinColumns, "count"> = {
      t0: floatColumn(buffer, view, offset, count),
      t1: floatColumn(buffer, view, offset + count * 8, count),
      first: floatColumn(buffer, view, offset + count * 16, count),
      last: floatColumn(buffer, view, offset + count * 24, count),
      min: floatColumn(buffer, view, offset + count * 32, count),
      max: floatColumn(buffer, view, offset + count * 40, count),
      sum: floatColumn(buffer, view, offset + count * 48, count),
      sumSq: floatColumn(buffer, view, offset + count * 56, count),
      sampleCount: new Uint32Array(buffer, offset + count * 64, count),
      finiteCount: new Uint32Array(
        buffer,
        offset + count * 64 + count * 4,
        count,
      ),
      flags: new Uint8Array(buffer, offset + count * 64 + count * 8, count),
    };
    for (const flags of columns.flags) {
      if ((flags & ~(1 | 2 | 4 | 8 | 16)) !== 0) {
        throw new Error("unknown tile bin flags");
      }
    }
    offset = align8AndValidate(view, offset + count * 73);
    need(view, offset, pointCount * POINT_STRIDE);
    const points = validatePointStream(
      new Uint8Array(buffer, offset, pointCount * POINT_STRIDE),
      pointCount,
    );
    offset = align8AndValidate(view, offset + pointCount * POINT_STRIDE);
    series.push({
      signalId,
      signalPath: path,
      unit,
      level,
      sourceStart,
      sourceEnd,
      origin,
      bins: { count, ...columns },
      points,
    });
  }
  if (offset !== view.byteLength) {
    throw new Error("trailing tile binary bytes");
  }
  return { requestId, series };
}

function floatColumn(
  buffer: ArrayBuffer,
  view: DataView,
  offset: number,
  count: number,
): Float64Array {
  if (offset % 8 !== 0) {
    throw new Error("unaligned tile binary float column");
  }
  need(view, offset, count * 8);
  return new Float64Array(buffer, offset, count);
}

function align8AndValidate(view: DataView, offset: number): number {
  const aligned = Math.ceil(offset / 8) * 8;
  need(view, offset, aligned - offset);
  for (let index = offset; index < aligned; index += 1) {
    if (view.getUint8(index) !== 0) {
      throw new Error("nonzero tile binary alignment padding");
    }
  }
  return aligned;
}

function need(view: DataView, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > view.byteLength
  ) {
    throw new Error("truncated tile binary payload");
  }
}

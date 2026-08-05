import { PROTOCOL_VERSION } from "../generated/protocol";
import type { BinColumns, ColumnarTileResponse } from "./bin-columns";

if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
  throw new Error("big-endian host unsupported");
}

const MAGIC = 0x42545353;
const FIXED_SERIES_BYTES = 24;

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
    const pathLength = view.getUint16(offset + 16, true);
    const unitLength = view.getUint16(offset + 18, true);
    if (view.getUint32(offset + 20, true) !== 0) {
      throw new Error("nonzero tile binary reserved series field");
    }
    offset += FIXED_SERIES_BYTES;
    need(view, offset, pathLength + (unitLength === 0xffff ? 0 : unitLength));
    const path = new TextDecoder().decode(
      new Uint8Array(buffer, offset, pathLength),
    );
    offset += pathLength;
    const unit =
      unitLength === 0xffff
        ? null
        : new TextDecoder().decode(new Uint8Array(buffer, offset, unitLength));
    offset += unitLength === 0xffff ? 0 : unitLength;
    offset = align8(offset);

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
    offset = align8(offset + count * 73);
    series.push({
      signalId,
      signalPath: path,
      unit,
      level,
      bins: { count, ...columns },
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

function align8(offset: number): number {
  return (offset + 7) & ~7;
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

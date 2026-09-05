/**
 * Decoded, correspondence-preserving Line2D data.
 *
 * The anchor column identifies the source row used to pair X and Y values;
 * it is not inferred from either plotted axis.
 */
export interface Line2DColumn {
  readonly signalId: string;
  readonly signalPath: string;
  readonly unit: string | null;
  readonly values: Float64Array;
}

export interface Line2DResponse {
  readonly requestId: string;
  readonly level: number;
  readonly anchor: Float64Array;
  readonly x: Line2DColumn;
  readonly ys: readonly Line2DColumn[];
}

const MAGIC = 0x324c5353;
const VERSION = 1;
const HEADER_BYTES = 24;
const METADATA_BYTES = 16;
const NO_UNIT = 0xffff;
const decoder = new TextDecoder("utf-8", { fatal: true });

if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
  throw new Error("big-endian host unsupported");
}

/** Decode the versioned little-endian Line2D response emitted by scope-server. */
export function decodeLineResponse(
  buffer: ArrayBuffer,
  requestId: string,
): Line2DResponse {
  const view = new DataView(buffer);
  if (view.byteLength < HEADER_BYTES) {
    throw new Error("truncated Line2D binary header");
  }

  let offset = 0;
  const magic = readU32(view, offset);
  offset += 4;
  if (magic !== MAGIC) {
    throw new Error(`invalid Line2D binary magic: ${String(magic)}`);
  }

  const version = readU32(view, offset);
  offset += 4;
  if (version !== VERSION) {
    throw new Error(
      `unsupported Line2D binary version ${String(version)}; expected ${String(VERSION)}`,
    );
  }

  const level = readU32(view, offset);
  offset += 4;
  const yCount = readU32(view, offset);
  offset += 4;
  if (yCount === 0) {
    throw new Error("Line2D response has no Y columns");
  }
  const rowCount = readU32(view, offset);
  offset += 4;
  if (readU32(view, offset) !== 0) {
    throw new Error("nonzero Line2D binary reserved header");
  }
  offset += 4;

  const metadataCount = checkedAdd(yCount, 1);
  const columnBytes = checkedMultiply(rowCount, 8);
  const columnCount = checkedAdd(yCount, 2);
  checkedMultiply(columnBytes, columnCount);
  need(view, offset, checkedMultiply(metadataCount, METADATA_BYTES));
  const xMetadata = readMetadata(view, buffer, offset);
  offset = xMetadata.offset;
  const yMetadata: Metadata[] = [];
  for (let index = 0; index < yCount; index += 1) {
    const metadata = readMetadata(view, buffer, offset);
    offset = metadata.offset;
    yMetadata.push(metadata.value);
  }

  const anchor = readF64s(view, buffer, offset, rowCount, columnBytes);
  offset += columnBytes;
  const xValues = readF64s(view, buffer, offset, rowCount, columnBytes);
  offset += columnBytes;
  const ys: Line2DColumn[] = [];
  for (const metadata of yMetadata) {
    const values = readF64s(view, buffer, offset, rowCount, columnBytes);
    offset += columnBytes;
    ys.push({ ...metadata, values });
  }

  if (offset !== view.byteLength) {
    throw new Error("trailing Line2D binary bytes");
  }

  return {
    requestId,
    level,
    anchor,
    x: { ...xMetadata.value, values: xValues },
    ys,
  };
}

interface Metadata {
  readonly signalId: string;
  readonly signalPath: string;
  readonly unit: string | null;
}

interface MetadataResult {
  readonly value: Metadata;
  readonly offset: number;
}

function readMetadata(
  view: DataView,
  buffer: ArrayBuffer,
  offset: number,
): MetadataResult {
  let at = offset;
  need(view, at, METADATA_BYTES);
  const signalId = view.getBigUint64(at, true).toString();
  const pathLength = view.getUint16(at + 8, true);
  const unitLength = view.getUint16(at + 10, true);
  if (view.getUint32(at + 12, true) !== 0) {
    throw new Error("nonzero Line2D binary reserved metadata field");
  }
  at += METADATA_BYTES;

  const unitBytes = unitLength === NO_UNIT ? 0 : unitLength;
  const metadataBytes = checkedAdd(pathLength, unitBytes);
  need(view, at, metadataBytes);
  const signalPath = decodeUtf8(buffer, at, pathLength, "signal path");
  at += pathLength;
  const unit =
    unitLength === NO_UNIT ? null : decodeUtf8(buffer, at, unitLength, "unit");
  at += unitBytes;
  const aligned = align8(at, view.byteLength);
  if (new Uint8Array(buffer, at, aligned - at).some((byte) => byte !== 0)) {
    throw new Error("nonzero Line2D binary metadata padding");
  }
  at = aligned;
  return {
    value: { signalId, signalPath, unit },
    offset: at,
  };
}

function readF64s(
  view: DataView,
  buffer: ArrayBuffer,
  offset: number,
  count: number,
  byteLength: number,
): Float64Array {
  if (offset % 8 !== 0) {
    throw new Error("unaligned Line2D binary float column");
  }
  need(view, offset, byteLength);
  return new Float64Array(buffer, offset, count);
}

function decodeUtf8(
  buffer: ArrayBuffer,
  offset: number,
  length: number,
  field: string,
): string {
  try {
    return decoder.decode(new Uint8Array(buffer, offset, length));
  } catch {
    throw new Error(`invalid UTF-8 Line2D binary ${field}`);
  }
}

function readU32(view: DataView, offset: number): number {
  need(view, offset, 4);
  return view.getUint32(offset, true);
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error("unsafe Line2D binary size/count math");
  }
  return result;
}

function checkedMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) {
    throw new Error("unsafe Line2D binary size/count math");
  }
  return result;
}

function align8(offset: number, length: number): number {
  const aligned = checkedAdd(offset, 7);
  const result = aligned - (aligned % 8);
  if (result > length) {
    throw new Error("truncated Line2D binary metadata");
  }
  return result;
}

function need(view: DataView, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    !Number.isSafeInteger(offset + length) ||
    offset + length > view.byteLength
  ) {
    throw new Error("truncated Line2D binary payload");
  }
}

export const POINT_STRIDE = 16;
export const BREAK_BEFORE = 1;

export interface PackedPointStream {
  readonly count: number;
  readonly bytes: Uint8Array;
  readonly forceBreakFirst: boolean;
}

export function pointTime(
  stream: PackedPointStream,
  origin: number,
  index: number,
): number {
  checkIndex(stream, index);
  return (
    origin +
    new DataView(
      stream.bytes.buffer,
      stream.bytes.byteOffset + index * POINT_STRIDE,
      4,
    ).getFloat32(0, true)
  );
}

export function pointValue(stream: PackedPointStream, index: number): number {
  checkIndex(stream, index);
  return new DataView(
    stream.bytes.buffer,
    stream.bytes.byteOffset + index * POINT_STRIDE + 4,
    4,
  ).getFloat32(0, true);
}

export function pointBreakBefore(
  stream: PackedPointStream,
  index: number,
): boolean {
  checkIndex(stream, index);
  if (index === 0 && stream.forceBreakFirst) return true;
  return (
    (new DataView(
      stream.bytes.buffer,
      stream.bytes.byteOffset + index * POINT_STRIDE + 8,
      4,
    ).getUint32(0, true) &
      BREAK_BEFORE) !==
    0
  );
}

export function slicePointStream(
  stream: PackedPointStream,
  origin: number,
  t0: number,
  t1: number,
): PackedPointStream {
  const start = firstAtOrAfter(stream, origin, t0);
  const end = firstAfter(stream, origin, t1);
  const sliceStart = Math.max(0, start - 1);
  const sliceEnd = Math.min(stream.count, end + 1);
  return {
    count: sliceEnd - sliceStart,
    bytes: stream.bytes.subarray(
      sliceStart * POINT_STRIDE,
      sliceEnd * POINT_STRIDE,
    ),
    forceBreakFirst:
      sliceStart > 0 || (sliceStart === 0 && stream.forceBreakFirst),
  };
}

export function validatePointStream(
  bytes: Uint8Array,
  count: number,
): PackedPointStream {
  if (
    count < 0 ||
    !Number.isSafeInteger(count) ||
    bytes.byteLength !== count * POINT_STRIDE
  ) {
    throw new Error("invalid tile point stream length");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index += 1) {
    const timeOffset = view.getFloat32(index * POINT_STRIDE, true);
    const value = view.getFloat32(index * POINT_STRIDE + 4, true);
    if (!Number.isFinite(timeOffset) || !Number.isFinite(value)) {
      throw new Error("nonfinite tile point value");
    }
    const flags = view.getUint32(index * POINT_STRIDE + 8, true);
    if ((flags & ~BREAK_BEFORE) !== 0) {
      throw new Error("unknown tile point flags");
    }
    if (view.getUint32(index * POINT_STRIDE + 12, true) !== 0) {
      throw new Error("nonzero tile point reserved word");
    }
  }
  return { count, bytes, forceBreakFirst: false };
}

function firstAtOrAfter(
  stream: PackedPointStream,
  origin: number,
  target: number,
): number {
  let low = 0;
  let high = stream.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pointTime(stream, origin, middle) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstAfter(
  stream: PackedPointStream,
  origin: number,
  target: number,
): number {
  let low = 0;
  let high = stream.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pointTime(stream, origin, middle) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function checkIndex(stream: PackedPointStream, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= stream.count) {
    throw new RangeError("tile point index out of range");
  }
}

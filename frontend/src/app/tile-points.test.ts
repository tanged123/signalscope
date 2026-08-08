import { describe, expect, it } from "vitest";
import {
  BREAK_BEFORE,
  POINT_STRIDE,
  pointBreakBefore,
  pointTime,
  pointValue,
  slicePointStream,
  validatePointStream,
} from "./tile-points";

function stream(): ReturnType<typeof validatePointStream> {
  const bytes = new Uint8Array(3 * POINT_STRIDE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 3; index += 1) {
    view.setFloat32(index * POINT_STRIDE, index + 0.25, true);
    view.setFloat32(index * POINT_STRIDE + 4, index * 2, true);
    view.setUint32(
      index * POINT_STRIDE + 8,
      index === 1 ? BREAK_BEFORE : 0,
      true,
    );
  }
  return validatePointStream(bytes, 3);
}

describe("packed tile points", () => {
  it("reads epoch-origin points without allocating point objects", () => {
    const points = stream();
    expect(pointTime(points, 1_700_000_000, 0)).toBeCloseTo(1_700_000_000.25);
    expect(pointValue(points, 2)).toBe(4);
    expect(pointBreakBefore(points, 1)).toBe(true);
    expect(points.bytes.buffer).toBe(points.bytes.buffer);
  });

  it("forces a break when a zero-copy slice starts mid-stream", () => {
    const points = stream();
    const sliced = slicePointStream(points, 0, 1.9, 2.1);
    expect(sliced.count).toBe(2);
    expect(sliced.forceBreakFirst).toBe(true);
    expect(pointBreakBefore(sliced, 0)).toBe(true);
  });

  it("rejects unknown flags and nonzero reserved words", () => {
    const bytes = new Uint8Array(POINT_STRIDE);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 2, true);
    expect(() => validatePointStream(bytes, 1)).toThrow(/flags/i);
    view.setUint32(8, 0, true);
    view.setUint32(12, 1, true);
    expect(() => validatePointStream(bytes, 1)).toThrow(/reserved/i);
  });

  it("rejects nonfinite packed point values", () => {
    const bytes = new Uint8Array(POINT_STRIDE);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, Number.NaN, true);
    expect(() => validatePointStream(bytes, 1)).toThrow(/finite/i);
    view.setFloat32(0, 0, true);
    view.setFloat32(4, Number.POSITIVE_INFINITY, true);
    expect(() => validatePointStream(bytes, 1)).toThrow(/finite/i);
  });
});

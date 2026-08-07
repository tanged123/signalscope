import { describe, expect, it } from "vitest";
import { HAS_GAP } from "./bin-columns";
import { adaptCanvasPoints } from "./canvas-point-adapter";
import { POINT_STRIDE, type PackedPointStream } from "./tile-points";

function points(
  values: readonly [number, number, boolean][],
): PackedPointStream {
  const bytes = new Uint8Array(values.length * POINT_STRIDE);
  const view = new DataView(bytes.buffer);
  values.forEach(([time, value, gap], index) => {
    view.setFloat32(index * POINT_STRIDE, time, true);
    view.setFloat32(index * POINT_STRIDE + 4, value, true);
    view.setUint32(index * POINT_STRIDE + 8, gap ? 1 : 0, true);
  });
  return { count: values.length, bytes, forceBreakFirst: false };
}

describe("adaptCanvasPoints", () => {
  it("turns packed points into degenerate renderer bins and preserves breaks", () => {
    const response = adaptCanvasPoints({
      requestId: "request-1",
      series: [
        {
          signalId: "7",
          signalPath: "vehicle/speed",
          unit: "m/s",
          level: 0,
          sourceStart: "0",
          sourceEnd: "3",
          origin: 10,
          bins: {
            count: 0,
            t0: new Float64Array(),
            t1: new Float64Array(),
            first: new Float64Array(),
            last: new Float64Array(),
            min: new Float64Array(),
            max: new Float64Array(),
            sum: new Float64Array(),
            sumSq: new Float64Array(),
            sampleCount: new Uint32Array(),
            finiteCount: new Uint32Array(),
            flags: new Uint8Array(),
          },
          points: points([
            [0, 2, false],
            [1, 4, true],
          ]),
        },
      ],
    });

    const bins = response.series[0]?.bins;
    expect(bins?.count).toBe(2);
    expect(Array.from(bins?.t0 ?? [])).toEqual([10, 11]);
    expect(Array.from(bins?.first ?? [])).toEqual([2, 4]);
    expect((bins?.flags[1] ?? 0) & HAS_GAP).toBe(HAS_GAP);
  });

  it("reuses the cached full point stream conversion", () => {
    const stream = points([[0, 2, false]]);
    const tile = {
      signalId: "7",
      signalPath: "vehicle/speed",
      unit: null,
      level: 0,
      sourceStart: "0",
      sourceEnd: "1",
      origin: 0,
      bins: {
        count: 0,
        t0: new Float64Array(),
        t1: new Float64Array(),
        first: new Float64Array(),
        last: new Float64Array(),
        min: new Float64Array(),
        max: new Float64Array(),
        sum: new Float64Array(),
        sumSq: new Float64Array(),
        sampleCount: new Uint32Array(),
        finiteCount: new Uint32Array(),
        flags: new Uint8Array(),
      },
      points: stream,
    };
    const first = adaptCanvasPoints({ requestId: "1", series: [tile] });
    const second = adaptCanvasPoints({ requestId: "2", series: [tile] });
    expect(second.series[0]?.bins).toBe(first.series[0]?.bins);
  });
});

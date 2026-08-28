import { describe, expect, it } from "vitest";

import type { BinColumns, ColumnarTileResponse } from "./bin-columns";
import { prepareTileBank } from "./prepared-tile-bank";

function columns(buffer: ArrayBuffer, byteOffset: number): BinColumns {
  const t0 = new Float64Array(buffer, byteOffset, 1);
  const t1 = new Float64Array(buffer, byteOffset + 8, 1);
  const first = new Float64Array(buffer, byteOffset + 16, 1);
  const last = new Float64Array(buffer, byteOffset + 24, 1);
  const min = new Float64Array(buffer, byteOffset + 32, 1);
  const max = new Float64Array(buffer, byteOffset + 40, 1);
  const sum = new Float64Array(buffer, byteOffset + 48, 1);
  const sumSq = new Float64Array(buffer, byteOffset + 56, 1);
  const sampleCount = new Uint32Array(buffer, byteOffset + 64, 1);
  const finiteCount = new Uint32Array(buffer, byteOffset + 68, 1);
  const flags = new Uint8Array(buffer, byteOffset + 72, 1);
  t0[0] = 0;
  t1[0] = 1;
  first[0] = 1;
  last[0] = 2;
  min[0] = 1;
  max[0] = 2;
  sum[0] = 3;
  sumSq[0] = 5;
  sampleCount[0] = 2;
  finiteCount[0] = 2;
  flags[0] = 15;
  return {
    count: 1,
    t0,
    t1,
    first,
    last,
    min,
    max,
    sum,
    sumSq,
    sampleCount,
    finiteCount,
    flags,
  };
}

function response(): ColumnarTileResponse {
  const buffer = new ArrayBuffer(160);
  return {
    requestId: "request-1",
    series: [
      {
        signalId: "1",
        signalPath: "run/value",
        unit: "V",
        level: 2,
        bins: columns(buffer, 0),
      },
      {
        signalId: "2",
        signalPath: "run/other",
        unit: "V",
        level: 2,
        bins: columns(buffer, 80),
      },
    ],
  };
}

describe("prepareTileBank", () => {
  it("counts a shared response buffer once and retains each prepared feed", () => {
    const tileResponse = response();
    const bank = prepareTileBank({
      id: "bank-1",
      role: "overview",
      response: tileResponse,
      window: { t0: 0, t1: 1 },
      visibleWindow: { t0: 0, t1: 1 },
      idsKey: "1\u00002",
      density: 2,
      requestedPixelWidth: 1,
    });

    expect(bank.feeds).toHaveLength(2);
    expect(bank.cpuBytes).toBe(
      160 + bank.feeds.reduce((sum, feed) => sum + feed.byteLength, 0),
    );
    expect(Object.isFrozen(bank)).toBe(true);
  });
});

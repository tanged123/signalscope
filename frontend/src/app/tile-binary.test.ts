import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import fixtureJson from "../../../protocol/testdata/tile-binary-conformance.json";
import { decodeTileResponse } from "./tile-binary";
import { wireBinFromColumns } from "./bin-columns";

interface BinaryFixtureSeries {
  readonly signal_id: string;
  readonly signal_path: string;
  readonly unit: string | null;
  readonly level: number;
  readonly bins: EnvelopeBin[];
}

interface BinaryFixture {
  readonly request_id: string;
  readonly series: BinaryFixtureSeries[];
}

const fixture = fixtureJson as BinaryFixture;
const fixtureBytes = readFileSync(
  new URL(
    "../../../protocol/testdata/tile-binary-conformance.bin",
    import.meta.url,
  ),
);
const fixtureBuffer = new ArrayBuffer(fixtureBytes.byteLength);
new Uint8Array(fixtureBuffer).set(fixtureBytes);

describe("decodeTileResponse", () => {
  it("matches the Rust binary conformance fixture", () => {
    const response = decodeTileResponse(fixtureBuffer, fixture.request_id);
    expect(response.requestId).toBe(fixture.request_id);
    expect(response.series).toHaveLength(fixture.series.length);
    for (const [index, actual] of response.series.entries()) {
      const expected = fixture.series[index] as BinaryFixtureSeries;
      expect(actual.signalId).toBe(expected.signal_id);
      expect(actual.signalPath).toBe(expected.signal_path);
      expect(actual.unit).toBe(expected.unit);
      expect(actual.level).toBe(expected.level);
      expect(actual.bins.count).toBe(expected.bins.length);
      expect(
        Array.from({ length: actual.bins.count }, (_, binIndex) =>
          wireBinFromColumns(actual.bins, binIndex),
        ),
      ).toEqual(expected.bins);
    }
  });

  it("rejects a wrong protocol version", () => {
    const bytes = new Uint8Array(fixtureBuffer.slice(0));
    new DataView(bytes.buffer).setUint32(4, 999, true);
    expect(() => decodeTileResponse(bytes.buffer, fixture.request_id)).toThrow(
      /version/i,
    );
  });

  it("rejects invalid UTF-8 in signal metadata", () => {
    const bytes = new Uint8Array(fixtureBuffer.slice(0));
    bytes[64] = 0xff;
    expect(() => decodeTileResponse(bytes.buffer, fixture.request_id)).toThrow(
      /utf-8/i,
    );
  });

  it("rejects reversed source ranges and nonfinite origins", () => {
    const reversed = new Uint8Array(fixtureBuffer.slice(0));
    new DataView(reversed.buffer).setBigUint64(40, 999n, true);
    expect(() =>
      decodeTileResponse(reversed.buffer, fixture.request_id),
    ).toThrow(/source range/i);

    const nonfiniteOrigin = new Uint8Array(fixtureBuffer.slice(0));
    new DataView(nonfiniteOrigin.buffer).setFloat64(56, Number.NaN, true);
    expect(() =>
      decodeTileResponse(nonfiniteOrigin.buffer, fixture.request_id),
    ).toThrow(/source range/i);
  });

  it("rejects unknown flags and nonzero alignment padding", () => {
    const flags = new Uint8Array(fixtureBuffer.slice(0));
    flags[36080] = 0x80;
    expect(() => decodeTileResponse(flags.buffer, fixture.request_id)).toThrow(
      /flags/i,
    );

    const padding = new Uint8Array(fixtureBuffer.slice(0));
    padding[36580] = 1;
    expect(() =>
      decodeTileResponse(padding.buffer, fixture.request_id),
    ).toThrow(/padding/i);
  });
});

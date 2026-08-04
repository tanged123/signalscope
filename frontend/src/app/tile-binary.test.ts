import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EnvelopeBin, TileResponse } from "../generated/protocol";
import fixtureJson from "../../../protocol/testdata/tile-binary-conformance.json";
import { decodeTileResponse } from "./tile-binary";
import { wireBinFromColumns } from "./bin-columns";

const fixture = fixtureJson as TileResponse;
const fixtureBytes = readFileSync(
  new URL(
    "../../../protocol/testdata/tile-binary-conformance.bin",
    import.meta.url,
  ),
);
const fixtureBuffer = fixtureBytes.buffer.slice(
  fixtureBytes.byteOffset,
  fixtureBytes.byteOffset + fixtureBytes.byteLength,
);

describe("decodeTileResponse", () => {
  it("matches the Rust binary conformance fixture", () => {
    const response = decodeTileResponse(fixtureBuffer, fixture.request_id);
    expect(response.requestId).toBe(fixture.request_id);
    expect(response.series).toHaveLength(fixture.series.length);
    for (const [index, actual] of response.series.entries()) {
      const expected = fixture.series[index] as NonNullable<
        TileResponse["series"][number]
      >;
      expect(actual.signalId).toBe(expected.signal_id);
      expect(actual.signalPath).toBe(expected.signal_path);
      expect(actual.unit).toBe(expected.unit);
      expect(actual.level).toBe(expected.level);
      expect(actual.bins.count).toBe(expected.bins.length);
      expect(
        Array.from({ length: actual.bins.count }, (_, binIndex) =>
          wireBinFromColumns(actual.bins, binIndex),
        ),
      ).toEqual(expected.bins as EnvelopeBin[]);
    }
  });

  it("rejects a wrong protocol version", () => {
    const bytes = new Uint8Array(fixtureBuffer.slice(0));
    new DataView(bytes.buffer).setUint32(4, 999, true);
    expect(() => decodeTileResponse(bytes.buffer, fixture.request_id)).toThrow(
      /version/i,
    );
  });
});

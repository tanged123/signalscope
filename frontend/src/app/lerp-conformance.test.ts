import { describe, expect, it } from "vitest";

import fixtureJson from "../../../protocol/testdata/lerp-conformance.json";
import { lerpSample } from "./csv-export";

interface LerpFixture {
  time: number[];
  values: number[];
  queries: number[];
  results: number[];
}

const fixture = fixtureJson as LerpFixture;

describe("CSV interpolation conformance", () => {
  it("matches the Rust lerp_at fixture", () => {
    for (const [index, query] of fixture.queries.entries()) {
      expect(lerpSample(fixture.time, fixture.values, query)).toBeCloseTo(
        fixture.results[index] ?? Number.NaN,
        12,
      );
    }
  });
});

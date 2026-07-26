import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { queryPyramid } from "./pyramid-query";
import fixtureJson from "../../../protocol/testdata/pyramid-conformance.json";

interface Fixture {
  levels: EnvelopeBin[][];
  queries: {
    t0: number;
    t1: number;
    pixel_width: number;
    level: number;
    bins: EnvelopeBin[];
  }[];
}

const fixture = fixtureJson as Fixture;

describe("queryPyramid", () => {
  it("matches the Rust implementation on every fixture query", () => {
    for (const query of fixture.queries) {
      expect(
        queryPyramid(fixture.levels, query.t0, query.t1, query.pixel_width),
      ).toEqual({ level: query.level, bins: query.bins });
    }
  });

  it("includes one neighboring bin on each viewport edge", () => {
    const level = [0, 1, 2, 3, 4].map(
      (time) =>
        ({
          t0: time,
          t1: time,
          first: time,
          last: time,
          min: time,
          max: time,
          has_gap: false,
        }) as EnvelopeBin,
    );
    const result = queryPyramid([level], 1.5, 2.5, 100);

    expect(result.bins.map((bin) => bin.t0)).toEqual([1, 2, 3]);
  });
});

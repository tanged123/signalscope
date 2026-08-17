import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { queryPyramid, queryRawPyramidRange } from "./pyramid-query";
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

  it("honors a per-series bin budget", () => {
    const levels = [
      Array.from(
        { length: 100 },
        (_, time) =>
          ({
            t0: time,
            t1: time,
            first: time,
            last: time,
            min: time,
            max: time,
            has_gap: false,
          }) as EnvelopeBin,
      ),
      Array.from(
        { length: 25 },
        (_, time) =>
          ({
            t0: time * 4,
            t1: time * 4 + 3,
            first: time,
            last: time,
            min: time,
            max: time,
            has_gap: false,
          }) as EnvelopeBin,
      ),
      Array.from(
        { length: 5 },
        (_, time) =>
          ({
            t0: time * 20,
            t1: time * 20 + 19,
            first: time,
            last: time,
            min: time,
            max: time,
            has_gap: false,
          }) as EnvelopeBin,
      ),
    ];

    const result = queryPyramid(levels, 0, 99, 100, 10);

    expect(result.level).toBe(2);
    expect(result.bins.length).toBe(5);
  });

  it("selects the raw level with neighbouring bins regardless of coarse levels", () => {
    const levelZero = Array.from(
      { length: 100 },
      (_, time) =>
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
    const levels = [
      levelZero,
      [
        {
          t0: 0,
          t1: 99,
          first: 0,
          last: 99,
          min: 0,
          max: 99,
          has_gap: false,
        } as EnvelopeBin,
      ],
    ];

    expect(queryRawPyramidRange(levels, 20, 79)).toEqual({
      level: 0,
      start: 19,
      end: 81,
    });
  });
});

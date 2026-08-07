import { describe, expect, it } from "vitest";
import type { BakedLevel, EnvelopeBin } from "../generated/protocol";
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

  it("keeps raw bins when they fit the viewport density", () => {
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

    const result = queryPyramid(levels, 0, 99, 100);

    expect(result.level).toBe(0);
    expect(result.bins.length).toBe(100);
  });

  it("uses serialized level identities instead of array positions", () => {
    const raw = Array.from(
      { length: 8 },
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
    const coarse = [0, 4].map(
      (time) =>
        ({
          t0: time,
          t1: time + 3,
          first: time,
          last: time + 3,
          min: time,
          max: time + 3,
          has_gap: false,
        }) as EnvelopeBin,
    );
    const levels: BakedLevel[] = [
      {
        level: 0,
        source_start: "0",
        source_end: "8",
        origin: 0,
        bins: raw,
        points: [],
      },
      {
        level: 3,
        source_start: "0",
        source_end: "8",
        origin: 0,
        bins: coarse,
        points: [],
      },
    ];

    expect(queryPyramid(levels, 0, 7, 1)).toEqual({
      level: 3,
      bins: coarse,
    });
  });
});

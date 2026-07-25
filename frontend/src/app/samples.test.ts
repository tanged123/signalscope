import fixtureJson from "../../../protocol/testdata/sample-conformance.json";
import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { binsToSamples, sampleWindow } from "./samples";

interface Fixture {
  time: number[];
  values: number[];
  queries: {
    t0: number;
    t1: number;
    max_points: number;
    stride: number;
    time: number[];
    values: number[];
  }[];
}

const fixture = fixtureJson as Fixture;

describe("sampleWindow", () => {
  it("matches the Rust implementation on every fixture query", () => {
    for (const query of fixture.queries) {
      expect(
        sampleWindow(
          fixture.time,
          fixture.values,
          query.t0,
          query.t1,
          query.max_points,
        ),
      ).toEqual({
        time: query.time,
        values: query.values,
        stride: query.stride,
      });
    }
  });

  it("returns nothing for windows wholly outside the data", () => {
    for (const [t0, t1] of [
      [50, 60],
      [-60, -50],
    ] as const) {
      expect(sampleWindow([0, 1, 2], [0, 1, 2], t0, t1, 32)).toEqual({
        time: [],
        values: [],
        stride: 1,
      });
    }
  });
});

describe("binsToSamples", () => {
  it("reads level-0 bins as raw samples and preserves gaps", () => {
    const bin = (time: number, value: number | null): EnvelopeBin => ({
      t0: time,
      t1: time,
      first: value,
      last: value,
      min: value,
      max: value,
      sum: value ?? 0,
      sum_sq: value === null ? 0 : value * value,
      finite_count: value === null ? "0" : "1",
      sample_count: "1",
      has_gap: value === null,
    });
    const samples = binsToSamples([bin(0, 5), bin(1, null), bin(2, 7)]);
    expect(samples.time).toEqual([0, 1, 2]);
    expect(samples.values[0]).toBe(5);
    expect(Number.isNaN(samples.values[1])).toBe(true);
    expect(samples.values[2]).toBe(7);
  });
});

import fixtureJson from "../../../protocol/testdata/sample-conformance.json";
import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import type { SampleResponse } from "../generated/protocol";
import { binsToSamples, mergeSampleResponses, sampleWindow } from "./samples";

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

describe("mergeSampleResponses", () => {
  it("replaces coarse overlap with visible-window detail", () => {
    const response = (
      request_id: string,
      time: number[],
      values: number[],
      stride: number,
    ): SampleResponse => ({
      request_id,
      series: [
        {
          signal_id: "1",
          signal_path: "demo/value",
          unit: null,
          time,
          values,
          stride,
        },
      ],
    });
    const merged = mergeSampleResponses(
      response("coarse", [0, 5, 10, 15, 20], [0, 5, 10, 15, 20], 5),
      response("detail", [8, 9, 10, 11, 12], [80, 90, 100, 110, 120], 1),
    );
    expect(merged.request_id).toBe("detail");
    expect(merged.series[0]?.time).toEqual([0, 5, 8, 9, 10, 11, 12, 15, 20]);
    expect(merged.series[0]?.values).toEqual([
      0, 5, 80, 90, 100, 110, 120, 15, 20,
    ]);
    expect(merged.series[0]?.stride).toBe(1);
  });
});

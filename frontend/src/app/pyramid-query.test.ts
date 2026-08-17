import { describe, expect, it } from "vitest";
import type { EnvelopeBin } from "../generated/protocol";
import { queryRawPyramidRange } from "./pyramid-query";

describe("queryRawPyramidRange", () => {
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

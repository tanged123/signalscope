import { describe, expect, it } from "vitest";
import { policyFor } from "./plot-capabilities";
import { resolveRanges } from "./plot-gestures";

describe("resolveRanges", () => {
  it("uses stored histogram ranges instead of its automatic edge span", () => {
    expect(
      resolveRanges(
        policyFor("histogram"),
        { x: [2, 4], y: [1, 3] },
        { x: [0, 10], y: [0, 8] },
        { t0: 20, t1: 30 },
      ),
    ).toEqual({
      x: { min: 2, max: 4 },
      y: { min: 1, max: 3 },
    });
  });

  it("uses the linked window for a linked-time x axis", () => {
    expect(
      resolveRanges(
        policyFor("time"),
        { x: [2, 4], y: [-2, 2] },
        { x: [0, 10], y: [-8, 8] },
        { t0: 20, t1: 30 },
      ),
    ).toEqual({
      x: { min: 20, max: 30 },
      y: { min: -2, max: 2 },
    });
  });

  it("re-reads a supplied automatic range when no stored range exists", () => {
    expect(
      resolveRanges(
        policyFor("xy"),
        { x: null, y: null },
        { x: [1, 5], y: [2, 8] },
        { t0: 20, t1: 30 },
      ),
    ).toEqual({
      x: { min: 1, max: 5 },
      y: { min: 2, max: 8 },
    });
  });

  it("returns null when either required range is unavailable", () => {
    expect(
      resolveRanges(
        policyFor("histogram"),
        { x: null, y: null },
        { x: null, y: [0, 8] },
        { t0: 20, t1: 30 },
      ),
    ).toBeNull();
    expect(
      resolveRanges(
        policyFor("histogram"),
        { x: null, y: null },
        { x: [0, 10], y: null },
        { t0: 20, t1: 30 },
      ),
    ).toBeNull();
  });
});

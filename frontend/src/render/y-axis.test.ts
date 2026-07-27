import { describe, expect, it } from "vitest";
import { isUsableYRange, YAxisPolicy } from "./y-axis";

const automatic: readonly [number, number] = [-50, 120];

describe("isUsableYRange", () => {
  it("accepts a finite ordered pair", () => {
    expect(isUsableYRange([-100, 300])).toBe(true);
  });

  it("rejects degenerate, inverted, and non-finite cases", () => {
    expect(isUsableYRange([5, 5])).toBe(false);
    expect(isUsableYRange([300, -100])).toBe(false);
    expect(isUsableYRange([Number.NaN, 1])).toBe(false);
    expect(isUsableYRange([0, Number.POSITIVE_INFINITY])).toBe(false);
    expect(isUsableYRange(null)).toBe(false);
  });
});

describe("YAxisPolicy", () => {
  it("uses a usable serialized range verbatim", () => {
    const policy = new YAxisPolicy();
    expect(policy.resolve("a", () => automatic, [-100, 300])).toEqual([
      -100, 300,
    ]);
  });

  it("ignores a serialized range that cannot be rendered", () => {
    const policy = new YAxisPolicy();
    expect(policy.resolve("a", () => automatic, [5, 5])).not.toEqual([5, 5]);
    expect(policy.resolve("a", () => automatic, [300, -100])).not.toEqual([
      300, -100,
    ]);
  });

  it("holds the autoscale as visible data changes", () => {
    const policy = new YAxisPolicy();
    const first = policy.resolve("a", () => [0, 1], null);
    const second = policy.resolve("a", () => [-900, 900], null);
    expect(second).toEqual(first);
  });

  it("refits when the series set changes", () => {
    const policy = new YAxisPolicy();
    const first = policy.resolve("a", () => [0, 1], null);
    const second = policy.resolve("a|b", () => [-900, 900], null);
    expect(second).not.toEqual(first);
  });

  it("does not latch onto an empty first frame", () => {
    const policy = new YAxisPolicy();
    policy.resolve("a", () => null, null);
    const settled = policy.resolve("a", () => [0, 10], null);
    expect(settled?.[1]).toBeGreaterThan(9);
  });

  it("does not compute the automatic range when serialized range is usable", () => {
    const policy = new YAxisPolicy();
    let calls = 0;
    expect(
      policy.resolve(
        "a",
        () => {
          calls += 1;
          return automatic;
        },
        [-100, 300],
      ),
    ).toEqual([-100, 300]);
    expect(calls).toBe(0);
  });
});

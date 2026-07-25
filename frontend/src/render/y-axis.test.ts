import { describe, expect, it } from "vitest";
import { autoYRange, isUsableYRange, YAxisPolicy } from "./y-axis";

const bins = [{ min: -50, max: 120 }];

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

describe("autoYRange", () => {
  it("pads the observed extent", () => {
    const range = autoYRange(bins);
    expect(range?.[0]).toBeLessThan(-50);
    expect(range?.[1]).toBeGreaterThan(120);
  });

  it("widens a flat signal instead of collapsing", () => {
    const range = autoYRange([{ min: 7, max: 7 }]);
    expect(range?.[0]).toBeLessThan(7);
    expect(range?.[1]).toBeGreaterThan(7);
  });

  it("returns null when nothing finite was observed", () => {
    expect(autoYRange([])).toBeNull();
    expect(autoYRange([{ min: null, max: null }])).toBeNull();
    expect(autoYRange([{ min: Number.NaN, max: Number.NaN }])).toBeNull();
  });
});

describe("YAxisPolicy", () => {
  it("uses a usable serialized range verbatim", () => {
    const policy = new YAxisPolicy();
    expect(policy.resolve("a", () => bins, [-100, 300])).toEqual([-100, 300]);
  });

  it("ignores a serialized range that cannot be rendered", () => {
    const policy = new YAxisPolicy();
    expect(policy.resolve("a", () => bins, [5, 5])).not.toEqual([5, 5]);
    expect(policy.resolve("a", () => bins, [300, -100])).not.toEqual([
      300, -100,
    ]);
  });

  it("holds the autoscale as visible data changes", () => {
    const policy = new YAxisPolicy();
    const first = policy.resolve("a", () => [{ min: 0, max: 1 }], null);
    const second = policy.resolve("a", () => [{ min: -900, max: 900 }], null);
    expect(second).toEqual(first);
  });

  it("refits when the series set changes", () => {
    const policy = new YAxisPolicy();
    const first = policy.resolve("a", () => [{ min: 0, max: 1 }], null);
    const second = policy.resolve("a|b", () => [{ min: -900, max: 900 }], null);
    expect(second).not.toEqual(first);
  });

  it("does not latch onto an empty first frame", () => {
    const policy = new YAxisPolicy();
    policy.resolve("a", () => [{ min: null, max: null }], null);
    const settled = policy.resolve("a", () => [{ min: 0, max: 10 }], null);
    expect(settled[1]).toBeGreaterThan(9);
  });
});

import { describe, expect, it } from "vitest";
import { histogram } from "./histogram";

describe("histogram", () => {
  it("shares edges across series and counts each separately", () => {
    const result = histogram([
      [0, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [5, 5, 5, 6, 7, 8, 9, 10, 10, 10, 10, 10, 10, 10],
    ]);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.edges[0]).toBe(0);
    expect(result.edges[result.edges.length - 1]).toBe(10);
    expect(result.counts).toHaveLength(2);
    expect(result.counts[0]).toHaveLength(result.edges.length - 1);
    const total = (result.counts[0] ?? []).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(14);
  });

  it("clamps the bin count into its bounds", () => {
    const many = Array.from({ length: 5000 }, (_, index) => index);
    const result = histogram([many]);
    expect(result).not.toBeNull();
    if (result === null) return;
    const bins = result.edges.length - 1;
    expect(bins).toBeGreaterThanOrEqual(8);
    expect(bins).toBeLessThanOrEqual(128);
  });

  it("widens a constant column so it still has a domain", () => {
    const result = histogram([[4, 4, 4, 4]]);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.edges[0]).toBeLessThan(4);
    expect(result.edges[result.edges.length - 1]).toBeGreaterThan(4);
  });

  it("ignores non-finite values and returns null when nothing is left", () => {
    expect(histogram([[Number.NaN, Number.POSITIVE_INFINITY]])).toBeNull();
    const mixed = histogram([[1, Number.NaN, 3]]);
    expect(mixed).not.toBeNull();
    expect((mixed?.counts[0] ?? []).reduce((sum, n) => sum + n, 0)).toBe(2);
  });
});

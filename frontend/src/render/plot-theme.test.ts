// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  COLOR_SLOTS,
  SERIES_TOKENS,
  formatTicks,
  hueIndex,
  invalidatePalette,
  resolvePalette,
  ticks,
} from "./plot-theme";

describe("plot theme", () => {
  it("wraps hues into the categorical slot range", () => {
    expect(hueIndex(1)).toBe(0);
    expect(hueIndex(COLOR_SLOTS + 1)).toBe(0);
    expect(hueIndex(0)).toBe(0);
  });

  it("generates and formats ticks", () => {
    expect(ticks(0, 10, 6).length).toBeGreaterThan(0);
    expect(formatTicks([0, 1])).toHaveLength(2);
  });

  it("uses a visible range to keep singleton tick labels distinct", () => {
    expect(formatTicks([323.1], { min: 323, max: 323.2 })).toEqual(["323.100"]);
    expect(formatTicks([1.04], { min: 1, max: 1.1 })).toEqual(["1.040"]);
  });

  it("adjusts range-aware precision as the visible range changes", () => {
    expect(formatTicks([323.1], { min: 323, max: 323.2 })[0]).toBe("323.100");
    expect(formatTicks([323.1], { min: 323, max: 333 })[0]).toBe("323.1");
  });

  it("preserves signs and readable notation at scale extremes", () => {
    expect(formatTicks([-12], { min: -20, max: 20 })).toEqual(["−12"]);
    expect(formatTicks([1_000_000], { min: 0, max: 2_000_000 })).toEqual([
      "1.0e+6",
    ]);
    expect(formatTicks([0.0005], { min: 0, max: 0.001 })).toEqual(["5.0e-4"]);
  });

  it("resolves a palette with one entry per series token and caches it", () => {
    invalidatePalette();
    const first = resolvePalette();
    expect(first.series).toHaveLength(SERIES_TOKENS.length);
    expect(resolvePalette()).toBe(first);
    invalidatePalette();
    expect(resolvePalette()).not.toBe(first);
  });
});

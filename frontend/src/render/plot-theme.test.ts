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

  it("resolves a palette with one entry per series token and caches it", () => {
    invalidatePalette();
    const first = resolvePalette();
    expect(first.series).toHaveLength(SERIES_TOKENS.length);
    expect(resolvePalette()).toBe(first);
    invalidatePalette();
    expect(resolvePalette()).not.toBe(first);
  });
});

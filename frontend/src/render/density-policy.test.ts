import { describe, expect, it } from "vitest";
import { densityMode } from "./density-policy";

describe("densityMode", () => {
  // 250_000 / N vs deviceWidth / 2. At deviceWidth 2956 (1478 CSS × 2 DPR)
  // the boundary sits at N = 250_000 / 1478 ≈ 169.
  it("strokes while the per-series allocation holds a bin per 2 device px", () => {
    expect(densityMode(1, 2956)).toBe("strokes");
    expect(densityMode(100, 2956)).toBe("strokes");
    expect(densityMode(169, 2956)).toBe("strokes");
  });

  it("switches to the raster once the budget starves resolution", () => {
    expect(densityMode(170, 2956)).toBe("raster");
    expect(densityMode(1000, 2956)).toBe("raster");
  });

  it("scales the boundary with panel width", () => {
    // Narrow panel: allocation 250 for N=1000 is >= 400/2, so strokes.
    expect(densityMode(1000, 400)).toBe("strokes");
    expect(densityMode(1000, 600)).toBe("raster");
  });

  it("the 64-bin floor keeps huge panels in raster, and degenerate inputs stroke", () => {
    expect(densityMode(10_000, 2956)).toBe("raster");
    expect(densityMode(0, 2956)).toBe("strokes");
    expect(densityMode(10, 0)).toBe("strokes");
  });
});

import { describe, expect, it } from "vitest";
import { countNonBackgroundPixels } from "./measure";

function rgba(
  ...pixels: readonly (readonly [number, number, number, number])[]
): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels.flatMap((pixel) => pixel));
}

describe("plot pixel evidence", () => {
  it("does not count a uniform plot background", () => {
    expect(
      countNonBackgroundPixels(rgba([14, 17, 22, 255], [14, 17, 22, 255]), [
        [14, 17, 22],
        [21, 25, 32],
      ]),
    ).toBe(0);
  });

  it("counts the exact colored trajectory pixels", () => {
    expect(
      countNonBackgroundPixels(
        rgba(
          [14, 17, 22, 255],
          [0, 114, 189, 255],
          [1, 113, 188, 255],
          [14, 17, 22, 255],
        ),
        [[14, 17, 22]],
      ),
    ).toBe(2);
  });
});

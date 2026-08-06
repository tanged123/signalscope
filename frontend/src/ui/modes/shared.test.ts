import { describe, expect, it } from "vitest";
import { colorIndexForHue, yLabel } from "./shared";

describe("shared render helpers", () => {
  it("colorIndexForHue maps hues onto the palette slots", () => {
    expect(colorIndexForHue(1)).toBe(0);
    expect(colorIndexForHue(null)).toBe(colorIndexForHue(1));
  });

  it("yLabel joins distinct units", () => {
    expect(typeof yLabel(["V", "V"])).toBe("string");
    expect(yLabel(["V", "V"])).toContain("V");
  });
});

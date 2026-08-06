import { describe, expect, it } from "vitest";
import { MODE_DATA } from "./contract";

describe("MODE_DATA", () => {
  it("declares the two-pipeline split from the spec", () => {
    expect(MODE_DATA.time).toEqual({ reduction: "envelope", windows: [] });
    expect(MODE_DATA.xy).toEqual({
      reduction: "samples",
      windows: ["context", "visible"],
    });
    expect(MODE_DATA.fft).toEqual({
      reduction: "samples",
      windows: ["visible"],
    });
    expect(MODE_DATA.histogram).toEqual({
      reduction: "samples",
      windows: ["visible"],
    });
  });

  it("covers every panel mode", () => {
    expect(Object.keys(MODE_DATA).sort()).toEqual([
      "fft",
      "histogram",
      "time",
      "xy",
    ]);
  });
});

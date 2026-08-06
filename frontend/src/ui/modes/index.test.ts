import { describe, expect, it } from "vitest";
import { MODE_DATA } from "./contract";
import { plotModeModule } from "./index";

describe("plotModeModule", () => {
  it("returns the module for every mode with matching declarations", () => {
    for (const mode of ["time", "xy", "fft", "histogram"] as const) {
      const module = plotModeModule(mode);
      expect(module.mode).toBe(mode);
      expect(module.data).toEqual(MODE_DATA[mode]);
    }
  });
});

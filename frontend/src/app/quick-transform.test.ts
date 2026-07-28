import { describe, expect, it } from "vitest";

import { quickTransform } from "./quick-transform";

describe("quickTransform", () => {
  it("uses the full source path to avoid basename collisions", () => {
    expect(quickTransform("imu/x", "gradient")[0]).toBe("derived/imu_x_dot");
    expect(quickTransform("gps/x", "gradient")[0]).toBe("derived/gps_x_dot");
  });

  it("quotes apostrophes in untrusted signal paths", () => {
    expect(quickTransform("pilot's/x", "gradient")).toEqual([
      "derived/pilot_s_x_dot",
      "gradient('pilot''s/x')",
    ]);
  });

  it("quotes moving-average inputs too", () => {
    expect(quickTransform("pilot's/x", "movmean")[1]).toBe(
      "movmean('pilot''s/x', 51)",
    );
  });
});

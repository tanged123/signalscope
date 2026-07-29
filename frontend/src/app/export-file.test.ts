import { describe, expect, it } from "vitest";

import { exportFileStem } from "./export-file";

describe("exportFileStem", () => {
  it("removes separators and control characters from panel titles", () => {
    expect(exportFileStem(" imu/accel\\raw\n ", "panel-1")).toBe(
      "imu-accel-raw",
    );
  });

  it("falls back to the panel id when the title becomes empty", () => {
    expect(exportFileStem("/\n\\", "panel-1")).toBe("panel-1");
  });
});

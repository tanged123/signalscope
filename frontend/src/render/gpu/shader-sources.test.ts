import { describe, expect, it } from "vitest";
import { PRODUCTION_SHADERS } from "./shader-sources";

describe("production shaders", () => {
  it("registers every renderer and picker module exactly once", () => {
    expect(PRODUCTION_SHADERS.map((shader) => shader.label)).toEqual([
      "grid",
      "line-quad",
      "line-hairline",
      "segment-flags",
      "scan-blocks",
      "scan-add",
      "segment-scatter",
      "indirect-args",
      "pick-series",
      "pick-reduce",
    ]);
  });
});

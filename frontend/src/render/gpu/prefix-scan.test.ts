import { describe, expect, it, vi } from "vitest";
import { exclusiveScan, scanDispatchPlan } from "./prefix-scan";

describe("GPU prefix scan", () => {
  it("matches the stable CPU exclusive scan reference", () => {
    expect(exclusiveScan([1, 0, 1, 1])).toEqual({
      values: [0, 1, 1, 2],
      total: 3,
    });
    expect(exclusiveScan([])).toEqual({ values: [], total: 0 });
  });

  it.each([0, 1, 255, 256, 257, 65_535, 65_536])(
    "plans bounded recursive passes for %i values",
    (length) => {
      const plan = scanDispatchPlan(length);
      expect(plan.every((pass) => pass.workgroups <= 256)).toBe(true);
      if (length === 0) expect(plan).toEqual([]);
      else expect(plan[0]?.kind).toBe("scan-blocks");
    },
  );

  it("does not dispatch a zero-length scan", () => {
    const encoder = {
      dispatchWorkgroups: vi.fn(),
    } as unknown as GPUComputePassEncoder;
    expect(scanDispatchPlan(0)).toHaveLength(0);
    void encoder;
  });
});

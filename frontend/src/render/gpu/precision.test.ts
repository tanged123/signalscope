import { describe, expect, it } from "vitest";
import { projectEpoch, splitF64 } from "./precision";

describe("GPU projection precision", () => {
  it.each([1_700_000_000, 1_700_000_000_000])(
    "keeps epoch projection near the f64 reference at %f",
    (origin) => {
      const [high, low] = splitF64(origin);
      expect(Number.isFinite(high)).toBe(true);
      expect(Number.isFinite(low)).toBe(true);
      for (const span of [1, 1e-3, 1e-6]) {
        const time = origin + span;
        const actual = projectEpoch(time, origin, 7680, 4);
        const expected = (time - origin) * 7680 * 4;
        expect(Math.abs(actual - expected)).toBeLessThan(0.25);
      }
    },
  );
});

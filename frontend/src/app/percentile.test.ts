import { expect, test } from "vitest";
import { percentile } from "./percentile";

test("percentile uses a zero-based nearest-rank index", () => {
  const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
  expect(percentile(sorted, 0.95)).toBe(95);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
});

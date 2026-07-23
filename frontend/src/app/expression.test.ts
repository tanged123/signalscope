import { describe, expect, it } from "vitest";

import { parseExpressionReferences, validateExpression } from "./expression";

describe("expression parsing", () => {
  it("matches prototype signal and transform references", () => {
    expect(
      parseExpressionReferences(
        'Math.hypot($("imu/ax"), smooth("imu/ay", 25))',
      ),
    ).toEqual([
      { operation: "$", path: "imu/ax", window: null },
      { operation: "smooth", path: "imu/ay", window: 25 },
    ]);
  });

  it("rejects host access", () => {
    expect(() => validateExpression('fetch($("imu/ax"))')).toThrow(
      "unsupported syntax",
    );
  });
});

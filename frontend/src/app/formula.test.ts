import { describe, expect, it } from "vitest";

import { parseFormulaInput } from "./formula";

describe("parseFormulaInput", () => {
  it("splits a name from an expression at the first equals sign", () => {
    expect(parseFormulaInput("derived/speed = 'a/x' * 2", 1)).toEqual({
      path: "derived/speed",
      expr: "'a/x' * 2",
    });
  });

  it("keeps equality operators in the expression", () => {
    expect(parseFormulaInput("derived/eq = 'a/x' == 2", 1)).toEqual({
      path: "derived/eq",
      expr: "'a/x' == 2",
    });
  });

  it("generates a name when none is given", () => {
    expect(parseFormulaInput("gradient('a/x')", 4)).toEqual({
      path: "derived/expr_4",
      expr: "gradient('a/x')",
    });
  });

  it("rejects blank input", () => {
    expect(parseFormulaInput("   ", 1)).toBeNull();
    expect(parseFormulaInput("derived/x =   ", 1)).toBeNull();
  });
});

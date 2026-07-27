import { describe, expect, it } from "vitest";

import {
  formulaAssignmentSeparator,
  insertSignalReference,
  parseFormulaInput,
  quoteSignalPath,
} from "./formula";

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
    expect(formulaAssignmentSeparator("derived/x = 'a/x' == 2")).toBe(10);
    expect(formulaAssignmentSeparator("'a/x' >= 2")).toBe(-1);
    expect(formulaAssignmentSeparator("'a=x' * 2")).toBe(-1);
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

describe("signal reference edits", () => {
  it("quotes a full path and doubles embedded apostrophes", () => {
    expect(quoteSignalPath("demo/attitude/pitch_deg")).toBe(
      "'demo/attitude/pitch_deg'",
    );
    expect(quoteSignalPath(`pilot's/"pitch"`)).toBe(`'pilot''s/"pitch"'`);
  });

  it("inserts at the caret and leaves the caret after the reference", () => {
    expect(insertSignalReference("derived/x =  * 2", "a/x", 12, 12)).toEqual({
      text: "derived/x = 'a/x' * 2",
      caret: 17,
    });
  });

  it("replaces a selection", () => {
    expect(
      insertSignalReference("derived/x = replace + 1", "a/y", 12, 19),
    ).toEqual({
      text: "derived/x = 'a/y' + 1",
      caret: 17,
    });
  });

  it("supports repeated signal drops", () => {
    const first = insertSignalReference("derived/x = hypot(, )", "a/x", 18, 18);
    expect(
      insertSignalReference(
        first.text,
        "a/y",
        first.caret + 2,
        first.caret + 2,
      ),
    ).toEqual({
      text: "derived/x = hypot('a/x', 'a/y')",
      caret: 30,
    });
  });
});

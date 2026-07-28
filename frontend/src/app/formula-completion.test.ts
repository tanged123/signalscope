import { describe, expect, it } from "vitest";

import {
  applyCompletion,
  completionContext,
  formulaCompletions,
} from "./formula-completion";

describe("completionContext", () => {
  it("completes identifiers only on the expression side", () => {
    expect(completionContext("derived/x = gra", 15, false)).toEqual({
      source: "language",
      query: "gra",
      start: 12,
      end: 15,
    });
    expect(completionContext("derived/gra = 'a/x'", 11, true)).toBeNull();
  });

  it("searches inside either quote style", () => {
    expect(completionContext("derived/x = 'pitch", 18, false)).toEqual({
      source: "signal",
      query: "pitch",
      start: 12,
      end: 18,
    });
    expect(completionContext('derived/x = "att', 16, false)).toEqual({
      source: "signal",
      query: "att",
      start: 12,
      end: 16,
    });
  });

  it("unescapes doubled delimiters in an open signal reference", () => {
    expect(completionContext("derived/x = 'pilot''s/pi", 25, false)).toEqual({
      source: "signal",
      query: "pilot's/pi",
      start: 12,
      end: 24,
    });
  });

  it("opens an empty language list only when requested", () => {
    expect(completionContext("derived/x = ", 12, false)).toBeNull();
    expect(completionContext("derived/x = ", 12, true)).toEqual({
      source: "language",
      query: "",
      start: 12,
      end: 12,
    });
  });
});

describe("formulaCompletions", () => {
  it("ranks prefix signal matches before substring matches and caps results", () => {
    const signals = [
      "demo/pitch_rate",
      "demo/target_pitch",
      ...Array.from(
        { length: 60 },
        (_, index) => `other/value_${String(index)}_pitch`,
      ),
    ];
    const context = {
      source: "signal" as const,
      query: "pitch",
      start: 0,
      end: 0,
    };
    const matches = formulaCompletions(context, signals);
    expect(matches[0]?.label).toBe("demo/pitch_rate");
    expect(matches[1]?.label).toBe("demo/target_pitch");
    expect(matches).toHaveLength(50);
  });

  it("describes language entries and applies call shapes", () => {
    const context = {
      source: "language" as const,
      query: "mov",
      start: 12,
      end: 15,
    };
    const completion = formulaCompletions(context, [])[0];
    if (completion === undefined) throw new Error("expected completion");
    expect(completion).toMatchObject({
      label: "movmean",
      detail: "moving mean",
      replacement: "movmean(, 51)",
    });
    expect(applyCompletion("derived/x = mov", context, completion)).toEqual({
      text: "derived/x = movmean(, 51)",
      caret: 20,
    });
  });

  it("offers radian and degree conversion functions", () => {
    const context = {
      source: "language" as const,
      query: "rad2",
      start: 12,
      end: 16,
    };
    expect(formulaCompletions(context, [])[0]).toMatchObject({
      label: "rad2deg",
      detail: "radians to degrees",
      replacement: "rad2deg()",
      caretOffset: 8,
    });

    expect(
      formulaCompletions({ ...context, query: "deg2" }, [])[0],
    ).toMatchObject({
      label: "deg2rad",
      detail: "degrees to radians",
      replacement: "deg2rad()",
      caretOffset: 8,
    });
  });

  it("replaces an existing closing delimiter with a quoted signal path", () => {
    const context = completionContext("derived/x = 'old' + 1", 13, false);
    if (context === null) throw new Error("expected signal context");
    const completion = formulaCompletions(context, ["pilot's/pitch"])[0];
    if (completion === undefined) throw new Error("expected completion");
    expect(
      applyCompletion("derived/x = 'old' + 1", context, completion),
    ).toEqual({
      text: "derived/x = 'pilot''s/pitch' + 1",
      caret: 28,
    });
  });
});

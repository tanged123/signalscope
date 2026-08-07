import { describe, expect, it } from "vitest";

import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzyScore("npr", "new panel row")).not.toBeNull();
    expect(fuzzyScore("qrs", "new panel row")).toBeNull();
  });

  it("prefers prefix and consecutive matches", () => {
    const prefix = fuzzyScore("new", "new panel row");
    const scattered = fuzzyScore("new", "n e w idget");
    if (prefix === null || scattered === null) {
      throw new Error("expected matches");
    }
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("empty query matches everything neutrally", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

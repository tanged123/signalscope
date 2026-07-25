import { describe, expect, it } from "vitest";
import { SEQ_TOKENS, sampleColormap } from "./colormap";

const stops = ["#000000", "#808080", "#ffffff"];

describe("sampleColormap", () => {
  it("returns the endpoints and clamps beyond them", () => {
    expect(sampleColormap(stops, 0)).toBe("#000000");
    expect(sampleColormap(stops, 1)).toBe("#ffffff");
    expect(sampleColormap(stops, -5)).toBe("#000000");
    expect(sampleColormap(stops, 5)).toBe("#ffffff");
  });

  it("interpolates between adjacent stops", () => {
    expect(sampleColormap(stops, 0.25)).toBe("#404040");
  });

  it("falls back to the first stop for a non-finite position", () => {
    expect(sampleColormap(stops, Number.NaN)).toBe("#000000");
  });

  it("declares sixteen ordered tokens", () => {
    expect(SEQ_TOKENS).toHaveLength(16);
    expect(SEQ_TOKENS[0]).toBe("--seq-01");
    expect(SEQ_TOKENS[15]).toBe("--seq-16");
  });
});

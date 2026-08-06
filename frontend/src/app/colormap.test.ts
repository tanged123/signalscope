import { describe, expect, it } from "vitest";
import {
  ColormapRamp,
  RAMP_STEPS,
  SEQ_TOKENS,
  sampleColormap,
} from "./colormap";

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

  it("normalizes malformed colour channels to zero", () => {
    expect(sampleColormap(["#zz", "#ffffff"], 0)).toBe("#000000");
    expect(sampleColormap(["#", "#ffffff"], 0)).toBe("#000000");
  });

  it("declares sixteen ordered tokens", () => {
    expect(SEQ_TOKENS).toHaveLength(16);
    expect(SEQ_TOKENS[0]).toBe("--seq-01");
    expect(SEQ_TOKENS[15]).toBe("--seq-16");
  });
});

describe("ColormapRamp.stepAt", () => {
  const ramp = new ColormapRamp(["#000000", "#ffffff"]);

  it("quantises to the ramp's fixed steps", () => {
    expect(ramp.stepAt(0)).toBe(0);
    expect(ramp.stepAt(1)).toBe(RAMP_STEPS);
    expect(ramp.stepAt(0.5)).toBe(RAMP_STEPS / 2);
  });

  it("clamps outside [0,1] and on NaN", () => {
    expect(ramp.stepAt(-3)).toBe(0);
    expect(ramp.stepAt(9)).toBe(RAMP_STEPS);
    expect(ramp.stepAt(Number.NaN)).toBe(0);
  });

  it("agrees with at() for every step", () => {
    for (let step = 0; step <= RAMP_STEPS; step += 1) {
      expect(ramp.atStep(step)).toBe(ramp.at(step / RAMP_STEPS));
    }
  });
});

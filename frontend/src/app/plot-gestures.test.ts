import { describe, expect, it } from "vitest";
import { policyFor, type PlotInteractionPolicy } from "./plot-capabilities";
import {
  allowsFit,
  boxZoomAxes,
  dragIntent,
  panAxes,
  resolveRanges,
  wheelAxes,
} from "./plot-gestures";

function policy(
  overrides: Partial<PlotInteractionPolicy>,
): PlotInteractionPolicy {
  return { ...policyFor("time"), ...overrides };
}

describe("resolveRanges", () => {
  it("uses stored histogram ranges instead of its automatic edge span", () => {
    expect(
      resolveRanges(
        policyFor("histogram"),
        { x: [2, 4], y: [1, 3] },
        { x: [0, 10], y: [0, 8] },
        { t0: 20, t1: 30 },
      ),
    ).toEqual({
      x: { min: 2, max: 4 },
      y: { min: 1, max: 3 },
    });
  });

  it("uses the linked window for a linked-time x axis", () => {
    expect(
      resolveRanges(
        policyFor("time"),
        { x: [2, 4], y: [-2, 2] },
        { x: [0, 10], y: [-8, 8] },
        { t0: 20, t1: 30 },
      ),
    ).toEqual({
      x: { min: 20, max: 30 },
      y: { min: -2, max: 2 },
    });
  });

  it("re-reads a supplied automatic range when no stored range exists", () => {
    expect(
      resolveRanges(
        policyFor("xy"),
        { x: null, y: null },
        { x: [1, 5], y: [2, 8] },
        { t0: 20, t1: 30 },
      ),
    ).toEqual({
      x: { min: 1, max: 5 },
      y: { min: 2, max: 8 },
    });
  });

  it("returns null when either required range is unavailable", () => {
    expect(
      resolveRanges(
        policyFor("histogram"),
        { x: null, y: null },
        { x: null, y: [0, 8] },
        { t0: 20, t1: 30 },
      ),
    ).toBeNull();
    expect(
      resolveRanges(
        policyFor("histogram"),
        { x: null, y: null },
        { x: [0, 10], y: null },
        { t0: 20, t1: 30 },
      ),
    ).toBeNull();
  });
});

describe("gesture policy", () => {
  it("intersects wheel modifiers with independently allowed axes", () => {
    const yOnly = policy({ zoom: new Set(["y"]) });
    expect(wheelAxes(yOnly, { shift: false, alt: false })).toEqual({
      x: false,
      y: true,
    });
    expect(wheelAxes(yOnly, { shift: true, alt: false })).toEqual({
      x: false,
      y: true,
    });
    expect(wheelAxes(yOnly, { shift: false, alt: true })).toEqual({
      x: false,
      y: false,
    });
    expect(
      wheelAxes(policy({ zoom: new Set() }), {
        shift: false,
        alt: false,
      }),
    ).toEqual({ x: false, y: false });
  });

  it("intersects pan and box zoom with independently allowed axes", () => {
    expect(panAxes(policy({ pan: new Set(["y"]) }))).toEqual({
      x: false,
      y: true,
    });
    expect(boxZoomAxes(policy({ zoom: new Set(["box", "y"]) }), "xy")).toEqual({
      x: false,
      y: true,
    });
    expect(boxZoomAxes(policy({ zoom: new Set(["x", "y"]) }), "xy")).toEqual({
      x: false,
      y: false,
    });
  });

  it("falls through a denied left drag to click inspection", () => {
    const noViewControls = policy({
      pan: new Set(),
      zoom: new Set(),
      fit: true,
    });
    expect(dragIntent(noViewControls, 0, { ctrl: false, meta: false })).toBe(
      "click",
    );
    expect(dragIntent(noViewControls, 0, { ctrl: true, meta: false })).toBe(
      "click",
    );
    expect(dragIntent(noViewControls, 1, { ctrl: false, meta: false })).toBe(
      "none",
    );
  });

  it("recognizes desktop pan bindings, box zoom, unsupported buttons, and fit", () => {
    const full = policyFor("time");
    expect(dragIntent(full, 0, { ctrl: true, meta: false })).toBe("pan");
    expect(dragIntent(full, 0, { ctrl: false, meta: true })).toBe("pan");
    expect(dragIntent(full, 1, { ctrl: false, meta: false })).toBe("pan");
    expect(dragIntent(full, 2, { ctrl: false, meta: false })).toBe("pan");
    expect(dragIntent(full, 0, { ctrl: false, meta: false })).toBe("box");
    expect(dragIntent(full, 3, { ctrl: false, meta: false })).toBe("none");
    expect(allowsFit(full)).toBe(true);
    expect(allowsFit(policy({ fit: false }))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { LinkedTimeModel } from "./linked-time";

describe("LinkedTimeModel", () => {
  it("keeps its serialized linked-time shape while toggling linkage", () => {
    const model = new LinkedTimeModel();
    model.setLinked(false);

    expect(model.snapshot()).toEqual({
      t0: 0,
      t1: 60,
      linked: false,
      cursorT: null,
      mode: "fixed",
      paused: false,
    });
  });

  it("rejects a reversed initial time window", () => {
    expect(
      () =>
        new LinkedTimeModel({
          t0: 3,
          t1: 2,
          linked: true,
          cursorT: null,
          mode: "fixed",
          paused: false,
        }),
    ).toThrow("finite and increasing");
  });

  it("setWindow validates and applies the new window", () => {
    const model = new LinkedTimeModel();
    model.setWindow(5, 15);
    expect(model.snapshot().t0).toBe(5);
    expect(model.snapshot().t1).toBe(15);
    expect(() => model.setWindow(3, 3)).toThrow();
  });

  it("stores finite cursor times and clears invalid values", () => {
    const model = new LinkedTimeModel();
    model.setCursor(12.5);
    expect(model.snapshot().cursorT).toBe(12.5);
    model.setCursor(Number.NaN);
    expect(model.snapshot().cursorT).toBeNull();
  });
});

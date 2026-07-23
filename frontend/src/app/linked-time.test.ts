import { describe, expect, it, vi } from "vitest";

import { LinkedTimeModel } from "./linked-time";

describe("LinkedTimeModel", () => {
  it("publishes a validated shared window with its origin", () => {
    const model = new LinkedTimeModel();
    const listener = vi.fn();
    model.subscribe(listener);

    model.setWindow({ t0: 12.4, t1: 68.22 }, "panel-a");

    expect(model.snapshot()).toMatchObject({ t0: 12.4, t1: 68.22 });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ t0: 12.4, t1: 68.22 }),
      "panel-a",
    );
  });

  it("rejects a reversed time window", () => {
    const model = new LinkedTimeModel();
    expect(() => model.setWindow({ t0: 3, t1: 2 }, "panel-a")).toThrow(
      "finite and increasing",
    );
  });
});

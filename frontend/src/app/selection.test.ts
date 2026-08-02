import { describe, expect, it, vi } from "vitest";

import { SelectionModel } from "./selection";

describe("SelectionModel", () => {
  it("toggles keys and preserves insertion order", () => {
    const selection = new SelectionModel();

    selection.toggle("b");
    selection.toggle("a");
    selection.toggle("b");

    expect(selection.has("a")).toBe(true);
    expect(selection.has("b")).toBe(false);
    expect(selection.keys()).toEqual(["a"]);
  });

  it("selects the inclusive range in visible order", () => {
    const selection = new SelectionModel();
    selection.toggle("b");

    selection.selectRange(["a", "b", "c", "d"], "d");
    expect(selection.keys()).toEqual(["b", "c", "d"]);

    selection.selectRange(["a", "b", "c", "d"], "a");
    expect(selection.keys()).toEqual(["a", "b"]);
  });

  it("uses a toggle when a range has no anchor", () => {
    const selection = new SelectionModel();

    selection.selectRange(["a", "b"], "b");

    expect(selection.keys()).toEqual(["b"]);
  });

  it("replaces selection with setAll while retaining the range anchor", () => {
    const selection = new SelectionModel();
    selection.toggle("b");
    selection.setAll(["a", "d"]);

    expect(selection.keys()).toEqual(["a", "d"]);
    selection.selectRange(["a", "b", "c", "d"], "c");
    expect(selection.keys()).toEqual(["b", "c"]);
  });

  it("notifies once for each effective mutation", () => {
    const selection = new SelectionModel();
    const listener = vi.fn();
    const unsubscribe = selection.onChange(listener);

    selection.toggle("a");
    selection.setAll(["b"]);
    selection.clear();
    selection.clear();
    unsubscribe();
    selection.toggle("b");

    expect(listener).toHaveBeenCalledTimes(3);
  });
});

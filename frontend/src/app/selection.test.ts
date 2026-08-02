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

  it("retains only keys still present in the catalog", () => {
    const selection = new SelectionModel();
    const listener = vi.fn();
    selection.setAll(["live", "deleted"]);
    selection.onChange(listener);

    selection.retain(new Set(["live", "other"]));

    expect(selection.keys()).toEqual(["live"]);
    expect(listener).toHaveBeenCalledOnce();
    selection.selectRange(["live", "other"], "other");
    expect(selection.keys()).toEqual(["other"]);
  });

  it("keeps the new range anchor after stale-selection recovery", () => {
    const selection = new SelectionModel();
    selection.toggle("deleted");
    selection.retain(new Set(["live", "other"]));

    selection.selectRange(["live", "other"], "other");
    expect(selection.keys()).toEqual(["other"]);

    selection.selectRange(["live", "other"], "live");
    expect(selection.keys()).toEqual(["live", "other"]);
  });

  it("does not notify when every selected key remains valid", () => {
    const selection = new SelectionModel();
    const listener = vi.fn();
    selection.setAll(["live"]);
    selection.onChange(listener);

    selection.retain(new Set(["live", "other"]));

    expect(listener).not.toHaveBeenCalled();
  });

  it("clears a stale deselected anchor during catalog reconciliation", () => {
    const selection = new SelectionModel();
    selection.toggle("live");
    selection.toggle("deleted");
    selection.toggle("deleted");

    selection.retain(new Set(["live", "other"]));

    expect(selection).toHaveProperty("anchor", null);
    expect(selection.keys()).toEqual(["live"]);
  });
});

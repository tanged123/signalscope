// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { BUNDLE_DRAG_TYPE } from "./panel";
import { SignalTreeView } from "./signal-tree";

describe("SignalTreeView favorites drop", () => {
  it("favorites a bundle dragged into the favorites section", () => {
    const list = document.createElement("div");
    const favorites = document.createElement("div");
    const onToggleFavoriteBundle = vi.fn();
    const tree = new SignalTreeView(list, favorites, {
      onPlotSignal: vi.fn(),
      onToggleFavorite: vi.fn(),
      onToggleFavoriteBundle,
      onRemoveDerived: vi.fn(),
    });
    tree.setSignals(["run_01/alt", "run_02/alt"]);
    tree.setSets([
      { key: "set-1", label: "Runs", prefixes: ["run_01", "run_02"] },
    ]);

    const payload = JSON.stringify({
      local_path: "alt",
      member_paths: ["run_01/alt", "run_02/alt"],
    });
    const dataTransfer = {
      types: [BUNDLE_DRAG_TYPE],
      getData: (type: string) => (type === BUNDLE_DRAG_TYPE ? payload : ""),
    };
    const dragover = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragover, "dataTransfer", { value: dataTransfer });
    favorites.dispatchEvent(dragover);
    expect(dragover.defaultPrevented).toBe(true);

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    favorites.dispatchEvent(drop);

    expect(onToggleFavoriteBundle).toHaveBeenCalledWith("alt");
  });
});

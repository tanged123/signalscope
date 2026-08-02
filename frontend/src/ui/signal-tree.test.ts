// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "../app/catalog";
import { SignalTreeView } from "./signal-tree";

function signal(sourceKey: string, channel: string): SignalSummary {
  return {
    signal_id: `${sourceKey}-${channel}`,
    source_id: sourceKey,
    source_key: sourceKey,
    local_path: channel,
    path: `${sourceKey}/${channel}`,
    unit: null,
    point_count: "1",
    t_min: 0,
    t_max: 0,
  };
}

describe("SignalTreeView sets and channels", () => {
  it("renders a shared channel and read-only named sets", () => {
    const list = document.createElement("div");
    const sets = document.createElement("div");
    const onSetSelected = vi.fn();
    const tree = new SignalTreeView(list, sets, {
      onPlotSignal: vi.fn(),
      onSetSelected,
      onRemoveDerived: vi.fn(),
    });
    tree.setCatalog(
      Catalog.build([signal("run-01", "temp"), signal("run-02", "temp")]),
    );
    tree.setNamedSets([
      {
        id: "set-1",
        name: "temperature",
        kind: "query",
        selector: "temp",
        refs: [],
      },
    ]);

    expect(list.querySelector(".tree-channel")?.textContent).toContain(
      "temp — 2 srcs",
    );
    expect(sets.textContent).toContain("temperature");
    sets.querySelector("button")?.dispatchEvent(new MouseEvent("click"));
    expect(onSetSelected).toHaveBeenCalledWith(
      expect.objectContaining({ id: "set-1" }),
    );
  });
});

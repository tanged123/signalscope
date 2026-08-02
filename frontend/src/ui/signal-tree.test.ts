// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "../app/catalog";
import { SignalTreeView } from "./signal-tree";
import { SET_DRAG_TYPE } from "./panel";

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
  it("renders a shared channel and bindable named sets", () => {
    const list = document.createElement("div");
    const sets = document.createElement("div");
    const onSetBind = vi.fn();
    const tree = new SignalTreeView(list, sets, {
      onPlotSignal: vi.fn(),
      onSetBind,
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
    expect(sets.textContent).toContain("live");
    sets
      .querySelector<HTMLElement>(".tree-set")
      ?.dispatchEvent(new MouseEvent("click"));
    expect(onSetBind).toHaveBeenCalledWith("set-1");
  });
});

describe("SignalTreeView set actions", () => {
  it("shows live and frozen counts, binds, deletes, and drags sets", () => {
    const list = document.createElement("div");
    const sets = document.createElement("div");
    const onSetBind = vi.fn();
    const onSetRemove = vi.fn();
    const tree = new SignalTreeView(list, sets, {
      onPlotSignal: vi.fn(),
      onSetBind,
      onSetRemove,
      onRemoveDerived: vi.fn(),
    });
    tree.setCatalog(
      Catalog.build([
        signal("run-01", "temp"),
        signal("run-02", "temp"),
        signal("bench", "temp"),
      ]),
    );
    tree.setNamedSets([
      {
        id: "set-query",
        name: "thermal",
        kind: "query",
        selector: "temp",
        refs: [],
      },
      {
        id: "set-pick",
        name: "manual",
        kind: "pick",
        selector: null,
        refs: [
          { source_key: "run-01", channel: "temp" },
          { source_key: "run-02", channel: "temp" },
        ],
      },
    ]);

    expect(sets.querySelector(".tree-set")?.textContent).toContain("3");
    expect(sets.textContent).toContain("live");
    expect(sets.textContent).toContain("▣ 2");
    sets.querySelector<HTMLElement>(".tree-set")?.click();
    expect(onSetBind).toHaveBeenCalledWith("set-query");

    const pick = sets.querySelectorAll<HTMLElement>(".tree-set")[1];
    pick?.focus();
    pick?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    expect(onSetRemove).toHaveBeenCalledWith("set-pick");

    const dataTransfer = { setData: vi.fn() };
    const drag = new Event("dragstart");
    Object.defineProperty(drag, "dataTransfer", { value: dataTransfer });
    sets.querySelector<HTMLElement>(".tree-set")?.dispatchEvent(drag);
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      SET_DRAG_TYPE,
      JSON.stringify({ set_id: "set-query" }),
    );
  });
});

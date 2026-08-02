// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "../app/catalog";
import { SET_DRAG_TYPE } from "./panel";
import { SetsListView } from "./sets-list";

function signal(source: string, channel: string): SignalSummary {
  return {
    signal_id: `${source}-${channel}`,
    source_id: source,
    source_key: source,
    local_path: channel,
    path: `${source}/${channel}`,
    unit: null,
    point_count: "1",
    t_min: 0,
    t_max: 0,
    last_value: null,
  };
}

describe("SetsListView", () => {
  it("renders live and frozen sets with bind, delete, and drag actions", () => {
    const element = document.createElement("div");
    const onSetBind = vi.fn();
    const onSetRemove = vi.fn();
    const view = new SetsListView(element, { onSetBind, onSetRemove });
    view.setCatalog(
      Catalog.build([signal("run-01", "temp"), signal("run-02", "temp")]),
    );
    view.setNamedSets([
      {
        id: "query",
        name: "thermal",
        kind: "query",
        selector: "temp",
        refs: [],
      },
      {
        id: "pick",
        name: "manual",
        kind: "pick",
        selector: null,
        refs: [{ source_key: "run-01", channel: "temp" }],
      },
    ]);

    expect(element.querySelector(".tree-set")?.textContent).toContain(
      "★ thermal",
    );
    expect(element.textContent).toContain("2");
    expect(element.textContent).toContain("live");
    expect(element.textContent).toContain("▣ 1");

    element.querySelector<HTMLElement>(".tree-set")?.click();
    expect(onSetBind).toHaveBeenCalledWith("query");
    const manual = element.querySelectorAll<HTMLElement>(".tree-set")[1];
    manual?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    expect(onSetRemove).toHaveBeenCalledWith("pick");

    const dataTransfer = { setData: vi.fn() };
    const drag = new Event("dragstart");
    Object.defineProperty(drag, "dataTransfer", { value: dataTransfer });
    element.querySelector<HTMLElement>(".tree-set")?.dispatchEvent(drag);
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      SET_DRAG_TYPE,
      JSON.stringify({ set_id: "query" }),
    );
  });

  it("renders the empty state", () => {
    const element = document.createElement("div");
    const view = new SetsListView(element, {
      onSetBind: vi.fn(),
      onSetRemove: vi.fn(),
    });
    view.setNamedSets([]);
    expect(element.textContent).toBe("Saved sets appear here");
  });
});

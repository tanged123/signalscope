// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "../app/catalog";
import { SET_DRAG_TYPE, SIGNAL_DRAG_TYPE } from "./panel";
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
    document.body.append(element);
    const onSetBind = vi.fn();
    const onSetRemove = vi.fn();
    const onSignalDrop = vi.fn();
    const view = new SetsListView(element, {
      onSetBind,
      onSetRemove,
      onSignalDrop,
    });
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
    expect(element.querySelector(".tree-set-detail")?.textContent).toBe("· 2");
    expect(element.textContent).toContain("live");
    expect(element.textContent).toContain("▣ 1");

    const queryCaret =
      element.querySelector<HTMLButtonElement>(".tree-set-caret");
    queryCaret?.click();
    expect(onSetBind).not.toHaveBeenCalled();
    const expandedCaret =
      element.querySelector<HTMLButtonElement>(".tree-set-caret");
    expect(expandedCaret?.ariaExpanded).toBe("true");
    expect(document.activeElement).toBe(expandedCaret);
    expect(
      [...element.querySelectorAll(".tree-set-member")].map(
        (member) => member.textContent,
      ),
    ).toEqual(["run-01/temp", "run-02/temp"]);

    element.querySelector<HTMLElement>(".tree-set")?.click();
    expect(onSetBind).toHaveBeenCalledWith("query");
    const manual = element.querySelectorAll<HTMLElement>(".tree-set")[1];
    manual?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    expect(onSetRemove).toHaveBeenCalledWith("pick");

    const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
    const drag = new Event("dragstart");
    Object.defineProperty(drag, "dataTransfer", { value: dataTransfer });
    element.querySelector<HTMLElement>(".tree-set")?.dispatchEvent(drag);
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      SET_DRAG_TYPE,
      JSON.stringify({ set_id: "query" }),
    );
    element.remove();
    expect(dataTransfer.effectAllowed).toBe("copy");
  });

  it("renders the empty state", () => {
    const element = document.createElement("div");
    const view = new SetsListView(element, {
      onSetBind: vi.fn(),
      onSetRemove: vi.fn(),
      onSignalDrop: vi.fn(),
    });
    view.setNamedSets([]);
    expect(element.textContent).toBe("Saved sets appear here");
  });

  it("accepts signal drops for manual set creation", () => {
    const element = document.createElement("div");
    const onSignalDrop = vi.fn();
    new SetsListView(element, {
      onSetBind: vi.fn(),
      onSetRemove: vi.fn(),
      onSignalDrop,
    });

    const payload = JSON.stringify({
      refs: [{ source_key: "run-01", channel: "temp" }],
      paths: ["run-01/temp"],
    });
    const dataTransfer = {
      types: [SIGNAL_DRAG_TYPE],
      getData: vi.fn(() => payload),
    };
    const dragover = new Event("dragover", { cancelable: true });
    Object.defineProperty(dragover, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(dragover);

    expect(element.classList.contains("drop-target")).toBe(true);
    expect(dragover.defaultPrevented).toBe(true);

    const dragleave = new Event("dragleave");
    Object.defineProperty(dragleave, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(dragleave);
    expect(element.classList.contains("drop-target")).toBe(false);

    const drop = new Event("drop", { cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(drop);

    expect(onSignalDrop).toHaveBeenCalledWith([
      { source_key: "run-01", channel: "temp" },
    ]);
  });
});

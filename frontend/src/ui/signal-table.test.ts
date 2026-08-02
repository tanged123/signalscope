// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "../app/catalog";
import { SelectionModel } from "../app/selection";
import { SignalTableView } from "./signal-table";
import { SIGNAL_DRAG_TYPE } from "./panel";

function signal(index: number, channel = "temp"): SignalSummary {
  const source = `run_${String(index).padStart(3, "0")}`;
  return {
    signal_id: `${source}-${channel}`,
    source_id: source,
    source_key: source,
    local_path: channel,
    path: `${source}/${channel}`,
    unit: "K",
    point_count: String(index + 1),
    t_min: 0,
    t_max: 1,
    last_value: index,
  };
}

function viewFixture(count = 5): {
  list: HTMLElement;
  selection: SelectionModel;
  view: SignalTableView;
  onSelectionChange: ReturnType<typeof vi.fn>;
} {
  const list = document.createElement("div");
  Object.defineProperty(list, "clientHeight", { value: 400 });
  const selection = new SelectionModel();
  const onSelectionChange = vi.fn();
  const view = new SignalTableView(list, selection, { onSelectionChange });
  view.setCatalog(
    Catalog.build(Array.from({ length: count }, (_, i) => signal(i))),
  );
  return { list, selection, view, onSelectionChange };
}

describe("SignalTableView", () => {
  it("renders only the virtual viewport for a large catalog", () => {
    const { list } = viewFixture(1_000);

    expect(list.querySelectorAll(".signal-table-row").length).toBeLessThan(60);
  });

  it("supports click, range selection, command selection, and escape", () => {
    const { list, selection, view } = viewFixture();
    const rows = (): HTMLElement[] => [
      ...list.querySelectorAll<HTMLElement>(".signal-table-row"),
    ];

    rows()[0]?.click();
    rows()[3]?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, shiftKey: true }),
    );
    expect(selection.size()).toBe(4);

    rows()[4]?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, ctrlKey: true }),
    );
    expect(selection.size()).toBe(5);

    list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(selection.size()).toBe(0);
    view.setFilter("temp @ run_00[1-2]");
    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", metaKey: true }),
    );
    expect(selection.size()).toBe(2);
  });

  it("sorts through header buttons and switches granularity", () => {
    const { list, view } = viewFixture();
    const source = (): HTMLButtonElement | null =>
      list.querySelector<HTMLButtonElement>('[data-column="source"]');
    source()?.click();
    expect(source()?.getAttribute("aria-sort")).toBe("ascending");
    source()?.click();
    expect(source()?.getAttribute("aria-sort")).toBe("descending");
    source()?.click();
    expect(source()?.getAttribute("aria-sort")).toBe("none");

    view.setCatalog(
      Catalog.build([signal(1, "temp"), signal(2, "temp"), signal(3, "speed")]),
    );
    list
      .querySelector<HTMLButtonElement>('[data-granularity="channels"]')
      ?.click();
    expect(list.querySelectorAll(".signal-table-row")).toHaveLength(2);
    expect(list.querySelector(".signal-table-row")?.textContent).toContain(
      "temp",
    );
  });

  it("drags all selected refs from a selected row and only that row otherwise", () => {
    const { list, selection } = viewFixture(3);
    const rows = (): HTMLElement[] => [
      ...list.querySelectorAll<HTMLElement>(".signal-table-row"),
    ];
    rows()[0]?.click();
    rows()[1]?.click();

    const selectedTransfer = { setData: vi.fn() };
    const selectedDrag = new Event("dragstart");
    Object.defineProperty(selectedDrag, "dataTransfer", {
      value: selectedTransfer,
    });
    rows()[0]?.dispatchEvent(selectedDrag);
    expect(selectedTransfer.setData).toHaveBeenCalledWith(
      SIGNAL_DRAG_TYPE,
      expect.stringContaining('"channel":"temp"'),
    );
    expect(
      JSON.parse(selectedTransfer.setData.mock.calls[0]?.[1] ?? "{}").refs,
    ).toHaveLength(2);

    selection.clear();
    const singleTransfer = { setData: vi.fn() };
    const singleDrag = new Event("dragstart");
    Object.defineProperty(singleDrag, "dataTransfer", {
      value: singleTransfer,
    });
    rows()[2]?.dispatchEvent(singleDrag);
    expect(
      JSON.parse(singleTransfer.setData.mock.calls[0]?.[1] ?? "{}").refs,
    ).toHaveLength(1);
  });
});

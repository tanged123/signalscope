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
  onPlotRow: ReturnType<typeof vi.fn>;
} {
  const list = document.createElement("div");
  Object.defineProperty(list, "clientHeight", { value: 400 });
  const selection = new SelectionModel();
  const onSelectionChange = vi.fn();
  const onPlotRow = vi.fn();
  const view = new SignalTableView(list, selection, {
    onSelectionChange,
    onPlotRow,
  });
  view.setCatalog(
    Catalog.build(Array.from({ length: count }, (_, i) => signal(i))),
  );
  return { list, selection, view, onSelectionChange, onPlotRow };
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
    expect(
      list
        .querySelector(".signal-table-header-cell")
        ?.classList.contains("signal-table-micro-label"),
    ).toBe(true);
  });

  it("formats values and adds an active row on double-click or Enter", () => {
    const { list, onPlotRow } = viewFixture(2);
    const rows = list.querySelectorAll<HTMLElement>(".signal-table-row");
    expect(rows[0]?.textContent).toContain("0.0000");
    expect(rows[0]?.textContent).toContain("▢");
    rows[0]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onPlotRow).toHaveBeenCalledWith([
      { source_key: "run_000", channel: "temp" },
    ]);
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onPlotRow).toHaveBeenCalledTimes(2);
  });

  it("marks selected rows across the full row", () => {
    const { list, selection } = viewFixture(1);
    selection.toggle("run_000\u0000temp");
    const row = list.querySelector<HTMLElement>(".signal-table-row");
    expect(row?.classList.contains("selected")).toBe(true);
    expect(row?.textContent).toContain("▣");
  });

  it("mounts the shared bulk bar as the table footer only in table mode", () => {
    const list = document.createElement("div");
    Object.defineProperty(list, "clientHeight", { value: 400 });
    const footer = document.createElement("div");
    const view = new SignalTableView(
      list,
      new SelectionModel(),
      { onSelectionChange: vi.fn() },
      footer,
    );
    view.setCatalog(Catalog.build([signal(1)]));
    view.setFooterInTable(true);
    expect(footer.parentElement).toBe(list);
    view.setFooterInTable(false);
    expect(footer.parentElement).toBeNull();
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
    const selectedRaw = selectedTransfer.setData.mock.calls[0]?.[1] as unknown;
    const selectedPayload = JSON.parse(
      typeof selectedRaw === "string" ? selectedRaw : "{}",
    ) as { refs: unknown[] };
    expect(selectedPayload.refs).toHaveLength(2);

    selection.clear();
    const singleTransfer = { setData: vi.fn() };
    const singleDrag = new Event("dragstart");
    Object.defineProperty(singleDrag, "dataTransfer", {
      value: singleTransfer,
    });
    rows()[2]?.dispatchEvent(singleDrag);
    const singleRaw = singleTransfer.setData.mock.calls[0]?.[1] as unknown;
    const singlePayload = JSON.parse(
      typeof singleRaw === "string" ? singleRaw : "{}",
    ) as { refs: unknown[] };
    expect(singlePayload.refs).toHaveLength(1);
  });

  it("offers the source alias from a row context menu", () => {
    const { list, view } = viewFixture(1);
    const onMergeChannels = vi.fn();
    view.destroy();
    const selection = new SelectionModel();
    const contextView = new SignalTableView(list, selection, {
      onSelectionChange: vi.fn(),
      onMergeChannels,
    });
    contextView.setCatalog(
      Catalog.build(
        [
          {
            ...signal(1, "Temp_C"),
            local_path: "Temp_C",
          },
        ],
        [
          {
            canonical: "temp",
            aliases: [{ source_key: "run_001", name: "Temp_C" }],
          },
        ],
      ),
    );

    list.querySelector<HTMLElement>(".signal-table-row")?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 5,
        clientY: 6,
      }),
    );

    expect(onMergeChannels).toHaveBeenCalledWith(
      [{ source_key: "run_001", name: "Temp_C" }],
      5,
      6,
    );
  });
});

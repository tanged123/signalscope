// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { SignalSummary } from "../generated/protocol";
import { Catalog } from "../app/catalog";
import { SelectionModel } from "../app/selection";
import { SIGNAL_DRAG_TYPE } from "./panel";
import { SignalOutlineView } from "./signal-outline";

function signal(source: string, channel: string, value = 1): SignalSummary {
  return {
    signal_id: `${source}-${channel}`,
    source_id: source,
    source_key: source,
    local_path: channel,
    path: `${source}/${channel}`,
    unit: "K",
    point_count: "2",
    t_min: 0,
    t_max: 1,
    last_value: value,
  };
}

function viewFor(
  catalog: Catalog,
  callbacks: Partial<ConstructorParameters<typeof SignalOutlineView>[2]> = {},
) {
  const list = document.createElement("div");
  Object.defineProperty(list, "clientWidth", {
    configurable: true,
    value: 400,
  });
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    value: 400,
  });
  const bulk = document.createElement("div");
  const selection = new SelectionModel();
  const onAddToPanel = vi.fn();
  const view = new SignalOutlineView(
    list,
    selection,
    {
      onSelectionChange: vi.fn(),
      onAddToPanel,
      onRemoveDerived: vi.fn(),
      ...callbacks,
    },
    bulk,
  );
  view.setCatalog(catalog);
  return { list, bulk, selection, view, onAddToPanel };
}

describe("SignalOutlineView", () => {
  it("renders virtualized rows and group selection", () => {
    const catalog = Catalog.build(
      Array.from({ length: 1_000 }, (_, index) =>
        signal(`run-${String(index)}`, "temp", index),
      ),
    );
    const { list, bulk, selection, view } = viewFor(catalog);
    view.setGroupBy("none");
    expect(
      list.querySelectorAll(".signal-outline-row").length,
    ).toBeLessThanOrEqual(36);
    expect(bulk.parentElement).toBe(list);

    view.setGroupBy("channel");
    const group = list.querySelector<HTMLElement>('[data-row-kind="group"]');
    expect(group?.querySelector(".outline-caret")?.textContent).toBe("▾");
    group?.querySelector<HTMLButtonElement>(".outline-select")?.click();
    expect(selection.size()).toBe(1_000);
    expect(bulk.hidden).toBe(false);
  });

  it("handles series selection, keyboard add, values, and derived removal", () => {
    const onRemoveDerived = vi.fn();
    const catalog = Catalog.build([
      signal("run-01", "temp", 1),
      signal("derived", "err", 2),
    ]);
    const { list, selection, view, onAddToPanel } = viewFor(catalog, {
      onRemoveDerived,
    });
    view.setGroupBy("none");
    view.setLiveValues(new Map([["run-01/temp", "9.0000"]]));
    const series = list.querySelector<HTMLElement>('[data-path="run-01/temp"]');
    series?.click();
    expect(selection.size()).toBe(1);
    series?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onAddToPanel).toHaveBeenCalledWith([
      { source_key: "run-01", channel: "temp" },
    ]);
    expect(series?.textContent).toContain("9.0000");
    const derived = list.querySelector<HTMLElement>(
      '[data-path="derived/err"]',
    );
    expect(derived?.textContent).toContain("ƒx");
    derived
      ?.querySelector<HTMLButtonElement>(".outline-derived-remove")
      ?.click();
    expect(onRemoveDerived).toHaveBeenCalledWith("derived/err");

    list.focus();
    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }),
    );
    expect(selection.size()).toBe(2);
    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(selection.size()).toBe(0);
  });

  it("keeps selection through regrouping and serializes drag payloads", () => {
    const catalog = Catalog.build([
      signal("run-01", "temp"),
      signal("run-02", "speed"),
    ]);
    const { list, selection, view } = viewFor(catalog);
    view.setGroupBy("none");
    const row = list.querySelector<HTMLElement>('[data-path="run-01/temp"]');
    row?.click();
    view.setGroupBy("source");
    expect(selection.keys()).toEqual(["run-01\u0000temp"]);
    const dataTransfer = { setData: vi.fn() };
    const drag = new Event("dragstart", { bubbles: true });
    Object.defineProperty(drag, "dataTransfer", { value: dataTransfer });
    list
      .querySelector<HTMLElement>('[data-path="run-01/temp"]')
      ?.dispatchEvent(drag);
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      SIGNAL_DRAG_TYPE,
      expect.stringContaining('"source_key":"run-01"'),
    );
  });

  it("opens an unmerge popover from a merged channel chip", () => {
    const catalog = Catalog.build(
      [signal("run-01", "temp"), signal("run-02", "Temp_C")],
      [
        {
          canonical: "temp",
          aliases: [
            { source_key: "run-01", name: "temp" },
            { source_key: "run-02", name: "Temp_C" },
          ],
        },
      ],
    );
    const onUnmerge = vi.fn();
    const { list, view } = viewFor(catalog, { onUnmerge });
    const chip = list.querySelector<HTMLButtonElement>(".channel-names-badge");
    chip?.click();
    expect(
      list.querySelector(".outline-unmerge-popover")?.textContent,
    ).toContain("temp");
    list.querySelector<HTMLButtonElement>('[data-action="unmerge"]')?.click();
    expect(onUnmerge).toHaveBeenCalledWith("temp");
    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(list.querySelector(".outline-unmerge-popover")).toBeNull();
    view.destroy();
  });

  it("drops opt-in and low-priority columns as the pane narrows", () => {
    const { list, view } = viewFor(Catalog.build([signal("run-01", "temp")]));
    view.setOptInColumns(["pts"]);
    view.applyWidth(600);
    expect(list.dataset.cols).toBe("channel,source,unit,value,pts");
    view.applyWidth(280);
    expect(list.dataset.cols).toContain("value");
    view.applyWidth(230);
    expect(list.dataset.cols).toBe("channel,source,unit");
    view.applyWidth(300);
    expect(list.dataset.cols).toBe("channel,source,unit,value");
  });

  it("keeps every rendered row aligned with the header grid", () => {
    const catalog = Catalog.build([
      signal("run-01", "temp"),
      signal("run-01", "speed"),
      signal("run-02", "temp"),
    ]);
    const { list, view } = viewFor(catalog);
    view.setGroupBy("source");
    const headerCells = list.querySelector(".signal-outline-header")?.children
      .length;
    expect(headerCells).toBeGreaterThan(0);
    for (const row of list.querySelectorAll<HTMLElement>(
      ".signal-outline-row",
    )) {
      expect(row.children.length).toBe(headerCells);
    }
    const group = list.querySelector<HTMLElement>('[data-row-kind="group"]');
    expect(group?.querySelector(".signal-outline-label")?.textContent).toBe(
      "run-01",
    );
    expect(group?.querySelector(".outline-check-cell")).toBe(
      group?.firstElementChild,
    );
    expect(group?.querySelector(".outline-caret")?.parentElement).toBe(
      group?.children[1],
    );
  });

  it("uses the locked flexible outline template and aggregate abbreviations", () => {
    const catalog = Catalog.build(
      Array.from({ length: 9 }, (_, index) =>
        signal(`run-${String(index)}`, "temp"),
      ),
    );
    const { list, view } = viewFor(catalog);
    view.setGroupBy("channel");
    view.applyWidth(280);
    expect(list.dataset.cols).toContain("value");
    expect(list.style.getPropertyValue("--outline-columns")).toBe(
      "18px minmax(88px, 1fr) 40px 32px 60px",
    );
    expect(
      list.querySelector<HTMLElement>(
        '[data-row-kind="group"] [data-column="source"]',
      )?.textContent,
    ).toBe("9");
    view.applyWidth(400);
    expect(
      list.querySelector<HTMLElement>(
        '[data-row-kind="group"] [data-column="source"]',
      )?.textContent,
    ).toBe("9 srcs");
  });

  it("puts source alignment on source groups only", () => {
    const onAlignSource = vi.fn();
    const catalog = Catalog.build([
      signal("run-01", "temp"),
      signal("run-01", "speed"),
      signal("run-02", "temp"),
    ]);
    const { list, view } = viewFor(catalog, { onAlignSource });
    view.setNonIdentitySources(new Set(["run-01"]));
    view.setGroupBy("source");
    const sourceGroup = list.querySelector<HTMLElement>(
      '[data-row-kind="group"]',
    );
    const align =
      sourceGroup?.querySelector<HTMLButtonElement>(".source-align");
    align?.click();
    expect(onAlignSource).toHaveBeenCalledWith("run-01", align);
    expect(
      sourceGroup?.querySelector(".source-alignment-marker")?.textContent,
    ).toBe("≠");
    view.setGroupBy("channel");
    expect(list.querySelector(".source-align")).toBeNull();
    expect(list.querySelector(".source-alignment-marker")).toBeNull();
  });
});

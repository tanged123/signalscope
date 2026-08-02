// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { Catalog } from "../app/catalog";
import { SelectionModel } from "../app/selection";
import type { SignalSummary } from "../generated/protocol";
import { SIGNAL_DRAG_TYPE } from "./panel";
import { SignalOutlineView } from "./signal-outline";

function signal(source: string, channel: string, value = 42): SignalSummary {
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
  it("virtualizes flat channels and selects collapsed channel groups", () => {
    const flat = viewFor(
      Catalog.build(
        Array.from({ length: 1_000 }, (_, index) =>
          signal("run-01", `channel-${String(index)}`),
        ),
      ),
    );
    expect(
      flat.list.querySelectorAll(".signal-outline-row").length,
    ).toBeLessThanOrEqual(36);
    expect(flat.bulk.parentElement).toBe(flat.list);

    const grouped = viewFor(
      Catalog.build(
        Array.from({ length: 1_000 }, (_, index) =>
          signal(`run-${String(index)}`, "temp"),
        ),
      ),
    );
    const group = grouped.list.querySelector<HTMLElement>(
      '[data-row-kind="group"]',
    );
    expect(group?.querySelector(".outline-caret")?.textContent).toBe("▸");
    expect(
      grouped.list.querySelectorAll('[data-row-kind="series"]'),
    ).toHaveLength(0);
    group?.querySelector<HTMLButtonElement>(".outline-select")?.click();
    expect(grouped.selection.size()).toBe(1_000);
    expect(grouped.bulk.hidden).toBe(false);
  });

  it("renders fixed columns and keeps VALUE blank without a cursor", () => {
    const { list, view } = viewFor(
      Catalog.build([signal("run-01", "temp", 42)]),
    );
    expect(list.dataset.cols).toBe("channel,value");
    expect(list.querySelector('[data-column="unit"]')).toBeNull();
    expect(list.querySelector('[data-column="source"]')).toBeNull();
    expect(
      list.querySelector('[data-row-kind="series"] [data-column="value"]')
        ?.textContent,
    ).toBe("");
    view.setLiveValues(new Map([["run-01/temp", "9.0000"]]));
    expect(
      list.querySelector('[data-row-kind="series"] [data-column="value"]')
        ?.textContent,
    ).toBe("9.0000");
    view.setLiveValues(new Map());
    expect(
      list.querySelector('[data-row-kind="series"] [data-column="value"]')
        ?.textContent,
    ).toBe("");
  });

  it("preserves series selection, add, drag, and derived removal", () => {
    const onRemoveDerived = vi.fn();
    const { list, selection, onAddToPanel } = viewFor(
      Catalog.build([signal("run-01", "temp"), signal("derived", "err")]),
      { onRemoveDerived },
    );
    const series = list.querySelector<HTMLElement>('[data-path="run-01/temp"]');
    series?.click();
    expect(selection.keys()).toEqual(["run-01\u0000temp"]);
    series?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onAddToPanel).toHaveBeenCalledWith([
      { source_key: "run-01", channel: "temp" },
    ]);
    const dataTransfer = { setData: vi.fn() };
    const drag = new Event("dragstart", { bubbles: true });
    Object.defineProperty(drag, "dataTransfer", { value: dataTransfer });
    series?.dispatchEvent(drag);
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      SIGNAL_DRAG_TYPE,
      expect.stringContaining('"source_key":"run-01"'),
    );

    const derived = list.querySelector<HTMLElement>(
      '[data-path="derived/err"]',
    );
    expect(derived?.textContent).toContain("ƒx");
    derived
      ?.querySelector<HTMLButtonElement>(".outline-derived-remove")
      ?.click();
    expect(onRemoveDerived).toHaveBeenCalledWith("derived/err");

    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }),
    );
    expect(selection.size()).toBe(2);
    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(selection.size()).toBe(0);
  });

  it("keeps group and series rows on the fixed header grid", () => {
    const { list } = viewFor(
      Catalog.build([signal("run-01", "temp"), signal("run-02", "temp")]),
    );
    const header = list.querySelector(".signal-outline-header");
    const group = list.querySelector<HTMLElement>('[data-row-kind="group"]');
    expect(header?.children).toHaveLength(3);
    expect(group?.children).toHaveLength(3);
    expect(group?.querySelector(".signal-outline-label")?.textContent).toBe(
      "temp — 2 srcs",
    );
    expect(group?.querySelector('[data-column="value"]')?.textContent).toBe("");
  });

  it("exposes source alignment after expanding a channel", () => {
    const onAlignSource = vi.fn();
    const { list, view } = viewFor(
      Catalog.build([signal("run-01", "temp"), signal("run-02", "temp")]),
      { onAlignSource },
    );
    list.querySelector<HTMLButtonElement>(".outline-caret")?.click();
    const source = list.querySelector<HTMLElement>('[data-path="run-01/temp"]');
    const align = source?.querySelector<HTMLButtonElement>(".source-align");
    align?.click();
    expect(onAlignSource).toHaveBeenCalledWith("run-01", align);

    view.setNonIdentitySources(new Set(["run-01"]));
    expect(
      list.querySelector('[data-path="run-01/temp"] .source-alignment-marker')
        ?.textContent,
    ).toBe("≠");
  });
});

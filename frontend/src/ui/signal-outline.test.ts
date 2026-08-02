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
  const selection = new SelectionModel();
  const onAddToPanel = vi.fn();
  const view = new SignalOutlineView(list, selection, {
    onSelectionChange: vi.fn(),
    onAddToPanel,
    onRemoveDerived: vi.fn(),
    onRemoveDerivedBundle: vi.fn(),
    ...callbacks,
  });
  view.setCatalog(catalog);
  return { list, selection, view, onAddToPanel };
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
  });

  it("selects and clears a channel group when its row is clicked", () => {
    const { list, selection } = viewFor(
      Catalog.build([signal("run-01", "temp"), signal("run-02", "temp")]),
    );

    list.querySelector<HTMLElement>('[data-row-kind="group"]')?.click();
    expect(selection.size()).toBe(2);
    expect(
      list.querySelector('[data-row-kind="group"] .outline-select')
        ?.textContent,
    ).toBe("▣");

    list.querySelector<HTMLElement>('[data-row-kind="group"]')?.click();
    expect(selection.size()).toBe(0);
    expect(
      list.querySelector('[data-row-kind="group"] .outline-select')
        ?.textContent,
    ).toBe("▢");
  });

  it("selects and clears all filtered signals from the header", () => {
    const { list, selection } = viewFor(
      Catalog.build([signal("run-01", "temp"), signal("run-02", "pressure")]),
    );

    list
      .querySelector<HTMLButtonElement>(
        ".signal-outline-header .outline-select",
      )
      ?.click();
    expect(selection.size()).toBe(2);
    expect(
      list.querySelector(".signal-outline-header .outline-select")?.textContent,
    ).toBe("▣");

    list
      .querySelector<HTMLButtonElement>(
        ".signal-outline-header .outline-select",
      )
      ?.click();
    expect(selection.size()).toBe(0);
    expect(
      list.querySelector(".signal-outline-header .outline-select")?.textContent,
    ).toBe("▢");
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

  it("renders a derived collection with one bundle removal action", () => {
    const onRemoveDerivedBundle = vi.fn();
    const { list } = viewFor(
      Catalog.build([
        signal("run-01", "derived/score"),
        signal("run-02", "derived/score"),
      ]),
      { onRemoveDerivedBundle },
    );
    const group = list.querySelector<HTMLElement>('[data-row-kind="group"]');

    expect(group?.textContent).toContain("ƒx");
    expect(group?.textContent).toContain("score — 2 srcs");
    group?.querySelector<HTMLButtonElement>(".outline-derived-remove")?.click();
    expect(onRemoveDerivedBundle).toHaveBeenCalledWith("derived/score");
  });

  it("exposes bundle removal when only one source is eligible", () => {
    const onRemoveDerived = vi.fn();
    const onRemoveDerivedBundle = vi.fn();
    const { list } = viewFor(
      Catalog.build([signal("run-01", "derived/score")]),
      { onRemoveDerived, onRemoveDerivedBundle },
    );
    const series = list.querySelector<HTMLElement>(
      '[data-path="run-01/derived/score"]',
    );

    expect(series?.textContent).toContain("ƒx");
    series
      ?.querySelector<HTMLButtonElement>(".outline-derived-remove")
      ?.click();
    expect(onRemoveDerivedBundle).toHaveBeenCalledWith("derived/score");
    expect(onRemoveDerived).not.toHaveBeenCalled();
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

  it("renders selectable source rows without alignment controls or a footer", () => {
    const { list } = viewFor(
      Catalog.build([signal("run-01", "temp"), signal("run-02", "temp")]),
    );
    list.querySelector<HTMLButtonElement>(".outline-caret")?.click();
    expect(list.querySelectorAll(".source-align")).toHaveLength(0);
    expect(list.querySelectorAll(".source-alignment-marker")).toHaveLength(0);
    expect(list.querySelector(".outline-bulk-footer")).toBeNull();
  });

  it("scrolls and focuses the active virtual row during keyboard navigation", () => {
    const { list } = viewFor(
      Catalog.build(
        Array.from({ length: 100 }, (_, index) =>
          signal("run-01", `channel-${String(index).padStart(3, "0")}`),
        ),
      ),
    );
    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      value: 44,
    });
    document.body.append(list);
    list.focus();

    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );

    const active = list.querySelector<HTMLElement>(
      '[data-path="run-01/channel-099"]',
    );
    expect(active).not.toBeNull();
    expect(document.activeElement).toBe(active);
    expect(list.scrollTop).toBeGreaterThan(0);
    list.remove();
  });

  it("removes owned listeners when destroyed", () => {
    const { list, view } = viewFor(Catalog.build([signal("run-01", "temp")]));
    const render = vi.fn();
    Object.assign(view, { render });
    view.destroy();

    list.dispatchEvent(new Event("scroll"));
    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );

    expect(render).not.toHaveBeenCalled();
  });
});

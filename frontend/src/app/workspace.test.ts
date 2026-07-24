import { describe, expect, it } from "vitest";

import { WorkspaceModel, emptySession } from "./workspace";

function heights(model: WorkspaceModel): number[] {
  return model.layout().map((row) => row.height);
}

function widths(model: WorkspaceModel, rowIndex: number): number[] {
  return model.layout()[rowIndex]?.panels.map((cell) => cell.width) ?? [];
}

describe("WorkspaceModel", () => {
  it("keeps panel grids independent across workspace tabs", () => {
    const model = new WorkspaceModel();
    const firstPanel = model.addPanelRow();
    const firstTab = model.activeTabId();
    const secondTab = model.addTab();
    const secondPanel = model.addPanelRow();

    expect(model.tabs().map((tab) => tab.title)).toEqual([
      "Workspace 1",
      "Workspace 2",
    ]);
    expect(model.panels().map((panel) => panel.id)).toEqual([secondPanel.id]);
    expect(model.selectTab(firstTab)).toBe(true);
    expect(model.panels().map((panel) => panel.id)).toEqual([firstPanel.id]);
    expect(model.selectTab(secondTab.id)).toBe(true);
    expect(model.focusedPanelId()).toBe(secondPanel.id);
  });

  it("closes tabs without ever removing the last workspace", () => {
    const model = new WorkspaceModel();
    const firstTab = model.activeTabId();
    const secondTab = model.addTab();
    model.closeTab(secondTab.id);
    expect(model.activeTabId()).toBe(firstTab);
    expect(model.tabs()).toHaveLength(1);

    model.closeTab(firstTab);
    expect(model.tabs()).toHaveLength(1);
  });

  it("adds panel rows with rebalanced heights", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.addPanelRow();
    expect(model.panels().map((panel) => panel.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(heights(model)).toEqual([0.5, 0.5]);
    expect(model.focusedPanelId()).toBe(second.id);
  });

  it("toggles pointer focus off when the focused panel is selected again", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.addPanelRow();

    model.togglePanelFocus(second.id);
    expect(model.focusedPanelId()).toBeNull();

    model.togglePanelFocus(first.id);
    expect(model.focusedPanelId()).toBe(first.id);
  });

  it("splits a panel right into equal halves of its cell", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    model.splitPanelRight(first.id);
    expect(widths(model, 0)).toEqual([0.5, 0.5]);
  });

  it("does not split a cell below the minimum panel width", () => {
    const model = new WorkspaceModel();
    let panel = model.addPanelRow();
    for (let split = 0; split < 3; split += 1) {
      const sibling = model.splitPanelRight(panel.id);
      if (sibling === null) throw new Error("split failed");
      panel = sibling;
    }

    expect(model.splitPanelRight(panel.id)).toBeNull();
    expect(widths(model, 0).every((width) => width >= 0.1)).toBe(true);
    expect(model.focusedPanelId()).toBe(panel.id);
  });

  it("splits a panel down immediately below its row", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const last = model.addPanelRow();
    const split = model.splitPanelDown(first.id);
    if (split === null) throw new Error("split failed");

    expect(model.layout()).toHaveLength(3);
    expect(heights(model)).toEqual([0.25, 0.25, 0.5]);
    expect(model.layout()[1]?.panels[0]?.panel_id).toBe(split.id);
    expect(model.layout()[2]?.panels[0]?.panel_id).toBe(last.id);
    expect(model.focusedPanelId()).toBe(split.id);
  });

  it("closing the last panel of a row removes the row and renormalizes", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.addPanelRow();
    model.closePanel(second.id);
    expect(heights(model)).toEqual([1]);
    expect(model.focusedPanelId()).toBe(first.id);
    expect(model.panels()).toHaveLength(1);
  });

  it("closing a panel in a shared row gives its width to the survivors", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.splitPanelRight(first.id);
    if (second === null) throw new Error("split failed");
    model.closePanel(first.id);
    expect(widths(model, 0)).toEqual([1]);
  });

  it("assigns the lowest unused color slot per panel", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    expect(model.addSeries(panel.id, "a/one")).toBe(true);
    expect(model.addSeries(panel.id, "a/two")).toBe(true);
    expect(model.addSeries(panel.id, "a/one")).toBe(false);
    const slots = model
      .panel(panel.id)
      ?.series.map((series) => series.color_slot);
    expect(slots).toEqual([1, 2]);
  });

  it("toggles series visibility", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeries(panel.id, "a/one");
    model.toggleSeriesVisible(panel.id, "a/one");
    expect(model.panel(panel.id)?.series[0]?.visible).toBe(false);
  });

  it("clamps seam resizes at a 10% minimum fraction", () => {
    const model = new WorkspaceModel();
    model.addPanelRow();
    model.addPanelRow();
    model.resizeRows(0, 0.9);
    expect(heights(model)[1]).toBeCloseTo(0.1);
    expect(heights(model)[0]).toBeCloseTo(0.9);
  });

  it("moves a panel into another row", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.addPanelRow();
    model.movePanel(second.id, 0, 0);
    expect(first.id).not.toBe(second.id);
    expect(heights(model)).toEqual([1]);
    expect(widths(model, 0)).toHaveLength(2);
    expect(model.layout()[0]?.panels[0]?.panel_id).toBe(second.id);
  });

  it("moves a panel to a new bottom row when the target row does not exist", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    model.splitPanelRight(first.id);
    model.movePanel(first.id, 5, 0);
    expect(model.layout()).toHaveLength(2);
    expect(model.layout()[1]?.panels[0]?.panel_id).toBe(first.id);
  });

  it("maximize is a runtime toggle and clears on close", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.toggleMaximize(panel.id);
    expect(model.maximizedPanelId()).toBe(panel.id);
    model.closePanel(panel.id);
    expect(model.maximizedPanelId()).toBeNull();
  });

  it("restores the layout before adding or splitting panels", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    model.toggleMaximize(first.id);
    model.splitPanelRight(first.id);
    expect(model.maximizedPanelId()).toBeNull();

    model.toggleMaximize(first.id);
    model.splitPanelDown(first.id);
    expect(model.maximizedPanelId()).toBeNull();
  });

  it("toggles favorites", () => {
    const model = new WorkspaceModel();
    model.toggleFavorite("a/one");
    model.toggleFavorite("a/two");
    model.toggleFavorite("a/one");
    expect([...model.favorites()]).toEqual(["a/two"]);
  });

  it("never reuses an id already present in a loaded session", () => {
    const session = emptySession();
    const tab = session.tabs[0];
    if (tab === undefined) throw new Error("default workspace is missing");
    tab.panels.push({
      id: "panel-1",
      title: "Panel 1",
      mode: "time",
      axis_style: "gutter",
      x_signal: null,
      color_signal: null,
      series: [],
      y_range: null,
      annotations: [],
      show_stats: false,
    });
    tab.layout.push({
      height: 1,
      panels: [{ panel_id: "panel-1", width: 1 }],
    });
    const model = new WorkspaceModel(session);
    model.addTab();
    const fresh = model.addPanelRow();
    expect(fresh.id).not.toBe("panel-1");
  });
});

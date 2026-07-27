import { describe, expect, it } from "vitest";

import { WorkspaceModel, emptySession } from "./workspace";

function heights(model: WorkspaceModel): number[] {
  return model.layout().map((row) => row.height);
}

function widths(model: WorkspaceModel, rowIndex: number): number[] {
  return model.layout()[rowIndex]?.panels.map((cell) => cell.width) ?? [];
}

describe("linked time", () => {
  it("serializes linked-time changes into the session", () => {
    const model = new WorkspaceModel();
    model.setLinked(false);
    model.setLinkedWindow(5, 15);
    model.setCursorT(12.5);
    expect(model.snapshot().linked_time).toEqual({
      t0: 5,
      t1: 15,
      linked: false,
      cursorT: 12.5,
      mode: "fixed",
      paused: false,
    });
  });

  it("rejects a non-increasing window", () => {
    const model = new WorkspaceModel();
    expect(() => model.setLinkedWindow(3, 3)).toThrow("finite and increasing");
  });

  it("clears non-finite cursor times", () => {
    const model = new WorkspaceModel();
    model.setCursorT(Number.NaN);
    expect(model.snapshot().linked_time.cursorT).toBeNull();
  });
});

describe("WorkspaceModel", () => {
  it("stores cursor mode independently for each workspace", () => {
    const model = new WorkspaceModel();
    expect(model.cursorMode()).toBe("none");
    model.setCursorMode("track");
    const first = model.activeTabId();
    const second = model.addTab().id;
    expect(model.cursorMode()).toBe("none");
    model.setCursorMode("measure");
    model.selectTab(first);
    expect(model.cursorMode()).toBe("track");
    model.selectTab(second);
    expect(model.cursorMode()).toBe("measure");
  });

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

  it("preserves maximization when closing a background workspace", () => {
    const model = new WorkspaceModel();
    const firstTab = model.activeTabId();
    const panel = model.addPanelRow();
    const backgroundTab = model.addTab();
    model.selectTab(firstTab);
    model.maximizePanel(panel.id);

    model.closeTab(backgroundTab.id);

    expect(model.activeTabId()).toBe(firstTab);
    expect(model.maximizedPanelId()).toBe(panel.id);
  });

  it("clears maximization when closing the active workspace", () => {
    const model = new WorkspaceModel();
    model.addPanelRow();
    model.addTab();
    const panel = model.addPanelRow();
    model.maximizePanel(panel.id);

    model.closeTab(model.activeTabId());

    expect(model.maximizedPanelId()).toBeNull();
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

  it("keeps panel routing idempotent when the current panel is reused", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.addPanelRow();

    model.focusPanel(second.id);
    expect(model.focusedPanelId()).toBe(second.id);
    model.focusPanel(second.id);
    expect(model.focusedPanelId()).toBe(second.id);
    model.focusPanel(first.id);
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

  it("does not split a row below the minimum panel height", () => {
    const model = new WorkspaceModel();
    let panel = model.addPanelRow();
    for (let split = 0; split < 3; split += 1) {
      const sibling = model.splitPanelDown(panel.id);
      if (sibling === null) throw new Error("split failed");
      panel = sibling;
    }
    model.maximizePanel(panel.id);

    expect(model.splitPanelDown(panel.id)).toBeNull();
    expect(heights(model).every((height) => height >= 0.1)).toBe(true);
    expect(model.maximizedPanelId()).toBe(panel.id);
    expect(model.focusedPanelId()).toBe(panel.id);
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

  it("allocates slots past 8 instead of wrapping onto slot 1", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    for (let index = 0; index < 10; index += 1) {
      model.addSeries(panel.id, `rocket/sig_${String(index)}`);
    }
    const slots = model.panels()[0]?.series.map((series) => series.color_slot);
    expect(slots).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("keeps the user dash default solid and writes the spec width", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeries(panel.id, "rocket/velocity_body/x");
    expect(model.panels()[0]?.series[0]?.dash).toBe("solid");
    expect(model.panels()[0]?.series[0]?.width).toBe(1.4);
  });

  it("toggles series visibility", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeries(panel.id, "a/one");
    model.toggleSeriesVisible(panel.id, "a/one");
    expect(model.panel(panel.id)?.series[0]?.visible).toBe(false);
  });

  it("promotes a plotted series to the XY x axis", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeries(panel.id, "position/east");
    model.addSeries(panel.id, "position/north");
    model.promoteSeriesToX(panel.id);
    expect(model.panel(panel.id)?.x_signal).toBe("position/east");
    expect(model.panel(panel.id)?.series.map((series) => series.path)).toEqual([
      "position/north",
    ]);
  });

  it("returns an outgoing x signal to the plotted series", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeries(panel.id, "position/east");
    model.addSeries(panel.id, "position/north");
    model.setXSignal(panel.id, "position/east");
    model.setXSignal(panel.id, "position/north");
    expect(model.panel(panel.id)?.x_signal).toBe("position/north");
    expect(model.panel(panel.id)?.series.map((series) => series.path)).toEqual([
      "position/east",
    ]);
  });

  it("stores and clears a panel y range", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    expect(model.panels()[0]?.y_range).toBeNull();
    model.setPanelYRange(panel.id, [-100, 300]);
    expect(model.panels()[0]?.y_range).toEqual([-100, 300]);
    model.clearPanelYRange(panel.id);
    expect(model.panels()[0]?.y_range).toBeNull();
  });

  it("stores and clears a panel-local x range", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    expect(model.panel(panel.id)?.x_range).toBeNull();
    model.setPanelXRange(panel.id, [-4, 9]);
    expect(model.panel(panel.id)?.x_range).toEqual([-4, 9]);
    model.clearPanelXRange(panel.id);
    expect(model.panel(panel.id)?.x_range).toBeNull();
  });

  it("writes title, axis labels and local time windows", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.renamePanel(panel.id, "Body velocity");
    model.setAxisLabel(panel.id, "y", "velocity (m/s)");
    model.setAxisLabel(panel.id, "c", "flight phase");
    model.setPanelTimeWindow(panel.id, [2, 8]);
    expect(model.panel(panel.id)).toMatchObject({
      title: "Body velocity",
      x_label: null,
      y_label: "velocity (m/s)",
      c_label: "flight phase",
      time_window: [2, 8],
    });
    model.setAxisLabel(panel.id, "c", null);
    expect(model.panel(panel.id)?.c_label).toBeNull();
    model.setPanelTimeWindow(panel.id, null);
    expect(model.panel(panel.id)?.time_window).toBeNull();
  });

  it("retains separate annotation domains across mode changes", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addAnnotation(panel.id, {
      id: "ann-1",
      series_path: "a/b",
      domain: "time",
      anchor: 2,
      pinned_value: 5,
      label: "",
    });
    model.addAnnotation(panel.id, {
      id: "ann-2",
      series_path: "a/b",
      domain: "frequency",
      anchor: 20,
      pinned_value: -3,
      label: "",
    });
    model.setMode(panel.id, "fft");
    model.setMode(panel.id, "time");
    model.setAnnotationLabel(panel.id, "ann-1", "peak");
    expect(model.panel(panel.id)?.annotations[0]?.label).toBe("peak");
    expect(
      model.panel(panel.id)?.annotations.map((item) => item.domain),
    ).toEqual(["time", "frequency"]);
    model.removeAnnotation(panel.id, "ann-1");
    expect(model.panel(panel.id)?.annotations).toHaveLength(1);
  });

  it("toggles statistics and axis style", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.toggleStats(panel.id);
    model.toggleAxisStyle(panel.id);
    expect(model.panel(panel.id)?.show_stats).toBe(true);
    expect(model.panel(panel.id)?.axis_style).toBe("inline");
  });

  it("updates series style and prunes annotations when removing it", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeries(panel.id, "a/b");
    model.setSeriesStyle(panel.id, "a/b", {
      color_slot: 5,
      dash: "dot",
      width: 2.5,
    });
    model.addAnnotation(panel.id, {
      id: "ann-1",
      series_path: "a/b",
      domain: "time",
      anchor: 0,
      pinned_value: 0,
      label: "",
    });
    expect(model.panel(panel.id)?.series[0]).toMatchObject({
      color_slot: 5,
      dash: "dot",
      width: 2.5,
    });
    model.removeSeries(panel.id, "a/b");
    expect(model.panel(panel.id)?.series).toEqual([]);
    expect(model.panel(panel.id)?.annotations).toEqual([]);
  });

  it("ignores a y range for an unknown panel", () => {
    const model = new WorkspaceModel();
    expect(() => {
      model.setPanelYRange("missing", [0, 1]);
    }).not.toThrow();
  });

  it("keeps a pinned y range when the series set changes", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.setPanelYRange(panel.id, [-100, 300]);
    model.addSeries(panel.id, "rocket/velocity_body/x");
    model.toggleSeriesVisible(panel.id, "rocket/velocity_body/x");
    expect(model.panels()[0]?.y_range).toEqual([-100, 300]);
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
      x_range: null,
      x_label: null,
      y_label: null,
      c_label: null,
      time_window: null,
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

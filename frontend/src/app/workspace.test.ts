import { describe, expect, it } from "vitest";

import { WorkspaceModel, emptySession } from "./workspace";
import type {
  PanelState,
  SourceRecord,
  StyleDimension,
} from "../generated/session";

interface TestSeries {
  path: string;
  color_slot: number;
  dash: "solid" | "dash" | "dot";
  width: number;
  visible: boolean;
}

function pathForRef(ref: { source_key: string; channel: string }): string {
  return ref.source_key === "derived"
    ? `derived/${ref.channel}`
    : `${ref.source_key}/${ref.channel}`;
}

function refForPath(path: string): { source_key: string; channel: string } {
  const separator = path.indexOf("/");
  if (separator === -1) throw new Error(`invalid series path: ${path}`);
  return {
    source_key: path.startsWith("derived/")
      ? "derived"
      : path.slice(0, separator),
    channel: path.slice(separator + 1),
  };
}

function legacySeries(panel: PanelState | undefined): TestSeries[] {
  if (panel === undefined) return [];
  return panel.bindings
    .filter((binding) => binding.kind === "pick")
    .flatMap((binding) => binding.refs)
    .map((ref) => {
      const override = panel.overrides.find(
        (entry) =>
          entry.target_ref?.source_key === ref.source_key &&
          entry.target_ref.channel === ref.channel,
      );
      return {
        path: pathForRef(ref),
        color_slot: override?.color_slot ?? 1,
        dash: override?.dash ?? "solid",
        width: override?.width ?? 1.4,
        visible: override?.visible ?? true,
      };
    });
}

function xPath(panel: PanelState | undefined): string | null {
  return panel?.x_ref === null || panel?.x_ref === undefined
    ? null
    : pathForRef(panel.x_ref);
}

function colorPath(panel: PanelState | undefined): string | null {
  return panel?.color_ref === null || panel?.color_ref === undefined
    ? null
    : pathForRef(panel.color_ref);
}

function focusPaths(
  panel: PanelState | undefined,
): { local_path: string; path: string }[] {
  return (panel?.focus ?? []).map((entry) => ({
    local_path: entry.channel ?? entry.ref?.channel ?? "",
    path: entry.ref === null ? "" : pathForRef(entry.ref),
  }));
}

function sourceRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    key: "00000000-0000-0000-0000-000000000001",
    path: "/data/run.csv",
    prefix: "run",
    provider_id: null,
    decode_provenance: null,
    reconcile_legacy: false,
    time_domain: { unit: "seconds", origin: "relative", alignment_origin: 0 },
    scale: 1,
    offset: 0,
    ...overrides,
  };
}

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

describe("derived definitions", () => {
  it("records definitions in order and removes them by path", () => {
    const model = new WorkspaceModel();
    model.addDerived("derived/speed", "hypot('a/x', 'a/y')");
    model.addDerived("derived/jerk", "gradient('derived/speed')");
    expect(model.snapshot().derived).toEqual([
      { path: "derived/speed", expr: "hypot('a/x', 'a/y')" },
      { path: "derived/jerk", expr: "gradient('derived/speed')" },
    ]);

    model.removeSignalRef(refForPath("derived/speed"), "derived/speed");
    expect(model.snapshot().derived.map((entry) => entry.path)).toEqual([
      "derived/jerk",
    ]);
  });

  it("round-trips derived bundle definitions", () => {
    const model = new WorkspaceModel();
    model.addDerivedBundle("score", "'temp' + 'alt'");
    expect(model.derivedBundles()).toEqual([
      { name: "score", expr: "'temp' + 'alt'" },
    ]);

    model.removeDerivedBundle("score");
    expect(model.derivedBundles()).toEqual([]);
  });

  it("replaces a redefined path in place", () => {
    const model = new WorkspaceModel();
    model.addDerived("derived/speed", "'a/x'");
    model.addDerived("derived/speed", "'a/y'");
    expect(model.snapshot().derived).toEqual([
      { path: "derived/speed", expr: "'a/y'" },
    ]);
  });

  it("removes a signal from every serialized workspace reference", () => {
    const model = new WorkspaceModel();
    const path = "derived/speed";
    const first = model.addPanelRow();
    model.addSeriesRef(first.id, refForPath(path));
    model.addAnnotation(first.id, {
      id: "ann-1",
      series_path: path,
      domain: "time",
      anchor: 0,
      pinned_value: 1,
      label: "",
    });
    const axes = model.addPanelRow();
    model.setXRef(axes.id, refForPath(path));
    model.setColorRef(axes.id, refForPath(path));
    model.addNamedSet({
      id: "set-1",
      name: path,
      kind: "pick",
      selector: null,
      refs: [refForPath(path)],
    });
    model.addDerived(path, "'imu/x'");

    model.addTab();
    const second = model.addPanelRow();
    model.addSeriesRef(second.id, refForPath(path));
    model.addAnnotation(second.id, {
      id: "ann-2",
      series_path: path,
      domain: "time",
      anchor: 1,
      pinned_value: 2,
      label: "",
    });

    model.removeSignalRef(refForPath(path), path);

    expect(model.snapshot().derived).toEqual([]);
    expect(model.snapshot().named_sets).toEqual([]);
    for (const tab of model.tabs()) {
      for (const panel of tab.panels) {
        expect(legacySeries(panel).some((series) => series.path === path)).toBe(
          false,
        );
        expect(
          panel.annotations.some(
            (annotation) => annotation.series_path === path,
          ),
        ).toBe(false);
        expect(xPath(panel)).not.toBe(path);
        expect(colorPath(panel)).not.toBe(path);
      }
    }
  });

  it("adds, updates, and removes sources by durable key", () => {
    const model = new WorkspaceModel();
    const source = sourceRecord();
    model.addSource(source);
    model.addSource({ ...source, path: "/moved/run.csv" });
    expect(model.sources()).toEqual([{ ...source, path: "/moved/run.csv" }]);
    model.removeSource(source.key);
    expect(model.sources()).toEqual([]);
  });
});

describe("WorkspaceModel", () => {
  it("replaces the whole session", () => {
    const model = new WorkspaceModel();
    const loaded = emptySession();
    loaded.theme = "light";
    loaded.derived = [{ path: "derived/x", expr: "'a/y'" }];
    model.replace(loaded);
    expect(model.theme()).toBe("light");
    expect(model.snapshot().derived).toHaveLength(1);
  });

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

  it("shows full tabs for export and restores their view state", () => {
    const model = new WorkspaceModel();
    const firstPanel = model.addPanelRow();
    const firstTab = model.activeTabId();
    model.maximizePanel(firstPanel.id);
    const secondTab = model.addTab();
    const secondPanel = model.addPanelRow();
    model.maximizePanel(secondPanel.id);
    const before = model.captureViewState();

    expect(model.showTabForExport(firstTab)).toBe(true);
    expect(model.activeTabId()).toBe(firstTab);
    expect(model.maximizedPanelId()).toBeNull();
    expect(model.showTabForExport(secondTab.id)).toBe(true);
    expect(model.maximizedPanelId()).toBeNull();

    model.restoreViewState(before);

    expect(model.activeTabId()).toBe(secondTab.id);
    expect(
      model.tabs().map((tab) => ({
        id: tab.id,
        focused: tab.focused_panel_id,
        maximized: tab.maximized_panel_id,
      })),
    ).toEqual([
      { id: firstTab, focused: firstPanel.id, maximized: firstPanel.id },
      {
        id: secondTab.id,
        focused: secondPanel.id,
        maximized: secondPanel.id,
      },
    ]);
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

  it("adds series refs without allocating manual overrides", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    expect(model.addSeriesRef(panel.id, refForPath("a/one"))).toBe(true);
    expect(model.addSeriesRef(panel.id, refForPath("a/two"))).toBe(true);
    expect(model.addSeriesRef(panel.id, refForPath("a/one"))).toBe(false);
    expect(model.panel(panel.id)?.overrides).toEqual([]);
  });

  it("addSeriesRefs adds all new refs in one call and skips duplicates", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeriesRef(panel.id, refForPath("run_01/alt"));
    const added = model.addSeriesRefs(panel.id, [
      refForPath("run_01/alt"),
      refForPath("run_02/alt"),
      refForPath("run_03/alt"),
    ]);
    expect(added).toBe(true);
    const series = legacySeries(model.panel(panel.id));
    expect(series.map((entry) => entry.path)).toEqual([
      "run_01/alt",
      "run_02/alt",
      "run_03/alt",
    ]);
    expect(model.panel(panel.id)?.overrides).toEqual([]);
    expect(model.addSeriesRefs(panel.id, [refForPath("run_02/alt")])).toBe(
      false,
    );
  });

  it("toggles focus entries", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    const entry = {
      kind: "series" as const,
      ref: refForPath("run_01/alt"),
      source_key: null,
      channel: null,
    };
    model.toggleFocus(panel.id, entry);
    expect(model.panel(panel.id)?.focus).toEqual([entry]);
    expect(model.focusEntries(panel.id)).toEqual([entry]);
    model.clearFocus(panel.id);
    expect(model.focusEntries(panel.id)).toEqual([]);
    model.toggleFocus(panel.id, entry);
    expect(model.focusEntries(panel.id)).toEqual([entry]);
    model.toggleFocus(panel.id, entry);
    expect(model.panel(panel.id)?.focus).toEqual([]);
  });

  it("colour-by-time replaces the colour signal", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.setColorRef(panel.id, refForPath("demo/speed"));
    model.setColorByTime(panel.id);
    expect(model.panel(panel.id)?.color_axis).toBe("time");
    expect(colorPath(model.panel(panel.id))).toBeNull();
    model.setColorRef(panel.id, null);
    expect(model.panel(panel.id)?.color_axis).toBe("none");
  });

  it("keeps the user dash default solid and writes the spec width", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeriesRef(panel.id, refForPath("rocket/velocity_body/x"));
    expect(legacySeries(model.panels()[0])[0]?.dash).toBe("solid");
    expect(legacySeries(model.panels()[0])[0]?.width).toBe(1.4);
  });

  it("toggles series visibility", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeriesRef(panel.id, refForPath("a/one"));
    model.toggleSeriesVisible(panel.id, { source_key: "a", channel: "one" });
    expect(legacySeries(model.panel(panel.id))[0]?.visible).toBe(false);
  });

  it("stores color rules, ghost mode, and selector overrides", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    const dimensions: StyleDimension[] = [
      "focus",
      "source",
      "channel",
      "set",
      "attr",
    ];
    for (const dimension of dimensions) model.setColorBy(panel.id, dimension);
    expect(model.panel(panel.id)?.color_by).toBe("attr");

    model.setGhostMode(panel.id, "ghost");
    expect(model.panel(panel.id)?.ghost_mode).toBe("ghost");
    model.toggleGhostMode(panel.id);
    expect(model.panel(panel.id)?.ghost_mode).toBe("all");

    model.addSelectorOverride(panel.id, "temp* @ run_01", {
      color_slot: 3,
      opacity: 0.5,
      visible: false,
    });
    expect(model.panel(panel.id)?.overrides).toEqual([
      {
        target_ref: null,
        target_selector: "temp* @ run_01",
        color_slot: 3,
        dash: null,
        width: null,
        opacity: 0.5,
        visible: false,
      },
    ]);
  });

  it("merges target-ref styles and manages the override stack", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    const ref = refForPath("a/one");
    model.setSeriesOverride(panel.id, ref, {
      color_slot: 5,
      dash: "dot",
      width: 2.5,
    });
    model.setSeriesOverride(panel.id, ref, {
      color_slot: 2,
      dash: "solid",
      width: 3,
    });
    expect(model.panel(panel.id)?.overrides).toEqual([
      {
        target_ref: ref,
        target_selector: null,
        color_slot: 2,
        dash: "solid",
        width: 3,
        opacity: null,
        visible: null,
      },
    ]);

    model.addSelectorOverride(panel.id, "one", { width: 4 });
    model.removeOverride(panel.id, 1);
    expect(model.panel(panel.id)?.overrides).toHaveLength(1);
    model.addSelectorOverride(panel.id, "one", { width: 4 });
    model.clearOverrides(panel.id);
    expect(model.panel(panel.id)?.overrides).toEqual([]);
  });

  it("promotes a plotted series to the XY x axis", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeriesRef(panel.id, refForPath("position/east"));
    model.addSeriesRef(panel.id, refForPath("position/north"));
    model.promoteSeriesToX(panel.id);
    expect(xPath(model.panel(panel.id))).toBe("position/east");
    expect(
      legacySeries(model.panel(panel.id)).map((series) => series.path),
    ).toEqual(["position/north"]);
  });

  it("returns an outgoing x signal to the plotted series", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeriesRef(panel.id, refForPath("position/east"));
    model.addSeriesRef(panel.id, refForPath("position/north"));
    model.setXRef(panel.id, refForPath("position/east"));
    model.setXRef(panel.id, refForPath("position/north"));
    expect(xPath(model.panel(panel.id))).toBe("position/north");
    expect(
      legacySeries(model.panel(panel.id)).map((series) => series.path),
    ).toEqual(["position/east"]);
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
    const ref = refForPath("a/b");
    model.addSeriesRef(panel.id, ref);
    model.setSeriesOverride(panel.id, ref, {
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
    expect(legacySeries(model.panel(panel.id))[0]).toMatchObject({
      color_slot: 5,
      dash: "dot",
      width: 2.5,
    });
    model.removeSeriesRef(panel.id, ref, "a/b");
    expect(legacySeries(model.panel(panel.id))).toEqual([]);
    expect(model.panel(panel.id)?.annotations).toEqual([]);
    expect(focusPaths(model.panel(panel.id))).toEqual([]);
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
    model.addSeriesRef(panel.id, refForPath("rocket/velocity_body/x"));
    model.toggleSeriesVisible(panel.id, {
      source_key: "rocket",
      channel: "velocity_body/x",
    });
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

  it("keeps the maximized panel in the session snapshot", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.toggleMaximize(panel.id);
    expect(model.snapshot().tabs[0]?.maximized_panel_id).toBe(panel.id);
    model.toggleMaximize(panel.id);
    expect(model.snapshot().tabs[0]?.maximized_panel_id).toBeNull();
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

  it("adds and removes named sets", () => {
    const model = new WorkspaceModel();
    model.addNamedSet({
      id: "set-1",
      name: "temperature",
      kind: "pick",
      selector: null,
      refs: [refForPath("a/one")],
    });
    model.addNamedSet({
      id: "set-2",
      name: "velocity",
      kind: "query",
      selector: "velocity",
      refs: [],
    });
    expect(model.namedSets().map((set) => set.name)).toEqual([
      "temperature",
      "velocity",
    ]);
    model.removeNamedSet("set-1");
    expect(model.namedSets().map((set) => set.name)).toEqual(["velocity"]);
    model.removeNamedSet("set-2");
    expect(model.namedSets()).toEqual([]);
  });

  it("adds query and set bindings without duplicates", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    expect(model.addQueryBinding(panel.id, "temp*")).toBe(true);
    expect(model.addQueryBinding(panel.id, "temp*")).toBe(false);
    expect(model.addSetBinding(panel.id, "set-1")).toBe(true);
    expect(model.addSetBinding(panel.id, "set-1")).toBe(false);
    expect(model.panel(panel.id)?.bindings).toEqual([
      { kind: "query", selector: "temp*", refs: [], set_id: null },
      { kind: "set", selector: null, refs: [], set_id: "set-1" },
    ]);
  });

  it("removes a binding by its serialized index", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addQueryBinding(panel.id, "temp");
    model.addSetBinding(panel.id, "set-1");
    model.removeBinding(panel.id, 0);
    expect(model.panel(panel.id)?.bindings).toEqual([
      { kind: "set", selector: null, refs: [], set_id: "set-1" },
    ]);
  });

  it("allocates the next set id across current and migrated ids", () => {
    const empty = new WorkspaceModel();
    expect(empty.nextSetId()).toBe("set-1");
    empty.addNamedSet({
      id: "set-3",
      name: "three",
      kind: "pick",
      selector: null,
      refs: [],
    });
    empty.addNamedSet({
      id: "set-fav-7",
      name: "seven",
      kind: "pick",
      selector: null,
      refs: [],
    });
    empty.addNamedSet({
      id: "other",
      name: "other",
      kind: "pick",
      selector: null,
      refs: [],
    });
    expect(empty.nextSetId()).toBe("set-8");
  });

  it("removes a named set binding from every tab", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    model.addSetBinding(first.id, "set-1");
    model.addSetBinding(first.id, "set-2");
    model.addTab();
    const second = model.addPanelRow();
    model.addSetBinding(second.id, "set-1");
    model.removeNamedSet("set-1");
    expect(
      model
        .tabs()
        .flatMap((tab) => tab.panels)
        .flatMap((panel) => panel.bindings),
    ).toEqual([{ kind: "set", selector: null, refs: [], set_id: "set-2" }]);
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
      x_ref: null,
      color_axis: "none",
      color_ref: null,
      bindings: [],
      color_by: "source",
      overrides: [],
      focus: [],
      ghost_mode: "all",
      split_by: "none",
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

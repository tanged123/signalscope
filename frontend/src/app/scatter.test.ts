import { expect, test } from "vitest";
import { WorkspaceModel } from "./workspace";
import { parseBakedSession } from "./baked-session";
import { prepareLine2DPlot, type Line2DPlotInput } from "./plot-capabilities";
import { usesPairedSamples } from "./panel-content";
import { resolveLineBindings } from "./line-bindings";
import { Catalog } from "./catalog";
import type { PlotLayout } from "./plot-math";

test("mixed panel creation restores the grid, preserves bindings, and round trips", () => {
  const model = new WorkspaceModel();
  const line = model.addPanelRow();
  model.maximizePanel(line.id);
  const scatter = model.splitPanelRight(line.id, { kind: "scatter2d" });
  expect(scatter?.content).toEqual({ kind: "scatter2d" });
  expect(scatter?.bindings).toEqual([]);
  expect(line.content).toEqual({ kind: "line2d" });
  expect(model.maximizedPanelId()).toBeNull();
  expect(model.focusedPanelId()).toBe(scatter?.id);
  const restored = new WorkspaceModel(
    parseBakedSession(JSON.stringify(model.snapshot())),
  );
  expect(restored.panel(scatter?.id ?? "")?.content.kind).toBe("scatter2d");
  restored.toggleMaximize(scatter?.id ?? "");
  restored.toggleMaximize(scatter?.id ?? "");
  expect(restored.maximizedPanelId()).toBeNull();
  const below = restored.splitPanelDown(line.id, { kind: "scatter2d" });
  expect(restored.layout()[1]?.panels[0]?.panel_id).toBe(below?.id);
});

test("rejected split leaves session, focus and maximization intact", () => {
  const model = new WorkspaceModel();
  const first = model.addPanelRow();
  model.splitPanelRight(first.id);
  model.splitPanelRight(first.id);
  model.splitPanelRight(first.id);
  model.maximizePanel(first.id);
  const before = JSON.stringify(model.snapshot());
  expect(model.splitPanelRight(first.id, { kind: "scatter2d" })).toBeNull();
  expect(JSON.stringify(model.snapshot())).toBe(before);
});

test("left creation inserts before its source and restores the grid", () => {
  const model = new WorkspaceModel();
  const original = model.addPanelRow();
  model.maximizePanel(original.id);
  const scatter = model.splitPanelLeft(original.id, { kind: "scatter2d" });
  expect(model.layout()[0]?.panels.map((cell) => cell.panel_id)).toEqual([
    scatter?.id,
    original.id,
  ]);
  expect(model.layout()[0]?.panels.map((cell) => cell.width)).toEqual([
    0.5, 0.5,
  ]);
  expect(model.maximizedPanelId()).toBeNull();
  expect(model.focusedPanelId()).toBe(scatter?.id);
});

test("scatter requires paired observations even when X is time", () => {
  const model = new WorkspaceModel();
  const line = model.addPanelRow();
  const scatter = model.addPanelRow({ kind: "scatter2d" });
  expect(usesPairedSamples(line)).toBe(false);
  expect(usesPairedSamples(scatter)).toBe(true);
  const catalog = Catalog.build([
    {
      signal_id: "1",
      source_id: "1",
      source_key: "run",
      local_path: "y",
      path: "run/y",
      unit: "V",
      point_count: "3",
      t_min: 0,
      t_max: 2,
      last_value: 2,
    },
  ]);
  const bindings = resolveLineBindings(
    scatter.x_axis,
    [{ ref: { source_key: "run", channel: "y" }, path: "run/y" }],
    catalog,
    null,
    true,
  );
  expect(bindings.groups).toEqual([{ xId: "1", ids: ["1"], timeX: true }]);
});

test("scatter selects observations, excludes hidden/nonfinite rows, and never picks a connecting segment", () => {
  const input: Line2DPlotInput = {
    anchor: Float64Array.from([0, 1, 2]),
    x: Float64Array.from([0, 10, 5]),
    series: [
      {
        path: "y",
        colorIndex: 0,
        unit: null,
        values: Float64Array.from([0, 10, NaN]),
      },
    ],
    window: { t0: 0, t1: 2 },
  };
  const layout: PlotLayout = {
    plot: { x: 0, y: 0, width: 100, height: 100 },
    xRange: { min: 0, max: 10 },
    yRange: { min: 0, max: 10 },
  };
  const line = prepareLine2DPlot(input);
  const scatter = prepareLine2DPlot({ ...input, primitive: "points" });
  expect(line.hitAdapter.seriesAt(layout, 50, 50, 4)?.path).toBe("y");
  expect(scatter.hitAdapter.seriesAt(layout, 50, 50, 4)).toBeNull();
  expect(scatter.cursorAt(layout, { x: 50, y: 50 }, 4)).toBeNull();
  expect(scatter.hitAdapter.seriesAt(layout, 100, 0, 4)?.path).toBe("y");
  expect(scatter.annotationAt(layout, { x: 100, y: 0 }, 4)).toEqual({
    path: "y",
    anchor: 1,
    x: 10,
    pinnedValue: 10,
  });
  const hidden = prepareLine2DPlot({
    ...input,
    primitive: "points",
    series: input.series.map((series) => ({ ...series, visible: false })),
  });
  expect(hidden.annotationAt(layout, { x: 100, y: 0 }, 4)).toBeNull();
});

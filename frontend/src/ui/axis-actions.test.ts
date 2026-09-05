import { expect, test, vi } from "vitest";
import { WorkspaceModel } from "../app/workspace";
import { axisActions } from "./axis-actions";

test("color limits republish style without discarding data or linked cursor", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  const host = {
    workspace,
    timeLimits: vi.fn(),
    resetY: vi.fn(),
    commit: vi.fn(),
    refreshStates: vi.fn(),
    resetCursor: vi.fn(),
    invalidate: vi.fn(),
    render: vi.fn(),
    refresh: vi.fn(),
  };
  const actions = axisActions(host);
  const axis = { source: { kind: "time" as const }, range: null, label: null };
  actions.onSetColorAxis(panel.id, axis);
  expect(host.invalidate).toHaveBeenCalledOnce();
  expect(host.refresh).toHaveBeenCalledOnce();
  actions.onSetColorAxis(panel.id, {
    ...axis,
    range: [0, 100],
    label: "time (s)",
  });
  expect(host.render).toHaveBeenCalledTimes(2);
  expect(host.invalidate).toHaveBeenCalledOnce();
  expect(host.refresh).toHaveBeenCalledOnce();
  expect(host.resetCursor).not.toHaveBeenCalled();
  expect(host.commit).toHaveBeenCalledTimes(2);
  actions.onSetColorAxis(panel.id, null);
  expect(host.invalidate).toHaveBeenCalledTimes(2);
});

test("one limits edit publishes X/Y/C together and restores automatic ranges", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  workspace.setPanelXAxis(panel.id, {
    kind: "signal",
    ref: { source_key: "run", channel: "x" },
  });
  workspace.setPanelColorAxis(panel.id, {
    source: { kind: "time" },
    range: null,
    label: null,
  });
  const host = {
    workspace,
    commit: vi.fn(),
    refreshStates: vi.fn(),
    resetCursor: vi.fn(),
    invalidate: vi.fn(),
    render: vi.fn(),
    refresh: vi.fn(),
    timeLimits: vi.fn(),
    resetY: vi.fn(),
  };
  const actions = axisActions(host);
  actions.onSetAxisLimits(panel.id, {
    x: [0, 10],
    y: [-5, 5],
    c: [20, 80],
    xLabel: "Position",
    yLabel: "Response",
    cLabel: "Time",
  });
  expect(workspace.panel(panel.id)).toMatchObject({
    x_range: [0, 10],
    y_range: [-5, 5],
    x_label: "Position",
    y_label: "Response",
    color_axis: { range: [20, 80], label: "Time" },
  });
  expect(host.commit).toHaveBeenCalledOnce();
  expect(host.refresh).not.toHaveBeenCalled();
  const automatic = {
    x: null,
    y: null,
    c: null,
    xLabel: null,
    yLabel: null,
    cLabel: null,
  };
  expect(() =>
    actions.onSetAxisLimits(panel.id, { ...automatic, c: [5, 1] }),
  ).toThrow(/increasing/);
  expect(workspace.panel(panel.id)?.x_range).toEqual([0, 10]);
  actions.onSetAxisLimits(panel.id, automatic);
  expect(workspace.panel(panel.id)).toMatchObject({
    x_range: null,
    y_range: null,
    color_axis: { range: null },
  });
  expect(host.resetY).toHaveBeenCalledOnce();
  expect(host.timeLimits).not.toHaveBeenCalled();
  workspace.setPanelXAxis(panel.id, { kind: "time" });
  actions.onSetAxisLimits(panel.id, { ...automatic, x: [2, 4] });
  expect(host.timeLimits).toHaveBeenLastCalledWith(panel.id, [2, 4]);
  actions.onSetAxisLimits(panel.id, automatic);
  expect(host.timeLimits).toHaveBeenLastCalledWith(panel.id, null);
});

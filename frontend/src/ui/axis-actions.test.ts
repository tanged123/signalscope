import { expect, test, vi } from "vitest";
import { WorkspaceModel } from "../app/workspace";
import { axisActions } from "./axis-actions";

test("color limits republish style without discarding data or linked cursor", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  const host = {
    workspace,
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
  actions.onSetColorAxis(panel.id, null);
  expect(host.invalidate).toHaveBeenCalledTimes(2);
});

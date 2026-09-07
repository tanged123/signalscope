// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceModel } from "../app/workspace";
import { parseBakedSession } from "../app/baked-session";
import { showAxisLimits, type AxisLimits } from "./axis-limits";
import { axisActions } from "./axis-actions";
import { required } from "./dom";

afterEach(() => document.body.replaceChildren());

test("axis equal applies with limits, survives restore, and cancels without mutation", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const actions = axisActions({
    workspace,
    timeLimits: vi.fn(),
    resetY: vi.fn(),
    commit: vi.fn(),
    refreshStates: vi.fn(),
    resetCursor: vi.fn(),
    invalidate: vi.fn(),
    render: vi.fn(),
    refresh: vi.fn(),
  });
  const apply = vi.fn((limits: AxisLimits) =>
    actions.onSetAxisLimits(panel.id, limits),
  );
  const open = () => {
    showAxisLimits(
      document.body,
      anchor,
      panel,
      { x: [0, 10], y: [0, 5] },
      apply,
    );
    return required<HTMLInputElement>(document.body, 'input[type="checkbox"]');
  };
  let equal = open();
  expect(equal.checked).toBe(false);
  equal.click();
  required(document.body, "form").dispatchEvent(
    new Event("submit", { cancelable: true }),
  );
  expect(apply).toHaveBeenCalledOnce();
  expect(panel.axis_equal).toBe(true);
  expect(
    parseBakedSession(JSON.stringify(workspace.snapshot())).tabs[0]?.panels[0]
      ?.axis_equal,
  ).toBe(true);
  expect(document.activeElement).toBe(anchor);
  equal = open();
  expect(equal.checked).toBe(true);
  equal.click();
  equal.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(panel.axis_equal).toBe(true);
  expect(apply).toHaveBeenCalledOnce();
});

test.each([null, undefined, false])(
  "older sessions default axis equal to off (%s)",
  (axis_equal) => {
    const workspace = new WorkspaceModel();
    Object.assign(workspace.addPanelRow(), { axis_equal });
    expect(
      parseBakedSession(JSON.stringify(workspace.snapshot())).tabs[0]?.panels[0]
        ?.axis_equal,
    ).toBe(false);
  },
);

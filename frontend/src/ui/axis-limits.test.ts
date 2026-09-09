// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceModel } from "../app/workspace";
import { parseBakedSession } from "../app/baked-session";
import { showAxisLimits, type AxisLimits } from "./axis-limits";
import { axisActions } from "./axis-actions";
import { required } from "./dom";

afterEach(() => document.body.replaceChildren());

test("X/Y/C log scales validate as one draft and survive session restore", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  panel.axis_equal = true;
  panel.color_axis = {
    source: { kind: "time" },
    scale: null,
    range: null,
    label: null,
  };
  const anchor = document.createElement("button");
  document.body.append(anchor);
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
  const apply = vi.fn((draft: AxisLimits) =>
    actions.onSetAxisLimits(panel.id, draft),
  );
  showAxisLimits(
    document.body,
    anchor,
    panel,
    { x: [0, 100], y: [-1, 100] },
    apply,
  );
  const select = (label: string, value: string) => {
    const element = required<HTMLSelectElement>(
      document.body,
      `[aria-label="${label}"]`,
    );
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  for (const axis of ["X", "Y", "C"]) select(`${axis} scale`, "log");
  expect(
    required<HTMLInputElement>(document.body, 'input[type="checkbox"]')
      .disabled,
  ).toBe(true);
  select("C limits mode", "fixed");
  required<HTMLInputElement>(document.body, '[aria-label="C minimum"]').value =
    "0";
  required<HTMLInputElement>(document.body, '[aria-label="C maximum"]').value =
    "100";
  const submit = () =>
    required(document.body, "form").dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
  submit();
  expect(apply).not.toHaveBeenCalled();
  expect(panel.x_scale).toBeNull();
  expect(required(document.body, '[role="alert"]').textContent).toContain(
    "positive",
  );
  required<HTMLInputElement>(document.body, '[aria-label="C minimum"]').value =
    "1";
  submit();
  expect(apply).toHaveBeenCalledOnce();
  expect(host.invalidate).not.toHaveBeenCalled();
  expect(
    parseBakedSession(JSON.stringify(workspace.snapshot())).tabs[0]?.panels[0],
  ).toMatchObject({
    x_scale: "log",
    y_scale: "log",
    axis_equal: false,
    color_axis: { scale: "log", range: [1, 100] },
  });
});

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

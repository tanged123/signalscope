import { expect, test } from "vitest";
import { WorkspaceModel } from "./workspace";
import { parseBakedSession } from "./baked-session";

test("empty-panel selection publishes once, preserves identity/layout and round trips", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  workspace.maximizePanel(panel.id);
  const layout = JSON.stringify(workspace.layout());
  const revision = workspace.revision();
  expect(workspace.setEmptyPanelContent(panel.id, { kind: "scatter2d" })).toBe(
    true,
  );
  expect(workspace.panel(panel.id)).toBe(panel);
  expect(workspace.revision()).toBe(revision + 1);
  expect(JSON.stringify(workspace.layout())).toBe(layout);
  expect(workspace.maximizedPanelId()).toBe(panel.id);
  const restored = new WorkspaceModel(
    parseBakedSession(JSON.stringify(workspace.snapshot())),
  );
  expect(restored.panel(panel.id)?.content.kind).toBe("scatter2d");
  expect(restored.panel(panel.id)?.content_selection_pending).toBe(false);
  expect(workspace.setEmptyPanelContent(panel.id, { kind: "scatter2d" })).toBe(
    false,
  );
  expect(workspace.revision()).toBe(revision + 1);
});

test("choosing the default line type completes selection and survives undo/redo state restore", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  const pending = structuredClone(workspace.snapshot());
  const revision = workspace.revision();
  expect(workspace.setEmptyPanelContent(panel.id, { kind: "line2d" })).toBe(
    true,
  );
  expect(panel.content_selection_pending).toBe(false);
  expect(workspace.revision()).toBe(revision + 1);
  const chosen = structuredClone(workspace.snapshot());
  workspace.replace(pending);
  expect(workspace.panel(panel.id)?.content_selection_pending).toBe(true);
  workspace.replace(chosen);
  expect(workspace.panel(panel.id)?.content_selection_pending).toBe(false);
});

test("explicit creation and directional shortcuts have already chosen a type", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow({ kind: "line2d" });
  const right = workspace.splitPanelRight(panel.id, { kind: "scatter2d" });
  const down = workspace.splitPanelDown(panel.id);
  for (const created of [panel, right, down]) {
    expect(created?.content_selection_pending).toBe(false);
    expect(
      workspace.setEmptyPanelContent(created?.id ?? "", { kind: "scatter2d" }),
    ).toBe(false);
  }
});

test.each(["pick", "query", "set"])(
  "assigning a %s binding accepts the default type even if the binding is later removed",
  (kind) => {
    const workspace = new WorkspaceModel();
    const panel = workspace.addPanelRow();
    if (kind === "pick")
      workspace.addSeriesRef(panel.id, { source_key: "run", channel: "y" });
    else if (kind === "query") workspace.addQueryBinding(panel.id, "*");
    else workspace.addSetBinding(panel.id, "set-1");
    workspace.removeBinding(panel.id, 0);
    expect(panel.bindings).toEqual([]);
    expect(panel.content_selection_pending).toBe(false);
  },
);

test("bound panels and missing panels reject type changes without publication", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  workspace.setEmptyPanelContent(panel.id, { kind: "scatter2d" });
  workspace.addSeriesRef(panel.id, { source_key: "run", channel: "y" });
  const before = JSON.stringify(workspace.snapshot());
  const revision = workspace.revision();
  expect(workspace.setEmptyPanelContent(panel.id, { kind: "line2d" })).toBe(
    false,
  );
  expect(workspace.setEmptyPanelContent("missing", { kind: "scatter2d" })).toBe(
    false,
  );
  expect(workspace.revision()).toBe(revision);
  expect(JSON.stringify(workspace.snapshot())).toBe(before);
});

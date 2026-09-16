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
  expect(workspace.setEmptyPanelContent(panel.id, { kind: "scatter2d" })).toBe(
    false,
  );
  expect(workspace.revision()).toBe(revision + 1);
});

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

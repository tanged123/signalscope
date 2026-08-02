// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "../generated/session";
import { WorkspaceTabsView } from "./workspace-tabs";

describe("WorkspaceTabsView", () => {
  it("marks the active workspace tab for the inset seam", () => {
    const root = document.createElement("nav");
    const view = new WorkspaceTabsView(root, {
      onSelect: vi.fn(),
      onAdd: vi.fn(),
      onClose: vi.fn(),
    });
    view.sync(
      [
        { id: "workspace-1", title: "Runbook" },
        { id: "workspace-2", title: "Compare" },
      ] as unknown as WorkspaceTab[],
      "workspace-2",
    );

    expect(root.querySelector(".workspace-tab.active")?.textContent).toContain(
      "Compare",
    );
  });
});

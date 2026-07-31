// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { WorkspaceModel } from "../app/workspace";
import type { BatchStatus } from "../generated/protocol";
import type { PanelMode } from "../generated/session";
import { AppShell, renderBatchProgress } from "./app-shell";

interface ShellProbe {
  workspace: WorkspaceModel;
  transitionPanelMode(panelId: string, mode: PanelMode): void;
}

describe("panel mode transitions", () => {
  it("preserves an XY x signal without adding it to time-mode series", () => {
    const workspace = new WorkspaceModel();
    const panel = workspace.addPanelRow();
    for (let index = 0; index < 8; index += 1) {
      workspace.addSeries(panel.id, `run_01/s${String(index)}`);
    }
    workspace.addSeries(panel.id, "run_01/time");
    workspace.setXSignal(panel.id, "run_01/time");
    workspace.setMode(panel.id, "xy");

    const shell = Object.create(AppShell.prototype) as ShellProbe;
    shell.workspace = workspace;
    shell.transitionPanelMode(panel.id, "time");

    expect(workspace.panel(panel.id)?.x_signal).toBe("run_01/time");
    expect(workspace.panel(panel.id)?.series).toHaveLength(8);
    expect(
      workspace
        .panel(panel.id)
        ?.series.some((series) => series.path === "run_01/time"),
    ).toBe(false);

    shell.transitionPanelMode(panel.id, "xy");

    expect(workspace.panel(panel.id)?.x_signal).toBe("run_01/time");
    expect(workspace.panel(panel.id)?.series).toHaveLength(8);
    expect(
      workspace
        .panel(panel.id)
        ?.series.some((series) => series.path === "run_01/time"),
    ).toBe(false);
  });
});

describe("renderBatchProgress", () => {
  it("renders byte-weighted progress and the current file", () => {
    const progress = document.createElement("div");
    const running: BatchStatus = {
      state: "running",
      fraction: 0.37,
      total: "12",
      done: "4",
      failed: "1",
      current_paths: ["/data/run_07.csv"],
      recent_failures: [],
    };
    renderBatchProgress(progress, running, () => undefined);

    expect(
      progress.querySelector<HTMLElement>(".ingest-bar-fill")?.style.width,
    ).toBe("37%");
    expect(progress.textContent).toContain("37%");
    expect(progress.textContent).toContain("4/12");
    expect(progress.textContent).toContain("run_07.csv");
    expect(progress.querySelector(".ingest-cancel")).not.toBeNull();

    renderBatchProgress(progress, { ...running, state: "done", fraction: 1 }, () => undefined);
    expect(progress.querySelector(".ingest-bar")).toBeNull();
    expect(progress.querySelector(".ingest-cancel")).toBeNull();
  });
});

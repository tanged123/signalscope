// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { WorkspaceModel } from "../app/workspace";
import { SelectionModel } from "../app/selection";
import type { BatchStatus } from "../generated/protocol";
import type { PanelMode } from "../generated/session";
import {
  AppShell,
  arrivalModeFor,
  groupCursorRows,
  renderBatchProgress,
} from "./app-shell";

it("arrival mode focuses small additions and ghosts large additions", () => {
  expect(arrivalModeFor(0)).toBe("none");
  expect(arrivalModeFor(4)).toBe("focus");
  expect(arrivalModeFor(5)).toBe("ghost");
});

it("groups ghost cursor rows by channel while keeping focused rows itemized", () => {
  const rows = [
    ...Array.from({ length: 16 }, (_, index) => ({
      path: `run_${String(index + 1)}/temp`,
      label: `run_${String(index + 1)}/temp`,
      value: index + 1,
      unit: "C",
      colorIndex: 0,
    })),
    {
      path: "run_17/temp",
      label: "run_17/temp",
      value: 17,
      unit: "C",
      colorIndex: 1,
    },
    {
      path: "run_18/alt",
      label: "run_18/alt",
      value: 18,
      unit: "m",
      colorIndex: 2,
    },
  ];
  const grouped = groupCursorRows(
    rows,
    new Map(rows.slice(0, 16).map((row) => [row.path, "temp"])),
  );
  expect(grouped).toHaveLength(3);
  expect(grouped[0]?.label).toBe("temp · 16 ghosts");
  expect(grouped[1]?.label).toBe("run_17/temp");
  expect(grouped[2]?.label).toBe("run_18/alt");
});

interface ShellProbe {
  workspace: WorkspaceModel;
  transitionPanelMode(panelId: string, mode: PanelMode): void;
}

interface DockProbe {
  root: HTMLElement;
  dockMode: "tree" | "table";
  selection: SelectionModel;
  tree: { filteredKeys(): readonly string[] };
  table: { filteredKeys(): readonly string[] };
  setDockView(mode: "tree" | "table"): void;
  selectAllDockRows(): void;
}

describe("signals dock modes", () => {
  it("swaps tree and table while keeping the shared selection", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="tree-scroll"></div>
      <div class="table-scroll"></div>
      <button data-dock-view="tree"></button>
      <button data-dock-view="table"></button>
    `;
    const shell = Object.create(AppShell.prototype) as DockProbe;
    shell.root = root;
    shell.dockMode = "tree";
    shell.selection = new SelectionModel();
    shell.tree = { filteredKeys: () => ["tree"] };
    shell.table = { filteredKeys: () => ["table"] };
    shell.selection.toggle("shared");

    shell.setDockView("table");

    expect(root.querySelector<HTMLElement>(".tree-scroll")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".table-scroll")?.hidden).toBe(
      false,
    );
    expect(shell.selection.keys()).toEqual(["shared"]);
  });

  it("selects all rows from the active dock only", () => {
    const shell = Object.create(AppShell.prototype) as DockProbe;
    shell.root = document.createElement("div");
    shell.dockMode = "table";
    shell.selection = new SelectionModel();
    shell.tree = { filteredKeys: () => ["tree"] };
    shell.table = { filteredKeys: () => ["table-1", "table-2"] };

    shell.selectAllDockRows();

    expect(shell.selection.keys()).toEqual(["table-1", "table-2"]);
  });
});

describe("panel mode transitions", () => {
  it("preserves an XY x signal without adding it to time-mode series", () => {
    const workspace = new WorkspaceModel();
    const panel = workspace.addPanelRow();
    for (let index = 0; index < 8; index += 1) {
      workspace.addSeriesRef(panel.id, {
        source_key: "run_01",
        channel: `s${String(index)}`,
      });
    }
    workspace.addSeriesRef(panel.id, {
      source_key: "run_01",
      channel: "time",
    });
    workspace.setXRef(panel.id, { source_key: "run_01", channel: "time" });
    workspace.setMode(panel.id, "xy");

    const shell = Object.create(AppShell.prototype) as ShellProbe;
    shell.workspace = workspace;
    shell.transitionPanelMode(panel.id, "time");

    expect(workspace.panel(panel.id)?.x_ref).toEqual({
      source_key: "run_01",
      channel: "time",
    });
    expect(workspace.panel(panel.id)?.bindings[0]?.refs).toHaveLength(8);
    expect(
      workspace
        .panel(panel.id)
        ?.bindings.flatMap((binding) => binding.refs)
        .some((ref) => ref.source_key === "run_01" && ref.channel === "time"),
    ).toBe(false);

    shell.transitionPanelMode(panel.id, "xy");

    expect(workspace.panel(panel.id)?.x_ref).toEqual({
      source_key: "run_01",
      channel: "time",
    });
    expect(workspace.panel(panel.id)?.bindings[0]?.refs).toHaveLength(8);
    expect(
      workspace
        .panel(panel.id)
        ?.bindings.flatMap((binding) => binding.refs)
        .some((ref) => ref.source_key === "run_01" && ref.channel === "time"),
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

    renderBatchProgress(
      progress,
      { ...running, state: "done", fraction: 1 },
      () => undefined,
    );
    expect(progress.querySelector(".ingest-bar")).toBeNull();
    expect(progress.querySelector(".ingest-cancel")).toBeNull();
  });
});

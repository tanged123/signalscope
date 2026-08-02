// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { WorkspaceModel } from "../app/workspace";
import { SelectionModel } from "../app/selection";
import { Catalog } from "../app/catalog";
import type { SignalSummary } from "../generated/protocol";
import type { BatchStatus } from "../generated/protocol";
import type { SourceSummary } from "../generated/protocol";
import type { PanelMode, SeriesRef } from "../generated/session";
import {
  AppShell,
  arrivalModeFor,
  groupCursorRows,
  renderBatchProgress,
  renderDockFooter,
  shellMarkup,
  statusAggregate,
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

it("labels itemized cursor rows with the source-local channel", () => {
  const [row] = groupCursorRows(
    [
      {
        path: "run_07/temperature",
        label: "run_07/temperature",
        value: 1,
        unit: "C",
        colorIndex: 0,
      },
    ],
    new Map(),
  );

  expect(row?.label).toBe("run_07/temperature");
});

interface ShellProbe {
  workspace: WorkspaceModel;
  transitionPanelMode(panelId: string, mode: PanelMode): void;
}

interface DockProbe {
  root: HTMLElement;
  selection: SelectionModel;
  outline: { filteredKeys(): readonly string[] };
  selectAllDockRows(): void;
}

describe("signals outline dock", () => {
  it("keeps one outline surface and the shared selection", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="outline-scroll"></div>`;
    const shell = Object.create(AppShell.prototype) as DockProbe;
    shell.root = root;
    shell.selection = new SelectionModel();
    shell.outline = { filteredKeys: () => ["outline"] };
    shell.selection.toggle("shared");

    expect(root.querySelector(".outline-scroll")).not.toBeNull();
    expect(root.querySelector(".signal-outline-controls")).toBeNull();
    expect(shell.selection.keys()).toEqual(["shared"]);
  });

  it("selects all filtered outline rows", () => {
    const shell = Object.create(AppShell.prototype) as DockProbe;
    shell.root = document.createElement("div");
    shell.selection = new SelectionModel();
    shell.outline = { filteredKeys: () => ["outline-1", "outline-2"] };

    shell.selectAllDockRows();

    expect(shell.selection.keys()).toEqual(["outline-1", "outline-2"]);
  });
});

function bulkSummary(source: string, channel: string): SignalSummary {
  return {
    signal_id: `${source}-${channel}`,
    source_id: source,
    source_key: source,
    local_path: channel,
    path: `${source}/${channel}`,
    unit: "K",
    point_count: "10",
    t_min: 0,
    t_max: 1,
    last_value: 1,
  };
}

interface SelectionProbe {
  workspace: WorkspaceModel;
  catalog: Catalog;
  selection: SelectionModel;
  root: HTMLElement;
  selectionWorkspaceId: string | null;
  saveSelectedAsSet(): void;
  syncSelectionActions(): void;
  syncSelectionWorkspace(): void;
  reconcileSelection(): void;
}

describe("selection actions", () => {
  it("renders the SETS save-selection button", () => {
    const markup = shellMarkup();
    expect(markup).toContain('class="sets-save-selection"');
    expect(markup).not.toContain("bulk-bar");
    expect(markup).not.toContain("source-align");
    expect(markup).not.toContain("source-alignment-popover");
  });

  it("enables manual-set creation only when signals are selected", () => {
    const ref: SeriesRef = { source_key: "run-01", channel: "temp" };
    const catalog = Catalog.build([bulkSummary(ref.source_key, ref.channel)]);
    const shell = Object.create(AppShell.prototype) as SelectionProbe;
    shell.catalog = catalog;
    shell.selection = new SelectionModel();
    shell.root = document.createElement("div");
    shell.root.innerHTML = shellMarkup();
    const saveButton = shell.root.querySelector<HTMLButtonElement>(
      ".sets-save-selection",
    );
    const setNameRow = shell.root.querySelector<HTMLElement>(".set-name-row");
    if (saveButton === null || setNameRow === null)
      throw new Error("missing UI");

    shell.selection.clear();
    shell.syncSelectionActions();
    expect(saveButton.disabled).toBe(true);
    shell.selection.toggle(catalog.refKey(ref));
    shell.syncSelectionActions();
    expect(saveButton.disabled).toBe(false);
    shell.saveSelectedAsSet();
    expect(setNameRow.hidden).toBe(false);
  });

  it("clears selection when the active workspace changes", () => {
    const workspace = new WorkspaceModel();
    const shell = Object.create(AppShell.prototype) as SelectionProbe;
    shell.workspace = workspace;
    shell.selection = new SelectionModel();
    shell.selectionWorkspaceId = workspace.activeTabId();
    shell.selection.toggle("selected");

    workspace.addTab();
    shell.syncSelectionWorkspace();

    expect(shell.selection.keys()).toEqual([]);
  });

  it("reconciles selection against the current catalog", () => {
    const ref = { source_key: "run-01", channel: "temp" };
    const catalog = Catalog.build([bulkSummary(ref.source_key, ref.channel)]);
    const shell = Object.create(AppShell.prototype) as SelectionProbe;
    shell.catalog = catalog;
    shell.selection = new SelectionModel();
    shell.selection.setAll([
      catalog.refKey(ref),
      catalog.refKey({ source_key: "run-02", channel: "temp" }),
    ]);

    shell.reconcileSelection();

    expect(shell.selection.keys()).toEqual([catalog.refKey(ref)]);
  });
});

interface SourcesProbe {
  root: HTMLElement;
  plane: { listSources(): Promise<readonly SourceSummary[]> };
  workspace: WorkspaceModel;
  signals: SignalSummary[];
  workspacePath: string | null;
  updateSources(): Promise<void>;
}

function sourceSummary(sourceKey: string): SourceSummary {
  return {
    source_id: sourceKey,
    source_key: sourceKey,
    prefix: sourceKey,
    path: `/data/${sourceKey}.csv`,
    point_count: "10",
  };
}

describe("workspace identity", () => {
  it("aggregates source and signal counts in the title identity", async () => {
    const shell = Object.create(AppShell.prototype) as SourcesProbe;
    shell.root = document.createElement("div");
    shell.root.innerHTML = `
      <span class="source-name"></span>
      <span class="session-identity"></span>
    `;
    shell.workspace = new WorkspaceModel();
    shell.workspacePath = null;
    shell.signals = [
      bulkSummary("run-01", "temp"),
      bulkSummary("run-02", "temp"),
    ];
    shell.plane = {
      listSources: vi
        .fn()
        .mockResolvedValue([sourceSummary("run-01"), sourceSummary("run-02")]),
    };

    await shell.updateSources();

    expect(shell.root.querySelector(".source-name")?.textContent).toBe(
      "Untitled",
    );
    expect(shell.root.querySelector(".session-identity")?.textContent).toBe(
      "— 2 sources · 2 signals",
    );
  });

  it("advertises the selector grammar in the filter placeholder", () => {
    const markup = shellMarkup();
    expect(markup).toContain('placeholder="glob @ source · unit:K"');
    expect(markup).toContain('class="sets-save-selection"');
    expect(markup).not.toContain('class="signal-group-select"');
    expect(markup).not.toContain('class="outline-columns-button"');
    expect(markup).not.toContain('class="channel-suggestions"');
    expect(markup).not.toContain("dock-view");
  });
});

describe("source dock rail", () => {
  it("formats the status identity as one aggregate readout", () => {
    expect(statusAggregate(2, 17, 2_000)).toBe(
      "2 sources · 17 signals · 2,000 pts",
    );
  });

  it("does not render a duplicate per-source listing", () => {
    const markup = shellMarkup();
    expect(markup).not.toContain('class="source-rows"');
    expect(markup).toContain('class="ingest-progress"');
    expect(markup).not.toContain('class="channel-suggestions"');
  });

  it("shows aggregate counts, loaded formats, and a load action", () => {
    const element = document.createElement("div");
    const onAddSource = vi.fn();
    renderDockFooter(
      element,
      [
        sourceSummary("run-01"),
        { ...sourceSummary("run-02"), path: "/data/run-02.mcap" },
      ],
      17,
      onAddSource,
    );

    expect(element.querySelector(".dock-aggregate")?.textContent).toContain(
      "2 sources · 17 signals",
    );
    expect(element.querySelector(".dock-points")?.textContent).toBe("20 pts");
    expect(element.querySelector(".dock-formats")?.textContent).toBe(
      "CSV · MCAP",
    );
    element.querySelector<HTMLButtonElement>(".dock-add-source")?.click();
    expect(onAddSource).toHaveBeenCalledTimes(1);
  });

  it("shows the supported-format hint only for an empty workspace", () => {
    const element = document.createElement("div");
    renderDockFooter(element, [], 0, vi.fn());
    expect(element.querySelector(".dock-formats")?.textContent).toBe(
      "CSV · MCAP",
    );
    expect(element.querySelector(".dock-add-source")?.textContent).toBe(
      "+ source",
    );
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

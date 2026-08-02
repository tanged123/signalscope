// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { WorkspaceModel } from "../app/workspace";
import { SelectionModel } from "../app/selection";
import { Catalog } from "../app/catalog";
import type { SignalSummary } from "../generated/protocol";
import type { BatchStatus } from "../generated/protocol";
import type { SourceSummary } from "../generated/protocol";
import type { PanelMode } from "../generated/session";
import {
  AppShell,
  arrivalModeFor,
  groupCursorRows,
  renderBatchProgress,
  shellMarkup,
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

it("labels itemized cursor rows with their original source channel", () => {
  const catalog = Catalog.build(
    [
      {
        signal_id: "run_07-temp",
        source_id: "run_07",
        source_key: "run_07",
        local_path: "temperature",
        path: "run_07/temperature",
        unit: "C",
        point_count: "1",
        t_min: 0,
        t_max: 1,
        last_value: 1,
      },
    ],
    [
      {
        canonical: "temp",
        aliases: [{ source_key: "run_07", name: "temperature" }],
      },
    ],
  );
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
    catalog,
  );

  expect(row?.label).toBe("run_07/temperature (run_07: temperature)");
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

interface BulkProbe {
  workspace: WorkspaceModel;
  catalog: Catalog;
  selection: SelectionModel;
  root: HTMLElement;
  bulkBar: {
    setDeriveEnabled(enabled: boolean, title: string): void;
    setMergeEnabled?(enabled: boolean, title: string): void;
  };
  afterLayoutChange(): void;
  applyBulkStyle(style: {
    color_slot: number;
    dash: "solid" | "dash" | "dot";
    width: number;
  }): void;
  applyBulkVisibility(visible: boolean): void;
  updateBulkBar(): void;
}

interface SuggestionProbe {
  workspace: WorkspaceModel;
  catalog: Catalog;
  selection: SelectionModel;
  root: HTMLElement;
  reloadSignals(): Promise<void>;
  commitHistory(): void;
  afterLayoutChange(): void;
  renderChannelSuggestions(): void;
}

describe("bulk dock actions", () => {
  it("fans a selector style override across every resolving panel once", () => {
    const catalog = Catalog.build([
      bulkSummary("run-01", "temp"),
      bulkSummary("run-02", "temp"),
    ]);
    const workspace = new WorkspaceModel();
    const first = workspace.addPanelRow();
    const second = workspace.addPanelRow();
    const refs = [
      { source_key: "run-01", channel: "temp" },
      { source_key: "run-02", channel: "temp" },
    ];
    workspace.addSeriesRefs(first.id, refs);
    workspace.addSeriesRefs(second.id, refs);
    const shell = Object.create(AppShell.prototype) as BulkProbe;
    shell.workspace = workspace;
    shell.catalog = catalog;
    shell.selection = new SelectionModel();
    shell.root = document.createElement("div");
    shell.root.innerHTML = '<input class="signal-search" value="temp" />';
    shell.bulkBar = { setDeriveEnabled: vi.fn() };
    shell.afterLayoutChange = vi.fn();
    shell.selection.setAll(refs.map((ref) => catalog.refKey(ref)));

    shell.applyBulkStyle({ color_slot: 2, dash: "solid", width: 2 });

    expect(workspace.panel(first.id)?.overrides).toEqual([
      expect.objectContaining({ target_selector: "temp", target_ref: null }),
    ]);
    expect(workspace.panel(second.id)?.overrides).toEqual([
      expect.objectContaining({ target_selector: "temp", target_ref: null }),
    ]);
  });

  it("uses a target-ref override for a hand-picked hide", () => {
    const catalog = Catalog.build([bulkSummary("run-01", "temp")]);
    const workspace = new WorkspaceModel();
    const panel = workspace.addPanelRow();
    const ref = { source_key: "run-01", channel: "temp" };
    workspace.addSeriesRef(panel.id, ref);
    const shell = Object.create(AppShell.prototype) as BulkProbe;
    shell.workspace = workspace;
    shell.catalog = catalog;
    shell.selection = new SelectionModel();
    shell.root = document.createElement("div");
    shell.root.innerHTML = '<input class="signal-search" value="" />';
    shell.bulkBar = { setDeriveEnabled: vi.fn() };
    shell.afterLayoutChange = vi.fn();
    shell.selection.toggle(catalog.refKey(ref));

    shell.applyBulkVisibility(false);

    expect(workspace.panel(panel.id)?.overrides).toEqual([
      expect.objectContaining({
        target_ref: ref,
        target_selector: null,
        visible: false,
      }),
    ]);
  });

  it("enables derive for one channel and disables it across channels", () => {
    const catalog = Catalog.build([
      bulkSummary("run-01", "temp"),
      bulkSummary("run-02", "temp"),
      bulkSummary("run-01", "speed"),
    ]);
    const shell = Object.create(AppShell.prototype) as BulkProbe;
    shell.catalog = catalog;
    shell.selection = new SelectionModel();
    const setDeriveEnabled = vi.fn();
    shell.bulkBar = { setDeriveEnabled };

    shell.selection.setAll([
      catalog.refKey({ source_key: "run-01", channel: "temp" }),
      catalog.refKey({ source_key: "run-02", channel: "temp" }),
    ]);
    shell.updateBulkBar();
    expect(setDeriveEnabled).toHaveBeenLastCalledWith(true, expect.any(String));
    shell.selection.setAll([
      catalog.refKey({ source_key: "run-01", channel: "temp" }),
      catalog.refKey({ source_key: "run-01", channel: "speed" }),
    ]);
    shell.updateBulkBar();
    expect(setDeriveEnabled).toHaveBeenLastCalledWith(
      false,
      "Derive requires one channel",
    );
  });

  it("enables merge only when selection spans channel names", () => {
    const catalog = Catalog.build([
      bulkSummary("run-01", "temp"),
      bulkSummary("run-02", "Temp_C"),
    ]);
    const shell = Object.create(AppShell.prototype) as BulkProbe;
    shell.catalog = catalog;
    shell.selection = new SelectionModel();
    const setMergeEnabled = vi.fn();
    shell.bulkBar = { setDeriveEnabled: vi.fn(), setMergeEnabled };

    shell.selection.setAll([
      catalog.refKey({ source_key: "run-01", channel: "temp" }),
      catalog.refKey({ source_key: "run-02", channel: "Temp_C" }),
    ]);
    shell.updateBulkBar();

    expect(setMergeEnabled).toHaveBeenLastCalledWith(
      true,
      "Merge selected channels",
    );
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
    time_domain: {
      unit: "seconds",
      origin: "relative",
      alignment_origin: 0,
    },
    scale: 1,
    offset: 0,
  };
}

describe("workspace identity", () => {
  it("aggregates source and signal counts in the title identity", async () => {
    const shell = Object.create(AppShell.prototype) as SourcesProbe;
    shell.root = document.createElement("div");
    shell.root.innerHTML = `
      <span class="source-name"></span>
      <span class="session-identity"></span>
      <div class="source-rows"></div>
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
    expect(shellMarkup()).toContain('placeholder="glob @ source · unit:K"');
  });
});

describe("channel suggestions", () => {
  it("renders merge and keep actions from the tree footer", async () => {
    const shell = Object.create(AppShell.prototype) as SuggestionProbe;
    shell.root = document.createElement("div");
    shell.root.innerHTML = '<div class="channel-suggestions"></div>';
    shell.workspace = new WorkspaceModel();
    shell.catalog = Catalog.build([
      bulkSummary("run-01", "temp"),
      bulkSummary("run-02", "Temp_C"),
    ]);
    shell.selection = new SelectionModel();
    shell.reloadSignals = vi.fn().mockResolvedValue(undefined);
    shell.commitHistory = vi.fn();
    shell.afterLayoutChange = vi.fn();

    shell.renderChannelSuggestions();
    const suggestion = shell.root.querySelector<HTMLElement>(
      ".channel-suggestion",
    );
    expect(suggestion?.textContent).toContain("temp");
    suggestion?.querySelector<HTMLButtonElement>("button")?.click();
    await Promise.resolve();
    expect(shell.workspace.channelMap()).toEqual([
      {
        canonical: "temp",
        aliases: [
          { source_key: "run-01", name: "temp" },
          { source_key: "run-02", name: "Temp_C" },
        ],
      },
    ]);

    suggestion?.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    await Promise.resolve();
    expect(
      shell.workspace.channelMap().every((entry) => entry.aliases.length === 1),
    ).toBe(true);
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

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { WorkspaceModel } from "../app/workspace";
import { SelectionModel } from "../app/selection";
import { Catalog } from "../app/catalog";
import type { CommandRegistry } from "../app/commands";
import type { DataPlane } from "../app/data-plane";
import type { SignalSummary } from "../generated/protocol";
import type { BatchStatus } from "../generated/protocol";
import type { SourceSummary } from "../generated/protocol";
import type { PanelMode, SeriesRef } from "../generated/session";
import {
  AppShell,
  arrivalModeFor,
  bundleCompletionEntries,
  exportSourceOptions,
  groupCursorRows,
  renderBatchProgress,
  renderDockFooter,
  formatHint,
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
  expect(grouped[0]?.label).toBe("temp · 16 signals");
  expect(grouped[0]?.ghost).toBe(true);
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

interface DropProbe {
  root: HTMLElement;
  plane: { ingest: unknown };
  palette: { isOpen(): boolean } | null;
  exportDialog: { isOpen(): boolean } | null;
  loadSession: ReturnType<typeof vi.fn>;
  ingestPaths: ReturnType<typeof vi.fn>;
  reportError: ReturnType<typeof vi.fn>;
  onDragDrop(event: { kind: string; paths: string[] }): void;
  handleDrop(paths: string[]): Promise<void>;
}

function dropProbe(ingest: unknown, modalOpen = false): DropProbe {
  const probe = Object.create(AppShell.prototype) as DropProbe;
  probe.root = document.createElement("div");
  probe.root.innerHTML = `<div class="drop-overlay" hidden></div>`;
  probe.plane = { ingest };
  probe.palette = { isOpen: () => modalOpen };
  probe.exportDialog = null;
  probe.loadSession = vi.fn(() => Promise.resolve());
  probe.ingestPaths = vi.fn(() => Promise.resolve());
  probe.reportError = vi.fn();
  return probe;
}

const scanIngest = (files: string[]) => ({
  scanSources: () =>
    Promise.resolve({
      files,
      total_bytes: "0",
      format_counts: [],
    }),
  listFormats: () =>
    Promise.resolve([
      { id: "csv", label: "Delimited text", extensions: ["csv"] },
    ]),
});

describe("drag-drop routing", () => {
  it("shows the overlay on enter and hides it on leave", () => {
    const probe = dropProbe(scanIngest([]));
    const overlay = probe.root.querySelector(".drop-overlay");
    probe.onDragDrop({ kind: "enter", paths: [] });
    expect(overlay?.hasAttribute("hidden")).toBe(false);
    probe.onDragDrop({ kind: "leave", paths: [] });
    expect(overlay?.hasAttribute("hidden")).toBe(true);
  });

  it("ignores drops and keeps the overlay hidden while a modal is open", () => {
    const probe = dropProbe(scanIngest(["/a.csv"]), true);
    probe.onDragDrop({ kind: "enter", paths: [] });
    expect(
      probe.root.querySelector(".drop-overlay")?.hasAttribute("hidden"),
    ).toBe(true);
    probe.onDragDrop({ kind: "drop", paths: ["/a.csv"] });
    expect(probe.ingestPaths).not.toHaveBeenCalled();
  });

  it("opens a dropped workspace file through loadSession", async () => {
    const probe = dropProbe(scanIngest([]));
    await probe.handleDrop(["/w/flight.signalscope"]);
    expect(probe.loadSession).toHaveBeenCalledWith("/w/flight.signalscope");
    expect(probe.ingestPaths).not.toHaveBeenCalled();
  });

  it("expands data drops into the batch ingest path", async () => {
    const probe = dropProbe(scanIngest(["/runs/a.csv", "/runs/b.csv"]));
    await probe.handleDrop(["/runs"]);
    expect(probe.ingestPaths).toHaveBeenCalledWith([
      "/runs/a.csv",
      "/runs/b.csv",
    ]);
  });

  it("rejects mixed drops and reports the reason", async () => {
    const probe = dropProbe(scanIngest([]));
    await probe.handleDrop(["/w/a.signalscope", "/d/a.csv"]);
    expect(probe.reportError).toHaveBeenCalled();
    expect(probe.loadSession).not.toHaveBeenCalled();
    expect(probe.ingestPaths).not.toHaveBeenCalled();
  });

  it("reports the supported formats when a drop expands to nothing", async () => {
    const probe = dropProbe(scanIngest([]));
    await probe.handleDrop(["/empty"]);
    expect(probe.ingestPaths).not.toHaveBeenCalled();
    const error = (probe.reportError.mock.calls as unknown[][])[0]?.[0];
    expect(String(error)).toContain(".csv");
  });
});

describe("recipe-required ingest failures", () => {
  function ingestProbe(
    batchStatus: BatchStatus,
    introspect: ReturnType<typeof vi.fn>,
  ) {
    const shell = Object.create(AppShell.prototype) as {
      root: HTMLElement;
      plane: { ingest: Record<string, unknown> };
      reloadSignals: ReturnType<typeof vi.fn>;
      afterLayoutChange: ReturnType<typeof vi.fn>;
      reportError: ReturnType<typeof vi.fn>;
      ingestPaths(paths: string[]): Promise<void>;
    };
    shell.root = document.createElement("div");
    shell.root.innerHTML = '<div class="ingest-progress" hidden></div>';
    shell.reloadSignals = vi.fn(() => Promise.resolve());
    shell.afterLayoutChange = vi.fn();
    shell.reportError = vi.fn();
    shell.plane = {
      ingest: {
        startBatch: vi.fn(() => Promise.resolve("job")),
        batchStatus: vi.fn(() => Promise.resolve(batchStatus)),
        releaseBatch: vi.fn(() => Promise.resolve()),
        introspect,
      },
    };
    return shell;
  }

  it("still reloads signals when an unflagged wizard mount is unavailable", async () => {
    const introspect = vi.fn(() =>
      Promise.reject(new Error("unsupported container magic")),
    );
    const shell = ingestProbe(
      {
        state: "partial",
        fraction: 1,
        total: "1",
        done: "0",
        failed: "1",
        current_paths: [],
        recent_failures: [
          {
            path: "/runs/mystery.bin",
            error: "unsupported format",
            recipe_required: false,
          },
        ],
      },
      introspect,
    );

    await shell.ingestPaths(["/runs"]);

    expect(introspect).not.toHaveBeenCalled();
    expect(shell.reloadSignals).toHaveBeenCalled();
  });

  it("contains a failed recipe wizard mount and still reloads signals", async () => {
    const introspect = vi.fn(() =>
      Promise.reject(new Error("unsupported container magic")),
    );
    const shell = ingestProbe(
      {
        state: "partial",
        fraction: 1,
        total: "1",
        done: "0",
        failed: "1",
        current_paths: [],
        recent_failures: [
          {
            path: "/runs/mystery.h5",
            error: "HDF5 input requires a validated container recipe",
            recipe_required: true,
          },
        ],
      },
      introspect,
    );

    await shell.ingestPaths(["/runs"]);

    expect(introspect).toHaveBeenCalledWith("/runs/mystery.h5");
    expect(shell.reportError).toHaveBeenCalled();
    expect(shell.reloadSignals).toHaveBeenCalled();
  });
});

describe("direct open", () => {
  interface OpenProbe {
    plane: { ingest: unknown };
    pickAndIngest: ReturnType<typeof vi.fn>;
    openSources(): void;
    openFolder(): void;
  }

  function openProbe(): OpenProbe {
    const probe = Object.create(AppShell.prototype) as OpenProbe;
    probe.plane = { ingest: {} };
    probe.pickAndIngest = vi.fn(() => Promise.resolve());
    return probe;
  }

  it("opens the native file picker with no intermediate chooser", () => {
    const probe = openProbe();
    probe.openSources();
    expect(probe.pickAndIngest).toHaveBeenCalledWith("files");
  });

  it("opens the folder picker from the demoted command", () => {
    const probe = openProbe();
    probe.openFolder();
    expect(probe.pickAndIngest).toHaveBeenCalledWith("folder");
  });
});

describe("open command shortcuts", () => {
  it("opens a folder with the dedicated mod-alt-o shortcut", () => {
    const shell = new AppShell(document.createElement("div"), {
      sourceLabel: "test",
      ingest: {} as NonNullable<DataPlane["ingest"]>,
      derived: null,
      session: null,
      restore: null,
      preferences: null,
      exporter: null,
      listSignals: () => Promise.resolve([]),
      listSources: () => Promise.resolve([]),
      queryTiles: () => Promise.reject(new Error("not used")),
      querySamples: () => Promise.reject(new Error("not used")),
    } satisfies DataPlane);
    const internals = shell as unknown as {
      commands: CommandRegistry;
      openFolder: () => void;
      registerCommands: () => void;
    };
    const openFolder = vi
      .spyOn(internals, "openFolder")
      .mockImplementation(() => undefined);

    internals.registerCommands();

    expect(
      internals.commands
        .listAll()
        .find((command) => command.id === "open-folder")?.keys,
    ).toBe("mod+alt+o");
    expect(
      internals.commands.handleKey(
        new KeyboardEvent("keydown", {
          key: "o",
          ctrlKey: true,
          altKey: true,
        }),
      ),
    ).toBe(true);
    expect(openFolder).toHaveBeenCalledOnce();
  });
});

interface ArrivalProbe {
  workspace: WorkspaceModel;
  catalog: Catalog;
  afterSeriesAdded(panelId: string, refs: readonly SeriesRef[]): void;
}

it("stores the first series as real focus when large additions enter ghost mode", () => {
  const refs = Array.from({ length: 5 }, (_, index) => ({
    source_key: `run-0${String(index + 1)}`,
    channel: "response",
  }));
  const shell = Object.create(AppShell.prototype) as ArrivalProbe;
  shell.workspace = new WorkspaceModel();
  shell.catalog = Catalog.build(
    refs.map((ref) => bulkSummary(ref.source_key, ref.channel)),
  );
  const panel = shell.workspace.addPanelRow();

  shell.afterSeriesAdded(panel.id, refs);

  expect(shell.workspace.panel(panel.id)?.ghost_mode).toBe("ghost");
  expect(shell.workspace.focusEntries(panel.id)).toEqual([
    {
      kind: "series",
      ref: { source_key: "run-01", channel: "response" },
      source_key: null,
      channel: "response",
    },
  ]);
});

interface DockProbe {
  root: HTMLElement;
  selection: SelectionModel;
  outline: { filteredKeys(): readonly string[] };
  selectAllDockRows(): void;
}

describe("signals outline dock", () => {
  it("keeps one outline surface and the shared selection", () => {
    const root = document.createElement("div");
    root.innerHTML = shellMarkup();
    const shell = Object.create(AppShell.prototype) as DockProbe;
    shell.root = root;
    shell.selection = new SelectionModel();
    shell.outline = { filteredKeys: () => ["shared"] };

    shell.selectAllDockRows();

    expect(root.querySelectorAll(".outline-scroll")).toHaveLength(1);
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

it("collapses export choices to one label per source", () => {
  expect(
    exportSourceOptions([
      bulkSummary("run-02", "command"),
      bulkSummary("run-01", "command"),
      bulkSummary("run-02", "response"),
      bulkSummary("run-01", "temperature"),
    ]),
  ).toEqual([
    { key: "run-01", label: "run-01" },
    { key: "run-02", label: "run-02" },
  ]);
});

describe("derived channel collections", () => {
  it("offers channels shared by multiple sources as bundle references", () => {
    expect(
      bundleCompletionEntries([
        bulkSummary("run-01", "alt"),
        bulkSummary("run-02", "alt"),
        bulkSummary("run-01", "temp"),
      ]),
    ).toEqual([{ localPath: "alt", runCount: 2 }]);
  });

  it("creates one derived member per source through the bundle port", async () => {
    const created = [
      bulkSummary("run-01", "derived/score"),
      bulkSummary("run-02", "derived/score"),
    ];
    const createBundle = vi.fn().mockResolvedValue({
      local_path: "derived/score",
      created,
      skipped: [],
    });
    const shell = Object.create(AppShell.prototype) as {
      plane: unknown;
      workspace: WorkspaceModel;
      signals: SignalSummary[];
      catalog: Catalog;
      reloadSignals(): Promise<void>;
      afterSeriesAdded(panelId: string, refs: readonly SeriesRef[]): void;
      afterLayoutChange(): void;
      createDerived(path: string, expr: string): Promise<void>;
    };
    shell.plane = {
      derived: {
        createBundle,
      },
    };
    shell.workspace = new WorkspaceModel();
    shell.signals = [
      bulkSummary("run-01", "alt"),
      bulkSummary("run-02", "alt"),
    ];
    shell.catalog = Catalog.build(shell.signals);
    const panel = shell.workspace.addPanelRow();
    shell.workspace.focusPanel(panel.id);
    shell.reloadSignals = vi.fn(() => {
      shell.signals = [...created];
      shell.catalog = Catalog.build(created);
      return Promise.resolve();
    });
    shell.afterSeriesAdded = vi.fn();
    shell.afterLayoutChange = vi.fn();

    await shell.createDerived("derived/score", "'alt' * 2");

    expect(createBundle).toHaveBeenCalledWith("derived/score", "'alt' * 2");
    expect(shell.workspace.derivedBundles()).toEqual([
      { name: "score", expr: "'alt' * 2" },
    ]);
    expect(shell.workspace.panel(panel.id)?.bindings[0]).toMatchObject({
      kind: "pick",
      refs: [
        { source_key: "run-01", channel: "derived/score" },
        { source_key: "run-02", channel: "derived/score" },
      ],
    });
  });
});

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

  it("renders set naming inline beneath the SETS heading", () => {
    const root = document.createElement("div");
    root.innerHTML = shellMarkup();
    const heading = root.querySelector(".sets-heading");
    const editor = root.querySelector(".set-name-row");

    expect(heading?.nextElementSibling).toBe(editor);
    expect(root.querySelector(".search-wrap .set-name-row")).toBeNull();
    expect(editor?.classList.contains("tree-set-draft")).toBe(true);
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

  it("uses a plain-language filter placeholder", () => {
    const markup = shellMarkup();
    expect(markup).toContain('placeholder="Search signals…"');
    expect(markup).toContain('class="sets-save-selection"');
    expect(markup).not.toContain('class="signal-group-select"');
    expect(markup).not.toContain('class="outline-columns-button"');
    expect(markup).not.toContain('class="channel-suggestions"');
    expect(markup).not.toContain("dock-view");
  });
});

describe("source dock rail", () => {
  it("derives the empty-state format hint from registered extensions", () => {
    expect(
      formatHint([
        { id: "parquet", label: "Parquet", extensions: ["parquet", "pq"] },
        { id: "csv", label: "CSV", extensions: ["csv"] },
      ]),
    ).toBe("CSV · PARQUET · PQ");
  });

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
    expect(element.querySelector(".dock-formats")?.textContent).toBe("—");
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

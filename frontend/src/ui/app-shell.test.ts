// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareResponseFeeds = vi.hoisted(() => vi.fn());

vi.mock("../render/m4-feed", async () => ({
  ...(await vi.importActual<typeof import("../render/m4-feed")>(
    "../render/m4-feed",
  )),
  prepareResponseFeeds,
}));

import { WorkspaceModel } from "../app/workspace";
import { SelectionModel } from "../app/selection";
import { Catalog } from "../app/catalog";
import { defaultPreferences } from "../app/preferences";
import type { CommandRegistry } from "../app/commands";
import type { DataPlane } from "../app/data-plane";
import type { SignalSummary } from "../generated/protocol";
import type { BatchStatus } from "../generated/protocol";
import type { SourceSummary } from "../generated/protocol";
import {
  binColumnsFromWire,
  type ColumnarTileResponse,
} from "../app/bin-columns";
import type { SeriesRef } from "../generated/session";
import { TileWindowCache } from "../app/tile-window-cache";
import {
  AppShell,
  arrivalModeFor,
  bundleCompletionEntries,
  clearIngestProgress,
  exportSourceOptions,
  groupCursorRows,
  renderBatchProgress,
  renderDockFooter,
  formatHint,
  shellMarkup,
  statusAggregate,
} from "./app-shell";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tileResponse(signalId = "1"): ColumnarTileResponse {
  return {
    requestId: `tiles-${signalId}`,
    series: [
      {
        signalId,
        signalPath: "run/value",
        unit: "V",
        level: 0,
        bins: binColumnsFromWire([
          {
            t0: 0,
            t1: 1,
            first: 1,
            last: 2,
            min: 1,
            max: 2,
            sum: 3,
            sum_sq: 5,
            finite_count: "2",
            sample_count: "2",
            has_gap: false,
          },
        ]),
      },
    ],
  };
}

type RefreshShell = {
  root: HTMLElement;
  workspace: { panels(): { id: string; mode: "time" }[] };
  workspaceView: null;
  plane: Pick<DataPlane, "queryTiles">;
  tileWindowCache: TileWindowCache;
  panelSignalIds(): { ids: string[]; missing: string[] };
  resolvedFor(): { visible: boolean }[];
  effectiveWindow(): { t0: number; t1: number };
  renderTiles(): void;
  reportError(error: unknown): void;
  refreshToken: number;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  tilesByPanel: Map<string, ColumnarTileResponse>;
  missingByPanel: Map<string, string[]>;
  refreshTiles(): Promise<void>;
};

function refreshShell(
  queryTiles: DataPlane["queryTiles"],
  panelIds = ["panel-1"],
): RefreshShell {
  const shell = Object.create(AppShell.prototype) as RefreshShell;
  shell.root = document.createElement("div");
  shell.root.innerHTML = '<div class="workspace"></div>';
  shell.workspace = {
    panels: () => panelIds.map((id) => ({ id, mode: "time" as const })),
  };
  shell.workspaceView = null;
  shell.plane = { queryTiles };
  shell.tileWindowCache = new TileWindowCache();
  shell.panelSignalIds = vi.fn(() => ({ ids: ["1"], missing: [] }));
  shell.resolvedFor = vi.fn(() => [{ visible: true }]);
  shell.effectiveWindow = vi.fn(() => ({ t0: 0, t1: 5 }));
  shell.renderTiles = vi.fn();
  shell.reportError = vi.fn();
  shell.refreshToken = 0;
  shell.refreshPromise = null;
  shell.refreshQueued = false;
  shell.tilesByPanel = new Map();
  shell.missingByPanel = new Map();
  return shell;
}

describe("sample refresh requests", () => {
  interface RefreshProbe {
    root: HTMLElement;
    workspace: {
      panels(): { id: string; mode: "time" }[];
    };
    plane: Pick<DataPlane, "queryTiles" | "querySamples">;
    tileWindowCache: TileWindowCache;
    panelSignalIds(): { ids: string[]; missing: string[] };
    resolvedFor(): { visible: boolean }[];
    effectiveWindow(): { t0: number; t1: number };
    renderTiles(): void;
    reportError(error: unknown): void;
    refreshToken: number;
    refreshTilesPass(token: number): Promise<void>;
  }

  function refreshProbe() {
    const querySamples = vi.fn<DataPlane["querySamples"]>(() =>
      Promise.resolve({ request_id: "samples", series: [] }),
    );
    const queryTiles = vi.fn<DataPlane["queryTiles"]>(() =>
      Promise.resolve({ requestId: "tiles", series: [] }),
    );
    const shell = Object.create(AppShell.prototype) as RefreshProbe;
    shell.root = document.createElement("div");
    shell.root.innerHTML = '<div class="workspace"></div>';
    shell.workspace = {
      panels: () => [{ id: "panel-1", mode: "time" }],
    };
    shell.plane = { queryTiles, querySamples };
    shell.tileWindowCache = new TileWindowCache();
    shell.panelSignalIds = vi.fn(() => ({ ids: ["1"], missing: [] }));
    shell.resolvedFor = vi.fn(() => [{ visible: true }]);
    shell.effectiveWindow = vi.fn(() => ({ t0: 20, t1: 79 }));
    shell.renderTiles = vi.fn();
    shell.reportError = vi.fn();
    shell.refreshToken = 0;
    return { shell, querySamples };
  }

  it("does not issue an uncapped sample request for live refresh", async () => {
    const { shell, querySamples } = refreshProbe();
    await shell.refreshTilesPass(0);
    expect(querySamples).not.toHaveBeenCalled();
  });
});

describe("tile refresh cache", () => {
  it("reuses a dense raw window without a second plane query", async () => {
    const queryTiles = vi.fn<DataPlane["queryTiles"]>(() =>
      Promise.resolve({
        requestId: "tiles",
        series: [
          {
            signalId: "1",
            signalPath: "run/value",
            unit: null,
            level: 0,
            bins: binColumnsFromWire(
              Array.from({ length: 12 }, (_, index) => ({
                t0: index,
                t1: index,
                first: index,
                last: index,
                min: index,
                max: index,
                sum: index,
                sum_sq: index * index,
                finite_count: "1",
                sample_count: "1",
                has_gap: false,
              })),
            ),
          },
        ],
      }),
    );
    const shell = Object.create(AppShell.prototype) as {
      root: HTMLElement;
      workspace: { panels(): { id: string; mode: "time" }[] };
      workspaceView: null;
      plane: Pick<DataPlane, "queryTiles">;
      tileWindowCache: TileWindowCache;
      panelSignalIds(): { ids: string[]; missing: string[] };
      resolvedFor(): { visible: boolean }[];
      effectiveWindow(): { t0: number; t1: number };
      renderTiles(): void;
      reportError: ReturnType<typeof vi.fn>;
      refreshToken: number;
      refreshTilesPass(token: number): Promise<void>;
    };
    shell.root = document.createElement("div");
    shell.root.innerHTML = '<div class="workspace"></div>';
    shell.workspace = {
      panels: () => [{ id: "panel-1", mode: "time" }],
    };
    shell.workspaceView = null;
    shell.plane = { queryTiles };
    shell.tileWindowCache = new TileWindowCache();
    shell.panelSignalIds = vi.fn(() => ({ ids: ["1"], missing: [] }));
    shell.resolvedFor = vi.fn(() => [{ visible: true }]);
    shell.effectiveWindow = vi.fn(() => ({ t0: 0, t1: 5 }));
    shell.renderTiles = vi.fn();
    shell.reportError = vi.fn();
    shell.refreshToken = 0;

    await shell.refreshTilesPass(0);
    await shell.refreshTilesPass(0);

    expect(queryTiles).toHaveBeenCalledOnce();
    const { reportError } = shell;
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("adaptive tile refresh", () => {
  beforeEach(() => {
    prepareResponseFeeds.mockReset();
  });

  it("keeps stale drawable tiles while refinement is pending", async () => {
    const pending = deferred<ColumnarTileResponse>();
    const queryTiles = vi.fn(() => pending.promise);
    const shell = refreshShell(queryTiles);
    const stale = tileResponse();
    shell.tileWindowCache.store("panel-1", {
      response: {
        ...stale,
        series: stale.series.map((series) => ({
          ...series,
          level: 2,
          bins: binColumnsFromWire(
            Array.from({ length: 20 }, (_, index) => ({
              t0: index,
              t1: index + 5,
              first: 1,
              last: 2,
              min: 1,
              max: 2,
              sum: 3,
              sum_sq: 5,
              finite_count: "2",
              sample_count: "2",
              has_gap: false,
            })),
          ),
        })),
      },
      window: { t0: 0, t1: 25 },
      pixelWidth: 1,
      requestedDevicePixels: 1,
      idsKey: "1",
    });
    shell.effectiveWindow = vi.fn(() => ({ t0: 8, t1: 12 }));
    shell.tilesByPanel = new Map([["panel-1", stale]]);

    const refresh = shell.refreshTiles();
    await Promise.resolve();

    expect(queryTiles).toHaveBeenCalledOnce();
    expect(shell.tilesByPanel.get("panel-1")).toBe(stale);
    expect(shell.renderTiles).not.toHaveBeenCalled();
    pending.resolve(tileResponse());
    await refresh;
  });

  it("discards a superseded response before the queued refresh publishes", async () => {
    const first = deferred<ColumnarTileResponse>();
    const second = deferred<ColumnarTileResponse>();
    const queryTiles = vi
      .fn<DataPlane["queryTiles"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const shell = refreshShell(queryTiles);

    const refresh = shell.refreshTiles();
    await Promise.resolve();
    const queued = shell.refreshTiles();
    first.resolve(tileResponse("first"));
    await Promise.resolve();
    await Promise.resolve();

    expect(shell.renderTiles).not.toHaveBeenCalled();
    expect(shell.tileWindowCache.get("panel-1")).toBeNull();
    second.resolve(tileResponse("second"));
    await Promise.all([refresh, queued]);

    expect(shell.renderTiles).toHaveBeenCalledOnce();
    expect(shell.tileWindowCache.get("panel-1")?.response.requestId).toBe(
      "tiles-second",
    );
  });

  it("prewarms every replacement before publishing the map", async () => {
    const order: string[] = [];
    prepareResponseFeeds.mockImplementation(() => order.push("prewarm"));
    const queryTiles = vi.fn(
      (request: Parameters<DataPlane["queryTiles"]>[0]) =>
        Promise.resolve(tileResponse(request.signal_ids[0] ?? "1")),
    );
    const shell = refreshShell(queryTiles, ["panel-1", "panel-2"]);
    shell.panelSignalIds = vi.fn((panel: { id: string }) => ({
      ids: [panel.id === "panel-1" ? "1" : "2"],
      missing: [],
    })) as RefreshShell["panelSignalIds"];
    shell.renderTiles = vi.fn(() => order.push("render"));

    await shell.refreshTiles();

    expect(prepareResponseFeeds).toHaveBeenCalledTimes(2);
    expect(
      queryTiles.mock.calls.every(
        ([request]) => request.max_total_bins === null,
      ),
    ).toBe(true);
    expect(order).toEqual(["prewarm", "prewarm", "render"]);
  });

  it("rejects more than 3,000 visible resolved series before querying", async () => {
    const queryTiles = vi.fn<DataPlane["queryTiles"]>();
    const shell = refreshShell(queryTiles);
    shell.resolvedFor = vi.fn(() =>
      Array.from({ length: 3001 }, () => ({ visible: true })),
    );
    const current = new Map<string, ColumnarTileResponse>([
      ["panel-1", tileResponse()],
    ]);
    shell.tilesByPanel = current;

    await shell.refreshTiles();

    expect(shell.reportError).toHaveBeenCalledWith(
      "series limit exceeded: 3001 visible; maximum 3000",
    );
    expect(queryTiles).not.toHaveBeenCalled();
    expect(shell.tilesByPanel).toBe(current);
    expect(shell.renderTiles).not.toHaveBeenCalled();
  });
});

describe("render errors", () => {
  it.each([["ChartGPU render", new Error("ChartGPU render failed")]])(
    "reports synchronous %s errors without retrying",
    (_label, error) => {
      const renderData = vi.fn(() => {
        throw error;
      });
      const shell = Object.create(AppShell.prototype) as {
        root: HTMLElement;
        workspace: { linkedTime(): { t0: number; t1: number } };
        workspaceView: {
          renderData: typeof renderData;
        };
        tilesByPanel: Map<string, ColumnarTileResponse>;
        missingByPanel: Map<string, string[]>;
        reportError: ReturnType<typeof vi.fn>;
        renderTiles(): void;
      };
      shell.root = document.createElement("div");
      shell.root.innerHTML = '<span class="render-ms"></span>';
      shell.workspace = {
        linkedTime: () => ({ t0: 0, t1: 1 }),
      };
      shell.workspaceView = { renderData };
      shell.tilesByPanel = new Map();
      shell.missingByPanel = new Map();
      shell.reportError = vi.fn();

      expect(() => shell.renderTiles()).not.toThrow();
      expect(renderData).toHaveBeenCalledOnce();
      const { reportError } = shell;
      expect(reportError).toHaveBeenCalledWith(error);
    },
  );
});

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

  it("mounts the recipe wizard when introspection succeeds", async () => {
    const introspect = vi.fn(() =>
      Promise.resolve({
        container: "hdf5",
        datasets: [
          {
            path: "run/time",
            kind: "numeric",
            len: "2",
            shape: [2],
            sample_preview: [0, 1],
          },
        ],
      }),
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

    expect(document.querySelector(".import-wizard")).not.toBeNull();
    expect(shell.reportError).not.toHaveBeenCalled();
    expect(shell.reloadSignals).toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
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

  it("renders a dismiss control alongside failures", () => {
    const progress = document.createElement("div");
    renderBatchProgress(
      progress,
      {
        state: "done",
        fraction: 0.5,
        done: "1",
        total: "2",
        failed: "1",
        current_paths: [],
        recent_failures: [
          {
            path: "/a/broken.csv",
            error: "no data rows",
            recipe_required: false,
          },
        ],
      },
      () => {},
    );
    const dismiss =
      progress.querySelector<HTMLButtonElement>(".ingest-dismiss");
    expect(dismiss).not.toBeNull();
    dismiss?.click();
    expect(progress.hidden).toBe(true);
    expect(progress.childElementCount).toBe(0);
  });

  it("renders no dismiss control while a batch is running", () => {
    const progress = document.createElement("div");
    renderBatchProgress(
      progress,
      {
        state: "running",
        fraction: 0.25,
        done: "1",
        total: "4",
        failed: "0",
        current_paths: ["/a/one.csv"],
        recent_failures: [],
      },
      () => {},
    );
    expect(progress.querySelector(".ingest-dismiss")).toBeNull();
  });

  it("clearIngestProgress hides and empties the banner", () => {
    const root = document.createElement("div");
    const progress = document.createElement("div");
    progress.className = "ingest-progress";
    progress.hidden = false;
    progress.append(document.createElement("span"));
    root.append(progress);
    clearIngestProgress(root);
    expect(progress.hidden).toBe(true);
    expect(progress.childElementCount).toBe(0);
  });
});

describe("workspace theme persistence", () => {
  it("keeps the user's theme across a new workspace", async () => {
    const workspace = new WorkspaceModel();
    const shell = Object.create(AppShell.prototype) as {
      root: HTMLElement;
      plane: { session: { reset: ReturnType<typeof vi.fn> } };
      workspace: WorkspaceModel;
      prefs: ReturnType<typeof defaultPreferences> & { theme: "light" };
      selection: { clear: ReturnType<typeof vi.fn> };
      history: { reset: ReturnType<typeof vi.fn> };
      autosaveTimer: number | null;
      workspacePath: string | null;
      tilesByPanel: Map<string, unknown>;
      missingByPanel: Map<string, unknown>;
      workspaceView: null;
      reloadSignals: ReturnType<typeof vi.fn>;
      afterLayoutChange: ReturnType<typeof vi.fn>;
      renderWorkspaceName: ReturnType<typeof vi.fn>;
      newWorkspace(): Promise<void>;
    };
    shell.root = document.createElement("div");
    shell.root.innerHTML = '<div class="ingest-progress"></div>';
    shell.workspace = workspace;
    shell.prefs = { ...defaultPreferences(), theme: "light" };
    shell.selection = { clear: vi.fn() };
    shell.history = { reset: vi.fn() };
    shell.autosaveTimer = null;
    shell.workspacePath = null;
    shell.tilesByPanel = new Map();
    shell.missingByPanel = new Map();
    shell.workspaceView = null;
    shell.reloadSignals = vi.fn(() => Promise.resolve());
    shell.afterLayoutChange = vi.fn();
    shell.renderWorkspaceName = vi.fn();
    shell.plane = {
      session: {
        reset: vi.fn(() =>
          Promise.resolve({
            session_json: JSON.stringify(workspace.snapshot()),
          }),
        ),
      },
    };

    await shell.newWorkspace();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("uses the serialized theme for a baked plane without preferences", () => {
    const shell = Object.create(AppShell.prototype) as {
      plane: { preferences: null };
      workspace: { theme(): "light"; setTheme: ReturnType<typeof vi.fn> };
      prefs: ReturnType<typeof defaultPreferences>;
      restoreTheme(): void;
    };
    shell.plane = { preferences: null };
    shell.workspace = { theme: () => "light", setTheme: vi.fn() };
    shell.prefs = defaultPreferences();

    shell.restoreTheme();

    expect(shell.prefs.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(shell.workspace.setTheme).not.toHaveBeenCalled();
  });
});

describe("recipe directory settings entries", () => {
  interface RecipeProbe {
    plane: { preferences: unknown };
    prefs: { recipe_directory: string | null };
    recipeDirectory: string | null;
    updatePreferences: ReturnType<typeof vi.fn>;
    refreshRecipeDirectory: ReturnType<typeof vi.fn>;
    reportError: ReturnType<typeof vi.fn>;
    recipeDirectoryEntries(): {
      title: string;
      hint: string;
      run: () => void;
    }[];
  }

  function recipeProbe(
    custom: string | null,
    picked: string | null = "/picked/recipes",
  ): RecipeProbe {
    const probe = Object.create(AppShell.prototype) as RecipeProbe;
    probe.plane = {
      preferences: {
        effectiveRecipeDirectory: () =>
          Promise.resolve(custom ?? "/default/recipes"),
        pickRecipeDirectory: () => Promise.resolve(picked),
      },
    };
    probe.prefs = { recipe_directory: custom };
    probe.recipeDirectory = custom ?? "/default/recipes";
    probe.updatePreferences = vi.fn();
    probe.refreshRecipeDirectory = vi.fn(() => Promise.resolve(undefined));
    probe.reportError = vi.fn();
    return probe;
  }

  it("shows the host-resolved directory and hides reset while on the default", () => {
    const entries = recipeProbe(null).recipeDirectoryEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("Recipe directory");
    expect(entries[0]?.hint).toBe("/default/recipes");
  });

  it("offers reset only while a custom directory is set", () => {
    const entries = recipeProbe("/home/me/recipes").recipeDirectoryEntries();

    expect(entries.map((entry) => entry.title)).toEqual([
      "Recipe directory",
      "Use default recipe directory",
    ]);
    expect(entries[0]?.hint).toBe("/home/me/recipes");
  });

  it("stores the picked directory", async () => {
    const probe = recipeProbe(null);
    probe.recipeDirectoryEntries()[0]?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(probe.updatePreferences).toHaveBeenCalledWith({
      recipe_directory: "/picked/recipes",
    });
  });

  it("leaves the directory unchanged when the picker is cancelled", async () => {
    const probe = recipeProbe("/home/me/recipes", null);
    probe.recipeDirectoryEntries()[0]?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(probe.updatePreferences).not.toHaveBeenCalled();
  });

  it("clears the preference back to the default", () => {
    const probe = recipeProbe("/home/me/recipes");
    probe.recipeDirectoryEntries()[1]?.run();

    expect(probe.updatePreferences).toHaveBeenCalledWith({
      recipe_directory: null,
    });
  });
});

describe("appearance settings entries", () => {
  interface AppearanceProbe {
    prefs: ReturnType<typeof defaultPreferences>;
    updatePreferences(patch: Record<string, unknown>): void;
    toggleTheme(): void;
    recipeDirectoryEntries(): [];
    settingsEntries(): Array<{
      title: string;
      hint: string;
      adjust?: (direction: -1 | 1) => void;
    }>;
  }

  function appearanceProbe(): AppearanceProbe {
    const probe = Object.create(AppShell.prototype) as AppearanceProbe;
    probe.prefs = defaultPreferences();
    probe.updatePreferences = (patch) => {
      Object.assign(probe.prefs, patch);
    };
    probe.toggleTheme = vi.fn();
    probe.recipeDirectoryEntries = () => [];
    return probe;
  }

  it("adjusts global plot line width in quarter steps", () => {
    const probe = appearanceProbe();
    const entry = probe
      .settingsEntries()
      .find(({ title }) => title === "Plot line width");

    expect(entry?.hint).toBe("100%");
    entry?.adjust?.(1);
    expect(probe.prefs.plot_line_width_scale).toBe(1.25);
    expect(
      probe.settingsEntries().find(({ title }) => title === "Plot line width")
        ?.hint,
    ).toBe("125%");
    probe.prefs.plot_line_width_scale = 1;
    entry?.adjust?.(-1);
    expect(probe.prefs.plot_line_width_scale).toBe(0.75);
  });
});

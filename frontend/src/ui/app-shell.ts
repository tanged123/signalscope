import { CommandRegistry, formatCombo } from "../app/commands";
import type { DataPlane } from "../app/data-plane";
import { runIngest } from "../app/ingest";
import { LinkedTimeModel } from "../app/linked-time";
import { WorkspaceModel } from "../app/workspace";
import {
  formatCursorTime,
  formatValue,
  valueAtTime,
  zoomRange,
} from "../app/plot-math";
import { type SignalSummary, type TileResponse } from "../generated/protocol";
import type { PanelState } from "../generated/session";
import { resolveSeriesStyle } from "../render/canvas-renderer";
import { CommandPalette, type PaletteEntry } from "./command-palette";
import { basename, bindPointerDrag, required } from "./dom";
import { SignalTreeView } from "./signal-tree";
import { WorkspaceTabsView } from "./workspace-tabs";
import { WorkspaceView } from "./workspace-view";

const TREE_WIDTH = { default: 262, collapse: 120, min: 180, max: 480 } as const;

export class AppShell {
  private readonly time = new LinkedTimeModel();
  private readonly workspace = new WorkspaceModel();
  private readonly commands = new CommandRegistry();
  private signals: SignalSummary[] = [];
  private signalsByPath = new Map<string, SignalSummary>();
  private workspaceView: WorkspaceView | null = null;
  private workspaceTabs: WorkspaceTabsView | null = null;
  private tree: SignalTreeView | null = null;
  private palette: CommandPalette | null = null;
  private tilesByPanel = new Map<string, TileResponse>();
  private signalTreeWidth: number = TREE_WIDTH.default;
  private refreshToken = 0;
  private renderScheduled = false;
  private refreshTimer: number | null = null;
  private liveValuesScheduled = false;
  private pendingCursorT: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly plane: DataPlane,
  ) {}

  async mount(): Promise<void> {
    this.root.innerHTML = shellMarkup();
    this.workspaceTabs = new WorkspaceTabsView(
      required(this.root, ".workspace-tabs"),
      {
        onSelect: (id) => {
          if (this.workspace.selectTab(id)) this.afterLayoutChange();
        },
        onAdd: () => {
          this.workspace.addTab();
          this.afterLayoutChange();
        },
        onClose: (id) => {
          this.workspace.closeTab(id);
          this.afterLayoutChange();
        },
      },
    );
    this.workspaceView = new WorkspaceView(
      required(this.root, ".workspace"),
      this.workspace,
      {
        onFocus: (id) => {
          this.workspace.focusPanel(id);
        },
        onClose: (id) => {
          this.workspace.closePanel(id);
          this.afterLayoutChange();
        },
        onSplitRight: (id) => {
          this.workspace.splitPanelRight(id);
          this.afterLayoutChange();
        },
        onSplitDown: (id) => {
          this.workspace.splitPanelDown(id);
          this.afterLayoutChange();
        },
        onMaximize: (id) => {
          this.workspace.toggleMaximize(id);
          this.afterLayoutChange();
        },
        onSelectMode: (id, mode) => {
          this.workspace.setMode(id, mode);
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onDropSignal: (id, path) => {
          this.plotSignal(path, id);
        },
        onToggleSeries: (id, path) => {
          this.workspace.toggleSeriesVisible(id, path);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onResized: () => {
          this.scheduleRender();
        },
        onCursor: (id, cursorT, client) => {
          this.setCursor(id, cursorT, client);
        },
        onTimeWindow: (id, t0, t1) => {
          this.applyTimeWindow(id, t0, t1);
        },
        onYRange: (id, range) => {
          this.workspace.setPanelYRange(id, [range[0], range[1]]);
          this.scheduleRender();
        },
        onPinAnnotation: (id, hit) => {
          this.workspace.addAnnotation(id, {
            id: crypto.randomUUID(),
            series_path: hit.path,
            time: hit.time,
            value: hit.value,
            label: "",
          });
          this.workspaceView?.refreshPanelStates();
        },
        onRemoveAnnotation: (id, annotationId) => {
          this.workspace.removeAnnotation(id, annotationId);
          this.workspaceView?.refreshPanelStates();
        },
        onEditAnnotationLabel: (id, annotationId, label) => {
          this.workspace.setAnnotationLabel(id, annotationId, label);
          this.workspaceView?.refreshPanelStates();
        },
        onFitView: (id) => {
          this.fitPanelView(id);
        },
        onToggleStats: (id) => {
          this.workspace.toggleStats(id);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onRenameTitle: (id, title) => {
          this.workspace.renamePanel(id, title);
          this.afterLayoutChange();
        },
        onEditAxisLabel: (id, axis, label) => {
          this.workspace.setAxisLabel(id, axis, label);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onSetSeriesStyle: (id, path, style) => {
          this.workspace.setSeriesStyle(id, path, style);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onRemoveSeries: (id, path) => {
          this.workspace.removeSeries(id, path);
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onLayoutChanged: () => {
          void this.refreshTiles();
        },
        onDropSignalNewPanel: (path) => {
          const panel = this.workspace.addPanelRow();
          this.plotSignal(path, panel.id);
        },
        onMovePanel: (id, rowIndex, cellIndex) => {
          this.workspace.movePanel(id, rowIndex, cellIndex);
          this.afterLayoutChange();
        },
        onShowPanel: (id) => {
          this.workspace.maximizePanel(id);
          this.afterLayoutChange();
        },
        onRestoreGrid: () => {
          this.workspace.restoreGrid();
          this.afterLayoutChange();
        },
      },
    );
    this.tree = new SignalTreeView(
      required(this.root, ".tree-scroll"),
      required(this.root, ".tree-favorites"),
      {
        onPlotSignal: (path) => {
          this.plotSignal(path);
        },
        onToggleFavorite: (path) => {
          this.workspace.toggleFavorite(path);
          this.tree?.setFavorites(this.workspace.favorites());
        },
      },
    );
    this.palette = new CommandPalette(this.root, () => this.paletteEntries());
    this.registerCommands();
    this.bindControls();
    this.renderWindowReadout();
    await this.reloadSignals();
    if (this.signals.length > 0 && this.workspace.panels().length === 0) {
      const panel = this.workspace.addPanelRow();
      for (const summary of this.signals.slice(0, 2)) {
        this.workspace.addSeries(panel.id, summary.path);
      }
      this.fitWindowToPlotted();
    }
    this.afterLayoutChange();
  }

  private registerCommands(): void {
    const zoomFocusedPanel = (factor: number): void => {
      const id = this.workspace.focusedPanelId();
      const panel = id === null ? undefined : this.workspace.panel(id);
      if (id === null || panel === undefined) return;
      const window = this.effectiveWindow(panel);
      const pivot = (window.t0 + window.t1) / 2;
      const next = zoomRange({ min: window.t0, max: window.t1 }, factor, pivot);
      this.applyTimeWindow(id, next.min, next.max);
    };
    const panFocusedPanel = (direction: -1 | 1): void => {
      const id = this.workspace.focusedPanelId();
      const panel = id === null ? undefined : this.workspace.panel(id);
      if (id === null || panel === undefined) return;
      const window = this.effectiveWindow(panel);
      const delta = (window.t1 - window.t0) * 0.1 * direction;
      this.applyTimeWindow(id, window.t0 + delta, window.t1 + delta);
    };
    this.commands.register({
      id: "open-files",
      title: "Open CSV or MCAP…",
      keys: "o",
      enabled: () => this.plane.ingest !== null,
      run: () => {
        void this.openFiles();
      },
    });
    this.commands.register({
      id: "new-workspace-tab",
      title: "New workspace tab",
      run: () => {
        this.workspace.addTab();
        this.afterLayoutChange();
      },
    });
    this.commands.register({
      id: "close-workspace-tab",
      title: "Close active workspace tab",
      enabled: () => this.workspace.tabs().length > 1,
      run: () => {
        this.workspace.closeTab(this.workspace.activeTabId());
        this.afterLayoutChange();
      },
    });
    this.commands.register({
      id: "split-panel-down",
      title: "Split current panel down",
      keys: "n",
      run: () => {
        const id = this.workspace.focusedPanelId();
        if (id === null) {
          this.workspace.addPanelRow();
        } else {
          this.workspace.splitPanelDown(id);
        }
        this.afterLayoutChange();
      },
    });
    this.registerFocusedPanelCommand(
      "split-panel-right",
      "Split current panel right",
      (id) => void this.workspace.splitPanelRight(id),
    );
    this.registerFocusedPanelCommand(
      "zoom-in-time",
      "Panel: zoom in (time)",
      () => {
        zoomFocusedPanel(0.8);
      },
    );
    this.registerFocusedPanelCommand(
      "zoom-out-time",
      "Panel: zoom out (time)",
      () => {
        zoomFocusedPanel(1.25);
      },
    );
    this.registerFocusedPanelCommand("pan-left", "Panel: pan left", () => {
      panFocusedPanel(-1);
    });
    this.registerFocusedPanelCommand("pan-right", "Panel: pan right", () => {
      panFocusedPanel(1);
    });
    this.registerFocusedPanelCommand(
      "fit-panel-view",
      "Panel: fit view",
      (id) => {
        this.fitPanelView(id);
      },
    );
    this.registerFocusedPanelCommand(
      "clear-annotations",
      "Panel: clear annotations",
      (id) => {
        const panel = this.workspace.panel(id);
        for (const annotation of [...(panel?.annotations ?? [])]) {
          this.workspace.removeAnnotation(id, annotation.id);
        }
      },
    );
    this.registerFocusedPanelCommand(
      "toggle-stats",
      "Panel: toggle statistics",
      (id) => {
        this.workspace.toggleStats(id);
      },
      "s",
    );
    this.registerFocusedPanelCommand(
      "toggle-axis-style",
      "Panel: toggle axis style (gutter/inline)",
      (id) => {
        this.workspace.toggleAxisStyle(id);
      },
    );
    this.registerFocusedPanelCommand(
      "close-panel",
      "Close current panel",
      (id) => {
        this.workspace.closePanel(id);
      },
    );
    this.registerFocusedPanelCommand(
      "maximize-panel",
      "Maximize current panel",
      (id) => {
        this.workspace.toggleMaximize(id);
      },
    );
    this.commands.register({
      id: "restore-panel-grid",
      title: "Restore panel grid",
      enabled: () => this.workspace.maximizedPanelId() !== null,
      run: () => {
        this.workspace.restoreGrid();
        this.afterLayoutChange();
      },
    });
    this.commands.register({
      id: "focus-filter",
      title: "Filter signals",
      keys: "/",
      run: () => {
        required<HTMLInputElement>(this.root, ".signal-search").focus();
      },
    });
    this.commands.register({
      id: "toggle-signal-tree",
      title: "Toggle signal tree",
      enabled: () => window.innerWidth > 820,
      run: () => {
        this.toggleSignalTree();
      },
    });
    this.commands.register({
      id: "toggle-linked",
      title: "Toggle linked time",
      keys: "l",
      run: () => {
        this.toggleLinked();
      },
    });
    this.commands.register({
      id: "toggle-theme",
      title: "Toggle theme",
      keys: "t",
      run: () => {
        this.toggleTheme();
      },
    });
    this.commands.register({
      id: "toggle-formula",
      title: "Toggle derived formula editor",
      keys: "e",
      run: () => {
        this.toggleFormula();
      },
    });
    this.commands.register({
      id: "command-palette",
      title: "Command palette",
      keys: "mod+k",
      run: () => {
        this.palette?.open();
      },
    });
    this.commands.register({
      id: "help",
      title: "Keyboard help",
      keys: "?",
      run: () => {
        this.palette?.open();
      },
    });
  }

  /** Registers a command that acts on the focused panel and refreshes. */
  private registerFocusedPanelCommand(
    id: string,
    title: string,
    act: (panelId: string) => void,
    keys?: string,
  ): void {
    this.commands.register({
      id,
      title,
      ...(keys === undefined ? {} : { keys }),
      enabled: () => this.workspace.focusedPanelId() !== null,
      run: () => {
        const panelId = this.workspace.focusedPanelId();
        if (panelId !== null) {
          act(panelId);
          this.afterLayoutChange();
        }
      },
    });
  }

  private paletteEntries(): PaletteEntry[] {
    const commands = this.commands.list().map((command) => ({
      title: command.title,
      hint: command.keys === undefined ? "" : formatCombo(command.keys),
      run: () => {
        this.commands.run(command.id);
      },
    }));
    const signals = this.signals.map((summary) => ({
      title: `plot ${summary.path}`,
      hint: "signal",
      run: () => {
        this.plotSignal(summary.path);
      },
    }));
    const tabs = this.workspace.tabs().map((tab) => ({
      title: `switch to ${tab.title}`,
      hint: "workspace",
      run: () => {
        this.workspace.selectTab(tab.id);
        this.afterLayoutChange();
      },
    }));
    const panels = this.workspace.panels().map((panel) => ({
      title: `focus ${panel.title}`,
      hint: "panel",
      run: () => {
        this.workspace.focusPanel(panel.id);
        if (this.workspace.maximizedPanelId() !== null) {
          this.workspace.maximizePanel(panel.id);
        }
        this.afterLayoutChange();
      },
    }));
    return [...commands, ...tabs, ...panels, ...signals];
  }

  private bindControls(): void {
    const openButton = required<HTMLButtonElement>(this.root, ".open-files");
    openButton.hidden = this.plane.ingest === null;
    openButton.addEventListener("click", () => {
      this.commands.run("open-files");
    });
    required(this.root, ".tree-toggle").addEventListener("click", () => {
      this.commands.run("toggle-signal-tree");
    });
    this.bindSignalTreeResize();
    required(this.root, ".theme-toggle").addEventListener("click", () => {
      this.commands.run("toggle-theme");
    });
    required(this.root, ".linked-toggle").addEventListener("click", () => {
      this.commands.run("toggle-linked");
    });
    required(this.root, ".formula-toggle").addEventListener("click", () => {
      this.commands.run("toggle-formula");
    });
    const formula = required<HTMLFormElement>(this.root, ".formula-bar");
    formula.addEventListener("submit", (event) => {
      event.preventDefault();
    });
    required<HTMLInputElement>(formula, ".formula-input").addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          this.setFormulaOpen(false);
        }
      },
    );
    required<HTMLInputElement>(this.root, ".signal-search").addEventListener(
      "input",
      (event) => {
        this.tree?.setFilter((event.target as HTMLInputElement).value);
      },
    );
    window.addEventListener("keydown", (event) => {
      if (this.palette?.isOpen() === true) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (this.commands.handleKey(event)) event.preventDefault();
    });
  }

  private plotSignal(path: string, panelId?: string): void {
    let target = panelId ?? this.workspace.focusedPanelId();
    if (target === null) {
      target = this.workspace.addPanelRow().id;
    }
    if (this.workspace.addSeries(target, path)) {
      this.workspace.focusPanel(target);
      this.fitWindowToPlotted();
      this.afterLayoutChange();
    }
  }

  private async openFiles(): Promise<void> {
    const port = this.plane.ingest;
    if (port === null) return;
    const progress = required<HTMLElement>(this.root, ".ingest-progress");
    try {
      const paths = await port.pickSources();
      for (const path of paths) {
        const name = basename(path);
        progress.hidden = false;
        await runIngest(port, path, (status) => {
          const percent =
            status.fraction > 0
              ? `${String(Math.round(status.fraction * 100))}%`
              : "…";
          progress.textContent = `${name} · ${status.stage} ${percent}`;
        });
      }
      await this.reloadSignals();
      this.afterLayoutChange();
    } catch (error: unknown) {
      this.reportError(error);
    } finally {
      progress.hidden = true;
    }
  }

  private fitWindowToPlotted(): void {
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = Number.NEGATIVE_INFINITY;
    for (const panel of this.workspace.panels()) {
      for (const series of panel.series) {
        const summary = this.signalsByPath.get(series.path);
        if (summary !== undefined) {
          t0 = Math.min(t0, summary.t_min);
          t1 = Math.max(t1, summary.t_max);
        }
      }
    }
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      this.time.setWindow(t0, t1 > t0 ? t1 : t0 + 1);
      this.renderWindowReadout();
    }
  }

  /** Renders the toolbar window readout from the linked-time model. */
  private renderWindowReadout(): void {
    const state = this.time.snapshot();
    required(this.root, ".window-readout").textContent =
      `t: ${state.t0.toFixed(3)} → ${state.t1.toFixed(3)} s`;
  }

  private afterLayoutChange(): void {
    this.workspaceTabs?.sync(
      this.workspace.tabs(),
      this.workspace.activeTabId(),
    );
    this.workspaceView?.sync(this.signals.length > 0);
    void this.refreshTiles();
  }

  private async reloadSignals(): Promise<void> {
    this.signals = await this.plane.listSignals();
    this.signalsByPath = new Map(
      this.signals.map((summary) => [summary.path, summary]),
    );
    this.tree?.setSignals(this.signals.map((summary) => summary.path));
    this.tree?.setFavorites(this.workspace.favorites());
    this.updateStatus();
  }

  private async refreshTiles(): Promise<void> {
    const refreshToken = ++this.refreshToken;
    const width = Math.max(
      1,
      Math.round(required(this.root, ".workspace").clientWidth),
    );
    const next = new Map<string, TileResponse>();
    await Promise.all(
      this.workspace.panels().map(async (panel) => {
        if (panel.mode !== "time") return;
        const ids = panel.series
          .map((series) => this.signalsByPath.get(series.path)?.signal_id)
          .filter((id): id is string => id !== undefined);
        if (ids.length === 0) return;
        const panelWidth = this.workspaceView?.panelWidth(panel.id) ?? 0;
        const window = this.effectiveWindow(panel);
        try {
          next.set(
            panel.id,
            await this.plane.queryTiles({
              request_id: crypto.randomUUID(),
              signal_ids: ids,
              window,
              pixel_width: panelWidth > 0 ? Math.round(panelWidth) : width,
            }),
          );
        } catch (error: unknown) {
          this.reportError(error);
        }
      }),
    );
    if (refreshToken !== this.refreshToken) return;
    this.tilesByPanel = next;
    this.renderTiles();
  }

  /** Coalesces bursts of per-panel resize renders into one frame. */
  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.renderTiles();
    });
  }

  private renderTiles(): void {
    const state = this.time.snapshot();
    const elapsed =
      this.workspaceView?.renderTiles(this.tilesByPanel, (panelId) => {
        const panel = this.workspace.panel(panelId);
        return panel === undefined
          ? { t0: state.t0, t1: state.t1 }
          : this.effectiveWindow(panel);
      }) ?? 0;
    required(this.root, ".render-ms").textContent = `${elapsed.toFixed(1)} ms`;
  }

  private applyTimeWindow(panelId: string, t0: number, t1: number): void {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return;
    const panel = this.workspace.panel(panelId);
    if (panel === undefined) return;
    if (this.time.snapshot().linked && panel.mode === "time") {
      this.time.setWindow(t0, t1);
      this.renderWindowReadout();
    } else {
      this.workspace.setPanelTimeWindow(panelId, [t0, t1]);
    }
    this.renderTiles();
    this.scheduleRefresh();
  }

  private effectiveWindow(panel: PanelState): { t0: number; t1: number } {
    const state = this.time.snapshot();
    if (state.linked && panel.mode === "time") {
      return { t0: state.t0, t1: state.t1 };
    }
    const local = panel.time_window;
    return local === null
      ? { t0: state.t0, t1: state.t1 }
      : { t0: local[0], t1: local[1] };
  }

  private scheduleRefresh(delay = 150): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshTiles();
    }, delay);
  }

  private fitPanelView(panelId: string): void {
    const panel = this.workspace.panel(panelId);
    if (panel === undefined) return;
    this.workspace.clearPanelYRange(panelId);
    this.workspaceView?.resetYAxis(panelId);
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = Number.NEGATIVE_INFINITY;
    for (const series of panel.series) {
      const summary = this.signalsByPath.get(series.path);
      if (summary !== undefined) {
        t0 = Math.min(t0, summary.t_min);
        t1 = Math.max(t1, summary.t_max);
      }
    }
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      this.applyTimeWindow(panelId, t0, t1 > t0 ? t1 : t0 + 1);
    } else {
      this.renderTiles();
      this.scheduleRefresh();
    }
  }

  private setCursor(
    panelId: string,
    cursorT: number | null,
    client: { x: number; y: number } | null,
  ): void {
    this.time.setCursor(cursorT);
    const state = this.time.snapshot();
    this.workspaceView?.setCursor(state.cursorT);
    required(this.root, ".cursor-readout").textContent =
      state.cursorT === null
        ? "t = —"
        : `t = ${formatCursorTime(state.cursorT)}`;
    this.renderTooltip(panelId, state.cursorT, client);
    this.scheduleLiveValues(state.cursorT);
  }

  private renderTooltip(
    panelId: string,
    cursorT: number | null,
    client: { x: number; y: number } | null,
  ): void {
    const tip = required<HTMLElement>(this.root, ".plot-tip");
    const panel = this.workspace.panel(panelId);
    const tiles = this.tilesByPanel.get(panelId);
    if (
      cursorT === null ||
      client === null ||
      panel === undefined ||
      tiles === undefined
    ) {
      tip.hidden = true;
      return;
    }
    const visible = new Set(
      panel.series
        .filter((series) => series.visible)
        .map((series) => series.path),
    );
    tip.replaceChildren(
      tooltipHeader(formatCursorTime(cursorT)),
      ...tiles.series
        .filter((tile) => visible.has(tile.signal_path))
        .map((tile) => {
          const series = panel.series.find(
            (entry) => entry.path === tile.signal_path,
          );
          const style = resolveSeriesStyle(
            series?.color_slot ?? 1,
            series?.dash ?? "solid",
          );
          return tooltipRow(
            `var(--series-${String(style.colorIndex + 1)})`,
            tile.signal_path.split("/").slice(-2).join("/"),
            formatValue(valueAtTime(tile.bins, cursorT)),
          );
        }),
    );
    tip.hidden = false;
    const rect = tip.getBoundingClientRect();
    const x =
      client.x + 16 + rect.width > window.innerWidth - 8
        ? client.x - 16 - rect.width
        : client.x + 16;
    const y =
      client.y + 14 + rect.height > window.innerHeight - 8
        ? client.y - 14 - rect.height
        : client.y + 14;
    tip.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
  }

  private scheduleLiveValues(cursorT: number | null): void {
    this.pendingCursorT = cursorT;
    if (this.liveValuesScheduled) return;
    this.liveValuesScheduled = true;
    requestAnimationFrame(() => {
      this.liveValuesScheduled = false;
      const values = new Map<string, string>();
      if (this.pendingCursorT !== null) {
        for (const tiles of this.tilesByPanel.values()) {
          for (const tile of tiles.series) {
            if (!values.has(tile.signal_path)) {
              values.set(
                tile.signal_path,
                formatValue(valueAtTime(tile.bins, this.pendingCursorT)),
              );
            }
          }
        }
      }
      this.tree?.setLiveValues(values);
    });
  }

  private updateStatus(): void {
    const pointCount = this.signals.reduce(
      (total, signal) => total + Number(signal.point_count),
      0,
    );
    required(this.root, ".signal-count").textContent =
      `${this.signals.length.toLocaleString()} signals`;
    required(this.root, ".point-count").textContent =
      `${pointCount.toLocaleString()} pts`;
    void this.updateSources();
  }

  private async updateSources(): Promise<void> {
    const sources = await this.plane.listSources();
    const rows = required(this.root, ".source-rows");
    rows.replaceChildren(
      ...sources.map((source) => {
        const row = document.createElement("div");
        row.className = "source-row";
        const dot = document.createElement("span");
        dot.className = "status-dot";
        const name = document.createElement("span");
        name.className = "signal-path";
        name.textContent = basename(source.path);
        name.title = source.path;
        const points = document.createElement("span");
        points.className = "source-points";
        points.textContent = `${Number(source.point_count).toLocaleString()} pts`;
        row.append(dot, name, points);
        return row;
      }),
    );
  }

  private toggleLinked(): void {
    const state = this.time.snapshot();
    const linked = !state.linked;
    if (!linked) {
      for (const panel of this.workspace.panels()) {
        if (panel.mode === "time") {
          this.workspace.setPanelTimeWindow(panel.id, [state.t0, state.t1]);
        }
      }
    }
    this.time.setLinked(linked);
    required(this.root, ".linked-toggle").classList.toggle("active", linked);
    void this.refreshTiles();
  }

  private toggleTheme(): void {
    const documentRoot = document.documentElement;
    documentRoot.dataset.theme =
      documentRoot.dataset.theme === "light" ? "dark" : "light";
    this.workspaceView?.invalidateTheme();
    this.renderTiles();
  }

  private toggleSignalTree(): void {
    const workbench = required(this.root, ".workbench");
    this.setSignalTreeOpen(workbench.classList.contains("tree-collapsed"));
  }

  private setSignalTreeOpen(open: boolean): void {
    const workbench = required<HTMLElement>(this.root, ".workbench");
    const button = required<HTMLButtonElement>(this.root, ".tree-toggle");
    const seam = required<HTMLElement>(this.root, ".tree-resize-handle");
    workbench.classList.toggle("tree-collapsed", !open);
    if (open) {
      workbench.style.setProperty(
        "--tree-width",
        `${String(this.signalTreeWidth)}px`,
      );
    }
    button.classList.toggle("active", open);
    button.ariaExpanded = String(open);
    button.title = open ? "Hide signal tree" : "Show signal tree";
    seam.setAttribute(
      "aria-valuenow",
      open ? String(this.signalTreeWidth) : "0",
    );
  }

  private bindSignalTreeResize(): void {
    const seam = required<HTMLElement>(this.root, ".tree-resize-handle");
    const workbench = required<HTMLElement>(this.root, ".workbench");
    const tokenWidth = Number.parseFloat(
      getComputedStyle(workbench).getPropertyValue("--tree-width"),
    );
    if (Number.isFinite(tokenWidth) && tokenWidth > 0) {
      this.signalTreeWidth = tokenWidth;
    }
    seam.setAttribute("aria-valuemax", String(TREE_WIDTH.max));
    seam.setAttribute(
      "aria-valuenow",
      String(Math.round(this.signalTreeWidth)),
    );
    const updateWidth = (width: number): void => {
      workbench.style.setProperty("--tree-width", `${String(width)}px`);
      seam.setAttribute("aria-valuenow", String(Math.round(width)));
    };
    const commitWidth = (width: number): void => {
      if (width < TREE_WIDTH.collapse) {
        this.setSignalTreeOpen(false);
        return;
      }
      this.signalTreeWidth = Math.max(
        TREE_WIDTH.min,
        Math.min(TREE_WIDTH.max, width),
      );
      this.setSignalTreeOpen(true);
    };

    bindPointerDrag(seam, (down) => {
      const collapsed = workbench.classList.contains("tree-collapsed");
      const startWidth = collapsed ? 0 : this.signalTreeWidth;
      let width = startWidth;
      updateWidth(startWidth);
      workbench.classList.remove("tree-collapsed");
      return {
        onMove: (moveEvent) => {
          width = Math.max(
            0,
            Math.min(
              TREE_WIDTH.max,
              startWidth + moveEvent.clientX - down.clientX,
            ),
          );
          updateWidth(width);
        },
        onEnd: () => {
          commitWidth(width);
        },
      };
    });
    seam.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const collapsed = workbench.classList.contains("tree-collapsed");
      const width = collapsed
        ? event.key === "ArrowRight"
          ? this.signalTreeWidth
          : 0
        : this.signalTreeWidth + (event.key === "ArrowRight" ? 20 : -20);
      commitWidth(width);
    });
  }

  private toggleFormula(): void {
    const workbench = required(this.root, ".workbench");
    this.setFormulaOpen(workbench.classList.contains("formula-collapsed"));
  }

  private setFormulaOpen(open: boolean): void {
    const workbench = required(this.root, ".workbench");
    const button = required<HTMLButtonElement>(this.root, ".formula-toggle");
    const input = required<HTMLInputElement>(this.root, ".formula-input");
    workbench.classList.toggle("formula-collapsed", !open);
    button.classList.toggle("active", open);
    button.ariaExpanded = String(open);
    if (open) {
      input.focus();
    } else {
      input.blur();
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    required(this.root, ".render-ms").textContent = `error: ${message}`;
    console.error(error);
  }
}

function shellMarkup(): string {
  return `<main class="workbench formula-collapsed">
    <div class="tool-bar">
      <span class="brand">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11 4 5l3 8 3-10 2 6 2-2" fill="none" stroke="var(--amber-7)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        SIGNALSCOPE
      </span>
      <span class="tool-divider"></span>
      <button class="tool-button active tree-toggle" title="Hide signal tree" aria-controls="signal-tree" aria-expanded="true">☰ Signals</button>
      <button class="tool-button open-files" hidden>Open CSV / MCAP</button>
      <button class="tool-button active linked-toggle">⇄ Linked t</button>
      <button class="tool-button formula-toggle" title="Toggle derived formula editor (E)" aria-controls="formula-editor" aria-expanded="false"><span class="formula-symbol">ƒx</span> Derived</button>
      <button class="tool-button theme-toggle" title="Toggle theme (T)">◐</button>
      <span class="tool-spacer"></span>
      <span class="window-label">window</span>
      <span class="window-readout"></span>
      <button class="tool-button follow-slot" disabled>⏸ FOLLOW</button>
      <span class="command-hint">commands <kbd>⌘K</kbd></span>
    </div>

    <nav class="workspace-tabs" aria-label="Workspace tabs" role="tablist"></nav>

    <aside class="signal-tree" id="signal-tree" aria-label="Signals">
      <div class="search-wrap">
        <label>/ <input class="signal-search" placeholder="filter signals…" spellcheck="false" /></label>
      </div>
      <div class="tree-heading">★ FAVORITES</div>
      <div class="tree-favorites"></div>
      <div class="tree-heading">SIGNALS</div>
      <div class="tree-scroll"></div>
      <div class="source-footer">
        <div class="ingest-progress" hidden></div>
        <div class="source-rows"></div>
      </div>
    </aside>

    <div class="tree-resize-handle" role="separator" aria-label="Resize signal tree" aria-orientation="vertical" aria-valuemin="0" tabindex="0"></div>

    <section class="workspace" aria-label="Panel workspace"></section>

    <form class="formula-bar" id="formula-editor">
      <span class="formula-mark">ƒx</span>
      <input class="formula-input" aria-label="Derived signal formula" placeholder='derived/name = Math.hypot($("signal/x"), $("signal/y"))' spellcheck="false" />
    </form>
    <div class="plot-tip" hidden></div>

    <footer class="status-bar">
      <span><span class="status-dot"></span> <span class="signal-count">0 signals</span></span>
      <span class="point-count status-value">0 pts</span>
      <span>render <span class="render-ms status-value">— ms</span></span>
      <span>cursor <span class="status-value cursor-readout">t = —</span></span>
      <span class="gesture-hint">drag box-zoom · wheel t · ⇧wheel y · right-drag pan · dbl-click fit · click datatip</span>
      <span class="status-command">⌘K</span>
    </footer>
  </main>`;
}

function tooltipHeader(text: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "plot-tip-header";
  header.textContent = text;
  return header;
}

function tooltipRow(color: string, name: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "plot-tip-row";
  const swatch = document.createElement("span");
  swatch.className = "plot-tip-swatch";
  swatch.style.background = color;
  const label = document.createElement("span");
  label.className = "signal-path";
  label.textContent = name;
  const reading = document.createElement("span");
  reading.className = "plot-tip-value";
  reading.textContent = value;
  row.append(swatch, label, reading);
  return row;
}

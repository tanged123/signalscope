import { CommandRegistry, formatCombo } from "../app/commands";
import type { DataPlane } from "../app/data-plane";
import { runIngest } from "../app/ingest";
import { LinkedTimeModel } from "../app/linked-time";
import { mergeSampleResponses } from "../app/samples";
import { WorkspaceModel } from "../app/workspace";
import { lerpSample } from "../app/xy";
import {
  formatCursorTime,
  formatValue,
  valueAtTime,
  zoomRange,
} from "../app/plot-math";
import {
  type SampleResponse,
  type SignalSummary,
  type TileResponse,
} from "../generated/protocol";
import type { PanelState } from "../generated/session";
import { resolveSeriesStyle } from "../render/canvas-renderer";
import type { CursorStyle } from "../render/overlay-renderer";
import { CommandPalette, type PaletteEntry } from "./command-palette";
import { basename, bindPointerDrag, required, signalLabel } from "./dom";
import type { PanelCursor } from "./panel";
import { SignalTreeView } from "./signal-tree";
import { WorkspaceTabsView } from "./workspace-tabs";
import { WorkspaceView } from "./workspace-view";

const TREE_WIDTH = { default: 262, collapse: 120, min: 180, max: 480 } as const;
const CURSOR_STYLES: readonly CursorStyle[] = ["none", "dot", "line"];
/** Point cap for non-time panels: enough for a 4096-bin FFT plus edges. */
const SAMPLE_CAP = 8192;

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
  private samplesByPanel = new Map<string, SampleResponse>();
  private signalTreeWidth: number = TREE_WIDTH.default;
  private refreshToken = 0;
  private renderScheduled = false;
  private refreshTimer: number | null = null;
  private helpTimer: number | null = null;
  private liveValuesScheduled = false;
  private pendingCursorT: number | null = null;
  private cursorStyle: CursorStyle = "none";

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
          if (mode === "xy") this.workspace.promoteSeriesToX(id);
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onDropSignal: (id, path) => {
          this.plotSignal(path, id);
        },
        onSetXSignal: (id, path) => {
          this.workspace.setMode(id, "xy");
          this.workspace.setXSignal(id, path);
          this.workspace.focusPanel(id);
          this.afterLayoutChange();
        },
        onSetColorSignal: (id, path) => {
          this.workspace.setColorSignal(id, path);
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onClearXSignal: (id) => {
          this.clearXSignal(id);
        },
        onToggleSeries: (id, path) => {
          this.workspace.toggleSeriesVisible(id, path);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onResized: () => {
          this.scheduleRender();
        },
        onCursor: (id, cursor, client) => {
          this.setCursor(id, cursor, client);
        },
        onTimeWindow: (id, t0, t1) => {
          this.applyTimeWindow(id, t0, t1);
        },
        onYRange: (id, range) => {
          this.workspace.setPanelYRange(id, [range[0], range[1]]);
          this.scheduleRender();
        },
        onXRange: (id, range) => {
          this.applyXRange(id, range);
        },
        onPinAnnotation: (id, hit) => {
          this.workspace.addAnnotation(id, {
            id: crypto.randomUUID(),
            series_path: hit.path,
            domain: "time",
            anchor: hit.time,
            pinned_value: hit.value,
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
          this.syncStatsToggle();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onToggleAxisStyle: (id) => {
          this.workspace.toggleAxisStyle(id);
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
    this.commands.register({
      id: "cycle-cursor-style",
      title: "Cursor: cycle off/dot/line",
      run: () => {
        this.cycleCursorStyle();
      },
    });
    this.commands.register({
      id: "toggle-all-stats",
      title: "Toggle statistics on every panel",
      run: () => {
        // Any panel still hiding stats turns them all on; otherwise all off.
        const target = this.workspace
          .panels()
          .some((panel) => !panel.show_stats);
        for (const panel of this.workspace.panels()) {
          if (panel.show_stats !== target) this.workspace.toggleStats(panel.id);
        }
        this.syncStatsToggle();
        this.workspaceView?.refreshPanelStates();
        this.renderTiles();
      },
    });
    for (const [mode, text] of [
      [
        "XY",
        "XY: drag box-zoom · wheel zoom · right-drag pan · dbl-click fit · click datatip · drop on the amber strip to set X",
      ],
      [
        "FFT",
        "FFT: computed over the visible time window · wheel/box zoom the frequency and dB axes · dbl-click fit",
      ],
      [
        "histogram",
        "Histogram: counts of the visible time window · bins rebin as the window moves · dbl-click fit",
      ],
    ] as const) {
      this.commands.register({
        id: `help-${mode.toLowerCase()}-gestures`,
        title: `Help: ${mode} mode gestures`,
        run: () => {
          this.showModeHelp(text);
        },
      });
    }
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
      "panel-switch-xy",
      "Panel: switch to XY mode",
      (id) => {
        this.workspace.setMode(id, "xy");
        this.workspace.promoteSeriesToX(id);
      },
    );
    this.registerFocusedPanelCommand(
      "panel-clear-x-signal",
      "Panel: clear X signal",
      (id) => {
        this.clearXSignal(id);
      },
    );
    this.registerFocusedPanelCommand(
      "panel-switch-fft",
      "Panel: switch to FFT mode",
      (id) => {
        this.workspace.setMode(id, "fft");
      },
    );
    this.registerFocusedPanelCommand(
      "panel-switch-histogram",
      "Panel: switch to histogram mode",
      (id) => {
        this.workspace.setMode(id, "histogram");
      },
    );
    this.registerFocusedPanelCommand(
      "panel-clear-color-signal",
      "Panel: clear color signal (c:)",
      (id) => {
        this.workspace.setColorSignal(id, null);
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
      keys: "mod+p",
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
    const focused = this.workspace.focusedPanelId();
    const xSignals =
      focused === null
        ? []
        : this.signals.map((summary) => ({
            title: `Panel: set X signal… ${summary.path}`,
            hint: "then pick from tree",
            run: () => {
              this.workspace.setMode(focused, "xy");
              this.workspace.setXSignal(focused, summary.path);
              this.afterLayoutChange();
            },
          }));
    const colorSignals =
      focused === null
        ? []
        : [
            {
              title: "Panel: set color signal (c:)… time",
              hint: "colour by time",
              run: () => {
                this.workspace.setColorSignal(focused, "time");
                this.afterLayoutChange();
              },
            },
            ...this.signals.map((summary) => ({
              title: `Panel: set color signal (c:)… ${summary.path}`,
              hint: "signal",
              run: () => {
                this.workspace.setColorSignal(focused, summary.path);
                this.afterLayoutChange();
              },
            })),
          ];
    return [
      ...commands,
      ...tabs,
      ...panels,
      ...xSignals,
      ...colorSignals,
      ...signals,
    ];
  }

  private bindControls(): void {
    document.addEventListener(
      "pointerdown",
      () => {
        this.hideTooltip();
      },
      true,
    );
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
    required(this.root, ".cursor-style-toggle").addEventListener(
      "click",
      () => {
        this.commands.run("cycle-cursor-style");
      },
    );
    required(this.root, ".stats-toggle").addEventListener("click", () => {
      this.commands.run("toggle-all-stats");
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

  /**
   * The union time extent of `paths`, or null when none are known. A
   * collapsed extent widens to one second so the window always has a span.
   */
  private timeExtent(
    paths: Iterable<string>,
  ): { t0: number; t1: number } | null {
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = Number.NEGATIVE_INFINITY;
    for (const path of paths) {
      const summary = this.signalsByPath.get(path);
      if (summary === undefined) continue;
      t0 = Math.min(t0, summary.t_min);
      t1 = Math.max(t1, summary.t_max);
    }
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
    return { t0, t1: t1 > t0 ? t1 : t0 + 1 };
  }

  private fitWindowToPlotted(): void {
    const extent = this.timeExtent(
      [...this.workspace.panels()].flatMap((panel) =>
        panel.series.map((series) => series.path),
      ),
    );
    if (extent === null) return;
    this.time.setWindow(extent.t0, extent.t1);
    this.renderWindowReadout();
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
    this.syncStatsToggle();
    void this.refreshTiles();
  }

  private syncStatsToggle(): void {
    const panels = this.workspace.panels();
    const active =
      panels.length > 0 && panels.every((panel) => panel.show_stats);
    required(this.root, ".stats-toggle").classList.toggle("active", active);
  }

  private showModeHelp(text: string): void {
    const help = required<HTMLElement>(this.root, ".mode-help");
    help.textContent = text;
    help.hidden = false;
    if (this.helpTimer !== null) window.clearTimeout(this.helpTimer);
    this.helpTimer = window.setTimeout(() => {
      help.hidden = true;
      this.helpTimer = null;
    }, 6000);
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
    const nextTiles = new Map<string, TileResponse>();
    const nextSamples = new Map<string, SampleResponse>();
    await Promise.all(
      this.workspace.panels().map(async (panel) => {
        const ids = this.panelSignalIds(panel);
        if (ids.length === 0) return;
        const window = this.effectiveWindow(panel);
        try {
          if (panel.mode === "time") {
            const panelWidth = this.workspaceView?.panelWidth(panel.id) ?? 0;
            nextTiles.set(
              panel.id,
              await this.plane.queryTiles({
                request_id: crypto.randomUUID(),
                signal_ids: ids,
                window,
                pixel_width: panelWidth > 0 ? Math.round(panelWidth) : width,
              }),
            );
          } else {
            const contextRequest = {
              request_id: crypto.randomUUID(),
              signal_ids: ids,
              window: this.sampleWindow(panel),
              max_points: SAMPLE_CAP,
            };
            if (panel.mode === "xy") {
              const detailRequest = {
                request_id: crypto.randomUUID(),
                signal_ids: ids,
                window,
                max_points: SAMPLE_CAP,
              };
              const [context, detail] = await Promise.all([
                this.plane.querySamples(contextRequest),
                this.plane.querySamples(detailRequest),
              ]);
              nextSamples.set(panel.id, mergeSampleResponses(context, detail));
            } else {
              nextSamples.set(
                panel.id,
                await this.plane.querySamples(contextRequest),
              );
            }
          }
        } catch (error: unknown) {
          this.reportError(error);
        }
      }),
    );
    if (refreshToken !== this.refreshToken) return;
    this.tilesByPanel = nextTiles;
    this.samplesByPanel = nextSamples;
    this.renderTiles();
  }

  /**
   * Signal ids a panel needs: its series, plus the XY x signal and the
   * colour channel, which are axes rather than plotted series.
   */
  private panelSignalIds(panel: PanelState): string[] {
    const paths = panel.series.map((series) => series.path);
    if (panel.mode === "xy") {
      if (panel.x_signal !== null) paths.unshift(panel.x_signal);
      if (panel.color_signal !== null) paths.push(panel.color_signal);
    }
    return [
      ...new Set(
        paths
          .map((path) => this.signalsByPath.get(path)?.signal_id)
          .filter((id): id is string => id !== undefined),
      ),
    ];
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
      this.workspaceView?.renderData(
        this.tilesByPanel,
        this.samplesByPanel,
        (panelId) => {
          const panel = this.workspace.panel(panelId);
          return panel === undefined
            ? { t0: state.t0, t1: state.t1 }
            : this.effectiveWindow(panel);
        },
      ) ?? 0;
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

  private applyXRange(panelId: string, range: readonly [number, number]): void {
    if (
      !Number.isFinite(range[0]) ||
      !Number.isFinite(range[1]) ||
      range[1] <= range[0]
    ) {
      return;
    }
    this.workspace.setPanelXRange(panelId, [range[0], range[1]]);
    this.renderTiles();
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

  /**
   * The window a panel's samples are fetched over. XY panels fetch the full
   * data extent because the spec dims the out-of-window trajectory rather
   * than clipping it; FFT and histogram compute over the visible window.
   */
  private sampleWindow(panel: PanelState): { t0: number; t1: number } {
    if (panel.mode !== "xy") return this.effectiveWindow(panel);
    const paths = panel.series.map((series) => series.path);
    if (panel.x_signal !== null) paths.push(panel.x_signal);
    return this.timeExtent(paths) ?? this.effectiveWindow(panel);
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
    if (panel.mode !== "time") {
      // Non-time panels have no time axis to fit: clearing both ranges
      // returns them to autoscale, which the renderer recomputes.
      this.workspace.clearPanelXRange(panelId);
      this.workspace.clearPanelYRange(panelId);
      this.workspaceView?.resetYAxis(panelId);
      this.renderTiles();
      return;
    }
    this.workspace.clearPanelYRange(panelId);
    this.workspaceView?.resetYAxis(panelId);
    const extent = this.timeExtent(panel.series.map((series) => series.path));
    if (extent === null) {
      this.renderTiles();
      this.scheduleRefresh();
      return;
    }
    this.applyTimeWindow(panelId, extent.t0, extent.t1);
  }

  /** Removes the assigned X signal while leaving an empty XY axis slot. */
  private clearXSignal(panelId: string): void {
    const panel = this.workspace.panel(panelId);
    const path = panel?.x_signal;
    if (panel === undefined || path === null || path === undefined) return;
    this.workspace.setXSignal(panelId, null);
    this.workspace.removeSeries(panelId, path);
    if (panel.color_signal === path) {
      this.workspace.setColorSignal(panelId, null);
    }
    this.workspace.clearPanelXRange(panelId);
    this.afterLayoutChange();
  }

  private setCursor(
    panelId: string,
    cursor: PanelCursor | null,
    client: { x: number; y: number } | null,
  ): void {
    if (this.cursorStyle === "none") cursor = null;
    const panel = this.workspace.panel(panelId);
    const localDomain = panel?.mode === "fft" || panel?.mode === "histogram";
    if (
      cursor?.domain === "frequency" ||
      cursor?.domain === "histogram" ||
      (cursor === null && localDomain)
    ) {
      this.workspaceView?.setLocalCursor(panelId, cursor?.value ?? null);
      if (cursor?.domain === "frequency") {
        required(this.root, ".cursor-readout").textContent =
          `f = ${formatValue(cursor.value)} Hz`;
      } else if (cursor?.domain === "histogram") {
        required(this.root, ".cursor-readout").textContent =
          `bin ${formatValue(cursor.low)} – ${formatValue(cursor.high)}`;
      } else {
        this.renderLinkedCursorReadout();
      }
      this.renderTooltip(
        panelId,
        this.cursorStyle === "line" ? cursor : null,
        this.cursorStyle === "line" ? client : null,
      );
      return;
    }
    const cursorT = cursor?.domain === "time" ? cursor.value : null;
    this.time.setCursor(cursorT);
    const state = this.time.snapshot();
    this.workspaceView?.setCursor(state.cursorT);
    this.renderLinkedCursorReadout();
    this.renderTooltip(
      panelId,
      this.cursorStyle === "line" && state.cursorT !== null
        ? { domain: "time", value: state.cursorT }
        : null,
      this.cursorStyle === "line" ? client : null,
    );
    this.scheduleLiveValues(this.cursorStyle === "none" ? null : state.cursorT);
  }

  private cycleCursorStyle(): void {
    const current = CURSOR_STYLES.indexOf(this.cursorStyle);
    this.cursorStyle =
      CURSOR_STYLES[(current + 1) % CURSOR_STYLES.length] ?? "dot";
    this.workspaceView?.setCursorStyle(this.cursorStyle);
    const button = required<HTMLButtonElement>(
      this.root,
      ".cursor-style-toggle",
    );
    const symbol =
      this.cursorStyle === "none"
        ? "off"
        : this.cursorStyle === "dot"
          ? "·"
          : "│";
    button.textContent = `cursor ${symbol}`;
    button.title = `Cursor: ${this.cursorStyle} (click to cycle)`;
    if (this.cursorStyle === "none") {
      this.workspaceView?.clearCursors();
      this.time.setCursor(null);
      this.renderLinkedCursorReadout();
      this.hideTooltip();
      this.scheduleLiveValues(null);
    }
  }

  private renderTooltip(
    panelId: string,
    cursor: PanelCursor | null,
    client: { x: number; y: number } | null,
  ): void {
    const tip = required<HTMLElement>(this.root, ".plot-tip");
    const panel = this.workspace.panel(panelId);
    if (cursor === null || client === null || panel === undefined) {
      tip.hidden = true;
      return;
    }
    const rows =
      cursor.domain === "frequency" || cursor.domain === "histogram"
        ? cursor.rows.map((row) =>
            tooltipRow(
              `var(--series-${String(row.colorIndex + 1)})`,
              signalLabel(row.path),
              cursor.domain === "frequency"
                ? `${formatValue(row.value)} dB`
                : `${formatValue(row.value)} samples`,
            ),
          )
        : panel.mode === "time"
          ? (this.tilesByPanel.get(panelId)?.series ?? [])
              .filter((tile) =>
                panel.series.some(
                  (series) =>
                    series.visible && series.path === tile.signal_path,
                ),
              )
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
                  signalLabel(tile.signal_path),
                  formatValue(valueAtTime(tile.bins, cursor.value)),
                );
              })
          : panel.mode === "xy"
            ? this.xyTooltipRows(panel, cursor.value)
            : [];
    if (rows.length === 0) {
      tip.hidden = true;
      return;
    }
    const header =
      cursor.domain === "time"
        ? `t = ${formatCursorTime(cursor.value)}`
        : cursor.domain === "frequency"
          ? `f = ${formatValue(cursor.value)} Hz`
          : `bin ${formatValue(cursor.low)} – ${formatValue(cursor.high)}`;
    tip.replaceChildren(tooltipHeader(header), ...rows);
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

  private xyTooltipRows(panel: PanelState, cursorT: number): HTMLElement[] {
    const samples = this.samplesByPanel.get(panel.id)?.series ?? [];
    const byPath = new Map(
      samples.map((series) => [series.signal_path, series]),
    );
    const entries = new Map<
      string,
      { roles: string[]; color: string; value: string }
    >();
    const add = (role: string, path: string, color: string): void => {
      const existing = entries.get(path);
      if (existing !== undefined) {
        if (!existing.roles.includes(role)) existing.roles.push(role);
        return;
      }
      const sample = byPath.get(path);
      entries.set(path, {
        roles: [role],
        color,
        value:
          sample === undefined
            ? "—"
            : formatValue(lerpSample(sample.time, sample.values, cursorT)),
      });
    };
    if (panel.x_signal !== null) {
      add("x", panel.x_signal, "var(--fg-2)");
    }
    panel.series
      .filter((series) => series.visible)
      .forEach((series, index) => {
        const style = resolveSeriesStyle(series.color_slot, series.dash);
        add(
          index === 0 ? "y" : `y${String(index + 1)}`,
          series.path,
          `var(--series-${String(style.colorIndex + 1)})`,
        );
      });
    if (panel.color_signal === "time") {
      entries.set("\u0000time", {
        roles: ["c"],
        color: "var(--fg-2)",
        value: formatCursorTime(cursorT),
      });
    } else if (panel.color_signal !== null) {
      add("c", panel.color_signal, "var(--fg-2)");
    }
    return [...entries.entries()].map(([path, entry]) =>
      tooltipRow(
        entry.color,
        `${entry.roles.join("/")} · ${path === "\u0000time" ? "time" : path}`,
        entry.value,
      ),
    );
  }

  private hideTooltip(): void {
    required<HTMLElement>(this.root, ".plot-tip").hidden = true;
  }

  private renderLinkedCursorReadout(): void {
    const cursorT = this.time.snapshot().cursorT;
    required(this.root, ".cursor-readout").textContent =
      cursorT === null ? "t = —" : `t = ${formatCursorTime(cursorT)}`;
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
      <button class="tool-button cursor-style-toggle" title="Cursor: off (click to cycle)">cursor off</button>
      <button class="tool-button stats-toggle" title="Show statistics on every panel">Σ Stats</button>
      <button class="tool-button theme-toggle" title="Toggle theme (T)">◐</button>
      <span class="tool-spacer"></span>
      <span class="window-label">window</span>
      <span class="window-readout"></span>
      <button class="tool-button follow-slot" disabled>⏸ FOLLOW</button>
      <span class="command-hint">commands <kbd>⌘P</kbd></span>
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

    <div class="mode-help" role="status" hidden></div>

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
      <span class="gesture-hint">
        <span><b>ZOOM</b> drag box · wheel</span>
        <span><b>ONE AXIS</b> thin drag · ⇧wheel Y · ⌥wheel X</span>
        <span><b>PAN</b> right-drag</span>
        <span><b>FIT</b> double-click</span>
      </span>
      <span class="status-command">⌘P</span>
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

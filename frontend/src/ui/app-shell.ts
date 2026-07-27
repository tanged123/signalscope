import {
  CommandRegistry,
  formatCombo,
  PLANNED_TITLE,
  type Command,
} from "../app/commands";
import type { DataPlane } from "../app/data-plane";
import { runIngest } from "../app/ingest";
import { LinkedTimeModel } from "../app/linked-time";
import { mergeSampleResponses } from "../app/samples";
import { WorkspaceModel } from "../app/workspace";
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
import type {
  CursorMode,
  PanelMode,
  PanelState,
  Theme,
} from "../generated/session";
import {
  CommandPalette,
  type PaletteEntry,
  type PaletteMode,
} from "./command-palette";
import { basename, bindPointerDrag, required } from "./dom";
import type { PlotCursor } from "../app/plot-capabilities";
import { SignalTreeView } from "./signal-tree";
import { WorkspaceTabsView } from "./workspace-tabs";
import { WorkspaceView } from "./workspace-view";
import { AppMenu } from "./app-menu";

const TREE_WIDTH = { default: 262, collapse: 120, min: 180, max: 480 } as const;
const CURSOR_MODES: readonly CursorMode[] = ["none", "track", "measure"];
const THEME_STORAGE_KEY = "signalscope.theme";
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

  constructor(
    private readonly root: HTMLElement,
    private readonly plane: DataPlane,
  ) {}

  async mount(): Promise<void> {
    this.root.innerHTML = shellMarkup();
    this.restoreTheme();
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
          this.transitionPanelMode(id, mode);
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
        onGesture: (_id, hint) => {
          required(this.root, ".gesture-hint").textContent = hint ?? "";
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
            domain: hit.domain,
            anchor: hit.anchor,
            pinned_value: hit.pinnedValue,
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
    this.palette = new CommandPalette(this.root, (mode) =>
      this.paletteEntries(mode),
    );
    this.registerCommands();
    void new AppMenu(
      required<HTMLButtonElement>(this.root, ".menu-button"),
      this.commands,
    );
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
      section: "file",
      group: "open",
      enabled: () => this.plane.ingest !== null,
      run: () => {
        void this.openFiles();
      },
    });
    this.commands.register({
      id: "new-workspace-tab",
      title: "New workspace tab",
      section: "workspace",
      group: "new",
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
      title: "New panel",
      keys: "n",
      section: "workspace",
      group: "new",
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
      id: "cycle-cursor-mode",
      title: "Cursor: cycle none/track/measure",
      keys: "c",
      run: () => {
        this.cycleCursorMode();
      },
    });
    this.commands.register({
      id: "toggle-all-stats",
      title: "Toggle statistics on every panel",
      section: "view",
      group: "display",
      checked: () =>
        this.workspace.panels().length > 0 &&
        this.workspace.panels().every((panel) => panel.show_stats),
      run: () => {
        // Any panel still hiding stats turns them all on; otherwise all off.
        const target = this.workspace
          .panels()
          .some((panel) => !panel.show_stats);
        for (const panel of this.workspace.panels()) {
          if (panel.show_stats !== target) this.workspace.toggleStats(panel.id);
        }
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
        this.transitionPanelMode(id, "xy");
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
        this.transitionPanelMode(id, "fft");
      },
    );
    this.registerFocusedPanelCommand(
      "panel-switch-histogram",
      "Panel: switch to histogram mode",
      (id) => {
        this.transitionPanelMode(id, "histogram");
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
    for (const [axis, title] of [
      ["x", "Panel: edit X axis label"],
      ["y", "Panel: edit Y axis label"],
      ["c", "Panel: edit color axis label"],
    ] as const) {
      this.registerFocusedPanelCommand(
        `edit-${axis}-axis-label`,
        title,
        (id) => {
          this.workspaceView?.beginAxisEdit(id, axis);
        },
        undefined,
        (id) => this.workspaceView?.canEditAxis(id, axis) ?? false,
      );
    }
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
      section: "view",
      group: "docks",
      checked: () =>
        !required(this.root, ".workbench").classList.contains("tree-collapsed"),
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
      section: "view",
      group: "display",
      run: () => {
        this.toggleTheme();
      },
    });
    this.commands.register({
      id: "toggle-formula",
      title: "Toggle derived formula editor",
      keys: "e",
      section: "view",
      group: "docks",
      checked: () =>
        !required(this.root, ".workbench").classList.contains(
          "formula-collapsed",
        ),
      run: () => {
        this.toggleFormula();
      },
    });
    this.commands.register({
      id: "command-palette",
      title: "Command list",
      keys: "mod+shift+p",
      section: "help",
      group: "commands",
      run: () => {
        this.palette?.open("commands");
      },
    });
    this.commands.register({
      id: "go-to-signal",
      title: "Go to signal",
      keys: "mod+p",
      run: () => {
        this.palette?.open("signals");
      },
    });
    this.commands.register({
      id: "help",
      title: "Keyboard help",
      keys: "?",
      run: () => {
        this.palette?.open("commands");
      },
    });
    this.commands.register({
      id: "about-signalscope",
      title: "About SignalScope",
      section: "help",
      group: "about",
      run: () => {
        this.showModeHelp("SignalScope 0.4.0");
      },
    });
    for (const planned of [
      ["open-recent", "Open Recent ▸", "file", "open"],
      ["open-workspace", "Open Workspace…", "file", "workspace"],
      ["save-workspace", "Save Workspace", "file", "workspace"],
      ["save-workspace-as", "Save Workspace As…", "file", "workspace"],
      ["export", "Export ▸ HTML · PNG · CSV", "file", "export"],
      ["annotations-dock", "Annotations dock", "view", "docks"],
      ["font-size", "Font size ▸", "view", "display"],
      ["axes-default", "Axes default ▸", "view", "display"],
      ["series-palette", "Series palette ▸", "view", "display"],
      ["duplicate-workspace", "Duplicate Workspace", "workspace", "new"],
      ["save-layout-preset", "Save Layout As Preset…", "workspace", "layout"],
      ["apply-layout-preset", "Apply Preset ▸", "workspace", "layout"],
      ["reset-layout", "Reset Layout", "workspace", "layout"],
      ["keymap", "Keymap", "help", "commands"],
    ] as const) {
      this.commands.register({
        id: planned[0],
        title: planned[1],
        section: planned[2],
        group: planned[3],
        status: "planned",
        run: () => undefined,
      });
    }
  }

  /** Moves between panel domains without dropping the assigned XY x series. */
  private transitionPanelMode(panelId: string, mode: PanelMode): void {
    const panel = this.workspace.panel(panelId);
    if (panel?.mode === "xy" && mode !== "xy") {
      this.workspace.setXSignal(panelId, null);
    }
    this.workspace.setMode(panelId, mode);
    if (mode === "xy") this.workspace.promoteSeriesToX(panelId);
  }

  /** Registers a command that acts on the focused panel and refreshes. */
  private registerFocusedPanelCommand(
    id: string,
    title: string,
    act: (panelId: string) => void,
    keys?: string,
    enabled?: (panelId: string) => boolean,
  ): void {
    this.commands.register({
      id,
      title,
      ...(keys === undefined ? {} : { keys }),
      enabled: () => {
        const panelId = this.workspace.focusedPanelId();
        return panelId !== null && (enabled?.(panelId) ?? true);
      },
      run: () => {
        const panelId = this.workspace.focusedPanelId();
        if (panelId !== null) {
          act(panelId);
          this.afterLayoutChange();
        }
      },
    });
  }

  private paletteEntries(mode: PaletteMode): PaletteEntry[] {
    // Planned and momentarily unavailable commands both stay listed so the
    // palette matches the menu, but each says why it will not run.
    const commands = this.commands.listAll().map((command) => ({
      title: command.title,
      hint: command.keys === undefined ? "" : formatCombo(command.keys),
      ...unavailableReason(command),
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
    return mode === "signals"
      ? [...signals, ...tabs, ...panels]
      : [...commands, ...xSignals, ...colorSignals];
  }

  private bindControls(): void {
    document.addEventListener(
      "pointerdown",
      () => {
        this.hideTooltip();
      },
      true,
    );
    required(this.root, ".tree-toggle").addEventListener("click", () => {
      this.commands.run("toggle-signal-tree");
    });
    this.bindSignalTreeResize();
    required(this.root, ".linked-toggle").addEventListener("click", () => {
      this.commands.run("toggle-linked");
    });
    required(this.root, ".formula-toggle").addEventListener("click", () => {
      this.commands.run("toggle-formula");
    });
    required(this.root, ".cursor-toggle").addEventListener("click", () => {
      this.commands.run("cycle-cursor-mode");
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

  /** Renders the status-bar window readout from the linked-time model. */
  private renderWindowReadout(): void {
    const state = this.time.snapshot();
    required(this.root, ".window-readout").textContent =
      `window ${state.t0.toFixed(3)} → ${state.t1.toFixed(3)} s`;
  }

  private afterLayoutChange(): void {
    this.workspaceTabs?.sync(
      this.workspace.tabs(),
      this.workspace.activeTabId(),
    );
    this.workspaceView?.sync(this.signals.length > 0);
    this.workspaceView?.setCursorMode(this.workspace.cursorMode());
    this.syncCursorMode();
    void this.refreshTiles();
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
    cursor: PlotCursor | null,
    client: { x: number; y: number } | null,
  ): void {
    const mode = this.workspace.cursorMode();
    if (mode === "none") cursor = null;
    const panel = this.workspace.panel(panelId);
    const localDomain = panel?.mode === "fft" || panel?.mode === "histogram";
    if (cursor?.link === "local" || (cursor === null && localDomain)) {
      this.workspaceView?.setLocalCursor(panelId, cursor?.x ?? null);
      if (cursor === null) this.renderCursorTime();
      else this.renderCursorTime(cursor.heading);
      this.renderTooltip(
        panelId,
        mode === "track" ? cursor : null,
        mode === "track" ? client : null,
      );
      return;
    }
    const cursorT = cursor?.link === "time" ? cursor.x : null;
    this.time.setCursor(cursorT);
    const state = this.time.snapshot();
    this.workspaceView?.setCursor(state.cursorT);
    this.renderCursorTime();
    this.renderTooltip(
      panelId,
      mode === "track" && state.cursorT !== null ? cursor : null,
      mode === "track" ? client : null,
    );
    this.scheduleLiveValues(mode === "none" ? null : state.cursorT);
  }

  private cycleCursorMode(): void {
    const current = CURSOR_MODES.indexOf(this.workspace.cursorMode());
    const mode = CURSOR_MODES[(current + 1) % CURSOR_MODES.length] ?? "track";
    this.workspace.setCursorMode(mode);
    this.workspaceView?.setCursorMode(mode);
    this.syncCursorMode();
  }

  private syncCursorMode(): void {
    const mode = this.workspace.cursorMode();
    required(this.root, ".cursor-mode").textContent =
      mode === "none" ? "" : `cursor: ${mode}`;
    // The dock button cycles the same three states as `C`, so it reads as
    // pressed for every mode that puts a cursor on the plots.
    const button = required<HTMLButtonElement>(this.root, ".cursor-toggle");
    button.classList.toggle("active", mode !== "none");
    button.ariaPressed = String(mode !== "none");
    button.title = `Cursor mode: ${mode} — cycle (C)`;
    if (mode !== "track") this.hideTooltip();
    if (mode === "none") {
      this.time.setCursor(null);
      this.workspaceView?.clearCursors();
      this.renderCursorTime();
      this.scheduleLiveValues(null);
    }
  }

  private renderTooltip(
    panelId: string,
    cursor: PlotCursor | null,
    client: { x: number; y: number } | null,
  ): void {
    const tip = required<HTMLElement>(this.root, ".plot-tip");
    const panel = this.workspace.panel(panelId);
    if (cursor === null || client === null || panel === undefined) {
      tip.hidden = true;
      return;
    }
    const rows = cursor.rows.map((row) =>
      tooltipRow(
        `var(--series-${String(row.colorIndex + 1)})`,
        row.label,
        row.unit === null
          ? formatValue(row.value)
          : `${formatValue(row.value)} ${row.unit}`,
      ),
    );
    if (rows.length === 0) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(tooltipHeader(cursor.heading), ...rows);
    tip.hidden = false;
    const rect = tip.getBoundingClientRect();
    const panelRect = this.workspaceView?.panelRect(panelId);
    if (panelRect === null || panelRect === undefined) {
      tip.hidden = true;
      return;
    }
    const rightCandidate = client.x + 12;
    const leftCandidate = client.x - 12 - rect.width;
    const x = Math.max(
      panelRect.left,
      Math.min(
        rightCandidate + rect.width <= panelRect.right
          ? rightCandidate
          : leftCandidate,
        panelRect.right - rect.width,
      ),
    );
    const belowCandidate = client.y + 12;
    const aboveCandidate = client.y - 12 - rect.height;
    const y = Math.max(
      panelRect.top,
      Math.min(
        belowCandidate + rect.height <= panelRect.bottom
          ? belowCandidate
          : aboveCandidate,
        panelRect.bottom - rect.height,
      ),
    );
    tip.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
  }

  private hideTooltip(): void {
    required<HTMLElement>(this.root, ".plot-tip").hidden = true;
  }

  private renderCursorTime(localHeading?: string): void {
    const cursorT = this.time.snapshot().cursorT;
    required(this.root, ".cursor-time").textContent =
      localHeading ??
      (cursorT === null ? "t —" : `t ${formatCursorTime(cursorT)}`);
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
    const firstName = sources[0] === undefined ? "" : basename(sources[0].path);
    required(this.root, ".source-name").textContent = firstName;
    required(this.root, ".session-identity").textContent =
      firstName === ""
        ? ""
        : `${firstName} — ${this.signals.length.toLocaleString()} signals`;
    const rows = required(this.root, ".source-rows");
    rows.replaceChildren(
      ...sources.map((source) => {
        const row = document.createElement("div");
        row.className = "source-row";
        const name = document.createElement("span");
        name.className = "signal-path";
        name.textContent = basename(source.path);
        name.title = source.path;
        const points = document.createElement("span");
        points.className = "source-points";
        points.textContent = `${Number(source.point_count).toLocaleString()} pts`;
        row.append(name, points);
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
    const theme = documentRoot.dataset.theme === "light" ? "dark" : "light";
    documentRoot.dataset.theme = theme;
    this.workspace.setTheme(theme);
    storeTheme(theme);
    this.workspaceView?.invalidateTheme();
    this.renderTiles();
  }

  private restoreTheme(): void {
    const stored = storedTheme();
    const theme = stored ?? this.workspace.theme();
    document.documentElement.dataset.theme = theme;
    this.workspace.setTheme(theme);
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

/** Explains why a listed command cannot run, or nothing when it can. */
function unavailableReason(command: Command): { unavailable?: string } {
  if (command.status === "planned") {
    return { unavailable: PLANNED_TITLE };
  }
  return (command.enabled?.() ?? true)
    ? {}
    : { unavailable: "unavailable in this context" };
}

/**
 * Reads the persisted theme. The self-contained snapshot opens from `file://`,
 * where `localStorage` access can throw, so storage failures degrade to the
 * session's own theme instead of aborting the boot.
 */
function storedTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" || stored === "light" ? stored : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A snapshot opened without storage still switches theme for this session.
  }
}

function shellMarkup(): string {
  return `<main class="workbench formula-collapsed">
    <div class="title-bar">
      <button class="menu-button" aria-label="Application menu" aria-haspopup="menu" aria-expanded="false">≡</button>
      <span class="brand">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11 4 5l3 8 3-10 2 6 2-2" fill="none" stroke="var(--amber-7)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        SIGNALSCOPE
      </span>
      <span class="session-identity"></span>
    </div>

    <div class="workspace-strip">
      <nav class="workspace-tabs" aria-label="Workspace tabs" role="tablist"></nav>
      <button class="layout-slot planned" aria-disabled="true" title="${PLANNED_TITLE}">layout ▾</button>
    </div>

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
      <span class="dock-toggles">
        <button class="status-button active tree-toggle" title="Hide signal tree" aria-controls="signal-tree" aria-expanded="true">▤</button>
        <button class="status-button formula-toggle" title="Toggle derived formula editor (E)" aria-controls="formula-editor" aria-expanded="false"><span class="formula-symbol">ƒx</span></button>
        <button class="status-button cursor-toggle" title="Cursor mode: none — cycle (C)" aria-pressed="false">┼</button>
      </span>
      <span class="status-separator"></span>
      <span class="source-truth">
        <span class="source-name"></span>
        <span class="signal-count">0 signals</span>
        <span class="point-count">0 pts</span>
        <span class="render-stat">render <span class="render-ms">— ms</span></span>
      </span>
      <span class="status-spacer"></span>
      <span class="gesture-hint"></span>
      <span class="cursor-mode"></span>
      <span class="status-separator"></span>
      <span class="time-cluster">
        <button class="status-button active linked-toggle">⇄ linked</button>
        <span class="cursor-time">t —</span>
        <span class="window-readout"></span>
        <button class="follow-slot planned" aria-disabled="true" title="${PLANNED_TITLE}">‖ FOLLOW</button>
      </span>
      <span class="status-separator"></span>
      <span class="palette-hints"><span>${formatCombo("mod+p")} <i>signals</i></span><span>${formatCombo("mod+shift+p")} <i>commands</i></span></span>
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

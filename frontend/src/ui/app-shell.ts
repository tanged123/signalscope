import {
  CommandRegistry,
  formatCombo,
  PLANNED_TITLE,
  reservedWhileEditing,
  setEditingReservedCombos,
  type Command,
} from "../app/commands";
import { parseBakedSession } from "../app/baked-session";
import { buildCsv, csvMaxPoints, type CsvExport } from "../app/csv-export";
import type { DataPlane, IngestPort } from "../app/data-plane";
import { exportFileStem } from "../app/export-file";
import { browserStorage, CommandUsage } from "../app/frecency";
import {
  HistoryStack,
  historySnapshot,
  restoreTransientSessionState,
} from "../app/history";
import { runBatchIngest, waitForBatch } from "../app/ingest";
import {
  applyPreferences,
  clampPlotFontSize,
  clampUiFontSize,
  defaultPreferences,
  FONT_FAMILIES,
  fontLabel,
  parsePreferences,
  PLOT_FONT_SIZE,
  UI_FONT_SIZE,
} from "../app/preferences";
import { quickTransform } from "../app/quick-transform";
import { composePanelPng, panelPngTargets, toBase64 } from "../app/png-export";
import { mergeSampleResponses } from "../app/samples";
import { Catalog } from "../app/catalog";
import { resolvePanel } from "../app/resolution";
import { virtualSlice } from "../app/tree-model";
import { WorkspaceModel } from "../app/workspace";
import { persistWorkspace } from "../app/workspace-save";
import {
  formatCursorTime,
  formatValue,
  valueAtTime,
  zoomRange,
} from "../app/plot-math";
import {
  type BatchStatus,
  type ExportFidelity,
  type ExportRange,
  type ExportSelection,
  type SampleResponse,
  type SampleSeries,
  type SignalSummary,
  type SourceSummary,
  type TileResponse,
} from "../generated/protocol";
import type {
  CursorMode,
  PanelMode,
  PanelState,
  Session,
} from "../generated/session";
import type { Preferences } from "../generated/preferences";
import {
  CommandPalette,
  type PaletteEntry,
  type PaletteMode,
} from "./command-palette";
import { basename, bindPointerDrag, required } from "./dom";
import { FormulaBar, formulaBarMarkup } from "./formula-bar";
import {
  ExportDialog,
  type ExportFormat,
  type PngScope,
} from "./export-dialog";
import { FolderScanDialog } from "./folder-scan-dialog";
import { type QuickTransform } from "./panel";
import type { PlotCursor } from "../app/plot-capabilities";
import { SignalTreeView } from "./signal-tree";
import { WorkspaceTabsView } from "./workspace-tabs";
import { WorkspaceView } from "./workspace-view";
import { AppMenu } from "./app-menu";

const TREE_WIDTH = { default: 262, collapse: 120, min: 180, max: 480 } as const;
const CURSOR_MODES: readonly CursorMode[] = ["none", "track", "measure"];
const AUTOSAVE_DEBOUNCE_MS = 800;
/** Point cap for non-time panels: enough for a 4096-bin FFT plus edges. */
const SAMPLE_CAP = 8192;
const DERIVED_PREFIX = "derived/";

export class AppShell {
  private readonly workspace = new WorkspaceModel();
  private readonly commands = new CommandRegistry();
  private readonly usage = new CommandUsage(browserStorage(), () => Date.now());
  private readonly history = new HistoryStack();
  private signals: SignalSummary[] = [];
  private catalog = Catalog.empty();
  private signalsByPath = new Map<string, SignalSummary>();
  private workspaceView: WorkspaceView | null = null;
  private workspaceTabs: WorkspaceTabsView | null = null;
  private tree: SignalTreeView | null = null;
  private palette: CommandPalette | null = null;
  private formulaBar: FormulaBar | null = null;
  private exportDialog: ExportDialog | null = null;
  private folderScanDialog: FolderScanDialog | null = null;
  private sourcesExpanded = false;
  private exportPng: Uint8Array | null = null;
  private readonly exportCsv = new Map<ExportFidelity, CsvExport>();
  private exportGeneration = 0;
  private tilesByPanel = new Map<string, TileResponse>();
  private samplesByPanel = new Map<string, SampleResponse>();
  private missingByPanel = new Map<string, string[]>();
  private signalTreeWidth: number = TREE_WIDTH.default;
  private refreshToken = 0;
  private renderScheduled = false;
  private refreshTimer: number | null = null;
  private helpTimer: number | null = null;
  private liveValuesScheduled = false;
  private pendingCursorT: number | null = null;
  private autosaveTimer: number | null = null;
  private prefs: Preferences = defaultPreferences();
  private prefsSaveTimer: number | null = null;
  private workspacePath: string | null = null;
  private dirty = false;
  private restoringHistory = false;
  private historyGestureKey: string | null = null;
  private historyCoalesceTimer: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly plane: DataPlane,
  ) {}

  async mount(): Promise<void> {
    this.root.innerHTML = shellMarkup();
    await this.loadPreferences();
    await this.restoreSession();
    this.history.reset(historySnapshot(this.workspace.snapshot()));
    this.restoreTheme();
    if (this.plane.derived === null) {
      required<HTMLElement>(this.root, ".formula-toggle").hidden = true;
    }
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
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onDropSignals: (id, paths) => {
          this.plotSignals(paths, id);
        },
        onToggleHighlight: (id, path) => {
          const ref = this.catalog.refFromPath(path);
          if (ref === undefined) return;
          this.workspace.toggleFocus(id, {
            kind: "series",
            ref,
            source_key: null,
            channel: ref.channel,
          });
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        localPathFor: (path) =>
          this.isDerivedPath(path)
            ? path.slice(DERIVED_PREFIX.length)
            : (this.signalsByPath.get(path)?.local_path ?? null),
        sourceKeyFor: (path) =>
          this.isDerivedPath(path)
            ? "derived"
            : (this.signalsByPath.get(path)?.source_key ?? null),
        pathForRef: (ref) => this.catalog.get(ref)?.path ?? null,
        resolveSeries: (state) =>
          resolvePanel(this.catalog, state, this.workspace.namedSets()),
        onSetXSignal: (id, path) => {
          this.workspace.setMode(id, "xy");
          const ref = this.catalog.refFromPath(path);
          if (ref === undefined) return;
          this.workspace.setXRef(id, ref);
          this.workspace.focusPanel(id);
          this.afterLayoutChange();
        },
        onSetColorSignal: (id, path) => {
          this.workspace.setColorRef(
            id,
            path === null ? null : (this.catalog.refFromPath(path) ?? null),
          );
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onClearXSignal: (id) => {
          this.clearXSignal(id);
        },
        onToggleSeries: (id, ref) => {
          this.workspace.toggleSeriesVisible(id, ref);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onResized: () => {
          this.scheduleRender();
        },
        onGesture: (id, hint) => {
          required(this.root, ".gesture-hint").textContent = hint ?? "";
          if (hint === null) {
            this.historyGestureKey = null;
            this.closeHistoryCoalescing();
          } else {
            this.historyGestureKey = `range:${id}`;
            this.clearHistoryCoalesceTimer();
          }
        },
        onCursor: (id, cursor, client) => {
          this.setCursor(id, cursor, client);
        },
        onTimeWindow: (id, t0, t1) => {
          this.applyTimeWindow(id, t0, t1);
        },
        onYRange: (id, range) => {
          this.workspace.setPanelYRange(id, [range[0], range[1]]);
          this.commitHistory(`range:${id}`);
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
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
        },
        onRemoveAnnotation: (id, annotationId) => {
          this.workspace.removeAnnotation(id, annotationId);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
        },
        onEditAnnotationLabel: (id, annotationId, label) => {
          this.workspace.setAnnotationLabel(id, annotationId, label);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
        },
        onFitView: (id) => {
          this.fitPanelView(id);
        },
        onToggleStats: (id) => {
          this.workspace.toggleStats(id);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onToggleAxisStyle: (id) => {
          this.workspace.toggleAxisStyle(id);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onRenameTitle: (id, title) => {
          this.workspace.renamePanel(id, title);
          this.afterLayoutChange();
        },
        onEditAxisLabel: (id, axis, label) => {
          this.workspace.setAxisLabel(id, axis, label);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onSetSeriesStyle: (id, ref, style) => {
          this.workspace.setSeriesOverride(id, ref, style);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onRemoveSeries: (id, ref) => {
          this.workspace.removeSeriesRef(id, ref, this.catalog.get(ref)?.path);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onQuickTransform: (_id, path, kind) => {
          void this.applyQuickTransform(path, kind);
        },
        onLayoutChanged: () => {
          this.commitHistory();
          void this.refreshTiles();
        },
        onDropSignalNewPanel: (path) => {
          const panel = this.workspace.addPanelRow();
          this.plotSignal(path, panel.id);
        },
        onDropSignalsNewPanel: (memberPaths) => {
          const panel = this.workspace.addPanelRow();
          this.plotSignals(memberPaths, panel.id);
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
      required(this.root, ".tree-sets"),
      {
        onPlotSignal: (path) => {
          this.plotSignal(path);
        },
        onPlotSignals: (paths) => {
          this.plotSignals(paths);
        },
        onSetSelected: (set) => {
          const paths =
            set.kind === "pick"
              ? set.refs
                  .map((ref) => this.catalog.get(ref)?.path)
                  .filter((path): path is string => path !== undefined)
              : this.catalog
                  .allSeries()
                  .filter((series) => series.channel === set.selector)
                  .map((series) => series.path);
          this.plotSignals(paths);
        },
        onRemoveDerived: (path) => {
          void this.removeDerived(path);
        },
      },
    );
    this.palette = new CommandPalette(this.root, (mode) =>
      this.paletteEntries(mode),
    );
    this.formulaBar = new FormulaBar(required(this.root, ".formula-bar"), {
      onCreate: (path, expression) => this.createDerived(path, expression),
      onClose: () => {
        this.setFormulaOpen(false);
      },
    });
    this.registerCommands();
    this.commands.onRun = (id) => {
      this.usage.record(id);
    };
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
        const ref = this.catalog.refFromPath(summary.path);
        if (ref !== undefined) this.workspace.addSeriesRef(panel.id, ref);
      }
      this.fitWindowToPlotted();
    }
    this.afterLayoutChange();
    this.renderWorkspaceName();
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
    const undoCommand: Command = {
      id: "undo",
      title: "Undo",
      keys: "mod+z",
      section: "workspace",
      group: "history",
      enabled: () => this.history.canUndo(),
      run: () => {
        this.applyHistory(this.history.undo());
      },
    };
    const redoCommand: Command = {
      id: "redo",
      title: "Redo",
      keys: "mod+shift+z",
      altKeys: ["mod+y"],
      section: "workspace",
      group: "history",
      enabled: () => this.history.canRedo(),
      run: () => {
        this.applyHistory(this.history.redo());
      },
    };
    this.commands.register(undoCommand);
    this.commands.register(redoCommand);
    setEditingReservedCombos(
      [
        undoCommand.keys,
        redoCommand.keys,
        ...(redoCommand.altKeys ?? []),
      ].filter((keys): keys is string => keys !== undefined),
    );
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
      id: "open-folder",
      title: "Open folder…",
      section: "file",
      group: "open",
      enabled: () => this.plane.ingest !== null,
      run: () => {
        void this.openFolder();
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
        this.commitHistory();
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
        this.workspace.setColorRef(id, null);
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
      id: "increase-plot-font",
      title: "Plot font size: increase",
      keys: "mod+=",
      section: "view",
      group: "display",
      run: () => {
        this.updatePreferences({
          plot_font_size: this.prefs.plot_font_size + PLOT_FONT_SIZE.step,
        });
      },
    });
    this.commands.register({
      id: "decrease-plot-font",
      title: "Plot font size: decrease",
      keys: "mod+-",
      section: "view",
      group: "display",
      run: () => {
        this.updatePreferences({
          plot_font_size: this.prefs.plot_font_size - PLOT_FONT_SIZE.step,
        });
      },
    });
    this.commands.register({
      id: "reset-plot-font",
      title: "Plot font size: reset",
      keys: "mod+0",
      section: "view",
      group: "display",
      run: () => {
        this.updatePreferences({ plot_font_size: PLOT_FONT_SIZE.default });
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
      id: "open-settings",
      title: "Settings…",
      keys: "mod+,",
      section: "view",
      group: "display",
      run: () => {
        this.palette?.open("settings");
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
        this.showModeHelp("SignalScope 0.14.3");
      },
    });
    this.commands.register({
      id: "new-workspace",
      title: "New Workspace",
      keys: "mod+n",
      section: "file",
      group: "workspace",
      enabled: () => this.plane.session !== null,
      run: () => {
        void this.newWorkspace();
      },
    });
    this.commands.register({
      id: "open-workspace",
      title: "Open Workspace…",
      keys: "mod+o",
      section: "file",
      group: "workspace",
      enabled: () => this.plane.session !== null,
      run: () => {
        void this.pickAndLoadWorkspace();
      },
    });
    this.commands.register({
      id: "save-workspace",
      title: "Save Workspace",
      keys: "mod+s",
      section: "file",
      group: "workspace",
      enabled: () => this.plane.session !== null,
      run: () => {
        void this.saveWorkspace(false);
      },
    });
    this.commands.register({
      id: "save-workspace-as",
      title: "Save Workspace As…",
      section: "file",
      group: "workspace",
      enabled: () => this.plane.session !== null,
      run: () => {
        void this.saveWorkspace(true);
      },
    });
    this.commands.register({
      id: "export-html",
      title: "Export ▸ HTML Snapshot…",
      section: "file",
      group: "export",
      enabled: () => this.plane.exporter !== null,
      run: () => {
        this.openExportDialog("html");
      },
    });
    this.commands.register({
      id: "export-png",
      title: "Export ▸ PNG…",
      section: "file",
      group: "export",
      enabled: () =>
        this.plane.exporter !== null &&
        this.workspace.focusedPanelId() !== null,
      run: () => {
        this.openExportDialog("png");
      },
    });
    this.commands.register({
      id: "export-csv",
      title: "Export ▸ Visible CSV…",
      section: "file",
      group: "export",
      enabled: () =>
        this.plane.exporter !== null &&
        this.workspace.focusedPanelId() !== null,
      run: () => {
        this.openExportDialog("csv");
      },
    });
    for (const planned of [
      ["open-recent", "Open Recent ▸", "file", "open"],
      ["annotations-dock", "Annotations dock", "view", "docks"],
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

  private settingsEntries(): PaletteEntry[] {
    const cycleFont = (key: "ui_font_family" | "plot_font_family"): void => {
      const index = FONT_FAMILIES.indexOf(this.prefs[key]);
      const next = FONT_FAMILIES[(index + 1) % FONT_FAMILIES.length] ?? "inter";
      this.updatePreferences({ [key]: next });
    };
    const sizeEntry = (
      title: string,
      key: "ui_font_size" | "plot_font_size",
      step: number,
    ): PaletteEntry => ({
      title,
      hint: `${String(this.prefs[key])}px`,
      keepOpen: true,
      run: () => {
        this.updatePreferences({ [key]: this.prefs[key] + step });
      },
      adjust: (direction) => {
        this.updatePreferences({ [key]: this.prefs[key] + direction * step });
      },
    });
    return [
      {
        title: "Theme",
        hint: this.workspace.theme(),
        keepOpen: true,
        run: () => {
          this.toggleTheme();
        },
      },
      {
        title: "UI font",
        hint: fontLabel(this.prefs.ui_font_family),
        keepOpen: true,
        run: () => {
          cycleFont("ui_font_family");
        },
      },
      {
        title: "Plot font",
        hint: fontLabel(this.prefs.plot_font_family),
        keepOpen: true,
        run: () => {
          cycleFont("plot_font_family");
        },
      },
      sizeEntry("UI font size", "ui_font_size", UI_FONT_SIZE.step),
      sizeEntry("Plot font size", "plot_font_size", PLOT_FONT_SIZE.step),
      {
        title: "Reset appearance to defaults",
        hint: "",
        keepOpen: true,
        run: () => {
          const defaults = defaultPreferences();
          this.updatePreferences({
            ui_font_family: defaults.ui_font_family,
            plot_font_family: defaults.plot_font_family,
            ui_font_size: defaults.ui_font_size,
            plot_font_size: defaults.plot_font_size,
          });
        },
      },
    ];
  }

  private paletteEntries(mode: PaletteMode): PaletteEntry[] {
    if (mode === "settings") return this.settingsEntries();
    // Planned and momentarily unavailable commands both stay listed so the
    // palette matches the menu, but each says why it will not run.
    const ranked = [...this.commands.listAll()].sort(
      (left, right) => this.usage.score(right.id) - this.usage.score(left.id),
    );
    const commands = ranked.map((command) => ({
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
              const ref = this.catalog.refFromPath(summary.path);
              if (ref !== undefined) this.workspace.setXRef(focused, ref);
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
                this.workspace.setColorByTime(focused);
                this.afterLayoutChange();
              },
            },
            ...this.signals.map((summary) => ({
              title: `Panel: set color signal (c:)… ${summary.path}`,
              hint: "signal",
              run: () => {
                const ref = this.catalog.refFromPath(summary.path);
                if (ref !== undefined) this.workspace.setColorRef(focused, ref);
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
    required<HTMLInputElement>(this.root, ".signal-search").addEventListener(
      "input",
      (event) => {
        this.tree?.setFilter((event.target as HTMLInputElement).value);
      },
    );
    window.addEventListener("keydown", (event) => {
      if (this.palette?.isOpen() === true) return;
      if (this.exportDialog?.isOpen() === true) return;
      const target = event.target;
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (
        editing &&
        ((!event.metaKey && !event.ctrlKey) || reservedWhileEditing(event))
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
    const ref = this.catalog.refFromPath(path);
    if (ref !== undefined && this.workspace.addSeriesRef(target, ref)) {
      this.workspace.focusPanel(target);
      this.fitWindowToPlotted();
      this.afterLayoutChange();
    }
  }

  private plotSignals(memberPaths: readonly string[], panelId?: string): void {
    let target = this.workspace.focusedPanelId();
    if (panelId !== undefined) target = panelId;
    if (target === null) target = this.workspace.addPanelRow().id;
    const refs = memberPaths
      .map((path) => this.catalog.refFromPath(path))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined);
    if (this.workspace.addSeriesRefs(target, refs)) {
      this.workspace.focusPanel(target);
      this.fitWindowToPlotted();
      this.afterLayoutChange();
    }
  }

  private async openFiles(): Promise<void> {
    const port = this.plane.ingest;
    if (port === null) return;
    try {
      const paths = await port.pickSources();
      if (paths.length > 0) await this.ingestPaths(paths);
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  private async openFolder(): Promise<void> {
    const port = this.plane.ingest;
    if (port === null) return;
    try {
      const folder = await port.pickSourceFolder();
      if (folder === null) return;
      this.folderScanDialog ??= new FolderScanDialog(this.root);
      this.folderScanDialog.open(
        folder,
        (recursive) => port.scanSources(folder, recursive),
        (paths) => {
          if (paths.length > 0) void this.ingestPaths(paths);
        },
      );
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  private async ingestPaths(paths: string[]): Promise<void> {
    const port = this.plane.ingest;
    if (port === null || paths.length === 0) return;
    const progress = required<HTMLElement>(this.root, ".ingest-progress");
    let keepProgress = false;
    try {
      progress.hidden = false;
      let jobId: string | null = null;
      const tracked: IngestPort = {
        ...port,
        startBatch: async (batchPaths) => {
          jobId = await port.startBatch(batchPaths);
          return jobId;
        },
      };
      const status = await runBatchIngest(tracked, paths, (current) => {
        renderBatchProgress(progress, current, () => {
          if (jobId !== null) void port.cancelBatch(jobId);
        });
      });
      keepProgress = status.recent_failures.length > 0;
      await this.reloadSignals();
      this.afterLayoutChange();
    } catch (error: unknown) {
      this.reportError(error);
    } finally {
      progress.hidden = !keepProgress;
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
        resolvePanel(this.catalog, panel, this.workspace.namedSets()).map(
          (series) => series.path,
        ),
      ),
    );
    if (extent === null) return;
    this.workspace.setLinkedWindow(extent.t0, extent.t1);
    this.renderWindowReadout();
  }

  /** Renders the status-bar window readout from the session's linked time. */
  private renderWindowReadout(): void {
    const state = this.workspace.linkedTime();
    required(this.root, ".window-readout").textContent =
      `window ${state.t0.toFixed(3)} → ${state.t1.toFixed(3)} s`;
  }

  /** Records the post-mutation state; no-op while restoring history. */
  private commitHistory(coalesceKey?: string): void {
    if (this.restoringHistory) return;
    const key = this.historyGestureKey ?? coalesceKey;
    this.history.commit(historySnapshot(this.workspace.snapshot()), key);
    if (key === undefined || this.historyGestureKey !== null) {
      this.clearHistoryCoalesceTimer();
      return;
    }
    this.clearHistoryCoalesceTimer();
    this.historyCoalesceTimer = window.setTimeout(() => {
      this.historyCoalesceTimer = null;
      this.history.commit(historySnapshot(this.workspace.snapshot()));
    }, 250);
  }

  private closeHistoryCoalescing(): void {
    this.clearHistoryCoalesceTimer();
    this.history.commit(historySnapshot(this.workspace.snapshot()));
  }

  private clearHistoryCoalesceTimer(): void {
    if (this.historyCoalesceTimer === null) return;
    window.clearTimeout(this.historyCoalesceTimer);
    this.historyCoalesceTimer = null;
  }

  private applyHistory(session: Session | null): void {
    if (session === null) return;
    this.restoringHistory = true;
    try {
      this.workspace.replace(
        restoreTransientSessionState(session, this.workspace.snapshot()),
      );
      document.documentElement.dataset.theme = this.workspace.theme();
      this.workspaceView?.invalidateTheme();
      this.renderWindowReadout();
      this.afterLayoutChange();
      this.workspaceView?.setCursor(this.workspace.linkedTime().cursorT);
      required(this.root, ".linked-toggle").classList.toggle(
        "active",
        this.workspace.linkedTime().linked,
      );
    } finally {
      this.restoringHistory = false;
    }
    void this.replayMissingDerived();
  }

  /**
   * After an undo resurrects derived definitions the data plane no longer
   * holds (their removal really deleted the signal), recreate them exactly
   * as session load does. Unresolved definitions stay recorded.
   */
  private async replayMissingDerived(): Promise<void> {
    const port = this.plane.derived;
    if (port === null) return;
    const missing = this.workspace
      .derived()
      .filter((definition) => !this.signalsByPath.has(definition.path));
    if (missing.length === 0) return;
    for (const definition of missing) {
      try {
        await port.create(definition.path, definition.expr);
      } catch {
        // Unresolved definitions stay recorded for a later source retry.
      }
    }
    await this.reloadSignals();
    await this.refreshTiles();
  }

  private afterLayoutChange(): void {
    this.commitHistory();
    this.workspaceTabs?.sync(
      this.workspace.tabs(),
      this.workspace.activeTabId(),
    );
    this.workspaceView?.sync(this.signals.length > 0);
    this.workspaceView?.setCursorMode(this.workspace.cursorMode());
    this.syncCursorMode();
    void this.refreshTiles();
    this.scheduleAutosave();
  }

  /** Coalesces rapid state changes into one write. */
  scheduleAutosave(): void {
    if (this.plane.session === null) return;
    this.dirty = true;
    this.renderWorkspaceName();
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      void this.plane.session
        ?.save(JSON.stringify(this.workspace.snapshot()), null)
        .catch((error: unknown) => {
          this.reportError(error);
        });
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Loads global preferences; any failure falls back to defaults without
   * touching the stored file (it is only written on a user change). */
  private async loadPreferences(): Promise<void> {
    const port = this.plane.preferences;
    if (port !== null) {
      try {
        const json = await port.load();
        const parsed = json === null ? null : parsePreferences(json);
        if (json !== null && parsed === null) {
          console.warn(
            "preferences file is unreadable or newer; using defaults",
          );
        }
        this.prefs = parsed ?? defaultPreferences();
      } catch (error: unknown) {
        console.warn("preferences load failed; using defaults", error);
      }
    }
    applyPreferences(this.prefs, document.documentElement);
  }

  private updatePreferences(
    patch: Partial<Omit<Preferences, "schema_version">>,
  ): void {
    this.prefs = { ...this.prefs, ...patch };
    this.prefs.ui_font_size = clampUiFontSize(this.prefs.ui_font_size);
    this.prefs.plot_font_size = clampPlotFontSize(this.prefs.plot_font_size);
    applyPreferences(this.prefs, document.documentElement);
    this.workspaceView?.invalidateTheme();
    this.renderTiles();
    this.schedulePreferencesSave();
  }

  /** Coalesces rapid setting changes into one write, like autosave. */
  private schedulePreferencesSave(): void {
    const port = this.plane.preferences;
    if (port === null) return;
    if (this.prefsSaveTimer !== null) window.clearTimeout(this.prefsSaveTimer);
    this.prefsSaveTimer = window.setTimeout(() => {
      this.prefsSaveTimer = null;
      void port.save(JSON.stringify(this.prefs)).catch((error: unknown) => {
        this.reportError(error);
      });
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Restores the baked snapshot session or the autosaved session. */
  private async restoreSession(): Promise<void> {
    const baked = this.plane.bakedSessionJson;
    if (baked !== undefined && baked !== "") {
      this.workspace.replace(parseBakedSession(baked));
      return;
    }
    await this.loadSession(null);
  }

  private async saveWorkspace(saveAs: boolean): Promise<void> {
    const port = this.plane.session;
    if (port === null) return;
    try {
      const savedPath = await persistWorkspace(
        port,
        JSON.stringify(this.workspace.snapshot()),
        this.workspacePath,
        saveAs,
      );
      if (savedPath === null) return;
      this.workspacePath = savedPath;
      this.dirty = false;
      this.renderWorkspaceName();
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  private openExportDialog(format: ExportFormat): void {
    this.exportGeneration += 1;
    this.exportPng = null;
    this.exportCsv.clear();
    this.exportDialog ??= new ExportDialog(this.root, {
      estimateHtml: async (setKeys) => {
        const exporter = this.plane.exporter;
        if (exporter === null) return null;
        try {
          return await exporter.estimate(
            JSON.stringify(this.workspace.snapshot()),
            this.exportSelection(setKeys),
          );
        } catch (error: unknown) {
          this.reportError(error);
          return null;
        }
      },
      exportSets: () =>
        this.signals.map((source) => ({
          key: source.source_key,
          label: source.path,
        })),
      pngBytes: async () => {
        const generation = this.exportGeneration;
        try {
          const png = await this.buildVisiblePng();
          if (generation === this.exportGeneration) this.exportPng = png;
          return png?.length ?? null;
        } catch (error: unknown) {
          this.reportError(error);
          return null;
        }
      },
      pngPanelCount: () => panelPngTargets(this.workspace.tabs()).length,
      csvEstimate: async (fidelity) => {
        const generation = this.exportGeneration;
        try {
          const csv = await this.buildVisibleCsv(fidelity);
          if (csv === null) return null;
          if (generation === this.exportGeneration) {
            this.exportCsv.set(fidelity, csv);
          }
          return {
            bytes: new TextEncoder().encode(csv.text).length,
            rows: csv.rows,
            stride: csv.stride,
          };
        } catch (error: unknown) {
          this.reportError(error);
          return null;
        }
      },
      runExport: async (selected, range, fidelity, pngScope, setKeys) => {
        const cachedPng = this.exportPng;
        const cachedCsv = this.exportCsv.get(fidelity);
        this.exportGeneration += 1;
        try {
          await this.runExport(
            selected,
            range,
            fidelity,
            pngScope,
            cachedPng,
            cachedCsv,
            setKeys,
          );
        } catch (error: unknown) {
          this.reportError(error);
          throw error;
        }
      },
    });
    this.exportDialog.open(format);
  }

  private async runExport(
    format: ExportFormat,
    range: ExportRange,
    fidelity: ExportFidelity,
    pngScope: PngScope,
    cachedPng: Uint8Array | null,
    cachedCsv: CsvExport | undefined,
    setKeys: readonly string[],
  ): Promise<void> {
    const exporter = this.plane.exporter;
    if (exporter === null) return;
    let path: string | null;
    if (format === "html") {
      path = await exporter.writeHtml(
        JSON.stringify(this.workspace.snapshot()),
        range,
        fidelity,
        this.exportSelection(setKeys),
      );
    } else if (format === "png") {
      if (pngScope === "all") {
        path = await this.exportAllPanelPngs();
      } else {
        const panelId = this.workspace.focusedPanelId();
        const panel =
          panelId === null ? undefined : this.workspace.panel(panelId);
        if (panel === undefined) return;
        const bytes = cachedPng ?? (await this.buildVisiblePng());
        if (bytes === null) return;
        const name = exportFileStem(panel.title, panel.id);
        path = await exporter.saveFile(`${name}.png`, "png", toBase64(bytes));
      }
    } else {
      const panelId = this.workspace.focusedPanelId();
      const panel =
        panelId === null ? undefined : this.workspace.panel(panelId);
      if (panel === undefined) return;
      const name = exportFileStem(panel.title, panel.id);
      const csv = cachedCsv ?? (await this.buildVisibleCsv(fidelity));
      if (csv === null) return;
      path = await exporter.saveFile(
        `${name}.csv`,
        "csv",
        toBase64(new TextEncoder().encode(csv.text)),
      );
    }
    if (path !== null) this.showModeHelp(`exported ${path}`);
  }

  private exportSelection(sourceKeys?: readonly string[]): ExportSelection {
    const session = this.workspace.snapshot();
    return {
      source_keys: [
        ...(sourceKeys ?? session.sources.map((source) => source.key)),
      ],
    };
  }

  private async buildVisiblePng(): Promise<Uint8Array | null> {
    const panelId = this.workspace.focusedPanelId();
    if (panelId === null) return null;
    return this.buildPanelPng(panelId);
  }

  private async buildPanelPng(panelId: string): Promise<Uint8Array | null> {
    const panel = this.workspace.panel(panelId);
    const canvases = this.workspaceView?.panelCanvases(panelId) ?? null;
    if (panel === undefined || canvases === null) return null;
    const styles = getComputedStyle(document.documentElement);
    const composed = composePanelPng(
      panel.title,
      canvases.plot,
      canvases.overlay,
      {
        background: styles.getPropertyValue("--surface-1").trim(),
        text: styles.getPropertyValue("--fg-1").trim(),
        font: styles.getPropertyValue("--font-ui").trim(),
      },
    );
    const blob = await new Promise<Blob | null>((resolve) => {
      composed.toBlob(resolve, "image/png");
    });
    return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
  }

  private async exportAllPanelPngs(): Promise<string | null> {
    const exporter = this.plane.exporter;
    if (exporter === null) return null;
    const directory = await exporter.pickDirectory();
    if (directory === null) return null;
    const targets = panelPngTargets(this.workspace.tabs());
    const viewState = this.workspace.captureViewState();
    let activeTabId: string | null = null;
    try {
      for (const target of targets) {
        if (target.tabId !== activeTabId) {
          if (!this.workspace.showTabForExport(target.tabId)) {
            throw new Error(`workspace ${target.tabId} is unavailable`);
          }
          activeTabId = target.tabId;
          this.syncWorkspaceForExport();
          await this.refreshTiles();
        }
        const bytes = await this.buildPanelPng(target.panelId);
        if (bytes === null) {
          throw new Error(`panel ${target.panelId} could not be rendered`);
        }
        try {
          await exporter.saveFileToDirectory(
            directory,
            target.fileName,
            "png",
            toBase64(bytes),
          );
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`failed to export ${target.fileName}: ${message}`);
        }
      }
      return directory;
    } finally {
      this.workspace.restoreViewState(viewState);
      this.syncWorkspaceForExport();
      await this.refreshTiles();
    }
  }

  private syncWorkspaceForExport(): void {
    this.workspaceTabs?.sync(
      this.workspace.tabs(),
      this.workspace.activeTabId(),
    );
    this.workspaceView?.sync(this.signals.length > 0);
    this.workspaceView?.setCursorMode(this.workspace.cursorMode());
  }

  private async buildVisibleCsv(
    fidelity: ExportFidelity,
  ): Promise<CsvExport | null> {
    const panelId = this.workspace.focusedPanelId();
    if (panelId === null) return null;
    const panel = this.workspace.panel(panelId);
    if (panel === undefined) return null;
    const { ids } = this.panelSignalIds(panel);
    if (ids.length === 0) return null;
    const window = this.effectiveWindow(panel);
    const response = await this.plane.querySamples({
      request_id: crypto.randomUUID(),
      signal_ids: ids,
      window,
      max_points: csvMaxPoints(fidelity),
    });
    const byId = new Map(
      response.series.map((series) => [series.signal_id, series]),
    );
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((series): series is SampleSeries => series !== undefined);
    return buildCsv(ordered, window);
  }

  private async newWorkspace(): Promise<void> {
    const port = this.plane.session;
    if (port === null) return;
    try {
      if (this.autosaveTimer !== null) {
        window.clearTimeout(this.autosaveTimer);
        this.autosaveTimer = null;
      }
      const loaded = await port.reset();
      this.workspace.replace(JSON.parse(loaded.session_json) as Session);
      this.history.reset(historySnapshot(this.workspace.snapshot()));
      this.workspacePath = null;
      this.tilesByPanel.clear();
      this.samplesByPanel.clear();
      this.missingByPanel.clear();
      document.documentElement.dataset.theme = this.workspace.theme();
      this.workspaceView?.invalidateTheme();
      await this.reloadSignals();
      this.afterLayoutChange();
      this.dirty = false;
      this.renderWorkspaceName();
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  private async pickAndLoadWorkspace(): Promise<void> {
    const port = this.plane.session;
    if (port === null) return;
    try {
      const target = await port.pick("open");
      if (target === null) return;
      await this.loadSession(target);
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  /**
   * Replaces the current session, re-ingests its sources, and replays its
   * derived definitions in order. Definitions whose references are missing
   * stay recorded; their panels show the unresolved-signal empty state.
   */
  async loadSession(path: string | null): Promise<void> {
    const port = this.plane.session;
    if (port === null) return;
    const progress = required<HTMLElement>(this.root, ".ingest-progress");
    try {
      if (this.autosaveTimer !== null) {
        window.clearTimeout(this.autosaveTimer);
        this.autosaveTimer = null;
      }
      const loaded = await port.load(path);
      let sessionJson = loaded.session_json;
      const ingestPort = this.plane.ingest;
      const restorePort = this.plane.restore;
      if (ingestPort !== null && restorePort !== null) {
        progress.hidden = false;
        const jobId = await restorePort.start(sessionJson);
        let reconciliationAttempted = false;
        try {
          await waitForBatch(ingestPort, jobId, (status) => {
            renderBatchProgress(progress, status, () => {
              void ingestPort.cancelBatch(jobId);
            });
          });
          const reconciled = await restorePort.reconcile(sessionJson, jobId);
          reconciliationAttempted = true;
          sessionJson = reconciled.session_json;
          const conflict = reconciled.conflicts[0];
          if (conflict !== undefined) {
            this.showModeHelp(
              `${conflict.legacy_path} is claimed by ${String(conflict.claimants.length)} sources — relink to finish restoring`,
            );
          }
        } finally {
          if (!reconciliationAttempted) {
            await restorePort.reconcile(sessionJson, jobId).catch(() => {});
          }
          await ingestPort.releaseBatch(jobId);
        }
      }
      this.workspace.replace(JSON.parse(sessionJson) as Session);
      this.history.reset(historySnapshot(this.workspace.snapshot()));
      this.workspacePath = loaded.path;
      this.dirty = false;
      document.documentElement.dataset.theme = this.workspace.theme();
      this.workspaceView?.invalidateTheme();

      await this.reloadSignals();

      const derivedPort = this.plane.derived;
      if (derivedPort !== null) {
        for (const definition of [...this.workspace.derivedBundles()]) {
          try {
            await derivedPort.createBundle(definition.name, definition.expr);
          } catch {
            // Unresolved definitions stay recorded for a later source retry.
          }
        }
        await this.reloadSignals();
        for (const definition of [...this.workspace.derived()]) {
          try {
            await derivedPort.create(definition.path, definition.expr);
          } catch {
            // Unresolved definitions stay recorded for a later source retry.
          }
        }
        await this.reloadSignals();
      }

      this.afterLayoutChange();
      this.dirty = false;
      this.renderWorkspaceName();
    } catch (error: unknown) {
      this.reportError(error);
    } finally {
      progress.hidden = true;
    }
  }

  /** Shows the open workspace's file name and whether it has unsaved edits. */
  private renderWorkspaceName(): void {
    const element = required<HTMLElement>(this.root, ".workspace-name");
    const name =
      this.workspacePath === null ? "Untitled" : basename(this.workspacePath);
    element.textContent = this.dirty ? `${name} •` : name;
  }

  /**
   * Creates a derived signal, records its definition in the session, and
   * plots it on the focused panel. Task 16's session replay calls this too.
   */
  async createDerived(path: string, expr: string): Promise<void> {
    const port = this.plane.derived;
    if (port === null) throw new Error("This snapshot cannot create signals");
    const summary = await port.create(path, expr);
    this.workspace.addDerived(summary.path, expr);
    await this.reloadSignals();
    const focused = this.workspace.focusedPanelId();
    const ref = this.catalog.refFromPath(summary.path);
    if (focused !== null && ref !== undefined)
      this.workspace.addSeriesRef(focused, ref);
    this.afterLayoutChange();
  }

  private async removeDerived(path: string): Promise<void> {
    const port = this.plane.derived;
    if (port === null) return;
    const ref = this.catalog.refFromPath(path);
    if (ref === undefined) return;
    try {
      await port.remove(path);
      this.workspace.removeSignalRef(ref, path);
      await this.reloadSignals();
      this.afterLayoutChange();
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  private async applyQuickTransform(
    path: string,
    kind: QuickTransform,
  ): Promise<void> {
    try {
      await this.createDerived(...quickTransform(path, kind));
    } catch (error: unknown) {
      this.reportError(error);
    }
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
    this.catalog = Catalog.build(this.signals);
    this.signalsByPath = new Map(
      this.signals.map((summary) => [summary.path, summary]),
    );
    this.tree?.setCatalog(this.catalog);
    this.tree?.setNamedSets(this.workspace.namedSets());
    this.formulaBar?.setSignals(this.signals.map((summary) => summary.path));
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
    const nextMissing = new Map<string, string[]>();
    await Promise.all(
      this.workspace.panels().map(async (panel) => {
        const { ids, missing } = this.panelSignalIds(panel);
        nextMissing.set(panel.id, missing);
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
    this.missingByPanel = nextMissing;
    this.renderTiles();
  }

  /**
   * Signal ids a panel needs: its series, plus the XY x signal and the
   * colour channel, which are axes rather than plotted series.
   */
  private panelSignalIds(panel: PanelState): {
    ids: string[];
    missing: string[];
  } {
    const resolved = resolvePanel(
      this.catalog,
      panel,
      this.workspace.namedSets(),
    );
    const paths = resolved.map((series) => series.path);
    if (panel.mode === "xy") {
      const x = panel.x_ref === null ? null : this.catalog.get(panel.x_ref);
      if (x !== null && x !== undefined) {
        paths.unshift(x.path);
        for (const series of resolved) {
          const paired = this.catalog.get({
            source_key: series.ref.source_key,
            channel: x.channel,
          });
          if (paired !== undefined) paths.push(paired.path);
        }
      }
      const color =
        panel.color_ref === null ? null : this.catalog.get(panel.color_ref);
      if (color !== null && color !== undefined) {
        paths.push(color.path);
        for (const series of resolved) {
          const paired = this.catalog.get({
            source_key: series.ref.source_key,
            channel: color.channel,
          });
          if (paired !== undefined) paths.push(paired.path);
        }
      }
    }
    const ids: string[] = [];
    const missing: string[] = [];
    for (const path of new Set(paths)) {
      const id = this.signalsByPath.get(path)?.signal_id;
      if (id === undefined) missing.push(path);
      else ids.push(id);
    }
    return { ids, missing };
  }

  private isDerivedPath(path: string): boolean {
    return this.workspace.derived().some((entry) => entry.path === path);
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
    const state = this.workspace.linkedTime();
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
        (panelId) => this.missingByPanel.get(panelId) ?? [],
      ) ?? 0;
    required(this.root, ".render-ms").textContent = `${elapsed.toFixed(1)} ms`;
  }

  private applyTimeWindow(panelId: string, t0: number, t1: number): void {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return;
    const panel = this.workspace.panel(panelId);
    if (panel === undefined) return;
    if (this.workspace.linkedTime().linked && panel.mode === "time") {
      this.workspace.setLinkedWindow(t0, t1);
      this.renderWindowReadout();
    } else {
      this.workspace.setPanelTimeWindow(panelId, [t0, t1]);
    }
    this.commitHistory(`range:${panelId}`);
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
    this.commitHistory(`range:${panelId}`);
    this.renderTiles();
  }

  private effectiveWindow(panel: PanelState): { t0: number; t1: number } {
    const state = this.workspace.linkedTime();
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
    const paths = resolvePanel(
      this.catalog,
      panel,
      this.workspace.namedSets(),
    ).map((series) => series.path);
    if (panel.x_ref !== null) {
      const x = this.catalog.get(panel.x_ref);
      if (x !== undefined) paths.push(x.path);
    }
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
      this.commitHistory();
      this.renderTiles();
      return;
    }
    this.workspace.clearPanelYRange(panelId);
    this.workspaceView?.resetYAxis(panelId);
    const extent = this.timeExtent(
      resolvePanel(this.catalog, panel, this.workspace.namedSets()).map(
        (series) => series.path,
      ),
    );
    if (extent === null) {
      this.commitHistory();
      this.renderTiles();
      this.scheduleRefresh();
      return;
    }
    this.applyTimeWindow(panelId, extent.t0, extent.t1);
    this.commitHistory();
  }

  /** Removes the assigned X signal while leaving an empty XY axis slot. */
  private clearXSignal(panelId: string): void {
    const panel = this.workspace.panel(panelId);
    const ref = panel?.x_ref;
    const path =
      ref === null || ref === undefined ? null : this.catalog.get(ref)?.path;
    if (
      panel === undefined ||
      ref === null ||
      ref === undefined ||
      path === undefined ||
      path === null
    )
      return;
    this.workspace.setXRef(panelId, null);
    this.workspace.removeSeriesRef(panelId, ref, path);
    if (
      panel.color_ref !== null &&
      panel.color_ref.source_key === ref.source_key &&
      panel.color_ref.channel === ref.channel
    ) {
      this.workspace.setColorRef(panelId, null);
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
    this.workspace.setCursorT(cursorT);
    const state = this.workspace.linkedTime();
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
    this.commitHistory();
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
      this.workspace.setCursorT(null);
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
    const cursorT = this.workspace.linkedTime().cursorT;
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
    for (const source of sources) {
      if (
        this.workspace
          .sources()
          .some((saved) => saved.key === source.source_key)
      ) {
        continue;
      }
      this.workspace.addSource({
        key: source.source_key,
        path: source.path,
        prefix: source.prefix,
        provider_id: null,
        decode_provenance: null,
        reconcile_legacy: false,
        time_domain: source.time_domain,
        scale: source.scale,
        offset: source.offset,
      });
    }
    const firstName = sources[0] === undefined ? "" : basename(sources[0].path);
    required(this.root, ".source-name").textContent = firstName;
    required(this.root, ".session-identity").textContent =
      firstName === ""
        ? ""
        : `${firstName} — ${this.signals.length.toLocaleString()} signals`;
    const rows = required<HTMLElement>(this.root, ".source-rows");
    const toggleSources = (): void => {
      this.sourcesExpanded = !this.sourcesExpanded;
      renderSourceRows(
        rows,
        sources,
        this.sourcesExpanded,
        toggleSources,
        (source, domain, scale, offset) => {
          void this.applySourceAlignment(source, domain, scale, offset);
        },
      );
    };
    renderSourceRows(
      rows,
      sources,
      this.sourcesExpanded,
      toggleSources,
      (source, domain, scale, offset) => {
        void this.applySourceAlignment(source, domain, scale, offset);
      },
    );
  }

  private async applySourceAlignment(
    source: SourceSummary,
    domain: SourceSummary["time_domain"],
    scale: number,
    offset: number,
  ): Promise<void> {
    try {
      await this.plane.setSourceAlignment({
        source_key: source.source_key,
        time_domain: domain,
        scale,
        offset,
      });
      this.workspace.setSourceAlignment(
        source.source_key,
        domain,
        scale,
        offset,
      );
      this.commitHistory();
      await this.reloadSignals();
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  private toggleLinked(): void {
    const state = this.workspace.linkedTime();
    const linked = !state.linked;
    if (!linked) {
      for (const panel of this.workspace.panels()) {
        if (panel.mode === "time") {
          this.workspace.setPanelTimeWindow(panel.id, [state.t0, state.t1]);
        }
      }
    }
    this.workspace.setLinked(linked);
    this.commitHistory();
    required(this.root, ".linked-toggle").classList.toggle("active", linked);
    void this.refreshTiles();
  }

  private toggleTheme(): void {
    const documentRoot = document.documentElement;
    const theme = documentRoot.dataset.theme === "light" ? "dark" : "light";
    documentRoot.dataset.theme = theme;
    this.workspace.setTheme(theme);
    this.commitHistory();
    this.scheduleAutosave();
    this.workspaceView?.invalidateTheme();
    this.renderTiles();
  }

  /** Applies the session's theme. The session is the only durable store. */
  private restoreTheme(): void {
    document.documentElement.dataset.theme = this.workspace.theme();
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
    workbench.classList.toggle("formula-collapsed", !open);
    button.classList.toggle("active", open);
    button.ariaExpanded = String(open);
    this.formulaBar?.setOpen(open);
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    required(this.root, ".render-ms").textContent = `error: ${message}`;
    console.error(error);
  }
}

export function renderBatchProgress(
  progress: HTMLElement,
  status: BatchStatus,
  cancel: () => void,
): void {
  const percent = Math.round(status.fraction * 100);
  const summary = document.createElement("span");
  summary.textContent = `${String(percent)}% · ${status.done}/${status.total} loaded · ${status.failed} failed`;
  const children: HTMLElement[] = [];
  if (status.state === "running") {
    const bar = document.createElement("div");
    bar.className = "ingest-bar";
    const fill = document.createElement("div");
    fill.className = "ingest-bar-fill";
    fill.style.width = `${String(percent)}%`;
    bar.append(fill);
    children.push(bar);
  }
  children.push(summary);
  if (status.state === "running" && status.current_paths.length > 0) {
    const current = document.createElement("span");
    const [path] = status.current_paths;
    if (path !== undefined) {
      current.className = "ingest-current";
      current.textContent = `${basename(path)}${status.current_paths.length > 1 ? ` +${String(status.current_paths.length - 1)}` : ""}`;
      current.title = path;
      children.push(current);
    }
  }
  if (status.state === "running") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ingest-cancel";
    button.textContent = "Cancel";
    button.addEventListener("click", () => {
      button.disabled = true;
      cancel();
    });
    children.push(button);
  }
  if (status.recent_failures.length > 0) {
    const failures = document.createElement("div");
    failures.className = "ingest-failures";
    for (const failure of status.recent_failures) {
      const row = document.createElement("div");
      row.textContent = `${basename(failure.path)} — ${failure.error}`;
      row.title = failure.path;
      failures.append(row);
    }
    children.push(failures);
  }
  progress.replaceChildren(...children);
}

export function renderSourceRows(
  container: HTMLElement,
  sources: readonly SourceSummary[],
  expanded: boolean,
  onToggle: () => void,
  onAlignment?: (
    source: SourceSummary,
    domain: SourceSummary["time_domain"],
    scale: number,
    offset: number,
  ) => void,
): void {
  const previousScrollTop =
    container.querySelector<HTMLElement>(".source-scroll")?.scrollTop ?? 0;
  const totalPoints = sources.reduce(
    (total, source) => total + Number(source.point_count),
    0,
  );
  if (sources.length <= 8) {
    container.replaceChildren(
      ...sources.map((source) => sourceRow(source, onAlignment)),
    );
    return;
  }
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "source-summary";
  summary.ariaExpanded = String(expanded);
  summary.textContent = `${String(sources.length)} sources · ${totalPoints.toLocaleString()} pts ${expanded ? "▾" : "▸"}`;
  summary.addEventListener("click", onToggle);
  const children: HTMLElement[] = [summary];
  if (expanded) {
    const scroll = document.createElement("div");
    scroll.className = "source-scroll";
    const rowHeight = 22;
    const slice = virtualSlice(
      sources.length,
      previousScrollTop,
      scroll.clientHeight > 0 ? scroll.clientHeight : 176,
      rowHeight,
    );
    const spacer = document.createElement("div");
    spacer.className = "source-spacer";
    spacer.style.height = `${String(slice.totalHeight)}px`;
    const windowElement = document.createElement("div");
    windowElement.className = "source-window";
    windowElement.style.transform = `translateY(${String(slice.topPadding)}px)`;
    windowElement.append(
      ...sources
        .slice(slice.start, slice.end)
        .map((source) => sourceRow(source, onAlignment)),
    );
    spacer.append(windowElement);
    scroll.append(spacer);
    scroll.addEventListener("scroll", () => {
      renderSourceRows(container, sources, true, onToggle, onAlignment);
      const next = container.querySelector<HTMLElement>(".source-scroll");
      if (next !== null) next.scrollTop = scroll.scrollTop;
    });
    children.push(scroll);
  }
  container.replaceChildren(...children);
}

function sourceRow(
  source: SourceSummary,
  onAlignment?: (
    source: SourceSummary,
    domain: SourceSummary["time_domain"],
    scale: number,
    offset: number,
  ) => void,
): HTMLElement {
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
  if (onAlignment !== undefined) {
    const unit = document.createElement("select");
    unit.className = "source-time-unit";
    for (const option of [
      "seconds",
      "milliseconds",
      "microseconds",
      "nanoseconds",
    ] as const) {
      const item = document.createElement("option");
      item.value = option;
      item.textContent = option;
      item.selected = option === source.time_domain.unit;
      unit.append(item);
    }
    const scale = document.createElement("input");
    scale.type = "number";
    scale.step = "any";
    scale.value = String(source.scale);
    scale.ariaLabel = `${source.prefix} time scale`;
    const offset = document.createElement("input");
    offset.type = "number";
    offset.step = "any";
    offset.value = String(source.offset);
    offset.ariaLabel = `${source.prefix} time offset`;
    const apply = (): void => {
      const nextScale = Number(scale.value);
      const nextOffset = Number(offset.value);
      if (!Number.isFinite(nextScale) || !Number.isFinite(nextOffset)) return;
      onAlignment(
        source,
        {
          ...source.time_domain,
          unit: unit.value as SourceSummary["time_domain"]["unit"],
        },
        nextScale,
        nextOffset,
      );
    };
    unit.addEventListener("change", apply);
    scale.addEventListener("change", apply);
    offset.addEventListener("change", apply);
    row.append(unit, scale, offset);
  }
  return row;
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

function shellMarkup(): string {
  return `<main class="workbench formula-collapsed">
    <div class="title-bar">
      <button class="menu-button" aria-label="Application menu" aria-haspopup="menu" aria-expanded="false">≡</button>
      <span class="brand">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11 4 5l3 8 3-10 2 6 2-2" fill="none" stroke="var(--amber-7)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        SIGNALSCOPE
      </span>
      <span class="workspace-name">Untitled</span>
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
      <div class="tree-heading">SETS</div>
      <div class="tree-sets"></div>
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

    ${formulaBarMarkup()}
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

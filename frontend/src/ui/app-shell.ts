import {
  renderDockFooter,
  renderPresentationStatus,
  statusAggregate,
} from "./shell-status";
import {
  bindSessionTitle,
  renderSessionTitle,
  sessionDisplayTitle,
} from "./session-title";
import { showHelp } from "./help-dialog";
import { showAbout } from "./about-dialog";
import { shellMarkup } from "./shell-markup";
import { axisActions } from "./axis-actions";
import { resolveLineBindings } from "../app/line-bindings";
import { shellCommand } from "../app/shell-commands";
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
import { columnsValueAtTime } from "../app/bin-columns";
import { exportFileStem } from "../app/export-file";
import { browserStorage, CommandUsage } from "../app/frecency";
import {
  HistoryStack,
  historySnapshot,
  restoreTransientSessionState,
} from "../app/history";
import {
  pickIngestPaths,
  runBatchIngest,
  type SourceOpenKind,
  waitForBatch,
} from "../app/ingest";
import {
  applyPreferences,
  clampPlotLineWidthScale,
  clampPlotFontSize,
  clampUiFontSize,
  defaultPreferences,
  FONT_FAMILIES,
  fontLabel,
  parsePreferences,
  snapshotPreferences,
  PLOT_FONT_SIZE,
  PLOT_LINE_WIDTH_SCALE,
  UI_FONT_SIZE,
} from "../app/preferences";
import { composePanelPng, panelPngTargets, toBase64 } from "../app/png-export";
import { LinePresentationController } from "../app/line-presentation-controller";
import { Catalog } from "../app/catalog";
import {
  matchesAnyFocus,
  resolvePanel,
  type ResolvedSeries,
} from "../app/resolution";
import { SelectionModel } from "../app/selection";
import { evaluateSelector } from "../app/selector";
import { WorkspaceModel } from "../app/workspace";
import { persistWorkspace } from "../app/workspace-save";
import { formatCursorTime, formatValue, zoomRange } from "../app/plot-math";
import {
  type BatchStatus,
  type ExportFidelity,
  type ExportRange,
  type ExportSelection,
  type SampleSeries,
  type SignalSummary,
} from "../generated/protocol";
import type {
  CursorMode,
  PanelState,
  SeriesRef,
  Session,
} from "../generated/session";
import type { Preferences } from "../generated/preferences";
import {
  CommandPalette,
  type PaletteEntry,
  type PaletteMode,
} from "./command-palette";
import { basename, bindPointerDrag, required } from "./dom";
import { FormulaBar } from "./formula-bar";
import { ImportWizard } from "./import-wizard";
import {
  ExportDialog,
  type ExportFormat,
  type PngScope,
} from "./export-dialog";
import type { PlotCursor } from "../app/plot-capabilities";
import { SignalOutlineView } from "./signal-outline";
import { SetsListView } from "./sets-list";
import { WorkspaceTabsView } from "./workspace-tabs";
import { WorkspaceView } from "./workspace-view";
import { AppMenu } from "./app-menu";
import type { GpuContext, GpuFailure } from "../render/gpu-context";

const TREE_WIDTH = { default: 262, collapse: 120, min: 180, max: 480 } as const;
const CURSOR_MODES: readonly CursorMode[] = ["none", "track", "measure"];
const AUTOSAVE_DEBOUNCE_MS = 800;
const DERIVED_PREFIX = "derived/";

export function arrivalModeFor(count: number): "none" | "focus" | "ghost" {
  if (count <= 0) return "none";
  return count <= 4 ? "focus" : "ghost";
}

export function bundleCompletionEntries(
  signals: readonly SignalSummary[],
): { localPath: string; runCount: number }[] {
  const sourcesByChannel = new Map<string, Set<string>>();
  for (const signal of signals) {
    const sources = sourcesByChannel.get(signal.local_path) ?? new Set();
    sources.add(signal.source_key);
    sourcesByChannel.set(signal.local_path, sources);
  }
  return [...sourcesByChannel]
    .filter(([, sources]) => sources.size >= 2)
    .map(([localPath, sources]) => ({
      localPath,
      runCount: sources.size,
    }))
    .sort((left, right) => left.localPath.localeCompare(right.localPath));
}

export function exportSourceOptions(
  signals: readonly SignalSummary[],
): { key: string; label: string }[] {
  const sources = new Map<string, string>();
  for (const signal of signals) {
    if (sources.has(signal.source_key)) continue;
    const suffix = `/${signal.local_path}`;
    const label = signal.path.endsWith(suffix)
      ? signal.path.slice(0, -suffix.length)
      : signal.path;
    sources.set(signal.source_key, label);
  }
  return [...sources]
    .map(([key, label]) => ({ key, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function validateDerivedBundleName(path: string): void {
  const name = path.startsWith(DERIVED_PREFIX)
    ? path.slice(DERIVED_PREFIX.length)
    : path;
  if (name.includes("/")) {
    throw new Error("derived bundle names are a single segment");
  }
}

export class AppShell {
  private readonly workspace = new WorkspaceModel();
  private readonly commands = new CommandRegistry();
  private readonly usage = new CommandUsage(browserStorage(), () => Date.now());
  private readonly history = new HistoryStack();
  private readonly selection = new SelectionModel();
  private readonly presentation: LinePresentationController;
  private selectionWorkspaceId: string | null = null;
  private signals: SignalSummary[] = [];
  private catalog = Catalog.empty();
  private catalogRevision = 0;
  private readonly resolutionCache = new Map<
    string,
    { key: string; resolved: ResolvedSeries[] }
  >();
  private signalsByPath = new Map<string, SignalSummary>();
  private workspaceView: WorkspaceView | null = null;
  private workspaceTabs: WorkspaceTabsView | null = null;
  private outline: SignalOutlineView | null = null;
  private setsList: SetsListView | null = null;
  private pendingSetRefs: SeriesRef[] | null = null;
  private palette: CommandPalette | null = null;
  private formulaBar: FormulaBar | null = null;
  private exportDialog: ExportDialog | null = null;
  private exportPng: Uint8Array | null = null;
  private readonly exportCsv = new Map<ExportFidelity, CsvExport>();
  private exportGeneration = 0;
  private signalTreeWidth: number = TREE_WIDTH.default;
  private helpTimer: number | null = null;
  private liveValuesScheduled = false;
  private pendingCursorT: number | null = null;
  private autosaveTimer: number | null = null;
  private prefs: Preferences = defaultPreferences();
  private prefsSaveTimer: number | null = null;
  private recipeDirectory: string | null = null;
  private workspacePath: string | null = null;
  private dirty = false;
  private restoringHistory = false;
  private historyGestureKey: string | null = null;
  private historyDirty: string | null = null;
  private historyCoalesceTimer: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly plane: DataPlane,
    private gpu: GpuContext | null = null,
    private readonly requestGpuRecovery: (() => void) | null = null,
  ) {
    this.presentation = new LinePresentationController(this.plane, {
      panels: () => this.workspace.panels(),
      workspaceWidth: () =>
        required<HTMLElement>(this.root, ".workspace").clientWidth,
      panelWidth: (panelId) => this.workspaceView?.panelWidth(panelId) ?? 0,
      signalIds: (panel) => this.panelSignalIds(panel),
      windowFor: (panel) => this.effectiveWindow(panel),
      defaultWindow: () => {
        const linked = this.workspace.linkedTime();
        return { t0: linked.t0, t1: linked.t1 };
      },
      gpu: () => this.gpu,
      render: (responses, windowFor, missingFor, errorFor) =>
        this.workspaceView?.renderData(
          responses,
          windowFor,
          missingFor,
          errorFor,
        ) ?? 0,
      onPlan: (plan) => renderPresentationStatus(this.root, plan),
      onRender: (elapsed) => {
        required(this.root, ".render-ms").textContent =
          `${elapsed.toFixed(1)} ms`;
      },
      onError: (error) => this.reportError(error),
    });
  }

  setGpu(gpu: GpuContext): void {
    if (this.gpu !== null) return;
    this.gpu = gpu;
    gpu.onFailure((failure) => {
      if (this.gpu !== gpu) return;
      this.handleGpuFailure(failure);
    });
    const warning = this.root.querySelector<HTMLElement>(".gpu-warning");
    if (warning !== null) warning.hidden = true;
    this.workspaceView?.setGpu(gpu, this.signals.length > 0);
    void this.refreshTiles();
  }

  stopPresentation(): void {
    this.presentation.dispose();
    const gpu = this.gpu;
    this.gpu = null;
    this.workspaceView?.releaseGpu();
    gpu?.dispose();
  }

  private handleGpuFailure(failure: GpuFailure): void {
    if (failure.kind === "uncaptured-error") {
      this.reportError(failure.message);
      return;
    }
    const gpu = this.gpu;
    this.gpu = null;
    this.workspaceView?.releaseGpu();
    gpu?.dispose();
    const warning = required<HTMLElement>(this.root, ".gpu-warning");
    required<HTMLElement>(warning, ".gpu-warning-message").textContent =
      failure.kind === "device-lost"
        ? "WebGPU device lost — reconnecting"
        : "WebGPU renderer unavailable — reconnecting";
    required<HTMLButtonElement>(warning, ".gpu-warning-dismiss").hidden = true;
    required<HTMLButtonElement>(warning, ".gpu-warning-reload").hidden = false;
    warning.hidden = false;
    this.requestGpuRecovery?.();
  }

  private bindGpuWarning(): void {
    required<HTMLButtonElement>(
      this.root,
      ".gpu-warning-reload",
    ).addEventListener("click", () => {
      window.location.reload();
    });
  }

  async mount(): Promise<void> {
    await this.prepareMount();
    this.mountWorkspaceViews();
    this.mountChromeControllers();
    await this.loadMountedWorkspace();
  }

  private async prepareMount(): Promise<void> {
    delete this.root.dataset.ready;
    this.root.innerHTML = shellMarkup();
    this.bindGpuWarning();
    if (this.gpu === null) {
      const warning = required<HTMLElement>(this.root, ".gpu-warning");
      warning.hidden = false;
      required<HTMLButtonElement>(
        warning,
        ".gpu-warning-dismiss",
      ).addEventListener("click", () => {
        warning.hidden = true;
      });
    }
    await this.loadPreferences();
    await this.restoreSession();
    this.history.reset(historySnapshot(this.workspace.snapshot()));
    this.restoreTheme();
    if (this.plane.derived === null) {
      required<HTMLElement>(this.root, ".formula-toggle").hidden = true;
    }
  }

  private mountWorkspaceViews(): void {
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
          const tab = this.workspace.tabs().find((entry) => entry.id === id);
          const panelIds = tab?.panels.map((panel) => panel.id) ?? [];
          const canClose = this.workspace.tabs().length > 1;
          this.workspace.closeTab(id);
          if (
            canClose &&
            !this.workspace.tabs().some((entry) => entry.id === id)
          ) {
            for (const panelId of panelIds) {
              this.presentation.invalidate(panelId);
            }
          }
          this.afterLayoutChange();
        },
      },
    );
    this.workspaceView = new WorkspaceView(
      required(this.root, ".workspace"),
      this.workspace,
      {
        onEvictPanel: (id) => {
          this.presentation.invalidate(id);
        },
        onFocus: (id) => {
          this.workspace.focusPanel(id);
        },
        onClose: (id) => {
          const panelExisted = this.workspace.panel(id) !== undefined;
          this.workspace.closePanel(id);
          if (panelExisted) this.presentation.invalidate(id);
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
        onDropSignals: (id, paths) => {
          this.plotSignals(paths, id);
        },
        onDropSet: (id, setId) => {
          this.bindSetToPanel(setId, id);
        },
        onFocusToggle: (id, entry) => {
          this.workspace.toggleFocus(id, entry);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onFocusAdd: (id, entry) => {
          this.workspace.addFocus(id, entry);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onFocusRange: (id, entries) => {
          this.workspace.setFocusRange(id, entries);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onClearFocus: (id) => {
          this.workspace.clearFocus(id);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onMuteSelector: (id, selector) => {
          this.workspace.addSelectorOverride(id, selector, { visible: false });
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onMuteSeries: (id, ref) => {
          this.workspace.toggleSeriesVisible(id, ref);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onRemoveBinding: (id, index) => {
          this.workspace.removeBinding(id, index);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onToggleGhostMode: (id) => {
          this.workspace.toggleGhostMode(id);
          const panel = this.workspace.panel(id);
          if (panel?.ghost_mode === "ghost") {
            this.focusFirstSeries(
              id,
              this.resolvedFor(panel).map((series) => series.ref),
            );
          }
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onLegendLayout: (id, layout) => {
          this.workspace.setLegendLayout(id, layout);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
        },
        onSetEncoding: (id, property, dimension) => {
          this.workspace.setEncoding(id, property, dimension);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onSetPanelLineWidth: (id, width) => {
          this.workspace.setPanelLineWidth(id, width);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onSetGhostOpacity: (id, opacity) => {
          this.workspace.setGhostOpacity(id, opacity);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onSetStatColumns: (id, columns) => {
          this.workspace.setStatColumns(id, columns);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
        },
        onSetStatsSort: (id, column, descending) => {
          this.workspace.setStatsSort(id, column, descending);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
        },
        onRevertStyleOverride: (id, index) => {
          this.workspace.clearStyleOverride(id, index);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onClearOverrides: (id) => {
          this.workspace.clearStyleOverrides(id);
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
        catalog: () => this.catalog,
        namedSets: () => this.workspace.namedSets(),
        resolveSeries: (state) => this.resolvedFor(state),
        onToggleSeries: (id, ref) => {
          this.workspace.toggleSeriesVisible(id, ref);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onResized: () => {
          this.handlePanelResize();
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
          this.markHistoryDirty(`range:${id}`);
          this.scheduleRender();
        },
        onXRange: (id, range) => {
          this.applyXRange(id, range);
        },
        onPinAnnotation: (id, hit) => {
          this.workspace.addAnnotation(id, {
            id: crypto.randomUUID(),
            series_path: hit.path,
            anchor: hit.anchor,
            pinned_x: hit.x,
            pinned_value: hit.pinnedValue,
            label: "",
            offset: [10, -10],
          });
          const ref = this.catalog.refFromPath(hit.path);
          if (ref !== undefined) {
            this.workspace.addFocus(id, {
              kind: "series",
              ref,
              source_key: null,
              channel: ref.channel,
            });
          }
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onRemoveAnnotation: (id, annotationId) => {
          this.workspace.removeAnnotation(id, annotationId);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
        },
        onClearAnnotations: (id) => {
          this.workspace.clearAnnotations(id);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
        },
        onSetAnnotationDisplay: (id, display) => {
          this.workspace.setAnnotationDisplay(id, display);
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
        },
        onSetAnnotationOffset: (id, annotationId, offset) => {
          this.workspace.setAnnotationOffset(id, annotationId, offset);
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
        onPatchSeriesStyle: (id, ref, style) => {
          this.workspace.patchSeriesOverride(id, ref, style);
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
        ...axisActions({
          workspace: this.workspace,
          resetY: (id) => this.workspaceView?.resetYAxis(id),
          timeLimits: (id, range) => {
            const panel = this.workspace.panel(id);
            if (panel === undefined) return;
            const next =
              range === null
                ? this.timeExtent(
                    this.resolvedFor(panel).map((series) => series.path),
                  )
                : { t0: range[0], t1: range[1] };
            const current = this.effectiveWindow(panel);
            if (
              next !== null &&
              (next.t0 !== current.t0 || next.t1 !== current.t1)
            )
              this.applyTimeWindow(id, next.t0, next.t1);
          },
          commit: () => {
            this.commitHistory();
            this.scheduleAutosave();
          },
          refreshStates: () => this.workspaceView?.refreshPanelStates(),
          resetCursor: () => {
            this.workspaceView?.clearCursors();
            this.workspaceView?.setCursor(this.workspace.linkedTime().cursorT);
          },
          invalidate: (id) => this.presentation.invalidate(id),
          render: () => this.renderTiles(),
          refresh: () => {
            void this.refreshTiles();
          },
        }),
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
        onDropSetNewPanel: (setId) => {
          if (!this.workspace.namedSets().some((set) => set.id === setId))
            return;
          const panel = this.workspace.addPanelRow();
          this.bindSetToPanel(setId, panel.id);
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
      this.gpu,
    );
  }

  private mountChromeControllers(): void {
    this.setsList = new SetsListView(required(this.root, ".tree-sets"), {
      onSetBind: (setId) => this.bindSetToPanel(setId),
      onSignalDrop: (refs) => this.openSetNameRow(refs),
      onSetRemove: (setId) => {
        this.workspace.removeNamedSet(setId);
        this.setsList?.setNamedSets(this.workspace.namedSets());
        this.afterLayoutChange();
      },
    });
    this.outline = new SignalOutlineView(
      required(this.root, ".outline-scroll"),
      this.selection,
      {
        onSelectionChange: () => {},
        onAddToPanel: (refs) => this.addRefsToPanel(refs),
        onRemoveDerived: (path) => {
          void this.removeDerived(path);
        },
        onRemoveDerivedBundle: (localPath) => {
          void this.removeDerivedBundle(localPath);
        },
      },
    );
    bindSessionTitle(
      required(this.root, ".workspace-name"),
      () =>
        sessionDisplayTitle(
          this.workspace.snapshot().title,
          this.workspacePath,
        ),
      (title) => {
        this.workspace.replace({ ...this.workspace.snapshot(), title });
        this.commitHistory();
        this.scheduleAutosave();
        this.renderWorkspaceName();
      },
    );
    required(this.root, ".help-button").addEventListener("click", () =>
      showHelp(this.root, this.commands),
    );
    this.selection.onChange(() => {
      this.syncSelectionActions();
    });
    this.syncSelectionActions();
    this.palette = new CommandPalette(this.root, (mode, query, limit) =>
      this.paletteEntries(mode, query, limit),
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
  }

  private async loadMountedWorkspace(): Promise<void> {
    await this.reloadSignals();
    this.root.dataset.ready = "true";
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
      const range = this.navigationXRange(panel, id);
      if (range === null) return;
      const pivot = (range.min + range.max) / 2;
      const next = zoomRange(range, factor, pivot);
      if (panel.x_axis.kind !== "time") {
        this.applyXRange(id, [next.min, next.max]);
      } else {
        this.applyTimeWindow(id, next.min, next.max);
      }
    };
    const panFocusedPanel = (direction: -1 | 1): void => {
      const id = this.workspace.focusedPanelId();
      const panel = id === null ? undefined : this.workspace.panel(id);
      if (id === null || panel === undefined) return;
      const range = this.navigationXRange(panel, id);
      if (range === null) return;
      const delta = (range.max - range.min) * 0.1 * direction;
      if (panel.x_axis.kind !== "time") {
        this.applyXRange(id, [range.min + delta, range.max + delta]);
      } else {
        this.applyTimeWindow(id, range.min + delta, range.max + delta);
      }
    };
    const undoCommand: Command = shellCommand("undo", {
      enabled: () => this.history.canUndo(),
      run: () => {
        this.applyHistory(this.history.undo());
      },
    });
    const redoCommand: Command = shellCommand("redo", {
      enabled: () => this.history.canRedo(),
      run: () => {
        this.applyHistory(this.history.redo());
      },
    });
    this.commands.register(undoCommand);
    this.commands.register(redoCommand);
    this.commands.register(
      shellCommand("save-selection-as-set", {
        enabled: () => this.selection.size() > 0,
        run: () => this.saveSelectedAsSet(),
      }),
    );
    setEditingReservedCombos(
      [
        undoCommand.keys,
        redoCommand.keys,
        ...(redoCommand.altKeys ?? []),
      ].filter((keys): keys is string => keys !== undefined),
    );
    this.commands.register(
      shellCommand("open-sources", {
        enabled: () => this.plane.ingest !== null,
        run: () => {
          this.openSources();
        },
      }),
    );
    this.commands.register(
      shellCommand("open-folder", {
        enabled: () => this.plane.ingest !== null,
        run: () => {
          this.openFolder();
        },
      }),
    );
    this.commands.register(
      shellCommand("new-workspace-tab", {
        run: () => {
          this.workspace.addTab();
          this.afterLayoutChange();
        },
      }),
    );
    this.commands.register(
      shellCommand("close-workspace-tab", {
        enabled: () => this.workspace.tabs().length > 1,
        run: () => {
          this.workspace.closeTab(this.workspace.activeTabId());
          this.afterLayoutChange();
        },
      }),
    );
    this.commands.register(
      shellCommand("split-panel-down", {
        run: () => {
          const id = this.workspace.focusedPanelId();
          if (id === null) {
            this.workspace.addPanelRow();
          } else {
            this.workspace.splitPanelDown(id);
          }
          this.afterLayoutChange();
        },
      }),
    );
    this.registerFocusedPanelCommand(
      "split-panel-right",
      "Split current panel right",
      (id) => void this.workspace.splitPanelRight(id),
    );
    this.commands.register(
      shellCommand("cycle-cursor-mode", {
        run: () => {
          this.cycleCursorMode();
        },
      }),
    );
    this.commands.register(
      shellCommand("toggle-all-stats", {
        checked: () =>
          this.workspace.panels().length > 0 &&
          this.workspace.panels().every((panel) => panel.show_stats),
        run: () => {
          // Any panel still hiding stats turns them all on; otherwise all off.
          const target = this.workspace
            .panels()
            .some((panel) => !panel.show_stats);
          for (const panel of this.workspace.panels()) {
            if (panel.show_stats !== target)
              this.workspace.toggleStats(panel.id);
          }
          this.commitHistory();
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
      }),
    );
    this.registerFocusedPanelCommand("zoom-in-time", "Panel: zoom in", () => {
      zoomFocusedPanel(0.8);
    });
    this.registerFocusedPanelCommand("zoom-out-time", "Panel: zoom out", () => {
      zoomFocusedPanel(1.25);
    });
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
        this.workspace.clearAnnotations(id);
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
    this.commands.register(
      shellCommand("restore-panel-grid", {
        enabled: () => this.workspace.maximizedPanelId() !== null,
        run: () => {
          this.workspace.restoreGrid();
          this.afterLayoutChange();
        },
      }),
    );
    this.commands.register(
      shellCommand("focus-filter", {
        run: () => {
          required<HTMLInputElement>(this.root, ".signal-search").focus();
        },
      }),
    );
    this.commands.register(
      shellCommand("toggle-signal-tree", {
        checked: () =>
          !required(this.root, ".workbench").classList.contains(
            "tree-collapsed",
          ),
        enabled: () => window.innerWidth > 820,
        run: () => {
          this.toggleSignalTree();
        },
      }),
    );
    this.commands.register(
      shellCommand("toggle-linked", {
        run: () => {
          this.toggleLinked();
        },
      }),
    );
    this.commands.register(
      shellCommand("toggle-theme", {
        run: () => {
          this.toggleTheme();
        },
      }),
    );
    this.commands.register(
      shellCommand("increase-plot-font", {
        run: () => {
          this.updatePreferences({
            plot_font_size: this.prefs.plot_font_size + PLOT_FONT_SIZE.step,
          });
        },
      }),
    );
    this.commands.register(
      shellCommand("decrease-plot-font", {
        run: () => {
          this.updatePreferences({
            plot_font_size: this.prefs.plot_font_size - PLOT_FONT_SIZE.step,
          });
        },
      }),
    );
    this.commands.register(
      shellCommand("reset-plot-font", {
        run: () => {
          this.updatePreferences({ plot_font_size: PLOT_FONT_SIZE.default });
        },
      }),
    );
    this.commands.register(
      shellCommand("increase-plot-line-width", {
        run: () => {
          this.updatePreferences({
            plot_line_width_scale:
              this.prefs.plot_line_width_scale + PLOT_LINE_WIDTH_SCALE.step,
          });
        },
      }),
    );
    this.commands.register(
      shellCommand("decrease-plot-line-width", {
        run: () => {
          this.updatePreferences({
            plot_line_width_scale:
              this.prefs.plot_line_width_scale - PLOT_LINE_WIDTH_SCALE.step,
          });
        },
      }),
    );
    this.commands.register(
      shellCommand("reset-plot-line-width", {
        run: () => {
          this.updatePreferences({
            plot_line_width_scale: PLOT_LINE_WIDTH_SCALE.default,
          });
        },
      }),
    );
    this.commands.register(
      shellCommand("toggle-formula", {
        checked: () =>
          !required(this.root, ".workbench").classList.contains(
            "formula-collapsed",
          ),
        run: () => {
          this.toggleFormula();
        },
      }),
    );
    this.commands.register(
      shellCommand("command-palette", {
        run: () => {
          this.palette?.open("commands");
        },
      }),
    );
    this.commands.register(
      shellCommand("open-settings", {
        run: () => {
          this.palette?.open("settings");
        },
      }),
    );
    this.commands.register(
      shellCommand("go-to-signal", {
        run: () => {
          this.palette?.open("signals");
        },
      }),
    );
    this.commands.register(
      shellCommand("help", {
        run: () => {
          showHelp(this.root, this.commands);
        },
      }),
    );
    this.commands.register(
      shellCommand("about-signalscope", {
        run: () => {
          showAbout(this.root);
        },
      }),
    );
    this.commands.register(
      shellCommand("new-workspace", {
        enabled: () => this.plane.session !== null,
        run: () => {
          void this.newWorkspace();
        },
      }),
    );
    this.commands.register(
      shellCommand("open-workspace", {
        enabled: () => this.plane.session !== null,
        run: () => {
          void this.pickAndLoadWorkspace();
        },
      }),
    );
    this.commands.register(
      shellCommand("save-workspace", {
        enabled: () => this.plane.session !== null,
        run: () => {
          void this.saveWorkspace(false);
        },
      }),
    );
    this.commands.register(
      shellCommand("save-workspace-as", {
        enabled: () => this.plane.session !== null,
        run: () => {
          void this.saveWorkspace(true);
        },
      }),
    );
    this.commands.register(
      shellCommand("export-html", {
        enabled: () => this.plane.exporter !== null,
        run: () => {
          this.openExportDialog("html");
        },
      }),
    );
    this.commands.register(
      shellCommand("export-png", {
        enabled: () =>
          this.plane.exporter !== null &&
          this.workspace.focusedPanelId() !== null,
        run: () => {
          this.openExportDialog("png");
        },
      }),
    );
    this.commands.register(
      shellCommand("export-csv", {
        enabled: () =>
          this.plane.exporter !== null &&
          this.workspace.focusedPanelId() !== null,
        run: () => {
          this.openExportDialog("csv");
        },
      }),
    );
    for (const planned of [
      ["open-recent", "Open Recent ▸", "file", "open"],
      ["axes-default", "Axes default ▸", "view", "display"],
      ["series-palette", "Series palette ▸", "view", "display"],
      ["duplicate-workspace", "Duplicate Workspace", "workspace", "new"],
      ["save-layout-preset", "Save Layout As Preset…", "workspace", "layout"],
      ["apply-layout-preset", "Apply Preset ▸", "workspace", "layout"],
      ["reset-layout", "Reset Layout", "workspace", "layout"],
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

  /**
   * The recipe directory entries. The reset entry is listed only while a
   * custom directory is set, so the palette never offers an action that would
   * do nothing.
   */
  private recipeDirectoryEntries(): PaletteEntry[] {
    const port = this.plane.preferences;
    if (port === null) return [];
    const custom = this.prefs.recipe_directory;
    const entries: PaletteEntry[] = [
      {
        title: "Recipe directory",
        hint: this.recipeDirectory ?? "unavailable",
        keepOpen: true,
        run: () => {
          void port
            .pickRecipeDirectory()
            .then(async (picked) => {
              if (picked === null) return;
              this.updatePreferences({ recipe_directory: picked });
              await this.refreshRecipeDirectory();
            })
            .catch((error: unknown) => {
              this.reportError(error);
            });
        },
      },
    ];
    if (custom !== null) {
      entries.push({
        title: "Use default recipe directory",
        hint: "",
        keepOpen: true,
        run: () => {
          this.updatePreferences({ recipe_directory: null });
          void this.refreshRecipeDirectory();
        },
      });
    }
    return entries;
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
        hint: this.prefs.theme,
        keepOpen: true,
        run: () => {
          this.toggleTheme();
        },
      },
      ...this.recipeDirectoryEntries(),
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
        title: "Plot line width",
        hint: `${String(Math.round(this.prefs.plot_line_width_scale * 100))}%`,
        keepOpen: true,
        run: () => {
          this.updatePreferences({
            plot_line_width_scale:
              this.prefs.plot_line_width_scale + PLOT_LINE_WIDTH_SCALE.step,
          });
        },
        adjust: (direction) => {
          this.updatePreferences({
            plot_line_width_scale:
              this.prefs.plot_line_width_scale +
              direction * PLOT_LINE_WIDTH_SCALE.step,
          });
        },
      },
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
            plot_line_width_scale: defaults.plot_line_width_scale,
          });
        },
      },
    ];
  }

  private paletteEntries(
    mode: PaletteMode,
    query = "",
    limit = Number.POSITIVE_INFINITY,
  ): PaletteEntry[] {
    if (mode === "settings") return this.settingsEntries();
    if (mode === "signals") return this.signalPaletteEntries(query, limit);
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
    return commands;
  }

  private signalPaletteEntries(query: string, limit: number): PaletteEntry[] {
    const input = query.trim();
    const match = input === "" ? null : evaluateSelector(this.catalog, input);
    const selectorMode =
      match !== null && (match.signalCount > 0 || /[*?|[@:]/.test(input));
    const paths = selectorMode
      ? match.series.map((series) => series.path)
      : this.signals
          .filter(
            (summary) =>
              input === "" ||
              summary.path.toLowerCase().includes(input.toLowerCase()),
          )
          .map((summary) => summary.path);
    const aggregate: PaletteEntry[] =
      selectorMode && match.signalCount > 1
        ? [
            {
              title: `Add ${String(match.signalCount)} signals · ${String(match.sourceCount)} sources to focused panel`,
              hint: "selector",
              run: () => {
                this.bindQueryToPanel(input);
              },
            },
          ]
        : [];
    const signalEntries = paths.slice(0, limit).map((path) => ({
      title: `plot ${path}`,
      hint: "signal",
      run: () => {
        this.plotSignal(path);
      },
    }));
    const titleMatches = (title: string): boolean =>
      input === "" || title.toLowerCase().includes(input.toLowerCase());
    const tabs = this.workspace
      .tabs()
      .filter((tab) => titleMatches(`switch to ${tab.title}`))
      .map((tab) => ({
        title: `switch to ${tab.title}`,
        hint: "workspace",
        run: () => {
          this.workspace.selectTab(tab.id);
          this.afterLayoutChange();
        },
      }));
    const panels = this.workspace
      .panels()
      .filter((panel) => titleMatches(`focus ${panel.title}`))
      .map((panel) => ({
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
    return [...aggregate, ...signalEntries, ...tabs, ...panels].slice(0, limit);
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
    required<HTMLButtonElement>(
      this.root,
      ".sets-save-selection",
    ).addEventListener("click", () => {
      this.commands.run("save-selection-as-set");
    });
    required(this.root, ".cursor-toggle").addEventListener("click", () => {
      this.commands.run("cycle-cursor-mode");
    });
    const search = required<HTMLInputElement>(this.root, ".signal-search");
    search.addEventListener("input", () => {
      this.outline?.setFilter(search.value);
      this.renderSearchStatus();
    });
    search.addEventListener("keydown", (event) => {
      const input = search.value.trim();
      if (event.key === "Enter") {
        const match =
          input === "" ? null : evaluateSelector(this.catalog, input);
        if (match === null || match.signalCount === 0) return;
        event.preventDefault();
        this.bindQueryToPanel(input);
      } else if (
        event.key.toLowerCase() === "s" &&
        (event.metaKey || event.ctrlKey)
      ) {
        const match =
          input === "" ? null : evaluateSelector(this.catalog, input);
        if (match === null) return;
        event.preventDefault();
        event.stopPropagation();
        this.openSetNameRow();
      }
    });
    const setName = required<HTMLInputElement>(this.root, ".set-name-input");
    const commitSet = (): void => {
      const selector = search.value.trim();
      const name = setName.value.trim();
      if (name === "") return;
      if (this.pendingSetRefs === null && selector === "") return;
      const refs = this.pendingSetRefs;
      this.workspace.addNamedSet({
        id: this.workspace.nextSetId(),
        name,
        kind: refs === null ? "query" : "pick",
        selector: refs === null ? selector : null,
        refs: refs ?? [],
      });
      this.pendingSetRefs = null;
      this.setsList?.setNamedSets(this.workspace.namedSets());
      this.hideSetNameRow();
      this.commitHistory();
      this.afterLayoutChange();
      search.focus();
    };
    setName.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitSet();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.hideSetNameRow();
        search.focus();
      }
    });
    required<HTMLButtonElement>(this.root, ".set-name-save").addEventListener(
      "click",
      commitSet,
    );
    required<HTMLButtonElement>(this.root, ".set-name-cancel").addEventListener(
      "click",
      () => {
        this.hideSetNameRow();
        search.focus();
      },
    );
    this.renderSearchStatus();
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
        ((!event.metaKey && !event.ctrlKey) ||
          reservedWhileEditing(event) ||
          event.key.toLowerCase() === "a")
      ) {
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "a" &&
        this.dockContains(event.target)
      ) {
        event.preventDefault();
        this.selectAllDockRows();
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
      this.afterSeriesAdded(target, [ref]);
      this.workspace.focusPanel(target);
      this.fitWindowToPlotted();
      this.afterLayoutChange();
    }
  }

  private bindQueryToPanel(selector: string): void {
    let target = this.workspace.focusedPanelId();
    if (target === null) target = this.workspace.addPanelRow().id;
    if (!this.workspace.addQueryBinding(target, selector)) return;
    this.afterSeriesAdded(target, this.refsForSelector(selector));
    this.workspace.focusPanel(target);
    this.fitWindowToPlotted();
    this.afterLayoutChange();
  }

  private bindSetToPanel(setId: string, panelId?: string): void {
    const set = this.workspace.namedSets().find((entry) => entry.id === setId);
    if (set === undefined) return;
    let target = panelId ?? this.workspace.focusedPanelId();
    if (target === null) {
      target = this.workspace.addPanelRow().id;
    }
    if (!this.workspace.addSetBinding(target, setId)) return;
    this.afterSeriesAdded(
      target,
      set.kind === "pick" ? set.refs : this.refsForSelector(set.selector ?? ""),
    );
    this.workspace.focusPanel(target);
    this.fitWindowToPlotted();
    this.afterLayoutChange();
  }

  private renderSearchStatus(): void {
    const input = required<HTMLInputElement>(this.root, ".signal-search");
    const count = required<HTMLElement>(this.root, ".search-count");
    const filterRow = required<HTMLElement>(this.root, ".search-filter-row");
    const value = input.value.trim();
    count.replaceChildren();
    filterRow.classList.remove("has-selector");
    if (value === "") return;
    const match = evaluateSelector(this.catalog, value);
    const selectorMode =
      match !== null && (match.signalCount > 0 || /[*?|[@:]/.test(value));
    filterRow.classList.toggle("has-selector", selectorMode);
    if (selectorMode) {
      count.append(
        document.createTextNode(
          `${String(match.signalCount)} signals · ${String(match.sourceCount)} ${match.sourceCount === 1 ? "source" : "sources"} `,
        ),
      );
      const hint = document.createElement("span");
      hint.textContent = "⏎ add · ⌘S set";
      count.append(hint);
      return;
    }
    const query = value.toLowerCase();
    const matches = this.catalog
      .allSeries()
      .filter(
        (series) =>
          series.channel.toLowerCase().includes(query) ||
          series.path.toLowerCase().includes(query),
      );
    count.append(document.createTextNode(`${String(matches.length)} matches `));
    const hint = document.createElement("span");
    hint.textContent = "⏎ add · ⌘S set";
    count.append(hint);
  }

  private openSetNameRow(refs: readonly SeriesRef[] | null = null): void {
    const row = required<HTMLElement>(this.root, ".set-name-row");
    const input = required<HTMLInputElement>(this.root, ".set-name-input");
    this.pendingSetRefs = refs === null ? null : [...refs];
    row.hidden = false;
    input.value = "";
    input.focus();
  }

  private hideSetNameRow(): void {
    this.pendingSetRefs = null;
    required<HTMLElement>(this.root, ".set-name-row").hidden = true;
  }

  private plotSignals(memberPaths: readonly string[], panelId?: string): void {
    let target = panelId ?? this.workspace.focusedPanelId();
    if (target === null) target = this.workspace.addPanelRow().id;
    const refs = memberPaths
      .map((path) => this.catalog.refFromPath(path))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined);
    if (this.workspace.addSeriesRefs(target, refs)) {
      this.afterSeriesAdded(target, refs);
      this.workspace.focusPanel(target);
      this.fitWindowToPlotted();
      this.afterLayoutChange();
    }
  }

  private refsForSelector(selector: string): SeriesRef[] {
    return (evaluateSelector(this.catalog, selector)?.series ?? []).flatMap(
      (series) => {
        const ref = this.catalog.refFromPath(series.path);
        return ref === undefined ? [] : [ref];
      },
    );
  }

  private afterSeriesAdded(
    panelId: string,
    addedRefs: readonly SeriesRef[],
  ): void {
    const unique = new Map(
      addedRefs.map((ref) => [this.catalog.refKey(ref), ref]),
    );
    const mode = arrivalModeFor(unique.size);
    if (mode === "none") return;
    if (mode === "ghost") {
      this.workspace.setGhostMode(panelId, "ghost");
      this.focusFirstSeries(panelId, [...unique.values()]);
      return;
    }
    const focused = this.workspace.focusEntries(panelId);
    for (const ref of unique.values()) {
      if (
        focused.some(
          (entry) =>
            entry.kind === "series" &&
            entry.ref?.source_key === ref.source_key &&
            entry.ref.channel === ref.channel,
        )
      ) {
        continue;
      }
      this.workspace.toggleFocus(panelId, {
        kind: "series",
        ref,
        source_key: null,
        channel: ref.channel,
      });
    }
  }

  private focusFirstSeries(panelId: string, refs: readonly SeriesRef[]): void {
    const focus = this.workspace.focusEntries(panelId);
    if (refs.some((ref) => matchesAnyFocus(focus, ref))) return;
    const first = refs[0];
    if (first === undefined) return;
    this.workspace.toggleFocus(panelId, {
      kind: "series",
      ref: first,
      source_key: null,
      channel: first.channel,
    });
  }

  private selectedRefs(): SeriesRef[] {
    const byKey = new Map(
      this.catalog.allSeries().map((series) => [
        this.catalog.refKey({
          source_key: series.sourceKey,
          channel: series.channel,
        }),
        { source_key: series.sourceKey, channel: series.channel },
      ]),
    );
    return this.selection
      .keys()
      .map((key) => byKey.get(key))
      .filter((ref): ref is SeriesRef => ref !== undefined);
  }

  private saveSelectedAsSet(): void {
    this.openSetNameRow(this.selectedRefs());
  }

  private syncSelectionActions(): void {
    required<HTMLButtonElement>(this.root, ".sets-save-selection").disabled =
      this.selection.size() === 0;
  }

  private syncSelectionWorkspace(): void {
    const workspaceId = this.workspace.activeTabId();
    if (this.selectionWorkspaceId === null) {
      this.selectionWorkspaceId = workspaceId;
      return;
    }
    if (this.selectionWorkspaceId === workspaceId) return;
    this.selectionWorkspaceId = workspaceId;
    this.selection.clear();
  }

  private reconcileSelection(): void {
    const allowed = new Set(
      this.catalog.allSeries().map((series) =>
        this.catalog.refKey({
          source_key: series.sourceKey,
          channel: series.channel,
        }),
      ),
    );
    this.selection.retain(allowed);
  }

  private addRefsToPanel(refs: readonly SeriesRef[]): void {
    if (refs.length === 0) return;
    const panelId =
      this.workspace.focusedPanelId() ?? this.workspace.addPanelRow().id;
    if (!this.workspace.addSeriesRefs(panelId, refs)) return;
    this.afterSeriesAdded(panelId, refs);
    this.workspace.focusPanel(panelId);
    this.fitWindowToPlotted();
    this.afterLayoutChange();
  }

  private openSources(): void {
    if (this.plane.ingest === null) return;
    void this.pickAndIngest("files");
  }

  private openFolder(): void {
    if (this.plane.ingest === null) return;
    void this.pickAndIngest("folder");
  }

  private async pickAndIngest(kind: SourceOpenKind): Promise<void> {
    const port = this.plane.ingest;
    if (port === null) return;
    try {
      const paths = await pickIngestPaths(port, kind);
      if (paths.length > 0) await this.ingestPaths(paths);
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
      const needsRecipe = status.recent_failures.find(
        (failure) => failure.recipe_required,
      );
      if (needsRecipe !== undefined) {
        try {
          await ImportWizard.mount(this.plane, needsRecipe.path, (path) =>
            this.ingestPaths([path]),
          );
        } catch (error: unknown) {
          this.reportError(error);
        }
      }
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
        this.resolvedFor(panel).map((series) => series.path),
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

  private markHistoryDirty(coalesceKey: string): void {
    if (this.restoringHistory) return;
    this.historyDirty = coalesceKey;
    this.clearHistoryCoalesceTimer();
    this.historyCoalesceTimer = window.setTimeout(() => {
      this.historyCoalesceTimer = null;
      const key = this.historyDirty;
      this.historyDirty = null;
      if (key !== null) {
        this.history.commit(historySnapshot(this.workspace.snapshot()), key);
      }
      if (this.historyGestureKey === null) {
        this.history.commit(historySnapshot(this.workspace.snapshot()));
      }
    }, 250);
  }

  private closeHistoryCoalescing(): void {
    this.clearHistoryCoalesceTimer();
    const key = this.historyDirty;
    this.historyDirty = null;
    if (key !== null) {
      this.history.commit(historySnapshot(this.workspace.snapshot()), key);
      this.history.commit(historySnapshot(this.workspace.snapshot()));
      return;
    }
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
      this.workspace.setTheme(this.prefs.theme);
      applyPreferences(this.prefs, document.documentElement);
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
    this.syncSelectionWorkspace();
    this.commitHistory();
    this.workspaceTabs?.sync(
      this.workspace.tabs(),
      this.workspace.activeTabId(),
    );
    this.workspaceView?.sync(
      this.signals.length > 0,
      this.visibleSeriesCounts(),
    );
    this.workspaceView?.setCursorMode(this.workspace.cursorMode());
    this.syncCursorMode();
    void this.refreshTiles();
    this.scheduleAutosave();
    this.renderWorkspaceName();
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
    const baked = this.plane.bakedPreferencesJson;
    if (baked !== undefined) {
      this.prefs = parsePreferences(baked) ?? defaultPreferences();
    }
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
      await this.refreshRecipeDirectory();
    }
    applyPreferences(this.prefs, document.documentElement);
  }

  /**
   * Caches the host-resolved recipe directory so the settings entries can
   * show it synchronously. The default is the per-OS app data directory, so
   * it is never derived here.
   */
  private async refreshRecipeDirectory(): Promise<void> {
    const port = this.plane.preferences;
    if (port === null) return;
    try {
      this.recipeDirectory = await port.effectiveRecipeDirectory();
    } catch (error: unknown) {
      console.warn("recipe directory is unavailable", error);
      this.recipeDirectory = null;
    }
  }

  private updatePreferences(
    patch: Partial<Omit<Preferences, "schema_version">>,
  ): void {
    this.prefs = { ...this.prefs, ...patch };
    this.prefs.ui_font_size = clampUiFontSize(this.prefs.ui_font_size);
    this.prefs.plot_font_size = clampPlotFontSize(this.prefs.plot_font_size);
    this.prefs.plot_line_width_scale = clampPlotLineWidthScale(
      this.prefs.plot_line_width_scale,
    );
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
      exportSets: () => exportSourceOptions(this.signals),
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
        snapshotPreferences(this.prefs),
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
    const canvases = (await this.workspaceView?.capturePanel(panelId)) ?? null;
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
    this.workspaceView?.sync(
      this.signals.length > 0,
      this.visibleSeriesCounts(),
    );
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
      this.selection.clear();
      this.history.reset(historySnapshot(this.workspace.snapshot()));
      this.workspacePath = null;
      this.presentation.clear();
      clearIngestProgress(this.root);
      this.workspace.setTheme(this.prefs.theme);
      applyPreferences(this.prefs, document.documentElement);
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
        let finalized = false;
        try {
          await waitForBatch(ingestPort, jobId, (status) => {
            renderBatchProgress(progress, status, () => {
              void ingestPort.cancelBatch(jobId);
            });
          });
          const restored = await restorePort.finalize(sessionJson, jobId);
          finalized = true;
          sessionJson = restored.session_json;
        } finally {
          if (!finalized) {
            await restorePort.finalize(sessionJson, jobId).catch(() => {});
          }
          await ingestPort.releaseBatch(jobId);
        }
      }
      this.workspace.replace(JSON.parse(sessionJson) as Session);
      this.selection.clear();
      this.history.reset(historySnapshot(this.workspace.snapshot()));
      this.workspacePath = loaded.path;
      this.dirty = false;
      clearIngestProgress(this.root);
      this.workspace.setTheme(this.prefs.theme);
      applyPreferences(this.prefs, document.documentElement);
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

  private renderWorkspaceName(): void {
    renderSessionTitle(
      required(this.root, ".workspace-name"),
      sessionDisplayTitle(this.workspace.snapshot().title, this.workspacePath),
    );
    required<HTMLElement>(this.root, ".session-save-status").hidden =
      !this.dirty;
  }

  /**
   * Creates a derived signal, records its definition in the session, and
   * plots it on the focused panel. Task 16's session replay calls this too.
   */
  async createDerived(path: string, expr: string): Promise<void> {
    const port = this.plane.derived;
    if (port === null) throw new Error("This snapshot cannot create signals");
    if (this.hasBundleReference(expr)) {
      validateDerivedBundleName(path);
      const response = await port.createBundle(path, expr);
      this.workspace.addDerivedBundle(response.local_path, expr);
      await this.reloadSignals();
      const focused = this.workspace.focusedPanelId();
      if (focused !== null) {
        const refs = response.created
          .map((summary) => this.catalog.refFromPath(summary.path))
          .filter((ref): ref is SeriesRef => ref !== undefined);
        if (this.workspace.addSeriesRefs(focused, refs)) {
          this.afterSeriesAdded(focused, refs);
        }
      }
      if (response.skipped.length > 0) {
        const missing = response.skipped
          .map(
            (entry) =>
              `${entry.prefix} missing ${entry.missing.map((item) => `'${item}'`).join(", ")}`,
          )
          .join("; ");
        this.showModeHelp(
          `created for ${String(response.created.length)} sources; ${missing}`,
        );
      }
      this.afterLayoutChange();
      return;
    }
    const summary = await port.create(path, expr);
    this.workspace.addDerived(summary.path, expr);
    await this.reloadSignals();
    const focused = this.workspace.focusedPanelId();
    const ref = this.catalog.refFromPath(summary.path);
    if (focused !== null && ref !== undefined) {
      this.workspace.addSeriesRef(focused, ref);
      this.afterSeriesAdded(focused, [ref]);
    }
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

  private async removeDerivedBundle(localPath: string): Promise<void> {
    const port = this.plane.derived;
    if (port === null) return;
    try {
      const refs = this.signals
        .filter((summary) => summary.local_path === localPath)
        .flatMap((summary) => {
          const ref = this.catalog.refFromPath(summary.path);
          return ref === undefined ? [] : [{ ref, path: summary.path }];
        });
      await port.removeBundle(localPath);
      for (const entry of refs) {
        this.workspace.removeSignalRef(entry.ref, entry.path);
      }
      this.workspace.removeDerivedBundle(localPath);
      await this.reloadSignals();
      this.afterLayoutChange();
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  private hasBundleReference(expression: string): boolean {
    const fullPaths = new Set(this.signals.map((signal) => signal.path));
    const bundlePaths = new Set(
      bundleCompletionEntries(this.signals).map((bundle) => bundle.localPath),
    );
    for (const match of expression.matchAll(
      /'((?:''|[^'])*)'|"((?:""|[^"])*)"/g,
    )) {
      const doubled = match[1] === undefined ? '""' : "''";
      const quote = match[1] === undefined ? '"' : "'";
      const reference = (match[1] ?? match[2] ?? "").replaceAll(doubled, quote);
      if (!fullPaths.has(reference) && bundlePaths.has(reference)) return true;
    }
    return false;
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
    this.catalogRevision += 1;
    this.presentation.invalidate();
    this.reconcileSelection();
    this.signalsByPath = new Map(
      this.signals.map((summary) => [summary.path, summary]),
    );
    this.outline?.setCatalog(this.catalog);
    this.outline?.setFilter(
      required<HTMLInputElement>(this.root, ".signal-search").value,
    );
    this.setsList?.setCatalog(this.catalog);
    this.setsList?.setNamedSets(this.workspace.namedSets());
    this.formulaBar?.setSignals(this.signals.map((summary) => summary.path));
    this.formulaBar?.setBundles(bundleCompletionEntries(this.signals));
    this.renderSearchStatus();
    this.updateStatus();
  }

  private refreshTiles(): Promise<void> {
    return this.presentation.refresh();
  }

  /** Signal ids a panel needs for its plotted series. */
  private panelSignalIds(panel: PanelState) {
    return resolveLineBindings(
      panel.x_axis,
      this.resolvedFor(panel),
      this.catalog,
      panel.color_axis,
    );
  }

  private resolvedFor(panel: PanelState): ResolvedSeries[] {
    const key = `${String(this.catalogRevision)}:${String(this.workspace.resolutionRevision())}`;
    const cached = this.resolutionCache.get(panel.id);
    if (cached?.key === key) return cached.resolved;
    const resolved = resolvePanel(
      this.catalog,
      panel,
      this.workspace.namedSets(),
    );
    this.resolutionCache.set(panel.id, { key, resolved });
    return resolved;
  }

  private visibleSeriesCounts(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const tab of this.workspace.tabs()) {
      for (const panel of tab.panels) {
        counts.set(
          panel.id,
          this.resolvedFor(panel).filter((series) => series.visible).length,
        );
      }
    }
    return counts;
  }

  private isDerivedPath(path: string): boolean {
    return this.workspace.derived().some((entry) => entry.path === path);
  }

  private handlePanelResize(): void {
    this.presentation.resized();
  }

  private scheduleRender(): void {
    this.presentation.scheduleRender();
  }

  private renderTiles(): void {
    this.presentation.render();
  }

  private applyTimeWindow(panelId: string, t0: number, t1: number): void {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return;
    const panel = this.workspace.panel(panelId);
    if (panel === undefined) return;
    if (this.workspace.linkedTime().linked) {
      this.workspace.setLinkedWindow(t0, t1);
      this.renderWindowReadout();
    } else {
      this.workspace.setPanelTimeWindow(panelId, [t0, t1]);
    }
    this.publishCachedCoverage();
    this.markHistoryDirty(`range:${panelId}`);
    this.scheduleRender();
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
    this.markHistoryDirty(`range:${panelId}`);
    this.scheduleAutosave();
    this.scheduleRender();
  }

  private publishCachedCoverage(): void {
    this.presentation.publishCachedCoverage();
  }

  private effectiveWindow(panel: PanelState): { t0: number; t1: number } {
    const state = this.workspace.linkedTime();
    if (state.linked) {
      return { t0: state.t0, t1: state.t1 };
    }
    const local = panel.time_window;
    return local === null
      ? { t0: state.t0, t1: state.t1 }
      : { t0: local[0], t1: local[1] };
  }

  private navigationXRange(
    panel: PanelState,
    panelId: string,
  ): { min: number; max: number } | null {
    if (panel.x_axis.kind !== "time") {
      return this.workspaceView?.panelXRange(panelId) ?? null;
    }
    const window = this.effectiveWindow(panel);
    return { min: window.t0, max: window.t1 };
  }

  private scheduleRefresh(delay = 50): void {
    this.presentation.scheduleRefresh(delay);
  }

  private fitPanelView(panelId: string): void {
    const panel = this.workspace.panel(panelId);
    if (panel === undefined) return;
    this.workspace.clearPanelYRange(panelId);
    this.workspaceView?.resetYAxis(panelId);
    if (panel.x_axis.kind !== "time") {
      this.workspace.clearPanelXRange(panelId);
      this.commitHistory();
      this.scheduleAutosave();
      this.renderTiles();
      return;
    }
    const extent = this.timeExtent(
      this.resolvedFor(panel).map((series) => series.path),
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

  private setCursor(
    panelId: string,
    cursor: PlotCursor | null,
    client: { x: number; y: number } | null,
  ): void {
    const mode = this.workspace.cursorMode();
    if (mode === "none") cursor = null;
    const axis = this.workspace.panel(panelId)?.x_axis;
    const local = axis !== undefined && axis.kind !== "time";
    if (local) {
      this.workspace.setCursorT(null);
      this.workspaceView?.clearCursors();
      this.workspaceView?.setLocalCursor(panelId, cursor);
      this.renderCursorTime(cursor?.heading);
      this.renderTooltip(
        panelId,
        mode === "track" ? cursor : null,
        mode === "track" ? client : null,
      );
      this.scheduleLiveValues(null);
      return;
    }
    const cursorT = cursor?.x ?? null;
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
    const resolved = this.resolvedFor(panel);
    const ghostChannels = new Map(
      resolved
        .filter((series) => series.display === "ghost")
        .map((series) => [series.path, series.ref.channel]),
    );
    const rows = groupCursorRows(cursor.rows, ghostChannels).map((row) =>
      tooltipRow(
        row.colorIndex === null
          ? "var(--fg-4)"
          : `var(--series-${String(row.colorIndex + 1)})`,
        row.label,
        row.value,
        row.ghost,
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
        for (const data of this.presentation.responses()) {
          if (data.kind !== "time") continue;
          const tiles = data.response;
          for (const tile of tiles.series) {
            if (!values.has(tile.signalPath)) {
              values.set(
                tile.signalPath,
                formatValue(columnsValueAtTime(tile.bins, this.pendingCursorT)),
              );
            }
          }
        }
      }
      this.outline?.setLiveValues(values);
    });
  }

  private updateStatus(): void {
    const pointCount = this.signals.reduce(
      (total, signal) => total + Number(signal.point_count),
      0,
    );
    void this.updateSources(pointCount);
  }

  private async updateSources(pointCount: number): Promise<void> {
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
        recipe_id: null,
        recipe_digest: null,
      });
    }
    this.root
      .querySelector<HTMLElement>(".status-aggregate")
      ?.replaceChildren(
        document.createTextNode(
          statusAggregate(sources.length, this.signals.length, pointCount),
        ),
      );
    const dockFooter = this.root.querySelector<HTMLElement>(".dock-footer");
    if (dockFooter !== null) {
      renderDockFooter(dockFooter, () => this.openSources());
    }
  }

  private toggleLinked(): void {
    const state = this.workspace.linkedTime();
    const linked = !state.linked;
    if (!linked) {
      for (const panel of this.workspace.panels()) {
        this.workspace.setPanelTimeWindow(panel.id, [state.t0, state.t1]);
      }
    }
    this.workspace.setLinked(linked);
    this.commitHistory();
    required(this.root, ".linked-toggle").classList.toggle("active", linked);
    void this.refreshTiles();
  }

  private toggleTheme(): void {
    const theme = this.prefs.theme === "light" ? "dark" : "light";
    // Preferences are authoritative for the running app; the session keeps a
    // copy so an exported snapshot bakes the theme it was exported with. That
    // copy has to reach disk too, or a session saved after a theme change and
    // reopened elsewhere carries the old one.
    this.workspace.setTheme(theme);
    this.scheduleAutosave();
    this.updatePreferences({ theme });
  }

  /** Applies the user's global theme to the current session and document. */
  private restoreTheme(): void {
    if (this.plane.preferences === null) {
      this.prefs = { ...this.prefs, theme: this.workspace.theme() };
    } else {
      this.workspace.setTheme(this.prefs.theme);
    }
    applyPreferences(this.prefs, document.documentElement);
  }

  private toggleSignalTree(): void {
    const workbench = required(this.root, ".workbench");
    this.setSignalTreeOpen(workbench.classList.contains("tree-collapsed"));
  }

  private selectAllDockRows(): void {
    this.selection.setAll(this.outline?.filteredKeys() ?? []);
  }

  private dockContains(target: EventTarget | null): boolean {
    return (
      target instanceof Node &&
      required<HTMLElement>(this.root, ".signal-tree").contains(target)
    );
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

/** Hides and empties the ingest banner. Workspace reset and load both need
 * this: the banner is deliberately kept visible while failures are recent,
 * and nothing else ever takes it down. */
export function clearIngestProgress(root: HTMLElement): void {
  const progress = root.querySelector<HTMLElement>(".ingest-progress");
  if (progress === null) return;
  progress.hidden = true;
  progress.replaceChildren();
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
    if (status.state !== "running") {
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "ingest-dismiss";
      dismiss.textContent = "Dismiss";
      dismiss.title = "Dismiss ingest failures";
      dismiss.addEventListener("click", () => {
        progress.hidden = true;
        progress.replaceChildren();
      });
      children.push(dismiss);
    }
  }
  progress.replaceChildren(...children);
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

function tooltipHeader(text: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "plot-tip-header";
  header.textContent = text;
  return header;
}

export interface GroupedCursorRow {
  label: string;
  value: string;
  colorIndex: number | null;
  ghost: boolean;
}

export function groupCursorRows(
  rows: readonly PlotCursor["rows"][number][],
  ghostChannels: ReadonlyMap<string, string>,
): GroupedCursorRow[] {
  const grouped = new Map<
    string,
    { count: number; min: number; max: number; unit: string | null }
  >();
  const result: GroupedCursorRow[] = [];
  for (const row of rows) {
    const channel = ghostChannels.get(row.path);
    if (channel === undefined) {
      result.push({
        label: row.label,
        value:
          row.unit === null
            ? formatValue(row.value)
            : `${formatValue(row.value)} ${row.unit}`,
        colorIndex: row.colorIndex,
        ghost: false,
      });
      continue;
    }
    const current = grouped.get(channel);
    if (current === undefined) {
      grouped.set(channel, {
        count: 1,
        min: row.value,
        max: row.value,
        unit: row.unit,
      });
      result.push({ label: channel, value: "", colorIndex: null, ghost: true });
    } else {
      current.count += 1;
      current.min = Math.min(current.min, row.value);
      current.max = Math.max(current.max, row.value);
    }
  }
  for (const row of result) {
    if (!row.ghost) continue;
    const channel = row.label;
    const group = grouped.get(channel);
    if (group === undefined) continue;
    const range =
      group.min === group.max
        ? formatValue(group.min)
        : `${formatValue(group.min)} → ${formatValue(group.max)}`;
    row.label = `${channel} · ${String(group.count)} signals`;
    row.value = group.unit === null ? range : `${range} ${group.unit}`;
  }
  return result;
}

function tooltipRow(
  color: string,
  name: string,
  value: string,
  ghost = false,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "plot-tip-row";
  row.classList.toggle("ghost", ghost);
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

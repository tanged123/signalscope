import { bindAxisDrop } from "./axis-drop";
import { showAxisPicker, xAxisLabel as axisLabel } from "./axis-picker";
import {
  columnsValueAtTime,
  type ColumnarTileResponse,
} from "../app/bin-columns";
import type { Catalog } from "../app/catalog";
import { appliedOverrides, type ResolvedSeries } from "../app/resolution";
import { DEFAULT_PANEL_LINE_WIDTH } from "../app/style-defaults";
import { virtualSlice } from "../app/outline-model";
import { compileGlob, evaluateSelector } from "../app/selector";
import type {
  AxisStyle,
  AnnotationDisplay,
  Binding,
  DashStyle,
  FocusEntry,
  LegendAnchor,
  LegendDock,
  LegendState,
  NamedSet,
  PanelState,
  SeriesRef,
  SeriesOverride,
  StyleDimension,
  StatColumn,
  XAxisSource,
} from "../generated/session";
import {
  clamp,
  formatValue,
  insidePlot,
  type PlotLayout,
  type Range,
} from "../app/plot-math";
import { resolveRanges } from "../app/plot-gestures";
import {
  type AnnotationAnchor,
  type PlotCursor,
  type PreparedPlot,
  type ResolvedAnnotation,
  type SeriesHitAdapter,
} from "../app/plot-capabilities";
import type { PanelLineResponse } from "../app/line-presentation-controller";
import { line2dFamily } from "../app/line2d-family";
import {
  COLOR_SLOTS,
  hueIndex,
  invalidatePalette,
  resolvePalette,
  type SeriesStroke,
} from "../render/plot-theme";
import { ChartHost, type ChartRenderRequest } from "../render/chart-host";
import type { GpuContext } from "../render/gpu-context";
import { seriesInspector, formatToolbarNumber } from "./series-inspector";
import { showPanelMenu } from "./panel-menu";

const CHART_HOST_INITIALIZATION_TIMEOUT_MS = 5_000;
// A newly acquired device can outlive its first canvas configuration attempt.
// These retries cover that startup race before reporting a host failure.
const CHART_HOST_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;
import {
  OverlayRenderer,
  type OverlayAnnotation,
  type CursorMode,
  type CursorPoint,
} from "../render/overlay-renderer";
import { YAxisPolicy } from "../render/y-axis";
import { required } from "./dom";
import { PanelShell } from "./panel-shell";
import { PanelAnnotationState } from "./panel-annotations";
import {
  bindLegendDrag,
  floatLegend,
  legendResizeHandle,
  positionLegend,
  type LegendRailHost,
} from "./legend-rail";
import {
  aggregateLegendStats,
  csvCell,
  downloadText,
  emptyLegendStats,
  safeFilename,
  setStatCellValue,
  statCell,
  statColumnLabel,
  statGridTemplate,
  statHistogram,
  statSpan,
  statSpanDomain,
  type LegendStatValues,
} from "./legend-stats";
import {
  PlotInteractionController,
  type InteractionBox,
} from "./plot-interactions";

export {
  dragData,
  hasDragType,
  MAXIMIZE_GLYPH,
  PANEL_DRAG_TYPE,
  parseSetPayload,
  parseSignalPayload,
  parseSignalRefsPayload,
  SET_DRAG_TYPE,
  SIGNAL_DRAG_TYPE,
} from "./panel-shell";

export const MAX_SERIES_PER_PANEL = 64;

export type PanelCursor = PlotCursor;

interface ResolvedAnnotations {
  resolved: readonly ResolvedAnnotation[];
}

function colorIndexForHue(hue: number | null): number {
  if (hue === null) return 0;
  return hueIndex(hue);
}

export type EncodingProperty = "color" | "dash" | "width";

export interface PanelCallbacks {
  onFocus(id: string): void;
  onClose(id: string): void;
  onSplitRight(id: string): void;
  onSplitDown(id: string): void;
  onMaximize(id: string): void;
  onDropSignals(id: string, paths: string[]): void;
  onDropSet(id: string, setId: string): void;
  onFocusToggle(id: string, entry: FocusEntry): void;
  onFocusAdd(id: string, entry: FocusEntry): void;
  onFocusRange(id: string, entries: readonly FocusEntry[]): void;
  onClearFocus(id: string): void;
  onMuteSelector(id: string, selector: string): void;
  onMuteSeries(id: string, ref: SeriesRef): void;
  onRemoveBinding(id: string, index: number): void;
  onToggleGhostMode(id: string): void;
  onLegendLayout(
    id: string,
    layout: {
      state?: LegendState;
      position?: [number, number] | null;
      size?: [number, number] | null;
      anchor?: LegendAnchor | null;
      dock?: LegendDock | null;
      hintDismissed?: boolean;
    },
  ): void;
  localPathFor(path: string): string | null;
  sourceKeyFor(path: string): string | null;
  pathForRef(ref: { source_key: string; channel: string }): string | null;
  catalog(): Catalog;
  namedSets(): readonly NamedSet[];
  resolveSeries(state: PanelState): readonly ResolvedSeries[];
  onToggleSeries(id: string, ref: SeriesRef): void;
  onResized(id: string): void;
  onGesture(id: string, hint: string | null): void;
  onCursor(
    id: string,
    cursor: PanelCursor | null,
    client: { x: number; y: number } | null,
  ): void;
  onTimeWindow(id: string, t0: number, t1: number): void;
  onYRange(id: string, range: readonly [number, number]): void;
  onXRange(id: string, range: readonly [number, number]): void;
  onPinAnnotation(id: string, hit: AnnotationAnchor): void;
  onRemoveAnnotation(id: string, annotationId: string): void;
  onClearAnnotations?(id: string): void;
  onSetAnnotationDisplay?(id: string, display: AnnotationDisplay): void;
  onSetAnnotationOffset?(
    id: string,
    annotationId: string,
    offset: readonly [number, number],
  ): void;
  onEditAnnotationLabel(id: string, annotationId: string, label: string): void;
  onFitView(id: string): void;
  onToggleStats(id: string): void;
  onToggleAxisStyle(id: string): void;
  onRenameTitle(id: string, title: string): void;
  onEditAxisLabel(id: string, axis: "x" | "y", label: string | null): void;
  onSetEncoding(
    id: string,
    property: EncodingProperty,
    dimension: StyleDimension | null,
  ): void;
  onSetPanelLineWidth(id: string, width: number): void;
  onSetGhostOpacity(id: string, opacity: number): void;
  onSetStatColumns(id: string, columns: StatColumn[]): void;
  onSetStatsSort(
    id: string,
    column: StatColumn | null,
    descending: boolean,
  ): void;
  onRevertStyleOverride(id: string, index: number): void;
  onClearOverrides(id: string): void;
  onPatchSeriesStyle(
    id: string,
    ref: SeriesRef,
    style: {
      color_slot?: number | null;
      dash?: DashStyle | null;
      width?: number | null;
    },
  ): void;
  onRemoveSeries(id: string, ref: SeriesRef): void;
  onSetXAxis?(id: string, xAxis: XAxisSource): void;
}

export interface RenderSeries {
  ref: SeriesRef;
  path: string;
  display: ResolvedSeries["display"];
  hue: number | null;
  dash: DashStyle;
  width: number;
  opacity: number;
  visible: boolean;
  focused: boolean;
  overridden: boolean;
  overrideFields: { color: boolean; dash: boolean; width: boolean };
}

export type RenderPanelState = PanelState & {
  series: RenderSeries[];
};

export interface SeriesLegendRow {
  value: string;
  series: RenderSeries;
  focused: boolean;
}

export interface BindingChipEntry {
  label: string;
  bindingIndex: number;
  kind: Binding["kind"];
  refs: SeriesRef[];
  selector: string | null;
}

export { aggregateLegendStats } from "./legend-stats";

export function seriesLegendRows(
  catalog: Catalog,
  state: Pick<RenderPanelState, "series" | "focus">,
  query = "",
): SeriesLegendRow[] {
  const trimmedQuery = query.trim().replace(/^\/\s*/, "");
  const selectorQuery = /(?:^|\s)@|(?:^|\s)(?:unit|kind):/.test(trimmedQuery);
  const evaluation =
    trimmedQuery === "" || !selectorQuery
      ? null
      : evaluateSelector(catalog, trimmedQuery);
  if (selectorQuery && evaluation === null) return [];
  const matching =
    evaluation === null
      ? null
      : new Set(
          evaluation.series.map((series) =>
            catalog.refKey({
              source_key: series.sourceKey,
              channel: series.channel,
            }),
          ),
        );
  const rows: SeriesLegendRow[] = [];
  for (const series of state.series) {
    if (matching !== null && !matching.has(catalog.refKey(series.ref))) {
      continue;
    }
    const focus = state.focus.some((entry) => focusMatches(entry, series.ref));
    rows.push({
      value: catalog.refKey(series.ref),
      series,
      focused: focus,
    });
  }
  if (trimmedQuery === "" || selectorQuery) return rows;
  const glob = ["*", "?", "[", "|"].some((token) =>
    trimmedQuery.includes(token),
  )
    ? compileGlob(trimmedQuery)
    : null;
  const text = trimmedQuery.toLocaleLowerCase();
  return rows.filter((row) =>
    glob === null
      ? row.series.path.toLocaleLowerCase().includes(text)
      : glob.test(row.series.path),
  );
}

export function bindingChipEntries(
  catalog: Catalog,
  state: Pick<RenderPanelState, "bindings">,
  namedSets: readonly NamedSet[],
): BindingChipEntry[] {
  const entries: BindingChipEntry[] = [];
  for (const [bindingIndex, binding] of state.bindings.entries()) {
    if (binding.kind === "pick") {
      const groups = new Map<string, SeriesRef[]>();
      for (const ref of binding.refs) {
        const group = groups.get(ref.channel) ?? [];
        group.push(ref);
        groups.set(ref.channel, group);
      }
      for (const [channel, refs] of groups) {
        entries.push({
          label: `${channel} ×${String(refs.length)}`,
          bindingIndex,
          kind: binding.kind,
          refs,
          selector: null,
        });
      }
      continue;
    }

    const selector =
      binding.kind === "query"
        ? binding.selector
        : (namedSets.find((set) => set.id === binding.set_id)?.selector ??
          null);
    const set =
      binding.kind === "set"
        ? namedSets.find((entry) => entry.id === binding.set_id)
        : null;
    const refs =
      binding.kind === "set" && set?.kind === "pick"
        ? set.refs
        : selector === null
          ? []
          : (evaluateSelector(catalog, selector)?.series ?? []).map(
              (series) =>
                catalog.refFromPath(series.path) ?? {
                  source_key: series.sourceKey,
                  channel: series.channel,
                },
            );
    const label =
      binding.kind === "set"
        ? `★ ${set?.name ?? binding.set_id ?? "missing set"} · ${String(refs.length)}`
        : `${binding.selector ?? "invalid selector"} · ${String(refs.length)}`;
    entries.push({
      label,
      bindingIndex,
      kind: binding.kind,
      refs,
      selector,
    });
  }
  return entries;
}

function setsEqual(
  left: ReadonlySet<string> | null,
  right: ReadonlySet<string> | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null || left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function focusMatches(entry: FocusEntry, ref: SeriesRef): boolean {
  if (entry.kind === "series") {
    return (
      entry.ref !== null &&
      entry.ref.source_key === ref.source_key &&
      entry.ref.channel === ref.channel
    );
  }
  return entry.kind === "source"
    ? entry.source_key === ref.source_key
    : entry.channel === ref.channel;
}

function renderState(
  state: PanelState,
  callbacks: Pick<PanelCallbacks, "resolveSeries">,
): RenderPanelState {
  const resolved = callbacks.resolveSeries(state);
  return {
    ...state,
    series: resolved.map((entry) => ({
      ref: entry.ref,
      path: entry.path,
      display: entry.display,
      hue: entry.hue,
      dash: entry.dash,
      width: entry.width,
      opacity: entry.opacity,
      visible: entry.visible,
      focused: entry.focused,
      overridden: entry.overridden,
      overrideFields: entry.overrideFields,
    })),
  };
}

export class PanelView {
  readonly element: HTMLElement;
  private readonly shell: PanelShell;
  private readonly overlay: HTMLCanvasElement;
  private readonly chartHostElement: HTMLElement;
  private readonly overlayRenderer: OverlayRenderer;
  private chartHost: ChartHost | null = null;
  private chartHostReady: Promise<ChartHost | null> | null = null;
  private chartHostRetryTimer: number | null = null;
  private pendingChartRender: ChartRenderRequest | null = null;
  private chartHostGeneration = 0;
  private disposed = false;
  private readonly interactions: PlotInteractionController;
  private readonly yAxis = new YAxisPolicy();
  private lastState: RenderPanelState | null = null;
  private lastInputState: PanelState | null = null;
  private lastStateKey: string | null = null;
  private lastData: PanelLineResponse | null = null;
  private lastTiles: ColumnarTileResponse | null = null;
  private lastWindow: { t0: number; t1: number } | null = null;
  private lastMissingEmpty = true;
  private lastError: string | null = null;
  private preparedPlot: PreparedPlot | null = null;
  private hitAdapter: SeriesHitAdapter | null = null;
  private cursorT: number | null = null;
  private localCursor: PlotCursor | null = null;
  private cursorMode: CursorMode = "none";
  private box: InteractionBox | null = null;
  private emphasizePaths: ReadonlySet<string> | null = null;
  private hoverTip: AnnotationAnchor | null = null;
  private annotationState: PanelAnnotationState | null = null;
  private signalsExpanded = true;
  private focusOnly = false;
  private focusRangeAnchor: { scope: string; value: string } | null = null;
  private inspectorPath: string | null = null;
  private encodingDrawer: EncodingProperty | null = null;
  private overrideDrawer = false;
  private statsColumnsDrawer = false;
  private bindingCleanup: (() => void) | null = null;
  private panelConfigCleanup: (() => void) | null = null;
  private plotLegendPosition: { x: number; y: number } | null = null;
  private plotLegendSize: { width: number; height: number } | null = null;
  private plotLegendAnchor: LegendAnchor | null = null;
  private plotLegendDock: LegendDock | null = null;

  private get annotationUi(): PanelAnnotationState {
    return (this.annotationState ??= new PanelAnnotationState());
  }

  private readonly axisDropCleanup: () => void;

  constructor(
    private readonly id: string,
    private readonly callbacks: PanelCallbacks,
    private gpu: GpuContext | null = null,
  ) {
    this.shell = new PanelShell(id, {
      onFocus: (panelId) => callbacks.onFocus(panelId),
      onClose: (panelId) => callbacks.onClose(panelId),
      onSplitRight: (panelId) => callbacks.onSplitRight(panelId),
      onSplitDown: (panelId) => callbacks.onSplitDown(panelId),
      onMaximize: (panelId) => callbacks.onMaximize(panelId),
      onDropSignals: (panelId, paths) =>
        callbacks.onDropSignals(panelId, paths),
      onDropSet: (panelId, setId) => callbacks.onDropSet(panelId, setId),
      onRenameTitle: (panelId, title) =>
        callbacks.onRenameTitle(panelId, title),
    });
    this.element = this.shell.element;
    this.shell.slots.controls.innerHTML = lineToolbarMarkup();
    this.chartHostElement = document.createElement("div");
    this.chartHostElement.className = "chart-host";
    this.chartHostElement.hidden = true;
    this.shell.appendContent(this.chartHostElement);
    this.overlay = document.createElement("canvas");
    this.overlay.className = "overlay-canvas";
    this.overlay.setAttribute("aria-hidden", "true");
    this.shell.appendContent(this.overlay);
    this.overlayRenderer = new OverlayRenderer(this.overlay);
    this.bind();
    this.axisDropCleanup = bindAxisDrop(
      this.element,
      () => callbacks.catalog(),
      () => callbacks.namedSets(),
      (axis) => callbacks.onSetXAxis?.(this.id, axis),
    );
    this.interactions = new PlotInteractionController(this.overlay, {
      layout: () => this.activeLayout(),
      applyXRange: (min, max) => {
        this.applyXRange(min, max);
      },
      applyYRange: (min, max) => {
        const layout = this.activeLayout();
        if (layout !== null) {
          this.chartHost?.setRangesOnly(layout.xRange, [min, max]);
        }
        this.callbacks.onYRange(this.id, [min, max]);
      },
      fitView: () => {
        this.callbacks.onFitView(this.id);
      },
      plotClick: (x, y, modifiers) => {
        this.plotClick(x, y, modifiers);
      },
      setGesture: (hint) => {
        this.element.classList.toggle("plot-interacting", hint !== null);
        this.callbacks.onGesture(this.id, hint);
      },
      setBox: (box) => {
        this.box = box;
        this.drawOverlay();
      },
      axisEditZone: (x, y) => {
        const layout = this.activeLayout();
        const state = this.lastState;
        return layout === null || state === null
          ? null
          : axisEditZone(layout, state.axis_style, x, y);
      },
      beginAxisEdit: (axis) => {
        this.beginAxisEdit(axis);
      },
    });
    new ResizeObserver(() => {
      if (!this.element.isConnected) return;
      this.chartHost?.resize();
      this.positionPlotLegend();
      this.callbacks.onResized(this.id);
    }).observe(this.chartHostElement);
  }

  setGpu(gpu: GpuContext): void {
    if (this.gpu !== null || this.disposed) return;
    this.gpu = gpu;
    this.lastStateKey = null;
    if (this.lastInputState !== null) {
      this.update(
        this.lastInputState,
        this.element.classList.contains("maximized"),
      );
    }
    this.mount();
  }

  mount(): void {
    if (
      this.gpu === null ||
      this.disposed ||
      !this.element.isConnected ||
      this.chartHostElement.hidden
    ) {
      return;
    }
    if (this.chartHostReady !== null || this.chartHostRetryTimer !== null) {
      this.chartHost?.resize();
      return;
    }
    this.initializeChartHost(this.gpu);
  }

  private initializeChartHost(gpu: GpuContext, attempt = 0): void {
    const generation = this.chartHostGeneration;
    let timedOut = false;
    let timeoutId = 0;
    const creation = ChartHost.create(this.chartHostElement, gpu);
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = window.setTimeout(() => {
        timedOut = true;
        reject(new Error("ChartGPU initialization timed out"));
      }, CHART_HOST_INITIALIZATION_TIMEOUT_MS);
    });
    void creation.then(
      (host) => {
        if (timedOut) host.dispose();
      },
      () => {},
    );
    this.chartHostReady = Promise.race([creation, timeout])
      .then((host) => {
        if (
          this.disposed ||
          generation !== this.chartHostGeneration ||
          this.gpu !== gpu
        ) {
          host.dispose();
          return null;
        }
        this.chartHost = host;
        if (this.pendingChartRender !== null) {
          host.render(this.pendingChartRender);
          this.pendingChartRender = null;
          this.drawOverlay();
        }
        return host;
      })
      .catch((error: unknown) => {
        if (
          this.disposed ||
          generation !== this.chartHostGeneration ||
          this.gpu !== gpu
        ) {
          return null;
        }
        this.chartHostReady = null;
        const retryDelay = CHART_HOST_RETRY_DELAYS_MS[attempt];
        if (retryDelay !== undefined) {
          this.chartHostRetryTimer = window.setTimeout(() => {
            this.chartHostRetryTimer = null;
            if (
              this.disposed ||
              generation !== this.chartHostGeneration ||
              this.gpu !== gpu ||
              !this.element.isConnected
            ) {
              return;
            }
            this.initializeChartHost(gpu, attempt + 1);
          }, retryDelay);
          return null;
        }
        console.error("ChartGPU initialization failed", error);
        gpu.reportFailure({
          kind: "host-initialization",
          message:
            error instanceof Error
              ? error.message
              : "ChartGPU initialization failed",
        });
        if (this.gpu !== gpu) return null;
        this.gpu = null;
        this.chartHostElement.hidden = true;
        if (this.lastInputState !== null) {
          this.lastStateKey = null;
          this.update(
            this.lastInputState,
            this.element.classList.contains("maximized"),
          );
        }
        return null;
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
      });
  }

  private bind(): void {
    required(this.element, ".panel-stats-toggle").addEventListener(
      "click",
      () => {
        this.callbacks.onToggleStats(this.id);
      },
    );
    required(this.element, ".panel-axis-toggle").addEventListener(
      "click",
      () => {
        this.callbacks.onToggleAxisStyle(this.id);
      },
    );
    required(this.element, ".panel-y-axis").addEventListener(
      "click",
      (event) => {
        if (this.lastState !== null)
          this.openAxisPicker(
            "y",
            this.lastState,
            event.currentTarget as HTMLElement,
          );
      },
    );
    required(this.element, ".panel-x-axis").addEventListener(
      "click",
      (event) => {
        if (this.lastState !== null) {
          this.openAxisPicker(
            "x",
            this.lastState,
            event.currentTarget as HTMLElement,
          );
        }
      },
    );
    required(this.element, ".panel-line-width").addEventListener(
      "click",
      (event) => {
        if (this.lastState !== null)
          this.openLineWidthMenu(
            this.lastState,
            event.currentTarget as HTMLElement,
          );
      },
    );
    required(this.element, ".panel-ghost-opacity").addEventListener(
      "click",
      (event) => {
        if (this.lastState !== null)
          this.openGhostMenu(
            this.lastState,
            event.currentTarget as HTMLElement,
          );
      },
    );
    required(this.element, ".panel-legend-state").addEventListener(
      "click",
      (event) => {
        if (this.lastState !== null)
          this.openLegendStateMenu(
            this.lastState,
            event.currentTarget as HTMLElement,
          );
      },
    );
    required(this.element, ".panel-tips").addEventListener("click", (event) => {
      if (this.lastState !== null)
        this.openTipsMenu(this.lastState, event.currentTarget as HTMLElement);
    });
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (this.annotationUi.selectedIds.size > 0) {
          this.annotationUi.selectedIds.clear();
          this.drawOverlay();
          this.updatePlotLegend(this.lastState as RenderPanelState);
        } else if (this.emphasizePaths !== null) this.clearHover();
        else this.callbacks.onClearFocus(this.id);
        this.closeBindingPopover();
        this.closePanelConfig();
        const drawerOpen =
          this.encodingDrawer !== null ||
          this.overrideDrawer ||
          this.statsColumnsDrawer;
        const inspectorOpen = this.inspectorPath !== null;
        this.encodingDrawer = null;
        this.overrideDrawer = false;
        this.statsColumnsDrawer = false;
        this.inspectorPath = null;
        if ((drawerOpen || inspectorOpen) && this.lastState !== null) {
          this.updatePlotLegend(this.lastState);
        }
      } else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        this.annotationUi.selectedIds.size > 0
      ) {
        event.preventDefault();
        for (const id of this.annotationUi.selectedIds) {
          this.callbacks.onRemoveAnnotation(this.id, id);
        }
        this.annotationUi.selectedIds.clear();
      } else if (
        event.target === this.element &&
        event.key === "Tab" &&
        this.cursorT !== null
      ) {
        event.preventDefault();
        this.walkHover(event.shiftKey ? -1 : 1);
      } else if (
        event.target === this.element &&
        event.key === "Enter" &&
        this.emphasizePaths?.size === 1
      ) {
        const path = [...this.emphasizePaths][0];
        const series = this.lastState?.series.find(
          (entry) => entry.path === path,
        );
        if (series !== undefined) {
          event.preventDefault();
          this.callbacks.onFocusToggle(this.id, {
            kind: "series",
            ref: series.ref,
            source_key: null,
            channel: series.ref.channel,
          });
        }
      }
    });
    this.overlay.addEventListener("pointermove", (event) => {
      if (this.interactions.isDragging() || this.annotationUi.dragId !== null)
        return;
      const layout = this.activeLayout();
      const inside =
        layout !== null && insidePlot(layout, event.offsetX, event.offsetY);
      const cursor =
        layout !== null && inside
          ? this.cursorAt(layout, event.offsetX, event.offsetY, 40)
          : null;
      if (layout !== null && inside) {
        this.updateHover(event.offsetX, event.offsetY);
      } else {
        this.clearHover();
      }
      this.callbacks.onCursor(
        this.id,
        cursor,
        cursor === null ? null : { x: event.clientX, y: event.clientY },
      );
    });
    this.overlay.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const hit = this.overlayRenderer.annotationAt(
        event.offsetX,
        event.offsetY,
      );
      if (hit === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (hit.part === "delete") {
        this.callbacks.onRemoveAnnotation(this.id, hit.id);
        return;
      }
      const start = { x: event.offsetX, y: event.offsetY };
      const saved = this.lastState?.annotations.find(
        (annotation) => annotation.id === hit.id,
      )?.offset;
      const initial = this.annotationUi.offsets.get(hit.id) ?? {
        x: saved?.[0] ?? 10,
        y: saved?.[1] ?? -10,
      };
      let moved = false;
      this.annotationUi.dragId = hit.id;
      this.overlay.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent): void => {
        if (hit.part !== "label") return;
        const dx = next.offsetX - start.x;
        const dy = next.offsetY - start.y;
        if (!moved && Math.hypot(dx, dy) <= 3) return;
        moved = true;
        this.annotationUi.offsets.set(hit.id, {
          x: initial.x + dx,
          y: initial.y + dy,
        });
        this.drawOverlay();
      };
      const finish = (next: PointerEvent): void => {
        cleanup();
        if (!moved) {
          this.selectAnnotation(
            hit.id,
            next.metaKey || next.ctrlKey || next.shiftKey,
          );
        } else {
          const offset = this.annotationUi.offsets.get(hit.id);
          if (offset !== undefined) {
            this.callbacks.onSetAnnotationOffset?.(this.id, hit.id, [
              offset.x,
              offset.y,
            ]);
          }
        }
      };
      const cleanup = (): void => {
        this.overlay.removeEventListener("pointermove", move);
        this.overlay.removeEventListener("pointerup", finish);
        this.overlay.removeEventListener("pointercancel", cleanup);
        this.annotationUi.dragId = null;
      };
      this.overlay.addEventListener("pointermove", move);
      this.overlay.addEventListener("pointerup", finish);
      this.overlay.addEventListener("pointercancel", cleanup);
    });
    this.overlay.addEventListener("pointerleave", () => {
      if (
        !this.interactions.isDragging() &&
        this.annotationUi.dragId === null
      ) {
        this.clearHover();
        this.callbacks.onCursor(this.id, null, null);
      }
    });
    this.overlay.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  }

  update(state: PanelState, maximized: boolean): void {
    const rendered = renderState(state, this.callbacks);
    this.lastInputState = state;
    this.lastState = rendered;
    this.shell.setTitle(rendered.title, maximized);
    const axisToggle = required<HTMLButtonElement>(
      this.element,
      ".panel-axis-toggle",
    );
    axisToggle.textContent = `axes: ${rendered.axis_style}`;
    axisToggle.title = `Switch to ${rendered.axis_style === "gutter" ? "inline" : "gutter"} axes`;
    axisToggle.hidden = false;
    const xAxis = required<HTMLButtonElement>(this.element, ".panel-x-axis");
    const xAxisLabel = axisLabel(rendered.x_axis, this.callbacks.catalog());
    xAxis.textContent = `x: ${xAxisLabel} ▾`;
    xAxis.title =
      rendered.x_axis.kind === "time"
        ? "Choose a resolved signal for the X axis"
        : `X axis signal: ${xAxisLabel}`;
    xAxis.setAttribute("aria-label", `X axis: ${xAxisLabel}`);
    xAxis.hidden = false;
    required<HTMLElement>(this.element, ".panel-line-width-value").textContent =
      formatToolbarNumber(rendered.line_width);
    required<HTMLElement>(this.element, ".panel-ghost-value").textContent =
      rendered.ghost_mode === "all"
        ? "none"
        : `${String(Math.round(rendered.ghost_opacity * 100))}%`;
    required<HTMLElement>(this.element, ".panel-legend-value").textContent =
      rendered.legend_state;
    required<HTMLElement>(this.element, ".panel-tips-value").textContent =
      String(rendered.annotations.length);
    required<HTMLButtonElement>(
      this.element,
      ".panel-stats-toggle",
    ).setAttribute("aria-pressed", String(rendered.show_stats));
    this.updateBindings(rendered);
    this.updateLegend(rendered);
    this.pruneAnnotationUiState(rendered);
    const annotations = this.resolvedAnnotations(rendered);
    this.drawOverlay(annotations);
    if (
      this.inspectorPath !== null &&
      !rendered.series.some((series) => series.path === this.inspectorPath)
    ) {
      this.inspectorPath = null;
    }
    if (this.lastError !== null) {
      this.shell.setStatus({ kind: "error", message: this.lastError });
    } else if (rendered.series.length === 0) {
      this.shell.setStatus({
        kind: "empty",
        message: "Empty panel — drag a signal here.",
      });
    } else if (this.gpu === null) {
      this.shell.setStatus({
        kind: "unavailable",
        message: "WebGPU unavailable — plot rendering disabled",
      });
    } else {
      this.shell.setStatus({ kind: "ready" });
    }
  }

  renderData(
    state: PanelState,
    data: PanelLineResponse | null,
    window: { t0: number; t1: number },
    missing: readonly string[] = [],
    error: string | null = null,
  ): number {
    const stateKey = JSON.stringify(state);
    if (
      stateKey === this.lastStateKey &&
      data === this.lastData &&
      this.lastWindow !== null &&
      window.t0 === this.lastWindow.t0 &&
      window.t1 === this.lastWindow.t1 &&
      missing.length === 0 &&
      this.lastMissingEmpty &&
      error === this.lastError
    ) {
      if (this.lastError !== null) {
        this.shell.setStatus({ kind: "error", message: this.lastError });
      }
      return 0;
    }
    const windowChanged =
      this.lastWindow === null ||
      window.t0 !== this.lastWindow.t0 ||
      window.t1 !== this.lastWindow.t1;
    if (
      this.localCursor !== null &&
      (data !== this.lastData || windowChanged)
    ) {
      this.localCursor = null;
      this.cursorT = null;
      this.callbacks.onCursor(this.id, null, null);
    }
    const rendered = renderState(state, this.callbacks);
    this.lastInputState = state;
    this.lastStateKey = stateKey;
    this.lastState = rendered;
    this.lastData = data;
    this.lastTiles = data?.kind === "time" ? data.response : null;
    this.lastWindow = { ...window };
    this.lastMissingEmpty = missing.length === 0;
    this.lastError = error;
    this.preparedPlot = null;
    this.hitAdapter = null;
    this.updateLegendValues();
    const elapsed = this.renderForMode(rendered, data, window);
    this.hitAdapter =
      (this.preparedPlot as PreparedPlot | null)?.hitAdapter ?? null;
    this.interactions.setPolicy(
      (this.preparedPlot as PreparedPlot | null)?.interaction ?? null,
    );
    this.updatePlotLegend(rendered);
    this.pruneAnnotationUiState(rendered);
    const annotations = this.resolvedAnnotations(rendered);
    this.drawOverlay(annotations);
    if (error !== null) {
      this.shell.setStatus({ kind: "error", message: error });
    } else if (missing.length > 0) {
      this.shell.setStatus({
        kind: "error",
        message: `unknown signals: ${missing.join(", ")}`,
      });
    }
    return elapsed;
  }

  private renderForMode(
    state: RenderPanelState,
    data: PanelLineResponse | null,
    window: { t0: number; t1: number },
  ): number {
    if (this.gpu === null) {
      this.chartHostElement.hidden = true;
      return 0;
    }
    if (state.series.length === 0) {
      this.chartHostElement.hidden = true;
      return 0;
    }
    if (data === null) {
      this.chartHostElement.hidden = true;
      this.shell.setStatus({ kind: "loading", message: "Loading plot data…" });
      return 0;
    }
    this.chartHostElement.hidden = false;
    this.mount();
    const bySeries = new Map(
      state.series.map((series) => [series.path, series]),
    );
    const family = line2dFamily(data).prepare({
      series: state.series,
      window,
      axisStyle: state.axis_style,
      xLabel: state.x_label,
      yLabel: state.y_label,
    });
    const { plotted } = family;
    this.preparedPlot = family.plot;
    if (plotted.length === 0) {
      this.chartHostElement.hidden = true;
      this.shell.setStatus({
        kind: "empty",
        message: "Choose at least one Y signal.",
      });
      return 0;
    }
    this.shell.setStatus({ kind: "ready" });
    const seriesKey = state.series.map((series) => series.path).join("\u0000");
    const ranges = this.resolvePlotRanges(
      state,
      this.preparedPlot,
      window,
      seriesKey,
    );
    if (ranges === null) return 0;
    const styles: SeriesStroke[] = plotted.map((item) => {
      const series = bySeries.get(item.signalPath);
      return {
        hue: series?.hue ?? null,
        dash: series?.dash ?? "solid",
        width:
          (series?.width ?? DEFAULT_PANEL_LINE_WIDTH) +
          (series?.focused === true ? 1 : 0),
        alpha: series?.opacity ?? 1,
      };
    });
    const emphasisIndices =
      this.emphasizePaths === null
        ? []
        : plotted.flatMap((item, index) =>
            this.emphasizePaths?.has(item.signalPath) ? [index] : [],
          );
    const request: ChartRenderRequest = {
      ...family.makeInput(ranges, styles),
      emphasisIndices,
      palette: resolvePalette(),
    };
    if (this.chartHost === null) {
      this.pendingChartRender = request;
      return 0;
    }
    return this.chartHost.render(request);
  }

  private resolvePlotRanges(
    state: RenderPanelState,
    plot: PreparedPlot,
    window: { t0: number; t1: number },
    seriesKey = "",
  ): { x: Range; y: Range } | null {
    let cached: ReturnType<PreparedPlot["autoRanges"]> | null = null;
    const automatic = (): ReturnType<PreparedPlot["autoRanges"]> =>
      (cached ??= plot.autoRanges());
    const stickyY = plot.interaction.stickyAutoY
      ? this.yAxis.resolve(seriesKey, () => automatic().y, state.y_range)
      : automatic().y;
    return resolveRanges(
      plot.interaction,
      {
        x: state.x_range,
        y: plot.interaction.stickyAutoY ? null : state.y_range,
      },
      {
        x: plot.interaction.xAxis === "linked-time" ? null : automatic().x,
        y: stickyY,
      },
      window,
    );
  }

  invalidateTheme(): void {
    invalidatePalette();
    this.overlayRenderer.invalidateTheme();
    if (this.lastState !== null && this.lastWindow !== null) {
      this.renderForMode(this.lastState, this.lastData, this.lastWindow);
      this.drawOverlay(this.resolvedAnnotations(this.lastState));
    }
  }

  setCursor(cursorT: number | null): void {
    if (this.preparedPlot?.interaction.cursorLink !== "time") return;
    this.localCursor = null;
    this.cursorT = cursorT;
    this.updateLegendValues();
    this.drawOverlay();
  }

  setLocalCursor(cursor: PlotCursor | null): void {
    this.localCursor = cursor;
    this.cursorT = cursor?.x ?? null;
    this.updateLegendValues();
    this.drawOverlay();
  }

  clearCursor(): void {
    this.localCursor = null;
    this.cursorT = null;
    this.updateLegendValues();
    this.drawOverlay();
  }

  setCursorMode(cursorMode: CursorMode): void {
    this.cursorMode = cursorMode;
    this.drawOverlay();
  }

  resetYAxis(): void {
    this.yAxis.reset();
  }

  /** The chart host's rendered CSS width, for density-bounded tile queries. */
  plotWidth(): number {
    return this.chartHostElement.clientWidth;
  }

  plotXRange(): Range | null {
    const range = this.activeLayout()?.xRange;
    return range === undefined ? null : { ...range };
  }

  async capturePlot(): Promise<{
    plot: HTMLCanvasElement;
    overlay: HTMLCanvasElement;
  }> {
    const host = this.chartHost ?? (await this.chartHostReady);
    if (host === null) throw new Error("chart host unavailable");
    return { plot: await host.capture(), overlay: this.overlay };
  }

  dispose(): void {
    this.disposed = true;
    this.axisDropCleanup();
    this.closePanelConfig();
    this.releaseGpu();
    this.interactions.dispose();
    this.shell.dispose();
  }

  releaseGpu(): void {
    this.chartHostGeneration += 1;
    if (this.chartHostRetryTimer !== null) {
      window.clearTimeout(this.chartHostRetryTimer);
      this.chartHostRetryTimer = null;
    }
    this.chartHost?.dispose();
    this.chartHost = null;
    this.chartHostReady = null;
    this.gpu = null;
    this.chartHostElement.hidden = true;
  }

  private activeLayout(): PlotLayout | null {
    return this.chartHost?.layout() ?? null;
  }

  panelRect(): DOMRect {
    return this.element.getBoundingClientRect();
  }

  plotClick(
    offsetX: number,
    offsetY: number,
    modifiers: { alt: boolean; shift: boolean } = {
      alt: false,
      shift: false,
    },
  ): void {
    if (!modifiers.alt && !modifiers.shift) {
      const hit = this.annotationAt(offsetX, offsetY, 14);
      if (hit !== null) {
        this.callbacks.onPinAnnotation(this.id, hit);
        return;
      }
      const path = this.seriesHit(offsetX, offsetY, 6)?.path ?? null;
      const series = this.lastState?.series.find(
        (entry) => entry.path === path,
      );
      if (series !== undefined) {
        this.callbacks.onFocusAdd(this.id, {
          kind: "series",
          ref: series.ref,
          source_key: null,
          channel: series.ref.channel,
        });
      }
      return;
    }
    const hit = this.seriesHit(offsetX, offsetY, 6);
    if (hit !== null) {
      const series = this.lastState?.series.find(
        (entry) => entry.path === hit.path,
      );
      if (series !== undefined) {
        if (modifiers.alt) this.callbacks.onMuteSeries(this.id, series.ref);
        else if (modifiers.shift) {
          this.callbacks.onFocusToggle(this.id, {
            kind: "series",
            ref: series.ref,
            source_key: null,
            channel: series.ref.channel,
          });
        }
        return;
      }
    }
  }

  private seriesHit(
    offsetX: number,
    offsetY: number,
    threshold: number,
  ): { path: string; distance: number } | null {
    const layout = this.activeLayout();
    return layout === null || this.hitAdapter === null
      ? null
      : this.hitAdapter.seriesAt(layout, offsetX, offsetY, threshold);
  }

  private updateHover(offsetX: number, offsetY: number): void {
    const annotationHit = this.overlayRenderer.annotationAt(offsetX, offsetY);
    if (annotationHit !== null) {
      const changed = this.annotationUi.hoveredId !== annotationHit.id;
      this.annotationUi.hoveredId = annotationHit.id;
      this.hoverTip = null;
      this.setEmphasis(annotationHit.path);
      if (changed) {
        this.drawOverlay();
        if (this.lastState !== null) this.updatePlotLegend(this.lastState);
      }
      return;
    }
    const hit = this.seriesHit(offsetX, offsetY, 6);
    if (hit === null) {
      this.clearHover();
      return;
    }
    const layout = this.activeLayout();
    this.annotationUi.hoveredId = null;
    this.hoverTip =
      layout === null
        ? null
        : (this.preparedPlot?.annotationAt(
            layout,
            { x: offsetX, y: offsetY },
            14,
          ) ?? null);
    this.setEmphasis(hit.path);
    this.drawOverlay();
  }

  private clearHover(): void {
    const hadAnnotation = this.annotationUi.hoveredId !== null;
    this.hoverTip = null;
    this.annotationUi.hoveredId = null;
    this.setEmphasis(null);
    if (hadAnnotation && this.lastState !== null)
      this.updatePlotLegend(this.lastState);
    this.drawOverlay();
  }

  private walkHover(direction: -1 | 1): void {
    const state = this.lastState;
    if (state === null) return;
    const values =
      this.localCursor === null
        ? new Map(
            (this.lastTiles?.series ?? []).map((tile) => [
              tile.signalPath,
              this.cursorT === null
                ? null
                : columnsValueAtTime(tile.bins, this.cursorT),
            ]),
          )
        : new Map(
            this.localCursor.rows.map((row) => [row.path, row.value] as const),
          );
    const series = state.series
      .filter((entry) => entry.visible)
      .map((entry, index) => ({
        entry,
        index,
        value: values.get(entry.path),
      }))
      .sort((left, right) => {
        if (left.value === null || left.value === undefined) return 1;
        if (right.value === null || right.value === undefined) return -1;
        return left.value - right.value || left.index - right.index;
      });
    if (series.length === 0) return;
    const current = [...(this.emphasizePaths ?? [])][0];
    const index = series.findIndex((item) => item.entry.path === current);
    const next =
      series[(index === -1 ? (direction === 1 ? -1 : 0) : index) + direction];
    const wrapped = next ?? series[direction === 1 ? 0 : series.length - 1];
    if (wrapped === undefined) return;
    this.setEmphasis(wrapped.entry.path);
  }

  private annotationAt(
    offsetX: number,
    offsetY: number,
    radius: number,
  ): AnnotationAnchor | null {
    const layout = this.activeLayout();
    return layout === null
      ? null
      : (this.preparedPlot?.annotationAt(
          layout,
          { x: offsetX, y: offsetY },
          radius,
        ) ?? null);
  }

  private cursorAt(
    layout: PlotLayout,
    offsetX: number,
    offsetY: number,
    radius: number,
  ): PanelCursor | null {
    return (
      this.preparedPlot?.cursorAt(layout, { x: offsetX, y: offsetY }, radius) ??
      null
    );
  }

  private resolvedAnnotations(state: RenderPanelState): ResolvedAnnotations {
    const prepared = this.preparedPlot;
    if (prepared === null) return { resolved: [] };
    const resolved = state.annotations
      .map((annotation) => prepared.resolveAnnotation(annotation))
      .filter((annotation) => annotation !== null);
    return { resolved };
  }

  private drawOverlay(resolution?: ResolvedAnnotations): void {
    const state = this.lastState;
    const { resolved } =
      resolution ??
      (state === null ? { resolved: [] } : this.resolvedAnnotations(state));
    const bySeries = new Map(
      (state?.series ?? []).map((series) => [series.path, series]),
    );
    const cursorT = this.cursorT;
    const xyMarkers = this.localCursor?.markers ?? [];
    this.overlayRenderer.draw(this.activeLayout(), {
      cursorT,
      cursorMode: this.cursorMode,
      cursorPoints:
        this.localCursor === null &&
        this.cursorMode === "track" &&
        cursorT !== null
          ? this.cursorPointsAt(cursorT, bySeries)
          : [],
      xyMarkers,
      box: this.box,
      annotations: [
        ...resolved.map((annotation) => {
          const series = bySeries.get(annotation.annotation.series_path);
          return {
            id: annotation.annotation.id,
            path: annotation.annotation.series_path,
            x: annotation.x,
            y: annotation.y,
            colorIndex:
              series === undefined
                ? annotation.colorIndex
                : series.hue === null
                  ? null
                  : colorIndexForHue(series.hue),
            label: `${annotation.annotation.label === "" ? "" : `${annotation.annotation.label}  `}${annotation.summary}`,
            focused: series?.focused ?? false,
            selected: this.annotationUi.selectedIds.has(
              annotation.annotation.id,
            ),
            hovered:
              this.annotationUi.hoveredId === annotation.annotation.id ||
              this.emphasizePaths?.has(annotation.annotation.series_path) ===
                true,
            ghosted: series?.display === "ghost" || series?.visible === false,
            ephemeral: false,
            offset: this.annotationUi.offsets.get(annotation.annotation.id) ?? {
              x: annotation.annotation.offset[0],
              y: annotation.annotation.offset[1],
            },
          };
        }),
        ...this.overlayHoverTip(bySeries),
      ],
      annotationMode: state?.annotation_display ?? "labels",
    });
  }

  private overlayHoverTip(
    bySeries: ReadonlyMap<string, RenderSeries>,
  ): OverlayAnnotation[] {
    const tip = this.hoverTip;
    if (tip === null || this.lastState?.annotation_display === "hidden")
      return [];
    const duplicate = this.lastState?.annotations.some(
      (annotation) =>
        annotation.series_path === tip.path && annotation.anchor === tip.anchor,
    );
    if (duplicate === true) return [];
    const series = bySeries.get(tip.path);
    return [
      {
        id: null,
        path: tip.path,
        x: tip.x,
        y: tip.pinnedValue,
        colorIndex:
          series?.hue === null || series === undefined
            ? null
            : colorIndexForHue(series.hue),
        label: `${formatValue(tip.x)} · ${formatValue(tip.pinnedValue)}`,
        focused: false,
        selected: false,
        hovered: false,
        ghosted: series?.display === "ghost",
        ephemeral: true,
      },
    ];
  }

  /** The dots the cursor puts on each series, in that mode's own domain. */
  private cursorPointsAt(
    cursorT: number,
    bySeries: ReadonlyMap<string, RenderSeries>,
  ): CursorPoint[] {
    return (this.lastTiles?.series ?? []).flatMap((tile) => {
      const series = bySeries.get(tile.signalPath);
      if (series?.visible !== true) return [];
      const value = columnsValueAtTime(tile.bins, cursorT);
      if (value === null) return [];
      return [
        {
          value,
          colorIndex: series.hue === null ? null : colorIndexForHue(series.hue),
          alpha: series.opacity,
        },
      ];
    });
  }

  /**
   * Applies an x-axis range: the linked time window in time mode, a
   * panel-local value range everywhere else.
   */
  private applyXRange(min: number, max: number): void {
    const layout = this.activeLayout();
    if (layout !== null) {
      this.chartHost?.setRangesOnly({ min, max }, [
        layout.yRange.min,
        layout.yRange.max,
      ]);
    }
    if (this.preparedPlot?.interaction.xAxis === "linked-time") {
      this.callbacks.onTimeWindow(this.id, min, max);
    } else {
      this.callbacks.onXRange(this.id, [min, max]);
    }
  }

  canEditAxis(axis: "x" | "y"): boolean {
    return axis.length > 0;
  }

  beginAxisEdit(axis: "x" | "y"): void {
    if (!this.canEditAxis(axis)) return;
    const wrap = required<HTMLElement>(this.element, ".plot-wrap");
    if (wrap.querySelector(".axis-label-editor") !== null) return;
    const state = this.lastState;
    const input = document.createElement("input");
    input.className = `axis-label-editor axis-label-editor-${axis}`;
    input.setAttribute(
      "aria-label",
      axis === "x" ? "X axis name" : "Y axis name",
    );
    input.value = (axis === "x" ? state?.x_label : state?.y_label) ?? "";
    input.placeholder = axis === "x" ? "time (s)" : "value";
    let cancelled = false;
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        cancelled = true;
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      const value = input.value.trim();
      input.remove();
      if (!cancelled) {
        this.callbacks.onEditAxisLabel(
          this.id,
          axis,
          value === "" ? null : value,
        );
      }
    });
    wrap.append(input);
    input.focus();
    input.select();
  }

  private updateLegend(state: RenderPanelState): void {
    this.updatePlotLegend(state);
  }

  private updatePlotLegend(state: RenderPanelState): void {
    if (state.focus.length === 0) this.focusOnly = false;
    const legend = required<HTMLElement>(this.element, ".plot-series-legend");
    const wrap = required<HTMLElement>(this.element, ".plot-wrap");
    if (state.series.length === 0) {
      legend.hidden = true;
      legend.replaceChildren();
      delete legend.dataset.state;
      delete legend.dataset.collapsed;
      wrap.classList.remove("legend-dock-preview");
      delete wrap.dataset.legendDockPreview;
      wrap.classList.remove("legend-rail");
      wrap.classList.remove("legend-rail-collapsed");
      delete wrap.dataset.legendDock;
      wrap.style.removeProperty("--plot-legend-rail-width");
      wrap.style.removeProperty("--plot-legend-rail-height");
      return;
    }
    legend.hidden = false;
    legend.classList.toggle("stats-visible", state.show_stats);
    wrap.classList.remove("legend-dock-preview");
    delete wrap.dataset.legendDockPreview;
    legend.dataset.state = state.legend_state;
    wrap.classList.toggle("legend-rail", state.legend_state === "rail");
    this.plotLegendPosition =
      state.legend_position === null
        ? null
        : { x: state.legend_position[0], y: state.legend_position[1] };
    this.plotLegendSize =
      state.legend_size === null
        ? null
        : { width: state.legend_size[0], height: state.legend_size[1] };
    this.plotLegendAnchor = state.legend_anchor;
    this.plotLegendDock = state.legend_dock;

    if (state.legend_state === "badge") {
      const badge = document.createElement("div");
      badge.className = "plot-legend-badge";
      const ghosts = state.series.filter(
        (series) => series.visible && series.display === "ghost",
      ).length;
      const drag = document.createElement("button");
      drag.className = "plot-legend-drag plot-legend-badge-drag";
      drag.type = "button";
      drag.textContent = "⬓";
      drag.title =
        "Drag plot legend to any edge; End docks to the nearest edge";
      this.bindPlotLegendDrag(drag, legend);
      const summary = document.createElement("button");
      summary.className = "plot-legend-badge-summary";
      summary.type = "button";
      summary.innerHTML =
        '<b></b><span aria-hidden="true">·</span><span></span><span class="plot-legend-expand" aria-hidden="true">⌃</span>';
      required<HTMLElement>(summary, "b").textContent = String(
        state.focus.length,
      );
      required<HTMLElement>(summary, "span:nth-of-type(2)").textContent =
        `${String(ghosts)} dimmed`;
      summary.title = "Expand legend keys";
      summary.addEventListener("click", () => {
        this.callbacks.onLegendLayout(this.id, { state: "keys" });
      });
      badge.append(drag, summary);
      legend.replaceChildren(badge);
      this.positionPlotLegend();
      return;
    }

    const header = document.createElement("div");
    header.className = "plot-legend-header";
    if (state.legend_state === "rail") {
      const dock = state.legend_dock ?? "right";
      header.classList.add("plot-legend-rail-header");
      const title = document.createElement("span");
      title.className = "plot-legend-title";
      title.textContent = `${String(state.series.length)} · ${dock} ▾`;
      const undock = document.createElement("button");
      undock.className = "plot-legend-undock";
      undock.type = "button";
      undock.textContent = "⇥";
      undock.title = "Return legend to floating roster";
      undock.addEventListener("click", () => this.floatPlotLegend(legend));
      header.append(title);
      if (state.show_stats) header.append(this.statsScopeLabel());
      header.append(undock);
      legend.replaceChildren(
        header,
        this.plotLegendEncodingRow(state),
        ...this.plotLegendDrawers(state),
        state.show_stats
          ? this.plotLegendStats(state)
          : this.plotLegendRoster(state),
        this.legendResizeHandle(
          dock === "right"
            ? "left"
            : dock === "left"
              ? "right"
              : dock === "top"
                ? "bottom"
                : "top",
          legend,
        ),
      );
      this.positionPlotLegend();
      return;
    }
    const drag = document.createElement("button");
    drag.className = "plot-legend-drag";
    drag.type = "button";
    drag.textContent = "⠿";
    drag.title =
      "Drag plot legend to any edge; arrow keys move it; End docks to the nearest edge";
    this.bindPlotLegendDrag(drag, legend);
    const title = document.createElement("button");
    title.className = "plot-legend-title";
    title.type = "button";
    title.textContent = `${String(state.series.length)}${
      state.legend_state === "roster" ? " series" : ""
    } ▾`;
    title.title =
      state.legend_state === "roster" ? "Show compact keys" : "Show roster";
    title.addEventListener("click", () => {
      this.callbacks.onLegendLayout(this.id, {
        state: state.legend_state === "roster" ? "keys" : "roster",
      });
    });
    const collapse = document.createElement("button");
    collapse.className = "plot-legend-collapse";
    collapse.type = "button";
    collapse.textContent = "⌄";
    collapse.title = "Collapse legend to badge";
    collapse.addEventListener("click", () => {
      this.callbacks.onLegendLayout(this.id, { state: "badge" });
    });
    header.append(drag, title);
    if (state.show_stats) header.append(this.statsScopeLabel());
    header.append(collapse);

    const content = state.show_stats
      ? this.plotLegendStats(state)
      : state.legend_state === "roster"
        ? this.plotLegendRoster(state)
        : this.plotLegendKeys(state);
    const rightResize = this.legendResizeHandle("right", legend);
    const bottomResize = this.legendResizeHandle("bottom", legend);
    const cornerResize = this.legendResizeHandle("corner", legend);
    legend.replaceChildren(
      header,
      this.plotLegendEncodingRow(state),
      ...this.plotLegendDrawers(state),
      content,
      rightResize,
      bottomResize,
      cornerResize,
    );
    this.positionPlotLegend();
  }

  private statsScopeLabel(): HTMLElement {
    const scope = document.createElement("span");
    scope.className = "plot-legend-stats-scope";
    scope.textContent = "Σ visible region";
    scope.title = "Statistics recompute for the visible time region";
    return scope;
  }

  private plotLegendEncodingRow(state: RenderPanelState): HTMLElement {
    const row = document.createElement("div");
    row.className = "plot-legend-encoding";
    for (const property of ["color", "dash", "width"] as const) {
      const dimension =
        property === "color"
          ? state.color_by
          : property === "dash"
            ? state.dash_by
            : state.width_by;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "plot-legend-encoding-chip";
      chip.dataset.property = property;
      chip.setAttribute(
        "aria-expanded",
        String(this.encodingDrawer === property),
      );
      const sample = document.createElement("span");
      sample.className = `encoding-sample encoding-sample-${property}`;
      if (property === "color") sample.style.background = "var(--series-1)";
      if (property === "width") {
        sample.style.height = `${String(Math.max(1, state.line_width))}px`;
      }
      const label = document.createElement("span");
      label.textContent = `${property} ← ${dimension ?? "flat"}`;
      if (property === "width" && dimension === null) {
        label.textContent += ` · ${formatToolbarNumber(state.line_width)}`;
      }
      chip.append(sample, label);
      chip.addEventListener("click", () => {
        this.encodingDrawer =
          this.encodingDrawer === property ? null : property;
        this.overrideDrawer = false;
        this.statsColumnsDrawer = false;
        this.updatePlotLegend(state);
      });
      row.append(chip);
    }
    return row;
  }

  private plotLegendDrawers(state: RenderPanelState): HTMLElement[] {
    const drawers: HTMLElement[] = [];
    if (typeof this.encodingDrawer === "string") {
      drawers.push(this.plotEncodingDrawer(state, this.encodingDrawer));
    }
    if (this.overrideDrawer) drawers.push(this.plotOverrideDrawer());
    if (this.statsColumnsDrawer)
      drawers.push(this.plotStatsColumnsDrawer(state));
    return drawers;
  }

  private plotEncodingDrawer(
    state: RenderPanelState,
    property: EncodingProperty,
  ): HTMLElement {
    const drawer = document.createElement("div");
    drawer.className = "plot-legend-drawer plot-encoding-drawer";
    const title = document.createElement("div");
    title.className = "plot-legend-drawer-title";
    title.textContent = `${property.toUpperCase()} · BIND TO`;
    const choices = document.createElement("div");
    choices.className = "plot-encoding-choices";
    const active =
      property === "color"
        ? state.color_by
        : property === "dash"
          ? state.dash_by
          : state.width_by;
    for (const dimension of [
      null,
      "focus",
      "source",
      "channel",
      "set",
      "attr",
    ] as const) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "plot-encoding-choice";
      choice.classList.toggle("active", active === dimension);
      choice.textContent = dimension ?? "flat";
      choice.addEventListener("click", () => {
        this.encodingDrawer = null;
        this.callbacks.onSetEncoding(this.id, property, dimension);
      });
      choices.append(choice);
    }
    drawer.append(title, choices);
    if (property === "color") {
      const palette = document.createElement("div");
      palette.className = "plot-encoding-palette";
      for (let slot = 1; slot <= COLOR_SLOTS; slot += 1) {
        const swatch = document.createElement("span");
        swatch.style.background = `var(--series-${String(slot)})`;
        palette.append(swatch);
      }
      const count =
        active === null
          ? 1
          : encodingValueCount(state, active, this.callbacks.catalog());
      const note = document.createElement("div");
      note.className = "plot-encoding-note";
      note.textContent = `${String(count)} ${count === 1 ? "value" : "values"} → ${String(COLOR_SLOTS)} slots${count > COLOR_SLOTS ? " · repeats disclosed" : ""}`;
      drawer.append(palette, note);
    }
    return drawer;
  }

  private plotLegendKeys(state: RenderPanelState): HTMLElement {
    const content = document.createElement("div");
    content.className = "plot-legend-content plot-legend-keys";
    const all = seriesLegendRows(this.callbacks.catalog(), state);
    const shown = this.focusOnly ? all.filter((row) => row.focused) : all;
    const title = this.plotLegendGroupTitle(
      state,
      shown.length,
      all.filter((row) => row.focused).length,
    );
    title.className = "plot-legend-section-title plot-legend-group-title";
    const rows = document.createElement("div");
    rows.className = "plot-legend-key-rows";
    rows.hidden = !this.signalsExpanded;
    rows.append(
      ...shown.map((row) => this.plotLegendSeriesRow(state, row, shown)),
    );
    rows.addEventListener("click", (event) => {
      if (event.target === rows) this.callbacks.onClearFocus(this.id);
    });
    const ghosts = state.series.filter(
      (series) => series.visible && series.display === "ghost",
    ).length;
    const footer = this.plotLegendFooter(state, ghosts, () => {
      this.callbacks.onLegendLayout(this.id, { state: "roster" });
    });
    content.append(title, rows, this.plotLegendTips(state), footer);
    if (
      state.focus.length === 0 &&
      ghosts > 0 &&
      !state.legend_hint_dismissed
    ) {
      const hint = document.createElement("button");
      hint.className = "plot-legend-hint";
      hint.type = "button";
      hint.textContent = "hover a dimmed line to explore · click to focus  ×";
      hint.title = "Dismiss hint";
      hint.addEventListener("click", () => {
        this.callbacks.onLegendLayout(this.id, { hintDismissed: true });
      });
      content.append(hint);
    }
    return content;
  }

  private plotLegendGroupTitle(
    state: RenderPanelState,
    count: number,
    focusedCount: number,
  ): HTMLElement {
    const title = document.createElement("div");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "plot-legend-signals-toggle";
    toggle.textContent = `${this.signalsExpanded ? "▾" : "▸"} SIGNALS`;
    toggle.setAttribute("aria-expanded", String(this.signalsExpanded));
    toggle.addEventListener("click", () => {
      this.signalsExpanded = !this.signalsExpanded;
      this.updatePlotLegend(state);
    });
    const focus = document.createElement("button");
    focus.type = "button";
    focus.className = "plot-legend-focus-filter";
    focus.textContent = this.focusOnly
      ? `focus only ✓ · ${String(count)}/${String(state.series.length)}`
      : `${String(focusedCount)} focused ⤴`;
    focus.hidden = focusedCount === 0;
    focus.title = this.focusOnly
      ? "Show all legend rows"
      : "Show focused rows only";
    focus.addEventListener("click", () => {
      this.focusOnly = !this.focusOnly;
      this.updatePlotLegend(state);
    });
    const total = document.createElement("span");
    total.textContent = String(count);
    title.append(toggle, focus, total);
    return title;
  }

  private plotLegendSeriesRow(
    state: RenderPanelState,
    item: SeriesLegendRow,
    selectionRows: readonly SeriesLegendRow[],
  ): HTMLElement {
    const block = document.createElement("div");
    block.className = "plot-legend-row-block plot-legend-series-block";
    const row = document.createElement("div");
    row.className = "plot-legend-roster-row";
    row.classList.toggle("focused", item.focused);
    row.classList.toggle(
      "ghosted",
      item.series.display === "ghost" && !item.focused,
    );
    const series = item.series;
    row.dataset.paths = JSON.stringify([series.path]);
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "plot-legend-swatch plot-row-inspector-toggle";
    swatch.style.setProperty("--plot-row-swatch-color", seriesColor(series));
    swatch.style.setProperty(
      "--plot-row-swatch-width",
      `${String(series.width + (series.focused ? 1 : 0))}px`,
    );
    swatch.title = `Edit ${series.path} line properties`;
    swatch.setAttribute(
      "aria-expanded",
      String(this.inspectorPath === series.path),
    );
    swatch.addEventListener("click", () => {
      this.toggleInlineInspector(state, series.path);
    });
    const action = document.createElement("button");
    action.type = "button";
    action.className = "plot-legend-roster-action";
    const label = document.createElement("span");
    label.className = "plot-legend-label";
    label.textContent = `${series.overridden ? "▍ " : ""}${series.path}`;
    action.append(label);
    action.addEventListener("mouseenter", () => this.setEmphasis(series.path));
    action.addEventListener("mouseleave", () => this.setEmphasis(null));
    action.addEventListener("click", (event) => {
      if (event.altKey) this.callbacks.onMuteSeries(this.id, series.ref);
      else
        this.selectFocusRows(
          event,
          "legend",
          item.value,
          selectionRows,
          (row) => row.value,
          (row) => this.focusEntryForSeries(row.series),
        );
    });
    action.title = `Add ${series.path} to focus; Shift-click selects a range; Command/Ctrl-click toggles; Option-click mutes`;
    row.append(swatch, action);
    block.append(row);
    if (this.inspectorPath === series.path) {
      block.append(this.inlineSeriesInspector(state, series));
    }
    return block;
  }

  private plotLegendRoster(state: RenderPanelState): HTMLElement {
    const content = document.createElement("div");
    content.className = "plot-legend-content plot-legend-roster";
    const searchWrap = document.createElement("div");
    searchWrap.className = "plot-legend-search-wrap search-wrap";
    const searchRow = document.createElement("div");
    searchRow.className = "search-filter-row";
    const searchPrefix = document.createElement("span");
    searchPrefix.className = "search-filter-prefix";
    searchPrefix.textContent = "/";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "plot-legend-search signal-search";
    search.placeholder = "selector";
    search.setAttribute("aria-label", "Filter panel roster");
    const searchMeta = document.createElement("div");
    searchMeta.className = "plot-legend-search-meta search-count";
    searchRow.append(searchPrefix, search);
    searchWrap.append(searchRow, searchMeta);
    searchWrap.hidden = !this.signalsExpanded;
    const group = document.createElement("div");
    group.className = "plot-legend-group";
    group.classList.toggle("collapsed", !this.signalsExpanded);
    const groupTitle = document.createElement("div");
    groupTitle.className = "plot-legend-section-title plot-legend-group-title";
    const rows = document.createElement("div");
    rows.className = "plot-legend-roster-rows";
    rows.hidden = !this.signalsExpanded;
    const viewport = document.createElement("div");
    viewport.className = "plot-legend-roster-viewport";
    rows.addEventListener("click", (event) => {
      if (event.target === rows || event.target === viewport)
        this.callbacks.onClearFocus(this.id);
    });
    const renderRows = (): void => {
      const all = seriesLegendRows(
        this.callbacks.catalog(),
        state,
        search.value,
      );
      const shown = this.focusOnly ? all.filter((item) => item.focused) : all;
      groupTitle.replaceChildren(
        ...this.plotLegendGroupTitle(
          state,
          shown.length,
          all.filter((item) => item.focused).length,
        ).childNodes,
      );
      searchMeta.textContent = `${String(shown.length)} match · ⏎ focus · ⌥⏎ mute`;
      if (typeof this.inspectorPath === "string") {
        viewport.style.height = "auto";
        viewport.replaceChildren(
          ...shown.map((item) => this.plotLegendSeriesRow(state, item, shown)),
        );
        return;
      }
      const slice = virtualSlice(
        shown.length,
        rows.scrollTop,
        rows.clientHeight || 168,
        24,
      );
      viewport.style.height = `${String(slice.totalHeight)}px`;
      viewport.replaceChildren(
        ...shown.slice(slice.start, slice.end).map((item, offset) => {
          const block = this.plotLegendSeriesRow(state, item, shown);
          block.classList.add("virtual");
          block.style.top = `${String(slice.topPadding + offset * 24)}px`;
          return block;
        }),
      );
    };
    search.addEventListener("input", () => {
      rows.scrollTop = 0;
      renderRows();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const first = seriesLegendRows(
        this.callbacks.catalog(),
        state,
        search.value,
      )[0];
      if (first === undefined) return;
      event.preventDefault();
      if (event.altKey) this.callbacks.onMuteSeries(this.id, first.series.ref);
      else if (event.metaKey || event.ctrlKey)
        this.callbacks.onFocusToggle(
          this.id,
          this.focusEntryForSeries(first.series),
        );
      else
        this.callbacks.onFocusAdd(
          this.id,
          this.focusEntryForSeries(first.series),
        );
    });
    rows.addEventListener("scroll", renderRows);
    rows.append(viewport);
    group.append(groupTitle, rows);
    const ghosts = state.series.filter(
      (series) => series.visible && series.display === "ghost",
    ).length;
    const footer = this.plotLegendFooter(state, ghosts, () => {
      search.value = "";
      search.focus();
      renderRows();
    });
    content.append(searchWrap, group, this.plotLegendTips(state), footer);
    renderRows();
    return content;
  }

  private plotLegendTips(state: RenderPanelState): HTMLElement {
    const section = document.createElement("section");
    section.className = "plot-legend-tips";
    const heading = document.createElement("div");
    heading.className = "plot-legend-tips-heading";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = `${this.annotationUi.expanded ? "▾" : "▸"} TIPS`;
    toggle.setAttribute("aria-expanded", String(this.annotationUi.expanded));
    toggle.addEventListener("click", () => {
      this.annotationUi.expanded = !this.annotationUi.expanded;
      this.updatePlotLegend(state);
    });
    const count = document.createElement("span");
    count.textContent = String(state.annotations.length);
    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "plot-tip-export";
    exportButton.textContent = "⤓ csv";
    exportButton.title = "Export pinned tips as CSV";
    exportButton.addEventListener("click", () => this.exportAnnotations(state));
    heading.append(toggle, count, exportButton);
    section.append(heading);
    if (!this.annotationUi.expanded || state.annotations.length === 0)
      return section;

    heading.classList.add("resizable");
    heading.tabIndex = 0;
    heading.setAttribute("role", "group");
    heading.setAttribute("aria-label", "Tips controls and resize handle");
    heading.title = "Drag vertically to resize tips; use Up and Down arrows";

    const columns = document.createElement("div");
    columns.className = "plot-tip-columns";
    columns.innerHTML =
      '<span></span><span>SERIES</span><span class="plot-tip-x">x ↓</span><span class="plot-tip-value">value</span><span class="plot-tip-reading">x · value</span><span></span>';
    const body = document.createElement("div");
    body.className = "plot-tip-rows";
    const byPath = new Map(state.series.map((series) => [series.path, series]));
    const annotations = [...state.annotations].sort(
      (left, right) =>
        (right.pinned_x ?? right.anchor) - (left.pinned_x ?? left.anchor),
    );
    for (const annotation of annotations) {
      const series = byPath.get(annotation.series_path);
      const row = document.createElement("div");
      row.className = "plot-tip-row";
      row.dataset.paths = JSON.stringify([annotation.series_path]);
      row.classList.toggle("focused", series?.focused ?? false);
      row.classList.toggle(
        "selected",
        this.annotationUi.selectedIds.has(annotation.id),
      );
      row.classList.toggle(
        "ghosted",
        series?.display === "ghost" || series?.visible === false,
      );
      row.classList.toggle(
        "hovered",
        this.annotationUi.hoveredId === annotation.id,
      );
      const rule = document.createElement("span");
      rule.className = "plot-tip-rule";
      rule.style.background =
        series === undefined ? "var(--fg-4)" : seriesColor(series);
      const name = document.createElement("button");
      name.type = "button";
      name.className = "plot-tip-name";
      name.textContent =
        this.callbacks.localPathFor(annotation.series_path) ??
        annotation.series_path;
      name.title = annotation.series_path;
      name.addEventListener("click", (event) => {
        this.selectAnnotation(
          annotation.id,
          event.metaKey || event.ctrlKey || event.shiftKey,
        );
      });
      const x = document.createElement("span");
      x.className = "plot-tip-x";
      const plottedX = annotation.pinned_x ?? annotation.anchor;
      x.textContent = formatValue(plottedX);
      const value = document.createElement("span");
      value.className = "plot-tip-value";
      value.textContent = formatValue(annotation.pinned_value);
      const reading = document.createElement("span");
      reading.className = "plot-tip-reading";
      reading.textContent = `${formatValue(plottedX)} · ${formatValue(annotation.pinned_value)}`;
      const actions = document.createElement("span");
      actions.className = "plot-tip-actions";
      const locate = document.createElement("button");
      locate.type = "button";
      locate.textContent = "⌖";
      locate.title = "Pan to tip";
      locate.addEventListener("click", () =>
        this.panToAnnotation(annotation.pinned_x ?? annotation.anchor),
      );
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "✕";
      remove.title = "Delete tip";
      remove.addEventListener("click", () => {
        this.callbacks.onRemoveAnnotation(this.id, annotation.id);
      });
      actions.append(locate, remove);
      row.append(rule, name, x, value, reading, actions);
      row.addEventListener("click", (event) => {
        if (event.target instanceof HTMLButtonElement) return;
        this.selectAnnotation(
          annotation.id,
          event.metaKey || event.ctrlKey || event.shiftKey,
        );
      });
      row.addEventListener("mouseenter", () => {
        this.annotationUi.hoveredId = annotation.id;
        this.setEmphasis(annotation.series_path);
        this.drawOverlay();
      });
      row.addEventListener("mouseleave", () => {
        this.annotationUi.hoveredId = null;
        this.setEmphasis(null);
        this.drawOverlay();
      });
      body.append(row);
    }
    section.append(columns, body);
    if (this.annotationUi.tipsHeight !== null)
      section.style.height = `${String(this.annotationUi.tipsHeight)}px`;
    this.bindPlotTipsResize(heading, section);
    return section;
  }

  private bindPlotTipsResize(handle: HTMLElement, section: HTMLElement): void {
    const resize = (height: number): void => {
      const parentHeight =
        section.parentElement?.getBoundingClientRect().height ?? height;
      const next = clamp(height, 22, Math.max(22, parentHeight * 0.75));
      this.annotationUi.tipsHeight = next;
      section.style.height = `${String(next)}px`;
    };
    handle.addEventListener("keydown", (event) => {
      if (event.target !== handle) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const step = event.shiftKey ? 48 : 16;
      const height = section.getBoundingClientRect().height;
      resize(height + (event.key === "ArrowUp" ? step : -step));
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (
        event.target instanceof Element &&
        event.target.closest("button") !== null
      )
        return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = section.getBoundingClientRect().height;
      const move = (next: PointerEvent): void => {
        if (next.pointerId !== event.pointerId) return;
        resize(startHeight + startY - next.clientY);
      };
      const end = (next: PointerEvent): void => {
        if (next.pointerId !== event.pointerId) return;
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        document.removeEventListener("pointercancel", end);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end);
      document.addEventListener("pointercancel", end);
    });
  }

  private panToAnnotation(anchor: number): void {
    const range = this.activeLayout()?.xRange;
    if (range === undefined) return;
    const span = range.max - range.min;
    this.applyXRange(anchor - span / 2, anchor + span / 2);
  }

  private exportAnnotations(state: RenderPanelState): void {
    const selected =
      this.annotationUi.selectedIds.size === 0
        ? state.annotations
        : state.annotations.filter((annotation) =>
            this.annotationUi.selectedIds.has(annotation.id),
          );
    const lines = [
      "series,x,value,label",
      ...[...selected]
        .sort(
          (left, right) =>
            (right.pinned_x ?? right.anchor) - (left.pinned_x ?? left.anchor),
        )
        .map((annotation) =>
          [
            annotation.series_path,
            String(annotation.pinned_x ?? annotation.anchor),
            String(annotation.pinned_value),
            annotation.label,
          ]
            .map(csvCell)
            .join(","),
        ),
    ];
    downloadText(`${safeFilename(state.title)}-tips.csv`, lines.join("\n"));
  }

  private plotLegendFooter(
    state: RenderPanelState,
    ghosts: number,
    showGhosts: () => void,
    exportStats = false,
  ): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "plot-legend-footer";
    const ghostButton = document.createElement("button");
    ghostButton.type = "button";
    ghostButton.textContent = `${String(ghosts)} dimmed ▾`;
    ghostButton.addEventListener("click", showGhosts);
    footer.append(ghostButton);
    if (exportStats) {
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "plot-legend-stats-export";
      exportButton.textContent = "⤓ csv";
      exportButton.title = "Export visible statistic columns as CSV";
      exportButton.addEventListener("click", () =>
        this.exportLegendStats(state),
      );
      footer.append(exportButton);
    }
    const overrides = this.styleOverrides();
    const overrideButton = document.createElement("button");
    overrideButton.type = "button";
    overrideButton.className = "plot-legend-overrides";
    overrideButton.classList.toggle("active", overrides.length > 0);
    overrideButton.textContent = `${String(overrides.length)} ${overrides.length === 1 ? "override" : "overrides"} ▾`;
    overrideButton.addEventListener("click", () => {
      this.overrideDrawer = !this.overrideDrawer;
      this.encodingDrawer = null;
      this.statsColumnsDrawer = false;
      this.updatePlotLegend(state);
    });
    footer.append(overrideButton);
    return footer;
  }

  private styleOverrides(): ReturnType<typeof appliedOverrides> {
    const input = this.lastInputState;
    if (
      !input?.overrides.some((override) =>
        [override.color_slot, override.dash, override.width].some(
          (value) => value !== null,
        ),
      )
    ) {
      return [];
    }
    return appliedOverrides(
      this.callbacks.catalog(),
      input,
      this.callbacks.namedSets(),
    ).filter(({ override }) =>
      [override.color_slot, override.dash, override.width].some(
        (value) => value !== null,
      ),
    );
  }

  private plotOverrideDrawer(): HTMLElement {
    const drawer = document.createElement("div");
    drawer.className = "plot-legend-drawer plot-override-drawer";
    const overrides = this.styleOverrides();
    const heading = document.createElement("div");
    heading.className = "plot-legend-drawer-title";
    heading.textContent = `${String(overrides.length)} ${overrides.length === 1 ? "OVERRIDE" : "OVERRIDES"}`;
    const revertAll = document.createElement("button");
    revertAll.type = "button";
    revertAll.textContent = "⟲ revert all";
    revertAll.disabled = overrides.length === 0;
    revertAll.addEventListener("click", () => {
      this.callbacks.onClearOverrides(this.id);
      this.overrideDrawer = false;
    });
    const titleRow = document.createElement("div");
    titleRow.className = "plot-override-heading";
    titleRow.append(heading, revertAll);
    drawer.append(titleRow);
    for (const item of overrides) {
      const row = document.createElement("div");
      row.className = "plot-override-row";
      const target = document.createElement("span");
      target.textContent = overrideTarget(item.override, this.callbacks);
      target.title = target.textContent;
      const fields = document.createElement("span");
      fields.textContent = overrideFields(item.override);
      const revert = document.createElement("button");
      revert.type = "button";
      revert.textContent = "⟲";
      revert.title = `Revert ${target.textContent}`;
      revert.addEventListener("click", () => {
        this.callbacks.onRevertStyleOverride(this.id, item.index);
      });
      row.append(target, fields, revert);
      drawer.append(row);
    }
    return drawer;
  }

  private plotStatsColumnsDrawer(state: RenderPanelState): HTMLElement {
    const drawer = document.createElement("div");
    drawer.className = "plot-legend-drawer plot-stats-columns-drawer";
    const title = document.createElement("div");
    title.className = "plot-legend-drawer-title";
    title.textContent = "STAT COLUMNS · VISIBLE REGION";
    drawer.append(title);
    for (const column of [
      "min",
      "max",
      "mean",
      "rms",
      "n",
      "cursor",
    ] as const satisfies readonly StatColumn[]) {
      const button = document.createElement("button");
      button.type = "button";
      const active = state.stat_columns.includes(column);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = `${active ? "✓ " : "  "}${statColumnLabel(column)}`;
      button.addEventListener("click", () => {
        const columns = active
          ? state.stat_columns.filter((entry) => entry !== column)
          : [...state.stat_columns, column];
        if (columns.length > 0)
          this.callbacks.onSetStatColumns(this.id, columns);
      });
      drawer.append(button);
    }
    return drawer;
  }

  private plotLegendStats(state: RenderPanelState): HTMLElement {
    const content = document.createElement("div");
    content.className = "plot-legend-content plot-legend-stats";
    const columns = this.visibleStatColumns(state);
    const { units, mixedUnits, sharedUnit } = this.legendStatUnits(state);
    const grid = statGridTemplate(columns.length);
    const header = document.createElement("div");
    header.className = "plot-stat-header";
    header.style.gridTemplateColumns = grid;
    const seriesHeader = document.createElement("span");
    seriesHeader.className = "plot-stat-series-header";
    seriesHeader.textContent = "SERIES";
    const picker = document.createElement("button");
    picker.type = "button";
    picker.className = "plot-stat-column-picker";
    picker.textContent = "⊞▾";
    picker.title = "Choose statistic columns";
    picker.setAttribute("aria-expanded", String(this.statsColumnsDrawer));
    picker.addEventListener("click", () => {
      this.statsColumnsDrawer = !this.statsColumnsDrawer;
      this.encodingDrawer = null;
      this.overrideDrawer = false;
      this.updatePlotLegend(state);
    });
    seriesHeader.append(picker);
    header.append(seriesHeader);
    const spanHeader = document.createElement("span");
    spanHeader.className = "plot-stat-span-header";
    spanHeader.setAttribute("aria-label", "Minimum to maximum span");
    header.append(spanHeader);
    for (const column of columns) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "plot-stat-sort";
      button.dataset.column = column;
      const sorted = state.stats_sort === column;
      const sortable = column === "n" || !mixedUnits;
      button.classList.toggle("active", sorted);
      button.disabled = !sortable;
      button.title = sortable
        ? `Sort by ${statColumnLabel(column)}`
        : "Sorting is unavailable because these series have mixed units";
      button.textContent = `${statColumnLabel(column, column === "n" ? null : sharedUnit)}${sorted ? (state.stats_sort_descending ? " ↓" : " ↑") : ""}`;
      button.addEventListener("click", () => {
        const descending =
          state.stats_sort === column ? !state.stats_sort_descending : true;
        this.callbacks.onSetStatsSort(this.id, column, descending);
      });
      header.append(button);
    }

    const values = this.legendStatsByPath();
    const rows = state.series.map((series, index) => ({
      series,
      index,
      values: values.get(series.path) ?? emptyLegendStats(),
    }));
    if (
      state.stats_sort !== null &&
      (state.stats_sort === "n" || !mixedUnits)
    ) {
      const column = state.stats_sort;
      const direction = state.stats_sort_descending ? -1 : 1;
      rows.sort((left, right) => {
        const a = left.values[column];
        const b = right.values[column];
        if (a === null && b === null) return left.index - right.index;
        if (a === null) return 1;
        if (b === null) return -1;
        return a === b ? left.index - right.index : (a - b) * direction;
      });
    }
    const aggregate = aggregateLegendStats(
      rows.map((row) => row.values),
      mixedUnits,
    );
    const spanDomain = mixedUnits
      ? null
      : statSpanDomain(rows.map((row) => row.values));
    const aggregateRow = document.createElement("div");
    aggregateRow.className = "plot-stat-row plot-stat-aggregate";
    aggregateRow.style.gridTemplateColumns = grid;
    const aggregateLabel = document.createElement("span");
    aggregateLabel.textContent = `∑ ${String(rows.length)} series`;
    aggregateRow.append(
      aggregateLabel,
      statHistogram(
        mixedUnits && state.stats_sort !== "n"
          ? []
          : rows.map((row) => row.values[state.stats_sort ?? "mean"]),
      ),
    );
    for (const column of columns) {
      aggregateRow.append(statCell(aggregate[column], column));
    }

    const body = document.createElement("div");
    body.className = "plot-stat-body";
    body.addEventListener("click", (event) => {
      if (event.target === body) this.callbacks.onClearFocus(this.id);
    });
    for (const row of rows) {
      const element = document.createElement("div");
      element.className = "plot-stat-row";
      element.dataset.paths = JSON.stringify([row.series.path]);
      element.classList.toggle("muted", !row.series.visible);
      element.classList.toggle("focused", row.series.focused);
      element.classList.toggle("overridden", row.series.overridden);
      element.style.gridTemplateColumns = grid;
      const identity = document.createElement("span");
      identity.className = "plot-stat-identity";
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "plot-legend-swatch plot-row-inspector-toggle";
      swatch.style.setProperty(
        "--plot-row-swatch-color",
        seriesColor(row.series),
      );
      swatch.style.setProperty(
        "--plot-row-swatch-width",
        `${String(Math.max(1, row.series.width + (row.series.focused ? 1 : 0)))}px`,
      );
      swatch.title = `Edit ${row.series.path} line properties`;
      swatch.setAttribute(
        "aria-expanded",
        String(this.inspectorPath === row.series.path),
      );
      swatch.addEventListener("click", () => {
        this.toggleInlineInspector(state, row.series.path);
      });
      const label = document.createElement("button");
      label.type = "button";
      label.className = "plot-stat-label";
      label.textContent = row.series.path;
      if (row.series.overridden) {
        const marker = document.createElement("span");
        marker.className = "plot-row-override-marker";
        marker.textContent = "▍";
        label.append(marker);
      }
      label.addEventListener("mouseenter", () =>
        this.setEmphasis(row.series.path),
      );
      label.addEventListener("mouseleave", () => this.setEmphasis(null));
      label.addEventListener("click", (event) => {
        if (event.altKey) this.callbacks.onMuteSeries(this.id, row.series.ref);
        else
          this.selectFocusRows(
            event,
            "stats",
            row.series.path,
            rows,
            (entry) => entry.series.path,
            (entry) => ({
              kind: "series",
              ref: entry.series.ref,
              source_key: null,
              channel: entry.series.ref.channel,
            }),
          );
      });
      identity.append(swatch, label);
      element.append(
        identity,
        statSpan(row.values, spanDomain, seriesColor(row.series)),
      );
      for (const column of columns) {
        const cell = statCell(
          row.values[column],
          column,
          mixedUnits && column !== "n" ? units.get(row.series.path) : null,
        );
        if (column === "cursor") cell.dataset.path = row.series.path;
        element.append(cell);
      }
      body.append(element);
      if (this.inspectorPath === row.series.path) {
        body.append(this.inlineSeriesInspector(state, row.series));
      }
    }
    const ghosts = state.series.filter(
      (series) => series.visible && series.display === "ghost",
    ).length;
    content.append(
      header,
      aggregateRow,
      body,
      this.plotLegendTips(state),
      this.plotLegendFooter(
        state,
        ghosts,
        () => {
          this.callbacks.onLegendLayout(this.id, { state: "roster" });
        },
        true,
      ),
    );
    return content;
  }

  private legendStatsByPath(): Map<string, LegendStatValues> {
    const values = new Map<string, LegendStatValues>();
    for (const group of this.preparedPlot?.stats() ?? []) {
      const row = emptyLegendStats();
      for (const item of group.items) {
        if (item.label === "min") row.min = item.value;
        else if (item.label === "max") row.max = item.value;
        else if (item.label === "mean") row.mean = item.value;
        else if (item.label === "rms") row.rms = item.value;
        else if (item.label === "n") row.n = item.value;
      }
      row.cursor = this.valueAtCursor(group.label);
      values.set(group.label, row);
    }
    return values;
  }

  private valueAtCursor(path: string): number | null {
    const local = this.localCursor?.rows.find((row) => row.path === path);
    if (local !== undefined) return local.value;
    const tile = this.lastTiles?.series.find(
      (series) => series.signalPath === path,
    );
    return tile === undefined || this.cursorT === null
      ? null
      : columnsValueAtTime(tile.bins, this.cursorT);
  }

  private exportLegendStats(state: RenderPanelState): void {
    const values = this.legendStatsByPath();
    const columns = this.visibleStatColumns(state);
    const { units, mixedUnits, sharedUnit } = this.legendStatUnits(state);
    const lines = [
      [
        "series",
        ...columns.map((column) =>
          statColumnLabel(column, column === "n" ? null : sharedUnit),
        ),
      ]
        .map(csvCell)
        .join(","),
      ...state.series.map((series) => {
        const row = values.get(series.path) ?? emptyLegendStats();
        return [
          series.path,
          ...columns.map((column) => {
            if (row[column] === null) return "";
            const unit =
              mixedUnits && column !== "n"
                ? (units.get(series.path) ?? null)
                : null;
            return `${String(row[column])}${unit === null ? "" : ` ${unit}`}`;
          }),
        ]
          .map(csvCell)
          .join(",");
      }),
    ];
    downloadText(
      `${safeFilename(state.title)}-visible-stats.csv`,
      lines.join("\n"),
    );
  }

  private visibleStatColumns(state: RenderPanelState): StatColumn[] {
    const width = required<HTMLElement>(
      this.element,
      ".plot-series-legend",
    ).clientWidth;
    if (width === 0) return state.stat_columns;
    const capacity = Math.max(1, Math.floor((width - 184) / 64));
    if (capacity >= state.stat_columns.length) return state.stat_columns;
    const retained = state.stat_columns.slice(0, capacity);
    const sorted = state.stats_sort;
    if (
      sorted !== null &&
      state.stat_columns.includes(sorted) &&
      !retained.includes(sorted)
    ) {
      retained[retained.length - 1] = sorted;
    }
    return state.stat_columns.filter((column) => retained.includes(column));
  }

  private legendStatUnits(state: RenderPanelState): {
    units: Map<string, string | null>;
    mixedUnits: boolean;
    sharedUnit: string | null;
  } {
    const units = new Map(
      state.series.map((series) => [
        series.path,
        this.callbacks.catalog().get(series.ref)?.summary.unit ?? null,
      ]),
    );
    const distinctUnits = new Set(units.values());
    const mixedUnits = distinctUnits.size > 1;
    const sharedUnit =
      distinctUnits.size === 1
        ? (distinctUnits.values().next().value ?? null)
        : null;
    return { units, mixedUnits, sharedUnit };
  }

  private updateLegendValue(value: HTMLElement): void {
    const path = value.dataset.path;
    value.textContent = formatValue(this.valueAtCursor(path ?? ""));
  }

  private updateLegendValues(): void {
    for (const cell of this.element.querySelectorAll<HTMLElement>(
      '.plot-stat-cell[data-column="cursor"][data-path]',
    )) {
      setStatCellValue(
        cell,
        this.valueAtCursor(cell.dataset.path ?? ""),
        cell.dataset.unit ?? null,
      );
    }
    for (const value of this.element.querySelectorAll<HTMLElement>(
      ".plot-legend-value",
    )) {
      this.updateLegendValue(value);
    }
  }

  private legendRailHost(): LegendRailHost {
    const getPosition = (): { x: number; y: number } | null =>
      this.plotLegendPosition;
    const setPosition = (value: { x: number; y: number } | null): void => {
      this.plotLegendPosition = value;
    };
    const getSize = (): { width: number; height: number } | null =>
      this.plotLegendSize;
    const setSize = (value: { width: number; height: number } | null): void => {
      this.plotLegendSize = value;
    };
    const getAnchor = (): LegendAnchor | null => this.plotLegendAnchor;
    const setAnchor = (value: LegendAnchor | null): void => {
      this.plotLegendAnchor = value;
    };
    const getDock = (): LegendDock | null => this.plotLegendDock;
    const setDock = (value: LegendDock | null): void => {
      this.plotLegendDock = value;
    };
    return {
      id: this.id,
      root: this.element,
      get position() {
        return getPosition();
      },
      set position(value) {
        setPosition(value);
      },
      get size() {
        return getSize();
      },
      set size(value) {
        setSize(value);
      },
      get anchor() {
        return getAnchor();
      },
      set anchor(value) {
        setAnchor(value);
      },
      get dock() {
        return getDock();
      },
      set dock(value) {
        setDock(value);
      },
      commit: (layout) => this.callbacks.onLegendLayout(this.id, layout),
      refresh: () => this.refreshPlotLegendRoster(),
    };
  }

  private legendResizeHandle(
    edge: "left" | "right" | "top" | "bottom" | "corner",
    legend: HTMLElement,
  ): HTMLButtonElement {
    return legendResizeHandle(this.legendRailHost(), edge, legend);
  }

  private bindPlotLegendDrag(
    handle: HTMLButtonElement,
    legend: HTMLElement,
  ): void {
    bindLegendDrag(this.legendRailHost(), handle, legend);
  }

  private floatPlotLegend(legend: HTMLElement): void {
    floatLegend(this.legendRailHost(), legend);
  }

  private positionPlotLegend(): void {
    positionLegend(this.legendRailHost());
  }

  private refreshPlotLegendRoster(): void {
    this.element
      .querySelector<HTMLElement>(".plot-legend-roster-rows")
      ?.dispatchEvent(new Event("scroll"));
    this.updateEmphasisChrome();
  }
  private updateBindings(state: RenderPanelState): void {
    const container = required(this.element, ".panel-bindings");
    container.replaceChildren();
    for (const entry of bindingChipEntries(
      this.callbacks.catalog(),
      state,
      this.callbacks.namedSets(),
    )) {
      const chip = document.createElement("button");
      chip.className = "binding-chip";
      chip.type = "button";
      chip.textContent = entry.label;
      chip.title = "Show binding members";
      chip.addEventListener("click", (event) => {
        this.openBindingPopover(entry, event.currentTarget as HTMLElement);
      });
      container.append(chip);
    }
  }

  private setEmphasis(paths: readonly string[] | string | null): void {
    const next =
      paths === null
        ? null
        : new Set(typeof paths === "string" ? [paths] : paths);
    if (setsEqual(this.emphasizePaths, next)) return;
    this.emphasizePaths = next;
    this.updateEmphasisChrome();
    if (this.lastState !== null && this.lastWindow !== null) {
      this.renderForMode(this.lastState, this.lastData, this.lastWindow);
      this.drawOverlay(this.resolvedAnnotations(this.lastState));
    }
  }

  private updateEmphasisChrome(): void {
    for (const row of this.element.querySelectorAll<HTMLElement>(
      "[data-paths]",
    )) {
      let paths: string[] = [];
      try {
        const value: unknown = JSON.parse(row.dataset.paths ?? "[]");
        if (Array.isArray(value))
          paths = value.filter(
            (path): path is string => typeof path === "string",
          );
      } catch {
        paths = [];
      }
      row.classList.toggle(
        "cross-highlight",
        this.emphasizePaths !== null &&
          paths.some((path) => this.emphasizePaths?.has(path) === true),
      );
    }
  }

  private focusEntryForSeries(series: RenderSeries): FocusEntry {
    return {
      kind: "series",
      ref: series.ref,
      source_key: null,
      channel: series.ref.channel,
    };
  }

  private selectFocusRows<T>(
    event: MouseEvent,
    scope: string,
    value: string,
    rows: readonly T[],
    rowValue: (row: T) => string,
    focusEntry: (row: T) => FocusEntry,
  ): void {
    if (event.shiftKey) {
      const target = rows.findIndex((row) => rowValue(row) === value);
      const anchor =
        this.focusRangeAnchor?.scope === scope
          ? rows.findIndex(
              (row) => rowValue(row) === this.focusRangeAnchor?.value,
            )
          : -1;
      if (anchor !== -1 && target !== -1) {
        const start = Math.min(anchor, target);
        const end = Math.max(anchor, target);
        this.callbacks.onFocusRange(
          this.id,
          rows.slice(start, end + 1).map(focusEntry),
        );
        return;
      }
    }

    this.focusRangeAnchor = { scope, value };
    const row = rows.find((candidate) => rowValue(candidate) === value);
    if (row === undefined) return;
    const entry = focusEntry(row);
    if (event.metaKey || event.ctrlKey)
      this.callbacks.onFocusToggle(this.id, entry);
    else this.callbacks.onFocusAdd(this.id, entry);
  }

  private openBindingPopover(
    entry: BindingChipEntry,
    anchor: HTMLElement,
  ): void {
    this.closeBindingPopover();
    const popover = document.createElement("div");
    popover.className = "binding-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", `${entry.label} binding members`);
    const title = document.createElement("div");
    title.className = "binding-popover-title";
    title.textContent = entry.label;
    const rows = document.createElement("div");
    rows.className = "binding-popover-rows";
    const removeBinding = document.createElement("button");
    removeBinding.className = "binding-popover-remove";
    removeBinding.type = "button";
    removeBinding.textContent = "remove all";
    removeBinding.title = "Remove all series in this binding";
    removeBinding.addEventListener("click", () => {
      this.callbacks.onRemoveBinding(this.id, entry.bindingIndex);
      this.closeBindingPopover();
    });
    const renderRows = (): void => {
      const slice = virtualSlice(entry.refs.length, rows.scrollTop, 224, 24);
      rows.replaceChildren();
      rows.style.height = `${String(slice.totalHeight)}px`;
      rows.style.paddingTop = `${String(slice.topPadding)}px`;
      for (const ref of entry.refs.slice(slice.start, slice.end)) {
        const row = document.createElement("div");
        row.className = "binding-popover-row";
        const path = document.createElement("button");
        path.className = "binding-popover-member";
        path.type = "button";
        path.textContent =
          this.callbacks.pathForRef(ref) ?? `${ref.source_key}/${ref.channel}`;
        path.addEventListener("click", (event) => {
          event.stopPropagation();
          this.closeBindingPopover();
          this.openInspector(path.textContent);
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "✕";
        remove.title = "Remove series from binding";
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          this.callbacks.onRemoveSeries(this.id, ref);
          this.closeBindingPopover();
        });
        row.append(path, remove);
        rows.append(row);
      }
    };
    rows.addEventListener("scroll", renderRows);
    popover.append(title, rows, removeBinding);
    this.element.append(popover);
    const panelRect = this.element.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    popover.style.left = `${String(
      clamp(
        anchorRect.left - panelRect.left,
        4,
        Math.max(4, panelRect.width - 240),
      ),
    )}px`;
    popover.style.top = `${String(
      clamp(
        anchorRect.bottom - panelRect.top + 4,
        4,
        Math.max(4, panelRect.height - 280),
      ),
    )}px`;
    renderRows();
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && popover.contains(event.target))
        return;
      this.closeBindingPopover();
    };
    document.addEventListener("pointerdown", onPointer, { capture: true });
    this.bindingCleanup = () => {
      document.removeEventListener("pointerdown", onPointer, { capture: true });
      popover.remove();
    };
  }

  private closeBindingPopover(): void {
    this.bindingCleanup?.();
    this.bindingCleanup = null;
  }

  private openLineWidthMenu(
    state: RenderPanelState,
    anchor: HTMLElement,
  ): void {
    this.openPanelMenu(
      anchor,
      "LINE WIDTH · PANEL DEFAULT",
      [1, 1.4, 1.5, 2, 3].map((width) => ({
        label: `${formatToolbarNumber(width)} px`,
        active: Math.abs(state.line_width - width) < 0.001,
        run: () => this.callbacks.onSetPanelLineWidth(this.id, width),
      })),
    );
  }

  private openGhostMenu(state: RenderPanelState, anchor: HTMLElement): void {
    this.openPanelMenu(anchor, "DIM OTHER SERIES", [
      {
        label: "none · show full color",
        active: state.ghost_mode === "all",
        run: () => {
          if (state.ghost_mode !== "all")
            this.callbacks.onToggleGhostMode(this.id);
        },
      },
      ...[0.2, 0.35, 0.5].map((opacity) => ({
        label: `to ${String(Math.round(opacity * 100))}% opacity`,
        active:
          state.ghost_mode === "ghost" &&
          Math.abs(state.ghost_opacity - opacity) < 0.001,
        run: () => {
          this.callbacks.onSetGhostOpacity(this.id, opacity);
          if (state.ghost_mode !== "ghost")
            this.callbacks.onToggleGhostMode(this.id);
        },
      })),
    ]);
  }

  private openLegendStateMenu(
    state: RenderPanelState,
    anchor: HTMLElement,
  ): void {
    this.openPanelMenu(
      anchor,
      "LEGEND TYPE",
      (["badge", "keys", "roster", "rail"] as const).map((legendState) => ({
        label: legendState,
        active: state.legend_state === legendState,
        run: () =>
          this.callbacks.onLegendLayout(this.id, { state: legendState }),
      })),
    );
  }

  private openAxisPicker(
    axis: "x" | "y",
    state: RenderPanelState,
    anchor: HTMLElement,
  ): void {
    this.closePanelConfig();
    this.panelConfigCleanup = showAxisPicker(
      this.element,
      anchor,
      axis,
      state.x_axis,
      this.callbacks.catalog(),
      this.callbacks.namedSets(),
      (xAxis) => this.callbacks.onSetXAxis?.(this.id, xAxis),
      (paths) => this.callbacks.onDropSignals(this.id, paths),
    );
  }

  private openTipsMenu(state: RenderPanelState, anchor: HTMLElement): void {
    this.openPanelMenu(anchor, `TIPS · ${String(state.annotations.length)}`, [
      ...(["labels", "markers", "hidden"] as const).map((mode) => ({
        label: mode === "markers" ? "markers only" : mode,
        active: state.annotation_display === mode,
        run: () => {
          this.callbacks.onSetAnnotationDisplay?.(this.id, mode);
        },
      })),
      {
        label: "clear all",
        active: false,
        action: true,
        run: () => {
          this.annotationUi.selectedIds.clear();
          this.callbacks.onClearAnnotations?.(this.id);
        },
      },
    ]);
  }

  private openPanelMenu(
    anchor: HTMLElement,
    label: string,
    options: readonly {
      label: string;
      active: boolean;
      action?: boolean;
      run: () => void;
    }[],
  ): void {
    this.closePanelConfig();
    this.panelConfigCleanup = showPanelMenu(
      this.element,
      anchor,
      label,
      options,
    );
  }

  private closePanelConfig(): void {
    this.panelConfigCleanup?.();
    this.panelConfigCleanup = null;
  }

  openInspector(path: string): void {
    const series = this.lastState?.series.find((entry) => entry.path === path);
    if (series === undefined) return;
    this.inspectorPath = path;
    this.updatePlotLegend(this.lastState as RenderPanelState);
  }

  private selectAnnotation(id: string, additive: boolean): void {
    this.annotationUi.select(id, additive);
    const annotation = this.lastState?.annotations.find(
      (entry) => entry.id === id,
    );
    const series = this.lastState?.series.find(
      (entry) => entry.path === annotation?.series_path,
    );
    if (series !== undefined) {
      const focus: FocusEntry = {
        kind: "series",
        ref: series.ref,
        source_key: null,
        channel: series.ref.channel,
      };
      if (additive) this.callbacks.onFocusToggle(this.id, focus);
      else this.callbacks.onFocusAdd(this.id, focus);
    }
    this.drawOverlay();
    if (this.lastState !== null) this.updatePlotLegend(this.lastState);
  }

  private pruneAnnotationUiState(state: RenderPanelState): void {
    this.annotationUi.prune(
      new Set(state.annotations.map((annotation) => annotation.id)),
    );
  }

  private toggleInlineInspector(state: RenderPanelState, path: string): void {
    this.inspectorPath = this.inspectorPath === path ? null : path;
    this.updatePlotLegend(state);
  }

  private inlineSeriesInspector(
    state: RenderPanelState,
    series: RenderSeries,
  ): HTMLElement {
    return seriesInspector(state, series, seriesColor(series), {
      close: () => this.toggleInlineInspector(state, series.path),
      mute: () => this.callbacks.onMuteSeries(this.id, series.ref),
      patch: (style) =>
        this.callbacks.onPatchSeriesStyle(this.id, series.ref, style),
    });
  }
}

function overrideTarget(
  override: SeriesOverride,
  callbacks: Pick<PanelCallbacks, "pathForRef">,
): string {
  if (override.target_selector !== null) return override.target_selector;
  if (override.target_ref !== null) {
    return (
      callbacks.pathForRef(override.target_ref) ??
      `${override.target_ref.source_key}/${override.target_ref.channel}`
    );
  }
  return "unknown target";
}

function overrideFields(override: SeriesOverride): string {
  return [
    override.color_slot === null ? null : "color",
    override.dash === null ? null : "dash",
    override.width === null ? null : "width",
  ]
    .filter((field): field is string => field !== null)
    .join(" · ");
}

function axisEditZone(
  layout: PlotLayout,
  axisStyle: AxisStyle,
  px: number,
  py: number,
): "x" | "y" | null {
  const { plot } = layout;
  if (axisStyle === "inline") {
    if (px <= plot.x + 90 && py <= plot.y + 18) return "y";
    if (px >= plot.x + plot.width - 90 && py >= plot.y + plot.height - 18) {
      return "x";
    }
    return null;
  }
  if (px < plot.x - 20) return "y";
  if (py > plot.y + plot.height + 14) return "x";
  return null;
}

function encodingValueCount(
  state: RenderPanelState,
  dimension: StyleDimension,
  catalog: Catalog,
): number {
  if (dimension === "focus")
    return new Set(state.series.map((series) => series.focused)).size;
  if (dimension === "source")
    return new Set(state.series.map((series) => series.ref.source_key)).size;
  if (dimension === "channel")
    return new Set(state.series.map((series) => series.ref.channel)).size;
  if (dimension === "set") return state.bindings.length;
  return new Set(
    state.series.map((series) => catalog.get(series.ref)?.summary.unit ?? "—"),
  ).size;
}

function seriesColor(series: Pick<RenderSeries, "hue">): string {
  return series.hue === null
    ? "var(--fg-4)"
    : `var(--series-${String(colorIndexForHue(series.hue) + 1)})`;
}

function lineToolbarMarkup(): string {
  return `<span class="panel-toolbar-group panel-toolbar-axes">
      <button class="panel-action panel-axis-toggle" title="Switch axis presentation">axes: gutter</button>
      <button class="panel-toolbar-control panel-y-axis" type="button" title="Add Y signals or bundles" aria-label="Add Y signals or bundles">y: + add ▾</button>
      <button class="panel-toolbar-control panel-x-axis" type="button" title="Choose X axis">x: time ▾</button>
    </span>
    <span class="panel-toolbar-separator" aria-hidden="true"></span>
    <span class="panel-toolbar-group panel-toolbar-render">
      <button class="panel-toolbar-control panel-line-width" type="button" title="Panel line-width default"><span class="line-width-sample" aria-hidden="true"></span><span class="panel-line-width-value">${DEFAULT_PANEL_LINE_WIDTH.toFixed(1)}</span> <span class="toolbar-caret">▾</span></button>
      <button class="panel-toolbar-control panel-ghost-opacity" type="button" title="Dim non-selected series">dim <b class="panel-ghost-value">none</b> <span class="toolbar-caret">▾</span></button>
    </span>
    <span class="panel-toolbar-separator" aria-hidden="true"></span>
    <span class="panel-toolbar-group panel-toolbar-readout">
      <button class="panel-action panel-stats-toggle" title="Toggle statistics columns (S)" aria-pressed="false">Σ <span>stats</span></button>
      <button class="panel-toolbar-control panel-tips" type="button" title="Tip density and actions">tips <b class="panel-tips-value">0</b> <span class="toolbar-caret">▾</span></button>
      <button class="panel-toolbar-control panel-legend-state" type="button" title="Legend type">legend <b class="panel-legend-value">keys</b> <span class="toolbar-caret">▾</span></button>
    </span>`;
}

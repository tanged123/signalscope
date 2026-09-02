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
  prepareTimePlot,
  type AnnotationAnchor,
  type PlotCursor,
  type PreparedPlot,
  type ResolvedAnnotation,
  type SeriesHitAdapter,
} from "../app/plot-capabilities";
import {
  COLOR_SLOTS,
  hueIndex,
  invalidatePalette,
  resolvePalette,
} from "../render/plot-theme";
import { ChartHost, type ChartRenderRequest } from "../render/chart-host";
import type { GpuContext } from "../render/gpu-context";

const CHART_HOST_INITIALIZATION_TIMEOUT_MS = 5_000;
const CHART_HOST_RETRY_DELAYS_MS = [100] as const;
import {
  OverlayRenderer,
  type OverlayAnnotation,
  type CursorMode,
  type CursorPoint,
} from "../render/overlay-renderer";
import { YAxisPolicy } from "../render/y-axis";
import { required } from "./dom";
import {
  PlotInteractionController,
  type InteractionBox,
} from "./plot-interactions";

export const SIGNAL_DRAG_TYPE = "application/x-signalscope-signal";
export const SET_DRAG_TYPE = "application/x-signalscope-set";
export const PANEL_DRAG_TYPE = "application/x-signalscope-panel";
export const MAX_SERIES_PER_PANEL = 64;
export const MAXIMIZE_GLYPH = "↗";
const LEGEND_RAIL_COLLAPSE = 100;
const LEGEND_RAIL_MIN = 140;
const LEGEND_RAIL_DEFAULT = 236;
const DOCK_SEAM_WIDTH = 5;

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
  onFocusSolo(id: string, entry: FocusEntry): void;
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
}

export function hasDragType(event: DragEvent, type: string): boolean {
  return event.dataTransfer?.types.includes(type) ?? false;
}

/** The non-empty payload carried for `type` on a drop event, or null. */
export function dragData(event: DragEvent, type: string): string | null {
  const value = event.dataTransfer?.getData(type);
  return value !== undefined && value !== "" ? value : null;
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

export type LegendDimension = "source" | "channel";

export interface MatrixLegendRow {
  value: string;
  label: string;
  count: number;
  selector: string;
  focused: boolean;
  ghosted: boolean;
  overridden: boolean;
  hue: number | null;
}

export interface BindingChipEntry {
  label: string;
  bindingIndex: number;
  kind: Binding["kind"];
  refs: SeriesRef[];
  selector: string | null;
}

export interface LegendStatValues {
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
  n: number | null;
  cursor: number | null;
}

export function matrixLegendRows(
  catalog: Catalog,
  state: Pick<RenderPanelState, "series" | "focus" | "color_by">,
  dimension: LegendDimension,
  query = "",
): MatrixLegendRow[] {
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
  const rows = new Map<string, MatrixLegendRow>();
  for (const series of state.series) {
    const catalogSeries = catalog.get(series.ref);
    if (matching !== null && !matching.has(catalog.refKey(series.ref))) {
      continue;
    }
    const value =
      dimension === "source"
        ? (catalogSeries?.sourceName ?? series.ref.source_key)
        : series.ref.channel;
    const existing = rows.get(value);
    const focus = state.focus.some((entry) => focusMatches(entry, series.ref));
    if (existing === undefined) {
      rows.set(value, {
        value,
        label: value,
        count: 1,
        selector: dimension === "source" ? `* @ ${value}` : `${value} @ *`,
        focused: focus,
        ghosted: series.display === "ghost",
        overridden: series.overridden,
        hue: state.color_by === dimension ? series.hue : null,
      });
    } else {
      existing.count += 1;
      existing.focused ||= focus;
      existing.ghosted ||= series.display === "ghost";
      existing.overridden ||= series.overridden;
      if (existing.hue === null && state.color_by === dimension) {
        existing.hue = series.hue;
      }
    }
  }
  const result = [...rows.values()];
  if (trimmedQuery === "" || selectorQuery) return result;
  const glob = ["*", "?", "[", "|"].some((token) =>
    trimmedQuery.includes(token),
  )
    ? compileGlob(trimmedQuery)
    : null;
  const text = trimmedQuery.toLocaleLowerCase();
  return result.filter((row) =>
    glob === null
      ? row.label.toLocaleLowerCase().includes(text)
      : glob.test(row.label),
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

export function parseSignalPayload(data: string): string[] {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "paths" in payload &&
      Array.isArray(payload.paths) &&
      payload.paths.every((path) => typeof path === "string")
    ) {
      return payload.paths;
    }
    return [];
  } catch {
    // Malformed external drag payloads are ignored.
  }
  return data === "" ? [] : [data];
}

export function parseSignalRefsPayload(data: string): SeriesRef[] {
  try {
    const payload: unknown = JSON.parse(data);
    if (typeof payload !== "object" || payload === null) return [];
    const refs = (payload as { refs?: unknown }).refs;
    if (!Array.isArray(refs)) return [];
    if (
      refs.every((ref: unknown) => {
        if (typeof ref !== "object" || ref === null) return false;
        const candidate = ref as {
          source_key?: unknown;
          channel?: unknown;
        };
        return (
          typeof candidate.source_key === "string" &&
          typeof candidate.channel === "string"
        );
      })
    ) {
      return refs as SeriesRef[];
    }
  } catch {
    return [];
  }
  return [];
}

export function parseSetPayload(data: string): string | null {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "set_id" in payload &&
      typeof payload.set_id === "string"
    ) {
      return payload.set_id;
    }
  } catch {
    // Malformed external drag payloads are ignored.
  }
  return null;
}

export class PanelView {
  readonly element: HTMLElement;
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
  private lastTiles: ColumnarTileResponse | null = null;
  private lastWindow: { t0: number; t1: number } | null = null;
  private lastMissingEmpty = true;
  private preparedPlot: PreparedPlot | null = null;
  private hitAdapter: SeriesHitAdapter | null = null;
  private cursorT: number | null = null;
  private cursorMode: CursorMode = "none";
  private box: InteractionBox | null = null;
  private emphasizePaths: ReadonlySet<string> | null = null;
  private hoverTip: AnnotationAnchor | null = null;
  private hoveredAnnotationId: string | null = null;
  private readonly selectedAnnotationIds = new Set<string>();
  private readonly annotationOffsets = new Map<
    string,
    { x: number; y: number }
  >();
  private annotationsExpanded = false;
  private plotTipsHeight: number | null = null;
  private annotationDragId: string | null = null;
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

  constructor(
    private readonly id: string,
    private readonly callbacks: PanelCallbacks,
    private gpu: GpuContext | null = null,
  ) {
    this.element = document.createElement("article");
    this.element.className = "panel";
    this.element.dataset.panelId = id;
    this.element.tabIndex = 0;
    this.element.innerHTML = panelMarkup();
    this.chartHostElement = required<HTMLElement>(this.element, ".chart-host");
    this.overlay = required<HTMLCanvasElement>(this.element, ".overlay-canvas");
    this.overlayRenderer = new OverlayRenderer(this.overlay);
    this.bind();
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
    if (this.gpu === null || this.disposed || !this.element.isConnected) {
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
    this.element.addEventListener("pointerdown", () => {
      this.callbacks.onFocus(this.id);
    });
    required(this.element, ".plot-series-legend").addEventListener(
      "pointerdown",
      (event) => {
        event.stopPropagation();
      },
    );
    required(this.element, ".panel-close").addEventListener("click", () => {
      this.callbacks.onClose(this.id);
    });
    required(this.element, ".panel-split-right").addEventListener(
      "click",
      () => {
        this.callbacks.onSplitRight(this.id);
      },
    );
    required(this.element, ".panel-split-down").addEventListener(
      "click",
      () => {
        this.callbacks.onSplitDown(this.id);
      },
    );
    required(this.element, ".panel-maximize").addEventListener("click", () => {
      this.callbacks.onMaximize(this.id);
    });
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
        if (this.selectedAnnotationIds.size > 0) {
          this.selectedAnnotationIds.clear();
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
        this.selectedAnnotationIds.size > 0
      ) {
        event.preventDefault();
        for (const id of this.selectedAnnotationIds) {
          this.callbacks.onRemoveAnnotation(this.id, id);
        }
        this.selectedAnnotationIds.clear();
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
    const header = required<HTMLElement>(this.element, ".panel-header");
    required<HTMLElement>(this.element, ".panel-title").addEventListener(
      "dblclick",
      () => {
        this.beginTitleEdit();
      },
    );
    header.draggable = true;
    header.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(PANEL_DRAG_TYPE, this.id);
    });
    this.element.addEventListener("dragover", (event) => {
      const signalDrag = hasDragType(event, SIGNAL_DRAG_TYPE);
      const setDrag = hasDragType(event, SET_DRAG_TYPE);
      if (!signalDrag && !setDrag) return;
      event.preventDefault();
      this.element.classList.add("drop-target");
    });
    this.element.addEventListener("dragleave", () => {
      this.element.classList.remove("drop-target", "drop-x");
    });
    this.element.addEventListener("drop", (event) => {
      this.element.classList.remove("drop-target", "drop-x");
      const setPayload = dragData(event, SET_DRAG_TYPE);
      if (setPayload !== null) {
        event.preventDefault();
        event.stopPropagation();
        const setId = parseSetPayload(setPayload);
        if (setId !== null) this.callbacks.onDropSet(this.id, setId);
        return;
      }
      const path = dragData(event, SIGNAL_DRAG_TYPE);
      if (path === null) return;
      event.preventDefault();
      event.stopPropagation();
      const paths = parseSignalPayload(path);
      if (paths.length === 0) return;
      this.callbacks.onDropSignals(this.id, paths);
    });
    this.overlay.addEventListener("pointermove", (event) => {
      if (this.interactions.isDragging() || this.annotationDragId !== null)
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
      const initial = this.annotationOffsets.get(hit.id) ?? {
        x: saved?.[0] ?? 10,
        y: saved?.[1] ?? -10,
      };
      let moved = false;
      this.annotationDragId = hit.id;
      this.overlay.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent): void => {
        if (hit.part !== "label") return;
        const dx = next.offsetX - start.x;
        const dy = next.offsetY - start.y;
        if (!moved && Math.hypot(dx, dy) <= 3) return;
        moved = true;
        this.annotationOffsets.set(hit.id, {
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
          const offset = this.annotationOffsets.get(hit.id);
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
        this.annotationDragId = null;
      };
      this.overlay.addEventListener("pointermove", move);
      this.overlay.addEventListener("pointerup", finish);
      this.overlay.addEventListener("pointercancel", cleanup);
    });
    this.overlay.addEventListener("pointerleave", () => {
      if (!this.interactions.isDragging() && this.annotationDragId === null) {
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
    this.element.classList.toggle("maximized", maximized);
    this.element.setAttribute("aria-label", `${rendered.title} panel`);
    required(this.element, ".panel-title").textContent = rendered.title;
    required<HTMLButtonElement>(this.element, ".panel-maximize").title =
      maximized ? "Restore panel" : "Maximize panel";
    const axisToggle = required<HTMLButtonElement>(
      this.element,
      ".panel-axis-toggle",
    );
    axisToggle.textContent = `axes: ${rendered.axis_style}`;
    axisToggle.title = `Switch to ${rendered.axis_style === "gutter" ? "inline" : "gutter"} axes`;
    axisToggle.hidden = false;
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
    const empty = required<HTMLElement>(this.element, ".panel-empty");
    if (rendered.series.length === 0) {
      empty.hidden = false;
      empty.textContent = "Empty panel — drag a signal here.";
    } else if (this.gpu === null) {
      empty.hidden = false;
      empty.textContent = "WebGPU unavailable — time-series rendering disabled";
    } else {
      empty.hidden = true;
    }
  }

  renderData(
    state: PanelState,
    tiles: ColumnarTileResponse | null,
    window: { t0: number; t1: number },
    missing: readonly string[] = [],
  ): number {
    const stateKey = JSON.stringify(state);
    if (
      stateKey === this.lastStateKey &&
      tiles === this.lastTiles &&
      this.lastWindow !== null &&
      window.t0 === this.lastWindow.t0 &&
      window.t1 === this.lastWindow.t1 &&
      missing.length === 0 &&
      this.lastMissingEmpty
    ) {
      return 0;
    }
    const rendered = renderState(state, this.callbacks);
    this.lastInputState = state;
    this.lastStateKey = stateKey;
    this.lastState = rendered;
    this.lastTiles = tiles;
    this.lastWindow = { ...window };
    this.lastMissingEmpty = missing.length === 0;
    this.preparedPlot = null;
    this.hitAdapter = null;
    this.updateLegendValues();
    const elapsed = this.renderForMode(rendered, tiles, window);
    this.hitAdapter =
      (this.preparedPlot as PreparedPlot | null)?.hitAdapter ?? null;
    this.interactions.setPolicy(
      (this.preparedPlot as PreparedPlot | null)?.interaction ?? null,
    );
    this.updatePlotLegend(rendered);
    this.pruneAnnotationUiState(rendered);
    const annotations = this.resolvedAnnotations(rendered);
    this.drawOverlay(annotations);
    if (missing.length > 0) {
      this.setModeEmpty(true, `unknown signals: ${missing.join(", ")}`);
    }
    return elapsed;
  }

  private renderForMode(
    state: RenderPanelState,
    tiles: ColumnarTileResponse | null,
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
    this.chartHostElement.hidden = false;
    if (tiles === null) return 0;
    const bySeries = new Map(
      state.series.map((series) => [series.path, series]),
    );
    const shown = tiles.series.filter(
      (tile) => bySeries.get(tile.signalPath)?.visible ?? true,
    );
    const response = { requestId: tiles.requestId, series: shown };
    this.preparedPlot = prepareTimePlot({
      series: shown.map((tile) => {
        const series = bySeries.get(tile.signalPath);
        return {
          path: tile.signalPath,
          colorIndex: colorIndexForHue(series?.hue ?? 1),
          bins: tile.bins,
        };
      }),
      window,
    });
    const seriesKey = state.series.map((series) => series.path).join("\u0000");
    const ranges = this.resolvePlotRanges(
      state,
      this.preparedPlot,
      window,
      seriesKey,
    );
    if (ranges === null) return 0;
    const styles = shown.map((tile) => {
      const series = bySeries.get(tile.signalPath);
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
        : shown.flatMap((tile, index) =>
            this.emphasizePaths?.has(tile.signalPath) ? [index] : [],
          );
    const request: ChartRenderRequest = {
      response,
      xRange: ranges.x,
      yRange: [ranges.y.min, ranges.y.max],
      xLabel: state.x_label ?? "time (s)",
      yLabel: state.y_label ?? yLabel(response.series.map((tile) => tile.unit)),
      styles,
      emphasisIndices,
      palette: resolvePalette(),
      axisStyle: state.axis_style,
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

  /**
   * Shows or clears a mode-specific empty message. Always assigns `hidden`,
   * so a panel that starts empty and then gets data does not keep a stale
   * message over its plot.
   */
  private setModeEmpty(show: boolean, message: string): void {
    const empty = required<HTMLElement>(this.element, ".panel-empty");
    empty.hidden = !show;
    if (show) empty.textContent = message;
  }

  invalidateTheme(): void {
    invalidatePalette();
    this.overlayRenderer.invalidateTheme();
    if (this.lastState !== null && this.lastWindow !== null) {
      this.renderForMode(this.lastState, this.lastTiles, this.lastWindow);
      this.drawOverlay(this.resolvedAnnotations(this.lastState));
    }
  }

  setCursor(cursorT: number | null): void {
    if (this.preparedPlot?.interaction.cursorLink !== "time") return;
    this.cursorT = cursorT;
    this.updateLegendValues();
    this.drawOverlay();
  }

  setLocalCursor(cursorValue: number | null): void {
    this.cursorT = cursorValue;
    this.updateLegendValues();
    this.drawOverlay();
  }

  clearCursor(): void {
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
    this.releaseGpu();
    this.interactions.dispose();
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
        this.callbacks.onFocusSolo(this.id, {
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
      const changed = this.hoveredAnnotationId !== annotationHit.id;
      this.hoveredAnnotationId = annotationHit.id;
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
    this.hoveredAnnotationId = null;
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
    const hadAnnotation = this.hoveredAnnotationId !== null;
    this.hoverTip = null;
    this.hoveredAnnotationId = null;
    this.setEmphasis(null);
    if (hadAnnotation && this.lastState !== null)
      this.updatePlotLegend(this.lastState);
    this.drawOverlay();
  }

  private walkHover(direction: -1 | 1): void {
    const state = this.lastState;
    if (state === null) return;
    const values = new Map(
      (this.lastTiles?.series ?? []).map((tile) => [
        tile.signalPath,
        this.cursorT === null
          ? null
          : columnsValueAtTime(tile.bins, this.cursorT),
      ]),
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
    const xyMarkers: never[] = [];
    this.overlayRenderer.draw(this.activeLayout(), {
      cursorT,
      cursorMode: this.cursorMode,
      cursorPoints:
        this.cursorMode === "track" && cursorT !== null
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
            selected: this.selectedAnnotationIds.has(annotation.annotation.id),
            hovered:
              this.hoveredAnnotationId === annotation.annotation.id ||
              this.emphasizePaths?.has(annotation.annotation.series_path) ===
                true,
            ghosted: series?.display === "ghost" || series?.visible === false,
            ephemeral: false,
            offset: this.annotationOffsets.get(annotation.annotation.id) ?? {
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
        x: tip.anchor,
        y: tip.pinnedValue,
        colorIndex:
          series?.hue === null || series === undefined
            ? null
            : colorIndexForHue(series.hue),
        label: `${formatValue(tip.anchor)} · ${formatValue(tip.pinnedValue)}`,
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

  private beginTitleEdit(): void {
    const header = required<HTMLElement>(this.element, ".panel-header");
    const title = required<HTMLElement>(this.element, ".panel-title");
    const previous = title.textContent;
    header.draggable = false;
    try {
      title.contentEditable = "plaintext-only";
    } catch {
      title.contentEditable = "true";
    }
    const finish = (commit: boolean): void => {
      title.removeEventListener("keydown", onKey);
      title.removeEventListener("blur", onBlur);
      title.contentEditable = "false";
      header.draggable = true;
      if (commit) {
        this.callbacks.onRenameTitle(this.id, title.textContent.trim());
      } else {
        title.textContent = previous;
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };
    const onBlur = (): void => {
      finish(true);
    };
    title.addEventListener("keydown", onKey);
    title.addEventListener("blur", onBlur);
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
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
    const dimension: LegendDimension =
      state.color_by === "channel" ? "channel" : "source";
    const all = matrixLegendRows(this.callbacks.catalog(), state, dimension);
    const shown = this.focusOnly ? all.filter((row) => row.focused) : all;
    const title = this.plotLegendGroupTitle(state, dimension, shown.length);
    title.className = "plot-legend-section-title plot-legend-group-title";
    const rows = document.createElement("div");
    rows.className = "plot-legend-key-rows";
    rows.append(
      ...shown.map((row) =>
        this.plotLegendMatrixRow(state, dimension, row, shown),
      ),
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
    dimension: LegendDimension,
    count: number,
  ): HTMLElement {
    const title = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = `▾ ${dimension.toUpperCase()}`;
    const focus = document.createElement("button");
    focus.type = "button";
    focus.className = "plot-legend-focus-filter";
    focus.textContent = this.focusOnly
      ? `focus only ✓ · ${String(count)}/${String(state.series.length)}`
      : `${String(state.focus.length)} focused ⤴`;
    focus.hidden = state.focus.length === 0;
    focus.title = this.focusOnly
      ? "Show all legend rows"
      : "Show focused rows only";
    focus.addEventListener("click", () => {
      this.focusOnly = !this.focusOnly;
      this.updatePlotLegend(state);
    });
    const total = document.createElement("span");
    total.textContent = String(count);
    title.append(label, focus, total);
    return title;
  }

  private plotLegendMatrixRow(
    state: RenderPanelState,
    dimension: LegendDimension,
    item: MatrixLegendRow,
    selectionRows: readonly MatrixLegendRow[],
  ): HTMLElement {
    const block = document.createElement("div");
    block.className = "plot-legend-row-block plot-legend-matrix-block";
    const row = document.createElement("div");
    row.className = "plot-legend-roster-row";
    row.classList.toggle("focused", item.focused);
    row.classList.toggle("ghosted", item.ghosted && !item.focused);
    const matching = state.series.filter((series) =>
      dimension === "source"
        ? (this.callbacks.catalog().get(series.ref)?.sourceName ??
            series.ref.source_key) === item.value
        : series.ref.channel === item.value,
    );
    const paths = matching.map((series) => series.path);
    row.dataset.paths = JSON.stringify(paths);
    const single = matching.length === 1 ? matching[0] : undefined;
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "plot-legend-swatch plot-row-inspector-toggle";
    swatch.style.setProperty(
      "--plot-row-swatch-color",
      item.hue === null
        ? "var(--fg-4)"
        : `var(--series-${String(colorIndexForHue(item.hue) + 1)})`,
    );
    if (single !== undefined) {
      swatch.style.setProperty(
        "--plot-row-swatch-width",
        `${String(single.width + (single.focused ? 1 : 0))}px`,
      );
    }
    if (single === undefined) {
      swatch.disabled = true;
      swatch.title = "Group styles are edited with selector rules";
    } else {
      swatch.title = `Edit ${single.path} line properties`;
      swatch.setAttribute(
        "aria-expanded",
        String(this.inspectorPath === single.path),
      );
      swatch.addEventListener("click", () => {
        this.toggleInlineInspector(state, single.path);
      });
    }
    const action = document.createElement("button");
    action.type = "button";
    action.className = "plot-legend-roster-action";
    const label = document.createElement("span");
    label.className = "plot-legend-label";
    label.textContent = `${item.overridden ? "▍ " : ""}${item.label}`;
    const count = document.createElement("span");
    count.className = "plot-legend-count";
    count.textContent = `×${String(item.count)}`;
    action.append(label, count);
    action.addEventListener("mouseenter", () => this.setEmphasis(paths));
    action.addEventListener("mouseleave", () => this.setEmphasis(null));
    action.addEventListener("click", (event) => {
      if (event.altKey) this.callbacks.onMuteSelector(this.id, item.selector);
      else
        this.selectFocusRows(
          event,
          dimension,
          item.value,
          selectionRows,
          (row) => row.value,
          (row) => this.focusEntryForRow(dimension, row, state),
        );
    });
    action.title = `Focus ${item.label}; Shift-click selects a range; Command/Ctrl-click toggles; Option-click mutes`;
    row.append(swatch, action);
    block.append(row);
    if (single !== undefined && this.inspectorPath === single.path) {
      block.append(this.inlineSeriesInspector(state, single));
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
    const dimension: LegendDimension =
      state.color_by === "channel" ? "channel" : "source";
    const group = document.createElement("div");
    group.className = "plot-legend-group";
    const groupTitle = document.createElement("div");
    groupTitle.className = "plot-legend-section-title plot-legend-group-title";
    const rows = document.createElement("div");
    rows.className = "plot-legend-roster-rows";
    const viewport = document.createElement("div");
    viewport.className = "plot-legend-roster-viewport";
    rows.addEventListener("click", (event) => {
      if (event.target === rows || event.target === viewport)
        this.callbacks.onClearFocus(this.id);
    });
    const renderRows = (): void => {
      const all = matrixLegendRows(
        this.callbacks.catalog(),
        state,
        dimension,
        search.value,
      );
      const shown = this.focusOnly ? all.filter((item) => item.focused) : all;
      groupTitle.replaceChildren(
        ...this.plotLegendGroupTitle(state, dimension, shown.length).childNodes,
      );
      searchMeta.textContent = `${String(shown.length)} match · ⏎ focus · ⌥⏎ mute`;
      if (typeof this.inspectorPath === "string") {
        viewport.style.height = "auto";
        viewport.replaceChildren(
          ...shown.map((item) =>
            this.plotLegendMatrixRow(state, dimension, item, shown),
          ),
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
          const block = this.plotLegendMatrixRow(state, dimension, item, shown);
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
      const first = matrixLegendRows(
        this.callbacks.catalog(),
        state,
        dimension,
        search.value,
      )[0];
      if (first === undefined) return;
      event.preventDefault();
      if (event.altKey) this.callbacks.onMuteSelector(this.id, first.selector);
      else if (event.metaKey || event.ctrlKey)
        this.callbacks.onFocusToggle(
          this.id,
          this.focusEntryForRow(dimension, first, state),
        );
      else
        this.callbacks.onFocusSolo(
          this.id,
          this.focusEntryForRow(dimension, first, state),
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
    toggle.textContent = `${this.annotationsExpanded ? "▾" : "▸"} TIPS`;
    toggle.setAttribute("aria-expanded", String(this.annotationsExpanded));
    toggle.addEventListener("click", () => {
      this.annotationsExpanded = !this.annotationsExpanded;
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
    if (!this.annotationsExpanded || state.annotations.length === 0)
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
      (left, right) => right.anchor - left.anchor,
    );
    for (const annotation of annotations) {
      const series = byPath.get(annotation.series_path);
      const row = document.createElement("div");
      row.className = "plot-tip-row";
      row.dataset.paths = JSON.stringify([annotation.series_path]);
      row.classList.toggle("focused", series?.focused ?? false);
      row.classList.toggle(
        "selected",
        this.selectedAnnotationIds.has(annotation.id),
      );
      row.classList.toggle(
        "ghosted",
        series?.display === "ghost" || series?.visible === false,
      );
      row.classList.toggle(
        "hovered",
        this.hoveredAnnotationId === annotation.id,
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
      x.textContent = formatValue(annotation.anchor);
      const value = document.createElement("span");
      value.className = "plot-tip-value";
      value.textContent = formatValue(annotation.pinned_value);
      const reading = document.createElement("span");
      reading.className = "plot-tip-reading";
      reading.textContent = `${formatValue(annotation.anchor)} · ${formatValue(annotation.pinned_value)}`;
      const actions = document.createElement("span");
      actions.className = "plot-tip-actions";
      const locate = document.createElement("button");
      locate.type = "button";
      locate.textContent = "⌖";
      locate.title = "Pan to tip";
      locate.addEventListener("click", () =>
        this.panToAnnotation(annotation.anchor),
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
        this.hoveredAnnotationId = annotation.id;
        this.setEmphasis(annotation.series_path);
        this.drawOverlay();
      });
      row.addEventListener("mouseleave", () => {
        this.hoveredAnnotationId = null;
        this.setEmphasis(null);
        this.drawOverlay();
      });
      body.append(row);
    }
    section.append(columns, body);
    if (this.plotTipsHeight !== null)
      section.style.height = `${String(this.plotTipsHeight)}px`;
    this.bindPlotTipsResize(heading, section);
    return section;
  }

  private bindPlotTipsResize(handle: HTMLElement, section: HTMLElement): void {
    const resize = (height: number): void => {
      const parentHeight =
        section.parentElement?.getBoundingClientRect().height ?? height;
      const next = clamp(height, 22, Math.max(22, parentHeight * 0.75));
      this.plotTipsHeight = next;
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
      this.selectedAnnotationIds.size === 0
        ? state.annotations
        : state.annotations.filter((annotation) =>
            this.selectedAnnotationIds.has(annotation.id),
          );
    const lines = [
      "series,x,value,label",
      ...[...selected]
        .sort((left, right) => right.anchor - left.anchor)
        .map((annotation) =>
          [
            annotation.series_path,
            String(annotation.anchor),
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
    const tile = this.lastTiles?.series.find(
      (series) => series.signalPath === path,
    );
    value.textContent =
      tile === undefined || this.cursorT === null
        ? "—"
        : formatValue(columnsValueAtTime(tile.bins, this.cursorT));
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

  private legendResizeHandle(
    edge: "left" | "right" | "top" | "bottom" | "corner",
    legend: HTMLElement,
  ): HTMLButtonElement {
    const resize = document.createElement("button");
    resize.className = `plot-legend-resize plot-legend-resize-${edge}`;
    if (legend.dataset.state === "rail")
      resize.classList.add("dock-resize-handle");
    resize.type = "button";
    resize.title =
      legend.dataset.state === "rail"
        ? "Resize or collapse docked legend"
        : `Resize plot legend from the ${edge}`;
    resize.setAttribute("aria-label", resize.title);
    this.bindPlotLegendResize(resize, legend, edge);
    return resize;
  }

  private bindPlotLegendResize(
    handle: HTMLButtonElement,
    legend: HTMLElement,
    edge: "left" | "right" | "top" | "bottom" | "corner",
  ): void {
    const dock = this.plotLegendDock ?? "right";
    const docked = legend.dataset.state === "rail";
    const verticalDock = dock === "left" || dock === "right";
    let requestedThickness: number | null = null;
    const resize = (width: number, height: number): void => {
      const box = legend.getBoundingClientRect();
      const bounds = legend.parentElement?.getBoundingClientRect();
      if (docked) {
        requestedThickness = verticalDock ? width : height;
      } else {
        this.plotLegendPosition = this.currentPlotLegendPosition(legend);
        this.plotLegendAnchor = null;
      }
      this.plotLegendSize = {
        width: docked && !verticalDock ? (bounds?.width ?? box.width) : width,
        height:
          docked && verticalDock ? (bounds?.height ?? box.height) : height,
      };
      this.positionPlotLegend();
    };
    const commit = (): void => {
      if (this.plotLegendSize === null) return;
      if (docked) {
        const bounds = legend.parentElement?.getBoundingClientRect();
        const box = legend.getBoundingClientRect();
        const raw =
          requestedThickness ?? (verticalDock ? box.width : box.height);
        const minimum = verticalDock ? LEGEND_RAIL_MIN : 120;
        const available = verticalDock
          ? (bounds?.width ?? raw)
          : (bounds?.height ?? raw);
        const thickness =
          raw < LEGEND_RAIL_COLLAPSE
            ? 0
            : clamp(raw, minimum, Math.max(minimum, available * 0.45));
        this.callbacks.onLegendLayout(this.id, {
          state: "rail",
          position: null,
          size: verticalDock
            ? [thickness, bounds?.height ?? this.plotLegendSize.height]
            : [bounds?.width ?? this.plotLegendSize.width, thickness],
          anchor: null,
          dock,
        });
        return;
      }
      const nextState: LegendState =
        this.plotLegendSize.height >= 150 ? "roster" : "keys";
      this.callbacks.onLegendLayout(this.id, {
        state: nextState,
        position:
          this.plotLegendPosition === null
            ? null
            : [this.plotLegendPosition.x, this.plotLegendPosition.y],
        size: [this.plotLegendSize.width, this.plotLegendSize.height],
        anchor: null,
        dock: null,
      });
    };
    handle.addEventListener("keydown", (event) => {
      const directions: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const direction = directions[event.key];
      if (direction === undefined) return;
      event.preventDefault();
      const box = legend.getBoundingClientRect();
      const expandKey =
        dock === "right"
          ? "ArrowLeft"
          : dock === "left"
            ? "ArrowRight"
            : dock === "top"
              ? "ArrowDown"
              : "ArrowUp";
      const collapseKey =
        dock === "right"
          ? "ArrowRight"
          : dock === "left"
            ? "ArrowLeft"
            : dock === "top"
              ? "ArrowUp"
              : "ArrowDown";
      const minimum = verticalDock ? LEGEND_RAIL_MIN : 120;
      const thickness = verticalDock ? box.width : box.height;
      if (
        docked &&
        ((legend.dataset.collapsed === "true" && event.key === expandKey) ||
          (legend.dataset.collapsed !== "true" &&
            thickness <= minimum &&
            event.key === collapseKey))
      ) {
        const next =
          legend.dataset.collapsed === "true" ? LEGEND_RAIL_DEFAULT : 0;
        resize(
          verticalDock ? next : box.width,
          verticalDock ? box.height : next,
        );
        commit();
        return;
      }
      const step = event.shiftKey ? 48 : 16;
      const widthDelta =
        edge === "left"
          ? -direction[0] * step
          : edge === "right" || edge === "corner"
            ? direction[0] * step
            : 0;
      const heightDelta =
        edge === "top"
          ? -direction[1] * step
          : edge === "bottom" || edge === "corner"
            ? direction[1] * step
            : 0;
      resize(box.width + widthDelta, box.height + heightDelta);
      commit();
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const box = legend.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      const move = (next: PointerEvent): void => {
        if (next.pointerId !== event.pointerId) return;
        const dx = next.clientX - start.x;
        const dy = next.clientY - start.y;
        resize(
          box.width +
            (edge === "left"
              ? -dx
              : edge === "right" || edge === "corner"
                ? dx
                : 0),
          box.height +
            (edge === "top"
              ? -dy
              : edge === "bottom" || edge === "corner"
                ? dy
                : 0),
        );
      };
      const end = (next: PointerEvent): void => {
        if (next.pointerId !== event.pointerId) return;
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        document.removeEventListener("pointercancel", end);
        commit();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end);
      document.addEventListener("pointercancel", end);
    });
  }

  private bindPlotLegendDrag(
    handle: HTMLButtonElement,
    legend: HTMLElement,
  ): void {
    handle.addEventListener("keydown", (event) => {
      if (event.key === "End") {
        event.preventDefault();
        this.dockPlotLegend(
          legend,
          this.nearestPlotLegendEdge(legend) ?? "right",
        );
        return;
      }
      const directions: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const direction = directions[event.key];
      if (direction === undefined) return;
      event.preventDefault();
      const step = event.shiftKey ? 24 : 8;
      const current = this.currentPlotLegendPosition(legend);
      this.plotLegendPosition = {
        x: current.x + direction[0] * step,
        y: current.y + direction[1] * step,
      };
      this.plotLegendAnchor = null;
      this.positionPlotLegend();
      this.commitPlotLegendPosition();
    });
    handle.addEventListener("dblclick", () => {
      const wrap = legend.parentElement;
      if (wrap === null) return;
      const bounds = wrap.getBoundingClientRect();
      const box = legend.getBoundingClientRect();
      const current = this.currentPlotLegendPosition(legend);
      const horizontal =
        current.x + box.width / 2 < bounds.width / 2 ? "left" : "right";
      const vertical =
        current.y + box.height / 2 < bounds.height / 2 ? "top" : "bottom";
      this.plotLegendAnchor = `${vertical}_${horizontal}` as LegendAnchor;
      this.plotLegendPosition = null;
      this.positionPlotLegend();
      this.callbacks.onLegendLayout(this.id, {
        position: null,
        anchor: this.plotLegendAnchor,
      });
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const origin = this.currentPlotLegendPosition(legend);
      const start = { x: event.clientX, y: event.clientY };
      const move = (next: PointerEvent): void => {
        if (next.pointerId !== event.pointerId) return;
        this.plotLegendPosition = {
          x: origin.x + next.clientX - start.x,
          y: origin.y + next.clientY - start.y,
        };
        this.plotLegendAnchor = null;
        this.positionPlotLegend();
        const wrap = legend.parentElement;
        if (wrap !== null) {
          const preview = this.nearestPlotLegendEdge(legend, 56);
          if (preview === null) delete wrap.dataset.legendDockPreview;
          else wrap.dataset.legendDockPreview = preview;
        }
      };
      const end = (next: PointerEvent): void => {
        if (next.pointerId !== event.pointerId) return;
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        document.removeEventListener("pointercancel", end);
        const wrap = legend.parentElement;
        if (wrap !== null) delete wrap.dataset.legendDockPreview;
        const dock = this.nearestPlotLegendEdge(legend, 20);
        if (dock !== null) {
          this.dockPlotLegend(legend, dock);
          return;
        }
        this.commitPlotLegendPosition();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end);
      document.addEventListener("pointercancel", end);
    });
  }

  private commitPlotLegendPosition(): void {
    if (this.plotLegendPosition === null) return;
    this.callbacks.onLegendLayout(this.id, {
      position: [this.plotLegendPosition.x, this.plotLegendPosition.y],
      anchor: null,
      dock: null,
    });
  }

  private dockPlotLegend(legend: HTMLElement, dock: LegendDock): void {
    const box = legend.getBoundingClientRect();
    const bounds = legend.parentElement?.getBoundingClientRect();
    const vertical = dock === "left" || dock === "right";
    this.callbacks.onLegendLayout(this.id, {
      state: "rail",
      position: null,
      size: vertical
        ? [box.width, bounds?.height ?? box.height]
        : [bounds?.width ?? box.width, box.height],
      anchor: null,
      dock,
    });
  }

  private nearestPlotLegendEdge(
    legend: HTMLElement,
    threshold = Number.POSITIVE_INFINITY,
  ): LegendDock | null {
    const wrap = legend.parentElement;
    if (wrap === null) return null;
    const bounds = wrap.getBoundingClientRect();
    const box = legend.getBoundingClientRect();
    const position = this.currentPlotLegendPosition(legend);
    const distances: Array<[LegendDock, number]> = [
      ["left", position.x],
      ["right", bounds.width - position.x - box.width],
      ["top", position.y],
      ["bottom", bounds.height - position.y - box.height],
    ];
    distances.sort((left, right) => left[1] - right[1]);
    const nearest = distances[0];
    return nearest !== undefined && nearest[1] <= threshold ? nearest[0] : null;
  }

  private floatPlotLegend(legend: HTMLElement): void {
    const bounds = legend.parentElement?.getBoundingClientRect();
    const box = legend.getBoundingClientRect();
    const maxHeight = Math.max(150, (bounds?.height ?? box.height) * 0.6);
    this.callbacks.onLegendLayout(this.id, {
      state: "roster",
      position: null,
      size: [box.width, clamp(280, 150, maxHeight)],
      anchor: "top_right",
      dock: null,
    });
  }

  private currentPlotLegendPosition(legend: HTMLElement): {
    x: number;
    y: number;
  } {
    if (this.plotLegendPosition !== null) return this.plotLegendPosition;
    const wrap = legend.parentElement;
    if (wrap === null) return { x: 8, y: 8 };
    const bounds = wrap.getBoundingClientRect();
    const box = legend.getBoundingClientRect();
    if (this.plotLegendAnchor !== null) {
      return {
        x: this.plotLegendAnchor.endsWith("right")
          ? bounds.width - box.width - 8
          : 8,
        y: this.plotLegendAnchor.startsWith("bottom")
          ? bounds.height - box.height - 8
          : 8,
      };
    }
    const measured = { x: box.left - bounds.left, y: box.top - bounds.top };
    return Number.isFinite(measured.x) && Number.isFinite(measured.y)
      ? measured
      : { x: 8, y: 8 };
  }

  private positionPlotLegend(): void {
    const legend = required<HTMLElement>(this.element, ".plot-series-legend");
    const wrap = legend.parentElement;
    if (wrap === null) return;
    const bounds = wrap.getBoundingClientRect();
    const state = legend.dataset.state as LegendState | undefined;
    if (state === "rail") {
      const dock = this.plotLegendDock ?? "right";
      const vertical = dock === "left" || dock === "right";
      const requested = vertical
        ? (this.plotLegendSize?.width ?? LEGEND_RAIL_DEFAULT)
        : (this.plotLegendSize?.height ?? LEGEND_RAIL_DEFAULT);
      const collapsed = requested < LEGEND_RAIL_COLLAPSE;
      const minimum = vertical ? LEGEND_RAIL_MIN : 120;
      const available = vertical ? bounds.width : bounds.height;
      const thickness = collapsed
        ? DOCK_SEAM_WIDTH
        : clamp(requested, minimum, Math.max(minimum, available * 0.45));
      this.plotLegendSize = {
        width: vertical ? (collapsed ? 0 : thickness) : bounds.width,
        height: vertical ? bounds.height : collapsed ? 0 : thickness,
      };
      wrap.classList.add("legend-rail");
      wrap.classList.toggle("legend-rail-collapsed", collapsed);
      wrap.dataset.legendDock = dock;
      wrap.style.setProperty(
        "--plot-legend-rail-width",
        `${String(vertical ? thickness : 0)}px`,
      );
      wrap.style.setProperty(
        "--plot-legend-rail-height",
        `${String(vertical ? 0 : thickness)}px`,
      );
      legend.dataset.dock = dock;
      legend.dataset.collapsed = String(collapsed);
      legend.style.width = vertical ? `${String(thickness)}px` : "100%";
      legend.style.height = vertical ? "100%" : `${String(thickness)}px`;
      legend.style.left = dock === "right" ? "auto" : "0";
      legend.style.right = dock === "left" ? "auto" : "0";
      legend.style.top = dock === "bottom" ? "auto" : "0";
      legend.style.bottom = dock === "top" ? "auto" : "0";
      this.refreshPlotLegendRoster();
      return;
    }
    wrap.classList.remove("legend-rail");
    wrap.classList.remove("legend-rail-collapsed");
    delete wrap.dataset.legendDock;
    wrap.style.removeProperty("--plot-legend-rail-width");
    wrap.style.removeProperty("--plot-legend-rail-height");
    delete legend.dataset.dock;
    delete legend.dataset.collapsed;
    legend.style.removeProperty("bottom");
    if (state === "badge") {
      legend.style.removeProperty("width");
      legend.style.removeProperty("height");
    } else if (this.plotLegendSize !== null) {
      const width = clamp(
        this.plotLegendSize.width,
        140,
        Math.max(140, bounds.width * 0.4),
      );
      const height =
        state === "roster"
          ? clamp(
              this.plotLegendSize.height,
              150,
              Math.max(150, bounds.height - 16),
            )
          : this.plotLegendSize.height;
      this.plotLegendSize = { width, height };
      legend.style.width = `${String(width)}px`;
      if (state === "roster") legend.style.height = `${String(height)}px`;
      else legend.style.removeProperty("height");
    } else {
      legend.style.removeProperty("width");
      legend.style.removeProperty("height");
    }
    const box = legend.getBoundingClientRect();
    const position = this.currentPlotLegendPosition(legend);
    const x = Math.min(
      Math.max(8, position.x),
      Math.max(8, bounds.width - box.width - 8),
    );
    const y = Math.min(
      Math.max(8, position.y),
      Math.max(8, bounds.height - box.height - 8),
    );
    if (this.plotLegendAnchor === null && this.plotLegendPosition !== null)
      this.plotLegendPosition = { x, y };
    legend.style.left = `${String(x)}px`;
    legend.style.top = `${String(y)}px`;
    legend.style.right = "auto";
    this.refreshPlotLegendRoster();
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
      this.renderForMode(this.lastState, this.lastTiles, this.lastWindow);
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

  private focusEntryForRow(
    dimension: LegendDimension,
    row: MatrixLegendRow,
    state: RenderPanelState,
  ): FocusEntry {
    const series = state.series.find((entry) =>
      dimension === "source"
        ? (this.callbacks.catalog().get(entry.ref)?.sourceName ??
            entry.ref.source_key) === row.value
        : entry.ref.channel === row.value,
    );
    return dimension === "source"
      ? {
          kind: "source",
          ref: null,
          source_key: series?.ref.source_key ?? row.value,
          channel: null,
        }
      : { kind: "channel", ref: null, source_key: null, channel: row.value };
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
    else this.callbacks.onFocusSolo(this.id, entry);
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
          this.selectedAnnotationIds.clear();
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
    const popover = document.createElement("div");
    popover.className = "panel-config-popover";
    popover.setAttribute("role", "menu");
    popover.setAttribute("aria-label", label);
    const title = document.createElement("div");
    title.className = "panel-config-title";
    title.textContent = label;
    popover.append(title);
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute(
        "role",
        option.action === true ? "menuitem" : "menuitemradio",
      );
      if (option.action !== true)
        button.setAttribute("aria-checked", String(option.active));
      button.textContent = `${option.active ? "✓ " : option.action === true ? "" : "  "}${option.label}`;
      button.addEventListener("click", () => {
        option.run();
        this.closePanelConfig();
      });
      popover.append(button);
    }
    this.element.append(popover);
    const panelRect = this.element.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    popover.style.left = `${String(
      clamp(
        anchorRect.right - panelRect.left - 190,
        4,
        Math.max(4, panelRect.width - 194),
      ),
    )}px`;
    popover.style.top = `${String(anchorRect.bottom - panelRect.top + 4)}px`;
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && popover.contains(event.target))
        return;
      this.closePanelConfig();
    };
    document.addEventListener("pointerdown", onPointer, { capture: true });
    this.panelConfigCleanup = () => {
      document.removeEventListener("pointerdown", onPointer, {
        capture: true,
      });
      popover.remove();
    };
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
    if (!additive) this.selectedAnnotationIds.clear();
    if (additive && this.selectedAnnotationIds.has(id))
      this.selectedAnnotationIds.delete(id);
    else this.selectedAnnotationIds.add(id);
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
      else this.callbacks.onFocusSolo(this.id, focus);
    }
    this.drawOverlay();
    if (this.lastState !== null) this.updatePlotLegend(this.lastState);
  }

  private pruneAnnotationUiState(state: RenderPanelState): void {
    const ids = new Set(state.annotations.map((annotation) => annotation.id));
    for (const id of this.selectedAnnotationIds) {
      if (!ids.has(id)) this.selectedAnnotationIds.delete(id);
    }
    for (const id of this.annotationOffsets.keys()) {
      if (!ids.has(id)) this.annotationOffsets.delete(id);
    }
    if (
      this.hoveredAnnotationId !== null &&
      !ids.has(this.hoveredAnnotationId)
    ) {
      this.hoveredAnnotationId = null;
    }
  }

  private toggleInlineInspector(state: RenderPanelState, path: string): void {
    this.inspectorPath = this.inspectorPath === path ? null : path;
    this.updatePlotLegend(state);
  }

  private inlineSeriesInspector(
    state: RenderPanelState,
    series: RenderSeries,
  ): HTMLElement {
    const inspector = document.createElement("div");
    inspector.className = "plot-row-inspector";
    inspector.setAttribute("role", "group");
    inspector.setAttribute("aria-label", `${series.path} line properties`);
    const heading = document.createElement("div");
    heading.className = "plot-row-inspector-heading";
    const sample = document.createElement("span");
    sample.className = "plot-legend-swatch";
    sample.style.background = seriesColor(series);
    sample.style.height = `${String(Math.max(1, series.width))}px`;
    const path = document.createElement("span");
    path.textContent = series.path;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close line inspector";
    close.addEventListener("click", () =>
      this.toggleInlineInspector(state, series.path),
    );
    heading.append(sample, path, close);

    const color = document.createElement("div");
    color.className = "plot-row-inspector-field";
    color.classList.toggle("overridden", series.overrideFields.color);
    const colorLabel = document.createElement("span");
    colorLabel.textContent = "color";
    const slots = document.createElement("span");
    slots.className = "plot-row-color-slots";
    for (let slot = 1; slot <= COLOR_SLOTS; slot += 1) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.style.background = `var(--series-${String(slot)})`;
      swatch.classList.toggle(
        "active",
        colorIndexForHue(series.hue) + 1 === slot,
      );
      swatch.setAttribute("aria-label", `Color slot ${String(slot)}`);
      swatch.addEventListener("click", () => {
        this.callbacks.onPatchSeriesStyle(this.id, series.ref, {
          color_slot: slot,
        });
      });
      slots.append(swatch);
    }
    color.append(
      colorLabel,
      slots,
      this.inspectorProvenance(
        series.overrideFields.color,
        `← ${state.color_by ?? "flat"}`,
        () =>
          this.callbacks.onPatchSeriesStyle(this.id, series.ref, {
            color_slot: null,
          }),
      ),
    );

    const line = document.createElement("div");
    line.className = "plot-row-inspector-field";
    line.classList.toggle(
      "overridden",
      series.overrideFields.dash || series.overrideFields.width,
    );
    const lineLabel = document.createElement("span");
    lineLabel.textContent = "line";
    const dashes = document.createElement("span");
    dashes.className = "plot-row-dashes";
    for (const dash of ["solid", "dash", "dot"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = dash;
      button.classList.toggle("active", series.dash === dash);
      button.addEventListener("click", () => {
        this.callbacks.onPatchSeriesStyle(this.id, series.ref, { dash });
      });
      dashes.append(button);
    }
    const width = document.createElement("input");
    width.type = "range";
    width.min = "0.5";
    width.max = "4";
    width.step = "0.25";
    width.value = String(series.width);
    width.setAttribute("aria-label", "Line width");
    const widthValue = document.createElement("span");
    widthValue.textContent = formatToolbarNumber(series.width);
    width.addEventListener("input", () => {
      widthValue.textContent = formatToolbarNumber(Number(width.value));
    });
    width.addEventListener("change", () => {
      this.callbacks.onPatchSeriesStyle(this.id, series.ref, {
        width: Number(width.value),
      });
    });
    line.append(
      lineLabel,
      dashes,
      width,
      widthValue,
      this.inspectorProvenance(
        series.overrideFields.dash || series.overrideFields.width,
        `← ${state.dash_by ?? "flat"} · ${state.width_by ?? "flat"}`,
        () =>
          this.callbacks.onPatchSeriesStyle(this.id, series.ref, {
            dash: null,
            width: null,
          }),
      ),
    );

    const footer = document.createElement("div");
    footer.className = "plot-row-inspector-footer";
    const count = Object.values(series.overrideFields).filter(Boolean).length;
    const summary = document.createElement("span");
    summary.textContent =
      count === 0 ? "no overrides" : `${String(count)} overrides`;
    summary.classList.toggle("active", count > 0);
    const mute = document.createElement("button");
    mute.type = "button";
    mute.textContent = series.visible ? "⌫ mute" : "restore";
    mute.addEventListener("click", () =>
      this.callbacks.onMuteSeries(this.id, series.ref),
    );
    footer.append(summary, mute);
    inspector.append(heading, color, line, footer);
    return inspector;
  }

  private inspectorProvenance(
    overridden: boolean,
    inherited: string,
    revert: () => void,
  ): HTMLElement {
    const control = document.createElement("button");
    control.type = "button";
    control.className = "plot-row-provenance";
    control.textContent = overridden ? "⟲" : inherited;
    control.disabled = !overridden;
    control.title = overridden
      ? "Revert field to its encoding rule"
      : inherited;
    if (overridden) control.addEventListener("click", revert);
    return control;
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

function yLabel(units: readonly (string | null)[]): string {
  const distinct = new Set(
    units.filter((unit): unit is string => unit !== null),
  );
  const [only] = distinct;
  return distinct.size === 1 && only !== undefined
    ? `value (${only})`
    : "value";
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

function formatToolbarNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
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

function emptyLegendStats(): LegendStatValues {
  return { min: null, max: null, mean: null, rms: null, n: null, cursor: null };
}

export function aggregateLegendStats(
  rows: readonly LegendStatValues[],
  mixedUnits = false,
): LegendStatValues {
  const finite = (column: StatColumn): number[] =>
    rows.flatMap((row) => {
      const value = row[column];
      return value === null ? [] : [value];
    });
  const min = finite("min");
  const max = finite("max");
  const weighted = (column: "mean" | "rms"): number | null => {
    let total = 0;
    let weight = 0;
    for (const row of rows) {
      const value = row[column];
      const count = row.n;
      if (
        value === null ||
        count === null ||
        !Number.isFinite(value) ||
        !Number.isFinite(count) ||
        count <= 0
      )
        continue;
      total += column === "rms" ? count * value ** 2 : count * value;
      weight += count;
    }
    if (weight === 0) return null;
    return column === "rms" ? Math.sqrt(total / weight) : total / weight;
  };
  const n = finite("n");
  const cursor = finite("cursor");
  return {
    min: mixedUnits || min.length === 0 ? null : Math.min(...min),
    max: mixedUnits || max.length === 0 ? null : Math.max(...max),
    mean: mixedUnits ? null : weighted("mean"),
    rms: mixedUnits ? null : weighted("rms"),
    n: n.length === 0 ? null : n.reduce((total, value) => total + value, 0),
    cursor: mixedUnits ? null : average(cursor),
  };
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function statGridTemplate(columns: number): string {
  return `minmax(128px, 1fr) minmax(56px, 1fr) repeat(${String(columns)}, 64px)`;
}

function statSpanDomain(
  rows: readonly LegendStatValues[],
): readonly [number, number] | null {
  const minima = rows.flatMap((row) => (row.min === null ? [] : [row.min]));
  const maxima = rows.flatMap((row) => (row.max === null ? [] : [row.max]));
  return minima.length === 0 || maxima.length === 0
    ? null
    : [Math.min(...minima), Math.max(...maxima)];
}

function statSpan(
  values: LegendStatValues,
  domain: readonly [number, number] | null,
  color: string,
): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "plot-stat-span";
  const track = document.createElement("span");
  track.className = "plot-stat-span-track";
  cell.append(track);
  if (values.min === null || values.max === null || domain === null)
    return cell;
  cell.title = `min ${formatStatValue(values.min)} · max ${formatStatValue(values.max)} · μ ${formatStatValue(values.mean)}`;
  const extent = domain[1] - domain[0];
  const position = (value: number): number =>
    extent === 0 ? 50 : ((value - domain[0]) / extent) * 100;
  const band = document.createElement("span");
  band.className = "plot-stat-span-band";
  band.style.background = color;
  band.style.left = `${String(position(values.min))}%`;
  band.style.right = `${String(100 - position(values.max))}%`;
  track.append(band);
  if (values.mean !== null) {
    const mean = document.createElement("span");
    mean.className = "plot-stat-span-mean";
    mean.style.left = `${String(position(values.mean))}%`;
    track.append(mean);
  }
  return cell;
}

function statHistogram(values: readonly (number | null)[]): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "plot-stat-histogram";
  const finite = values.filter((value): value is number => value !== null);
  if (finite.length === 0) return cell;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const bins = Array.from({ length: 7 }, () => 0);
  for (const value of finite) {
    const index =
      max === min
        ? 3
        : Math.min(6, Math.floor(((value - min) / (max - min)) * 7));
    bins[index] = (bins[index] ?? 0) + 1;
  }
  const peak = Math.max(...bins);
  for (const count of bins) {
    const bar = document.createElement("span");
    bar.style.height = `${String((count / peak) * 100)}%`;
    cell.append(bar);
  }
  return cell;
}

function statColumnLabel(
  column: StatColumn,
  unit: string | null = null,
): string {
  const label =
    column === "mean"
      ? "μ"
      : column === "cursor"
        ? "@CUR"
        : column.toUpperCase();
  return unit === null || unit === "" ? label : `${label} (${unit})`;
}

function statCell(
  value: number | null,
  column: StatColumn,
  unit: string | null = null,
): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "plot-stat-cell";
  cell.dataset.column = column;
  if (unit !== null && unit !== "") cell.dataset.unit = unit;
  setStatCellValue(cell, value, unit);
  return cell;
}

function setStatCellValue(
  cell: HTMLElement,
  value: number | null,
  unit: string | null,
): void {
  cell.replaceChildren(formatStatValue(value));
  if (value !== null && unit !== null && unit !== "") {
    const suffix = document.createElement("span");
    suffix.className = "plot-stat-unit";
    suffix.textContent = ` ${unit}`;
    cell.append(suffix);
  }
}

function formatStatValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0.000";
  const absolute = Math.abs(value);
  if (absolute >= 10_000 || absolute < 0.001) return value.toExponential(3);
  return Number(value.toPrecision(4)).toString();
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function safeFilename(value: string): string {
  const safe = value.trim().replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  return safe === "" ? "panel" : safe;
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function panelMarkup(): string {
  return `<header class="panel-header">
      <span class="panel-toolbar-group panel-toolbar-binding">
        <span class="drag-handle" aria-hidden="true">⠿</span>
        <span class="panel-title"></span>
        <span class="panel-bindings"></span>
      </span>
      <span class="panel-toolbar-separator" aria-hidden="true"></span>
      <span class="panel-toolbar-group panel-toolbar-axes">
        <button class="panel-action panel-axis-toggle" title="Switch axis presentation">axes: gutter</button>
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
      </span>
      <span class="panel-actions">
        <span class="panel-split-actions" aria-label="Split panel" role="group">
          <button class="panel-action panel-split-right" aria-label="Split panel right" title="Split panel right — new panel">→</button>
          <button class="panel-action panel-split-down" aria-label="Split panel down" title="Split panel down — new panel">↓</button>
        </span>
        <button class="panel-action panel-maximize" title="Maximize panel">${MAXIMIZE_GLYPH}</button>
        <button class="panel-action panel-close" title="Close panel">✕</button>
      </span>
    </header>
    <div class="plot-wrap">
      <div class="chart-host" hidden></div>
      <canvas class="overlay-canvas" aria-hidden="true"></canvas>
      <div class="plot-series-legend" aria-label="Plot legend"></div>
      <div class="panel-empty" hidden></div>
    </div>`;
}

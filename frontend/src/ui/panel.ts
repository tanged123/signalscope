import {
  columnsValueAtTime,
  type ColumnarTileResponse,
} from "../app/bin-columns";
import type { Catalog } from "../app/catalog";
import {
  appliedOverrides,
  overrideFor,
  type ResolvedSeries,
} from "../app/resolution";
import { virtualSlice } from "../app/outline-model";
import { compileGlob, evaluateSelector } from "../app/selector";
import type {
  AxisStyle,
  Binding,
  DashStyle,
  FocusEntry,
  LegendAnchor,
  LegendState,
  NamedSet,
  PanelState,
  SeriesRef,
  SeriesOverride,
  StyleDimension,
} from "../generated/session";
import {
  clamp,
  formatValue,
  insidePlot,
  projectX,
  projectY,
  type PlotLayout,
  type Range,
} from "../app/plot-math";
import { resolveRanges } from "../app/plot-gestures";
import {
  prepareTimePlot,
  type AnnotationAnchor,
  type PlotCursor,
  type PlotDelta,
  type PreparedPlot,
  type ResolvedAnnotation,
  type SeriesHitAdapter,
} from "../app/plot-capabilities";
import {
  COLOR_SLOTS,
  invalidatePalette,
  resolvePalette,
} from "../render/plot-theme";
import { ChartHost, type ChartRenderRequest } from "../render/chart-host";
import type { GpuContext } from "../render/gpu-context";

const CHART_HOST_RETRY_DELAYS_MS = [
  100, 250, 500, 1_000, 2_000, 4_000,
] as const;
import {
  OverlayRenderer,
  marker,
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
  delta: PlotDelta | null;
}

function colorIndexForHue(hue: number | null): number {
  if (hue === null) return 0;
  return Math.max(0, Math.min(COLOR_SLOTS - 1, Math.trunc(hue) - 1));
}

export function effectiveAxisStyle(
  _mode: RenderPanelState["mode"],
  _style: AxisStyle,
): AxisStyle {
  void _mode;
  void _style;
  return "gutter";
}

export type QuickTransform = "gradient" | "cumtrapz" | "movmean" | "abs";

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
  onEditAnnotationLabel(id: string, annotationId: string, label: string): void;
  onFitView(id: string): void;
  onToggleStats(id: string): void;
  onToggleAxisStyle(id: string): void;
  onRenameTitle(id: string, title: string): void;
  onEditAxisLabel(id: string, axis: "x" | "y", label: string | null): void;
  onSetColorBy(id: string, dimension: StyleDimension): void;
  onRemoveOverride(id: string, index: number): void;
  onClearOverrides(id: string): void;
  onSetSeriesStyle(
    id: string,
    ref: SeriesRef,
    style: { color_slot: number; dash: DashStyle; width: number },
  ): void;
  onRemoveSeries(id: string, ref: SeriesRef): void;
  onQuickTransform(id: string, path: string, kind: QuickTransform): void;
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

export interface FocusChip {
  entry: FocusEntry;
  label: string;
  hue: number | null;
  overridden: boolean;
}

export interface BindingChipEntry {
  label: string;
  bindingIndex: number;
  kind: Binding["kind"];
  refs: SeriesRef[];
  selector: string | null;
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

export function focusChips(
  catalog: Catalog,
  state: Pick<RenderPanelState, "series" | "focus">,
  limit = 8,
): { chips: FocusChip[]; overflow: number } {
  const chips = state.focus.map((entry) => {
    const matching = state.series.filter((series) =>
      focusMatches(entry, series.ref),
    );
    const first = matching[0];
    const label =
      entry.kind === "series"
        ? (first?.path ?? entry.ref?.channel ?? "series")
        : entry.kind === "source"
          ? (catalog.get(
              first?.ref ?? { source_key: entry.source_key ?? "", channel: "" },
            )?.sourceName ??
            entry.source_key ??
            "source")
          : (entry.channel ?? "channel");
    return {
      entry,
      label,
      hue: first?.hue ?? null,
      overridden: matching.some((series) => series.overridden),
    };
  });
  return {
    chips: chips.slice(0, limit),
    overflow: Math.max(0, chips.length - limit),
  };
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

function focusSelector(entry: FocusEntry, sourceName?: string): string {
  if (entry.kind === "source")
    return `* @ ${sourceName ?? entry.source_key ?? "*"}`;
  if (entry.kind === "channel") return `${entry.channel ?? "*"} @ *`;
  return entry.ref === null
    ? "*"
    : `${entry.ref.channel} @ ${entry.ref.source_key}`;
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
  private hoverPoint: { x: number; y: number } | null = null;
  private hoverTag: HTMLElement | null = null;
  private inspectorPath: string | null = null;
  private inspectorCleanup: (() => void) | null = null;
  private bindingCleanup: (() => void) | null = null;
  private rulesCleanup: (() => void) | null = null;
  private panelConfigCleanup: (() => void) | null = null;
  private plotLegendPosition: { x: number; y: number } | null = null;
  private plotLegendSize: { width: number; height: number } | null = null;
  private plotLegendAnchor: LegendAnchor | null = null;

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
          : axisEditZone(
              layout,
              effectiveAxisStyle(state.mode, state.axis_style),
              x,
              y,
            );
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
    this.chartHostReady = ChartHost.create(this.chartHostElement, gpu)
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
    required(this.element, ".panel-ghost-toggle").addEventListener(
      "click",
      () => {
        this.callbacks.onToggleGhostMode(this.id);
      },
    );
    required(this.element, ".panel-config-toggle").addEventListener(
      "click",
      (event) => {
        if (this.lastState !== null)
          this.openPanelConfig(
            this.lastState,
            event.currentTarget as HTMLElement,
          );
      },
    );
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (this.emphasizePaths !== null) this.clearHover();
        else this.callbacks.onClearFocus(this.id);
        this.closeBindingPopover();
        this.closePanelConfig();
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
      if (this.interactions.isDragging()) return;
      const layout = this.activeLayout();
      const inside =
        layout !== null && insidePlot(layout, event.offsetX, event.offsetY);
      const cursor =
        layout !== null && inside
          ? this.cursorAt(layout, event.offsetX, event.offsetY, 40)
          : null;
      if (layout !== null && inside) {
        this.updateHover(
          event.offsetX,
          event.offsetY,
          event.clientX,
          event.clientY,
        );
      } else {
        this.clearHover();
      }
      this.callbacks.onCursor(
        this.id,
        cursor,
        cursor === null ? null : { x: event.clientX, y: event.clientY },
      );
    });
    this.overlay.addEventListener("pointerleave", () => {
      if (!this.interactions.isDragging()) {
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
    axisToggle.hidden = true;
    this.updateBindings(rendered);
    this.updateGhostToggle(rendered);
    this.updateLegend(rendered);
    const annotations = this.resolvedAnnotations(rendered);
    this.renderAnnotationList(rendered, annotations);
    this.renderStats();
    this.drawOverlay(annotations);
    if (
      this.inspectorPath !== null &&
      !rendered.series.some((series) => series.path === this.inspectorPath)
    ) {
      this.closeInspector();
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
    this.renderStats();
    const annotations = this.resolvedAnnotations(rendered);
    this.renderAnnotationList(rendered, annotations);
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
        width: series?.width ?? 1.4,
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
      if (this.removeAt(offsetX, offsetY, 9)) return;
      if (this.pinAt(offsetX, offsetY, 14)) return;
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

  private updateHover(
    offsetX: number,
    offsetY: number,
    clientX: number,
    clientY: number,
  ): void {
    const hit = this.seriesHit(offsetX, offsetY, 6);
    if (hit === null) {
      this.clearHover();
      return;
    }
    this.hoverPoint = { x: offsetX, y: offsetY };
    this.setEmphasis(hit.path);
    this.showHoverTag(hit.path, clientX, clientY);
  }

  private showHoverTag(path: string, clientX: number, clientY: number): void {
    const series = this.lastState?.series.find((entry) => entry.path === path);
    if (series === undefined) return;
    const panelRect = this.element.getBoundingClientRect();
    const tag = this.hoverTag ?? document.createElement("div");
    this.hoverTag = tag;
    tag.className = "plot-hover-tag";
    tag.textContent = `${series.path} — ⇧click to focus`;
    tag.hidden = false;
    this.element.append(tag);
    const tagRect = tag.getBoundingClientRect();
    tag.style.left = `${String(
      clamp(
        clientX - panelRect.left + 10,
        4,
        Math.max(4, panelRect.width - tagRect.width - 4),
      ),
    )}px`;
    tag.style.top = `${String(
      clamp(
        clientY - panelRect.top + 10,
        4,
        Math.max(4, panelRect.height - tagRect.height - 4),
      ),
    )}px`;
  }

  private clearHover(): void {
    this.hoverPoint = null;
    this.setEmphasis(null);
    if (this.hoverTag !== null) {
      this.hoverTag.hidden = true;
      this.hoverTag.remove();
      this.hoverTag = null;
    }
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
    if (this.hoverPoint !== null) {
      const canvasRect = this.overlay.getBoundingClientRect();
      this.showHoverTag(
        wrapped.entry.path,
        canvasRect.left + this.hoverPoint.x,
        canvasRect.top + this.hoverPoint.y,
      );
    }
  }

  /** Removes the annotation under the pixel; true when one was removed. */
  private removeAt(offsetX: number, offsetY: number, radius: number): boolean {
    const layout = this.activeLayout();
    const state = this.lastState;
    const prepared = this.preparedPlot;
    if (layout === null || state === null || prepared === null) return false;
    const annotation = state.annotations
      .map((entry) => prepared.resolveAnnotation(entry))
      .filter((entry) => entry !== null)
      .find(
        (entry) =>
          Math.hypot(
            projectX(layout, entry.x) - offsetX,
            projectY(layout, entry.y) - offsetY,
          ) <= radius,
      );
    if (annotation === undefined) return false;
    this.callbacks.onRemoveAnnotation(this.id, annotation.annotation.id);
    return true;
  }

  /** Pins the nearest plotted vertex under the pixel, when one is in range. */
  private pinAt(offsetX: number, offsetY: number, radius: number): boolean {
    const layout = this.activeLayout();
    if (layout === null) return false;
    const hit = this.preparedPlot?.annotationAt(
      layout,
      { x: offsetX, y: offsetY },
      radius,
    );
    if (hit !== null && hit !== undefined) {
      this.callbacks.onPinAnnotation(this.id, hit);
      return true;
    }
    return false;
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
    if (prepared === null) return { resolved: [], delta: null };
    const resolved = state.annotations
      .map((annotation) => prepared.resolveAnnotation(annotation))
      .filter((annotation) => annotation !== null);
    return { resolved, delta: prepared.delta(resolved) };
  }

  private drawOverlay(resolution?: ResolvedAnnotations): void {
    const state = this.lastState;
    const { resolved, delta } =
      resolution ??
      (state === null
        ? { resolved: [], delta: null }
        : this.resolvedAnnotations(state));
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
      annotations: resolved.map((annotation) => {
        const series = bySeries.get(annotation.annotation.series_path);
        return {
          x: annotation.x,
          y: annotation.y,
          colorIndex:
            series === undefined
              ? annotation.colorIndex
              : series.hue === null
                ? null
                : colorIndexForHue(series.hue),
          label: `${annotation.annotation.label === "" ? "" : `${annotation.annotation.label} `}${annotation.summary}`,
        };
      }),
      delta,
    });
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

  private renderStats(): void {
    const strip = required<HTMLElement>(this.element, ".panel-stats");
    const state = this.lastState;
    const show = state !== null && state.show_stats;
    strip.hidden = !show;
    if (!show) {
      strip.replaceChildren();
      return;
    }
    const groups = this.preparedPlot?.stats() ?? [];
    if (groups.length === 0) {
      strip.hidden = true;
      strip.replaceChildren();
      return;
    }
    const rows = groups.map((group) => {
      const row = document.createElement("span");
      row.className = "stats-series";
      row.append(
        statsName(group.label),
        ...group.items.map((item) =>
          statsItem(
            item.label === "mean" ? "μ" : item.label,
            item.value,
            item.unit,
          ),
        ),
      );
      return row;
    });
    const hint = document.createElement("span");
    hint.className = "stats-hint";
    hint.textContent = "visible region · S toggles";
    strip.replaceChildren(...rows, hint);
  }

  private renderAnnotationList(
    state: RenderPanelState,
    resolution: ResolvedAnnotations,
  ): void {
    const list = required<HTMLElement>(this.element, ".panel-annotations");
    const prepared = this.preparedPlot;
    const annotations = prepared === null ? [] : state.annotations;
    list.hidden = annotations.length === 0;
    if (annotations.length === 0) {
      list.replaceChildren();
      return;
    }
    const heading = document.createElement("div");
    heading.className = "annotations-heading";
    heading.textContent = `ANNOTATIONS — ${state.title.toUpperCase()}`;
    const resolvedById = new Map(
      resolution.resolved.map((entry) => [entry.annotation.id, entry]),
    );
    const rows = annotations.map((annotation, index) => {
      const row = document.createElement("div");
      row.className = "annotation-row";
      const text = document.createElement("span");
      text.className = "annotation-text";
      const current = resolvedById.get(annotation.id);
      text.textContent =
        `${marker(index)} t ${formatValue(annotation.anchor)} · ${current?.summary ?? "unavailable"}` +
        (annotation.label === "" ? "" : ` "${annotation.label}"`);
      const edit = document.createElement("button");
      edit.className = "annotation-action";
      edit.textContent = "✎";
      edit.title = "Edit label";
      edit.addEventListener("click", () => {
        this.openAnnotationLabelEditor(row, annotation.id, annotation.label);
      });
      const remove = document.createElement("button");
      remove.className = "annotation-action";
      remove.textContent = "✕";
      remove.title = "Delete annotation";
      remove.addEventListener("click", () => {
        this.callbacks.onRemoveAnnotation(this.id, annotation.id);
      });
      row.append(text, edit, remove);
      return row;
    });
    const deltaRow = document.createElement("div");
    deltaRow.className = "annotation-delta";
    deltaRow.textContent = resolution.delta?.label ?? "";
    list.replaceChildren(
      heading,
      ...rows,
      ...(resolution.delta === null ? [] : [deltaRow]),
    );
  }

  private openAnnotationLabelEditor(
    row: HTMLElement,
    annotationId: string,
    current: string,
  ): void {
    const input = document.createElement("input");
    input.className = "annotation-label-input";
    input.value = current;
    input.setAttribute("aria-label", "Annotation label");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        input.value = current;
        input.blur();
      }
      event.stopPropagation();
    });
    input.addEventListener("blur", () => {
      this.callbacks.onEditAnnotationLabel(
        this.id,
        annotationId,
        input.value.trim(),
      );
    });
    row.append(input);
    input.focus();
    input.select();
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
    const legend = required<HTMLElement>(this.element, ".plot-series-legend");
    const wrap = required<HTMLElement>(this.element, ".plot-wrap");
    if (state.series.length === 0) {
      legend.hidden = true;
      legend.replaceChildren();
      delete legend.dataset.state;
      delete legend.dataset.collapsed;
      wrap.classList.remove("legend-dock-preview");
      wrap.classList.remove("legend-rail");
      wrap.classList.remove("legend-rail-collapsed");
      wrap.style.removeProperty("--plot-legend-rail-width");
      return;
    }
    legend.hidden = false;
    wrap.classList.remove("legend-dock-preview");
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
      drag.title = "Drag plot legend; End docks it right";
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
        `${String(ghosts)} ghosts`;
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
      header.classList.add("plot-legend-rail-header");
      const title = document.createElement("span");
      title.className = "plot-legend-title";
      title.textContent = `${String(state.series.length)} ▾`;
      const undock = document.createElement("button");
      undock.className = "plot-legend-undock";
      undock.type = "button";
      undock.textContent = "⇥";
      undock.title = "Return legend to floating roster";
      undock.addEventListener("click", () => this.floatPlotLegend(legend));
      header.append(title, undock);
      legend.replaceChildren(
        header,
        this.plotLegendRoster(state),
        this.legendResizeHandle("left", legend),
      );
      this.positionPlotLegend();
      return;
    }
    const drag = document.createElement("button");
    drag.className = "plot-legend-drag";
    drag.type = "button";
    drag.textContent = "⠿";
    drag.title = "Drag plot legend; arrow keys move it; End docks it right";
    this.bindPlotLegendDrag(drag, legend);
    const title = document.createElement("button");
    title.className = "plot-legend-title";
    title.type = "button";
    title.textContent = `${String(state.series.length)}${
      state.legend_state === "roster" ? " series" : ""
    } ▾`;
    title.title =
      state.legend_state === "roster" ? "Show focused keys" : "Show roster";
    title.addEventListener("click", () => {
      this.callbacks.onLegendLayout(this.id, {
        state: state.legend_state === "roster" ? "keys" : "roster",
      });
    });
    const rules = this.colorRuleToken(state);
    rules.textContent += " ▾";
    const collapse = document.createElement("button");
    collapse.className = "plot-legend-collapse";
    collapse.type = "button";
    collapse.textContent = "⌄";
    collapse.title = "Collapse legend to badge";
    collapse.addEventListener("click", () => {
      this.callbacks.onLegendLayout(this.id, { state: "badge" });
    });
    header.append(drag, title, rules, collapse);

    const content =
      state.legend_state === "roster"
        ? this.plotLegendRoster(state)
        : this.plotLegendKeys(state);
    const rightResize = this.legendResizeHandle("right", legend);
    const bottomResize = this.legendResizeHandle("bottom", legend);
    const cornerResize = this.legendResizeHandle("corner", legend);
    legend.replaceChildren(
      header,
      content,
      rightResize,
      bottomResize,
      cornerResize,
    );
    this.positionPlotLegend();
  }

  private plotLegendKeys(state: RenderPanelState): HTMLElement {
    const content = document.createElement("div");
    content.className = "plot-legend-content plot-legend-keys";
    const focusRows = document.createElement("div");
    focusRows.className = "plot-legend-focus-rows";
    const focus = focusChips(
      this.callbacks.catalog(),
      state,
      Number.POSITIVE_INFINITY,
    );
    for (const entry of focus.chips) {
      focusRows.append(this.plotLegendFocusRow(state, entry));
    }
    const ghosts = state.series.filter(
      (series) => series.visible && series.display === "ghost",
    ).length;
    const footer = document.createElement("button");
    footer.className = "plot-legend-footer";
    footer.type = "button";
    footer.textContent = `${String(ghosts)} ghosts ▾`;
    footer.addEventListener("click", () => {
      this.callbacks.onLegendLayout(this.id, { state: "roster" });
    });
    content.append(focusRows, footer);
    if (
      state.focus.length === 0 &&
      ghosts > 0 &&
      !state.legend_hint_dismissed
    ) {
      const hint = document.createElement("button");
      hint.className = "plot-legend-hint";
      hint.type = "button";
      hint.textContent = "hover a ghost to explore · click to focus  ×";
      hint.title = "Dismiss hint";
      hint.addEventListener("click", () => {
        this.callbacks.onLegendLayout(this.id, { hintDismissed: true });
      });
      content.append(hint);
    }
    return content;
  }

  private plotLegendFocusRow(
    state: RenderPanelState,
    entry: FocusChip,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "plot-legend-row";
    const matching = state.series.filter(
      (series) => series.visible && focusMatches(entry.entry, series.ref),
    );
    const paths = matching.map((series) => series.path);
    const primary = matching.length === 1 ? matching[0] : undefined;
    const action = document.createElement("button");
    action.className = "plot-legend-row-action";
    action.type = "button";
    action.innerHTML =
      '<span class="plot-legend-swatch"></span><span class="plot-legend-label"></span><span class="plot-legend-value">—</span><span class="plot-legend-unit"></span>';
    const swatch = required<HTMLElement>(action, ".plot-legend-swatch");
    swatch.style.background =
      entry.hue === null
        ? "var(--fg-4)"
        : `var(--series-${String(colorIndexForHue(entry.hue) + 1)})`;
    required<HTMLElement>(action, ".plot-legend-label").textContent =
      `${entry.overridden ? "◆ " : ""}${entry.label}`;
    const value = required<HTMLElement>(action, ".plot-legend-value");
    if (primary !== undefined) value.dataset.path = primary.path;
    required<HTMLElement>(action, ".plot-legend-unit").textContent =
      primary === undefined
        ? ""
        : (this.callbacks.catalog().get(primary.ref)?.summary.unit ?? "");
    action.addEventListener("mouseenter", () => this.setEmphasis(paths));
    action.addEventListener("mouseleave", () => this.setEmphasis(null));
    action.addEventListener("click", (event) => {
      if (event.altKey) {
        if (entry.entry.kind === "series" && entry.entry.ref !== null)
          this.callbacks.onMuteSeries(this.id, entry.entry.ref);
        else
          this.callbacks.onMuteSelector(
            this.id,
            focusSelector(
              entry.entry,
              primary === undefined
                ? undefined
                : this.callbacks.catalog().get(primary.ref)?.sourceName,
            ),
          );
      } else {
        this.callbacks.onFocusSolo(this.id, entry.entry);
      }
    });
    const remove = document.createElement("button");
    remove.className = "plot-legend-remove";
    remove.type = "button";
    remove.textContent = "✕";
    remove.title = `Remove focus: ${entry.label}`;
    remove.addEventListener("click", () => {
      this.callbacks.onFocusToggle(this.id, entry.entry);
    });
    row.append(action, remove);
    this.updateLegendValue(value);
    return row;
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
    const focusTitle = document.createElement("div");
    focusTitle.className = "plot-legend-section-title";
    focusTitle.textContent = `FOCUS ${String(state.focus.length)}`;
    const focusRows = document.createElement("div");
    focusRows.className = "plot-legend-focus-rows";
    for (const entry of focusChips(
      this.callbacks.catalog(),
      state,
      Number.POSITIVE_INFINITY,
    ).chips) {
      focusRows.append(this.plotLegendFocusRow(state, entry));
    }
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
    const renderRows = (): void => {
      const all = matrixLegendRows(
        this.callbacks.catalog(),
        state,
        dimension,
        search.value,
      );
      groupTitle.textContent = `▾ ${dimension.toUpperCase()} · ${String(all.length)}`;
      searchMeta.textContent = `${String(all.length)} match · ⏎ focus · ⌥⏎ mute`;
      const slice = virtualSlice(
        all.length,
        rows.scrollTop,
        rows.clientHeight || 168,
        24,
      );
      viewport.replaceChildren();
      viewport.style.height = `${String(slice.totalHeight)}px`;
      for (const [offset, item] of all
        .slice(slice.start, slice.end)
        .entries()) {
        const button = document.createElement("button");
        button.className = "plot-legend-roster-row";
        button.type = "button";
        button.style.top = `${String(slice.topPadding + offset * 24)}px`;
        button.innerHTML =
          '<span class="plot-legend-swatch"></span><span class="plot-legend-label"></span><span class="plot-legend-count"></span>';
        const swatch = required<HTMLElement>(button, ".plot-legend-swatch");
        swatch.style.background =
          item.hue === null
            ? "var(--fg-4)"
            : `var(--series-${String(colorIndexForHue(item.hue) + 1)})`;
        required<HTMLElement>(button, ".plot-legend-label").textContent =
          `${item.overridden ? "◆ " : ""}${item.label}`;
        required<HTMLElement>(button, ".plot-legend-count").textContent =
          `×${String(item.count)}`;
        const matching = state.series.filter((series) =>
          dimension === "source"
            ? (this.callbacks.catalog().get(series.ref)?.sourceName ??
                series.ref.source_key) === item.value
            : series.ref.channel === item.value,
        );
        const paths = matching.map((series) => series.path);
        button.addEventListener("mouseenter", () => this.setEmphasis(paths));
        button.addEventListener("mouseleave", () => this.setEmphasis(null));
        button.addEventListener("click", (event) => {
          const entry = this.focusEntryForRow(dimension, item, state);
          if (event.altKey)
            this.callbacks.onMuteSelector(this.id, item.selector);
          else this.callbacks.onFocusToggle(this.id, entry);
        });
        viewport.append(button);
      }
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
      else
        this.callbacks.onFocusToggle(
          this.id,
          this.focusEntryForRow(dimension, first, state),
        );
    });
    rows.addEventListener("scroll", renderRows);
    rows.append(viewport);
    group.append(groupTitle, rows);
    const footer = document.createElement("button");
    footer.className = "plot-legend-footer";
    footer.type = "button";
    const ghosts = state.series.filter(
      (series) => series.visible && series.display === "ghost",
    ).length;
    footer.textContent = `${String(ghosts)} ghosts ▾`;
    footer.addEventListener("click", () => {
      search.value = "";
      search.focus();
      renderRows();
    });
    content.append(searchWrap, focusTitle, focusRows, group, footer);
    renderRows();
    return content;
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
    for (const value of this.element.querySelectorAll<HTMLElement>(
      ".plot-legend-value",
    )) {
      this.updateLegendValue(value);
    }
  }

  private legendResizeHandle(
    edge: "left" | "right" | "bottom" | "corner",
    legend: HTMLElement,
  ): HTMLButtonElement {
    const resize = document.createElement("button");
    resize.className = `plot-legend-resize plot-legend-resize-${edge}`;
    if (edge === "left") resize.classList.add("dock-resize-handle");
    resize.type = "button";
    resize.title =
      edge === "left"
        ? "Resize or collapse docked legend"
        : `Resize plot legend from the ${edge}`;
    resize.setAttribute("aria-label", resize.title);
    this.bindPlotLegendResize(resize, legend, edge);
    return resize;
  }

  private bindPlotLegendResize(
    handle: HTMLButtonElement,
    legend: HTMLElement,
    edge: "left" | "right" | "bottom" | "corner",
  ): void {
    let railRequested = edge === "left";
    let requestedWidth: number | null = null;
    const resize = (width: number, height: number): void => {
      const box = legend.getBoundingClientRect();
      const bounds = legend.parentElement?.getBoundingClientRect();
      requestedWidth = width;
      if (edge !== "left") {
        this.plotLegendPosition = this.currentPlotLegendPosition(legend);
        this.plotLegendAnchor = null;
        railRequested ||=
          bounds !== undefined &&
          (width > bounds.width * 0.4 || height > bounds.height * 0.6);
      }
      this.plotLegendSize = {
        width:
          edge === "bottom"
            ? box.width
            : edge === "left" && width < LEGEND_RAIL_COLLAPSE
              ? 0
              : width || box.width,
        height:
          edge === "right" || edge === "left"
            ? box.height
            : height || box.height,
      };
      this.positionPlotLegend();
    };
    const commit = (): void => {
      if (this.plotLegendSize === null) return;
      if (edge === "left") {
        const bounds = legend.parentElement?.getBoundingClientRect();
        const rawWidth = requestedWidth ?? legend.getBoundingClientRect().width;
        const width =
          rawWidth < LEGEND_RAIL_COLLAPSE
            ? 0
            : clamp(
                rawWidth,
                LEGEND_RAIL_MIN,
                Math.max(LEGEND_RAIL_MIN, (bounds?.width ?? rawWidth) * 0.45),
              );
        this.callbacks.onLegendLayout(this.id, {
          state: "rail",
          position: null,
          size: [width, bounds?.height ?? this.plotLegendSize.height],
          anchor: null,
        });
        return;
      }
      const nextState: LegendState = railRequested
        ? "rail"
        : this.plotLegendSize.height >= 150
          ? "roster"
          : "keys";
      this.callbacks.onLegendLayout(this.id, {
        state: nextState,
        position:
          nextState === "rail" || this.plotLegendPosition === null
            ? null
            : [this.plotLegendPosition.x, this.plotLegendPosition.y],
        size: [this.plotLegendSize.width, this.plotLegendSize.height],
        anchor: null,
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
      if (
        edge === "left" &&
        ((legend.dataset.collapsed === "true" && event.key === "ArrowLeft") ||
          (legend.dataset.collapsed !== "true" &&
            event.key === "ArrowRight" &&
            box.width <= LEGEND_RAIL_MIN))
      ) {
        resize(
          legend.dataset.collapsed === "true" ? LEGEND_RAIL_DEFAULT : 0,
          box.height,
        );
        commit();
        return;
      }
      const step = event.shiftKey ? 48 : 16;
      resize(
        box.width + direction[0] * step * (edge === "left" ? -1 : 1),
        box.height + direction[1] * step,
      );
      commit();
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const box = legend.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      const move = (next: PointerEvent): void => {
        if (next.pointerId !== event.pointerId) return;
        resize(
          box.width + (next.clientX - start.x) * (edge === "left" ? -1 : 1),
          box.height + next.clientY - start.y,
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
        this.dockPlotLegend(legend);
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
        legend.parentElement?.classList.toggle(
          "legend-dock-preview",
          this.plotLegendNearRightEdge(legend),
        );
      };
      const end = (next: PointerEvent): void => {
        if (next.pointerId !== event.pointerId) return;
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        document.removeEventListener("pointercancel", end);
        legend.parentElement?.classList.remove("legend-dock-preview");
        if (this.plotLegendTouchesRightEdge(legend)) {
          this.dockPlotLegend(legend);
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
    });
  }

  private dockPlotLegend(legend: HTMLElement): void {
    const box = legend.getBoundingClientRect();
    this.callbacks.onLegendLayout(this.id, {
      state: "rail",
      position: null,
      size: [box.width, box.height],
      anchor: null,
    });
  }

  private plotLegendTouchesRightEdge(legend: HTMLElement): boolean {
    return this.plotLegendRightEdgeDistance(legend) <= 20;
  }

  private plotLegendNearRightEdge(legend: HTMLElement): boolean {
    return this.plotLegendRightEdgeDistance(legend) <= 56;
  }

  private plotLegendRightEdgeDistance(legend: HTMLElement): number {
    const wrap = legend.parentElement;
    if (wrap === null) return Number.POSITIVE_INFINITY;
    const bounds = wrap.getBoundingClientRect();
    const box = legend.getBoundingClientRect();
    const position = this.currentPlotLegendPosition(legend);
    return bounds.width - position.x - box.width;
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
      const requestedWidth = this.plotLegendSize?.width ?? LEGEND_RAIL_DEFAULT;
      const collapsed = requestedWidth < LEGEND_RAIL_COLLAPSE;
      const width = collapsed
        ? DOCK_SEAM_WIDTH
        : clamp(
            requestedWidth,
            LEGEND_RAIL_MIN,
            Math.max(LEGEND_RAIL_MIN, bounds.width * 0.45),
          );
      this.plotLegendSize = {
        width: collapsed ? 0 : width,
        height: bounds.height,
      };
      wrap.classList.add("legend-rail");
      wrap.classList.toggle("legend-rail-collapsed", collapsed);
      wrap.style.setProperty("--plot-legend-rail-width", `${String(width)}px`);
      legend.dataset.collapsed = String(collapsed);
      legend.style.width = `${String(width)}px`;
      legend.style.height = "100%";
      legend.style.left = "auto";
      legend.style.top = "0";
      legend.style.right = "0";
      this.refreshPlotLegendRoster();
      return;
    }
    wrap.classList.remove("legend-rail");
    wrap.classList.remove("legend-rail-collapsed");
    wrap.style.removeProperty("--plot-legend-rail-width");
    delete legend.dataset.collapsed;
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
  }

  private colorRuleToken(state: RenderPanelState): HTMLButtonElement {
    const token = document.createElement("button");
    token.className = "color-rule-token";
    token.type = "button";
    token.textContent = `color ← ${state.color_by}`;
    token.title = "Choose a color rule and review overrides";
    token.addEventListener("click", (event) => {
      this.openRulesPopover(state, event.currentTarget as HTMLElement);
    });
    return token;
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

  private updateGhostToggle(state: RenderPanelState): void {
    const toggle = required<HTMLButtonElement>(
      this.element,
      ".panel-ghost-toggle",
    );
    const ghost = state.ghost_mode === "ghost";
    toggle.textContent = ghost ? "ghost" : "all";
    toggle.title = ghost
      ? "Show all series"
      : "Show focused and rule-matched series only";
    toggle.setAttribute("aria-pressed", String(ghost));
  }

  private setEmphasis(paths: readonly string[] | string | null): void {
    const next =
      paths === null
        ? null
        : new Set(typeof paths === "string" ? [paths] : paths);
    if (setsEqual(this.emphasizePaths, next)) return;
    this.emphasizePaths = next;
    if (this.lastState !== null && this.lastWindow !== null) {
      this.renderForMode(this.lastState, this.lastTiles, this.lastWindow);
      this.drawOverlay(this.resolvedAnnotations(this.lastState));
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
    removeBinding.textContent = "remove binding";
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
          const rect = path.getBoundingClientRect();
          this.closeBindingPopover();
          this.openInspector(path.textContent, rect.left, rect.bottom);
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

  private openPanelConfig(state: RenderPanelState, anchor: HTMLElement): void {
    this.closePanelConfig();
    const popover = document.createElement("div");
    popover.className = "panel-config-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Panel configuration");
    const title = document.createElement("div");
    title.className = "panel-config-title";
    title.textContent = "PANEL CONFIG";
    const lineStyle = document.createElement("button");
    lineStyle.type = "button";
    const overridden = state.overrides.some(
      (override) => override.dash !== null || override.width !== null,
    );
    lineStyle.textContent = overridden
      ? "line style ◆ overridden"
      : "line style flat";
    lineStyle.addEventListener("click", () => {
      this.closePanelConfig();
      this.openRulesPopover(state, anchor);
    });
    const stats = document.createElement("button");
    stats.type = "button";
    stats.textContent = `statistics ${state.show_stats ? "on" : "off"}`;
    stats.addEventListener("click", () => {
      this.callbacks.onToggleStats(this.id);
      this.closePanelConfig();
    });
    popover.append(title, lineStyle, stats);
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

  private openRulesPopover(state: RenderPanelState, anchor: HTMLElement): void {
    this.closeRulesPopover();
    const popover = document.createElement("div");
    popover.className = "rules-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Color rules");
    const heading = document.createElement("div");
    heading.className = "rules-popover-title";
    const panelNumber = /^panel-(\d+)$/.exec(this.id)?.[1] ?? this.id;
    heading.textContent = `STYLE RULES — PANEL ${panelNumber}`;
    const rules = document.createElement("div");
    rules.className = "rules-rule-list";
    const colorRow = document.createElement("div");
    colorRow.className = "rules-rule-row rules-color-rule";
    const colorDimension = document.createElement("button");
    colorDimension.type = "button";
    colorDimension.className = "rules-color-dimension";
    colorDimension.textContent = `color ← ${state.color_by}`;
    colorDimension.setAttribute("aria-expanded", "false");
    const palette = document.createElement("span");
    palette.className = "rules-palette";
    for (let index = 1; index <= 8; index += 1) {
      const swatch = document.createElement("span");
      swatch.className = "rules-palette-swatch";
      swatch.style.background = `var(--series-${String(index)})`;
      swatch.setAttribute("aria-hidden", "true");
      palette.append(swatch);
    }
    const dimensions = document.createElement("div");
    dimensions.className = "rules-dimension-choice";
    dimensions.hidden = true;
    for (const dimension of [
      "focus",
      "source",
      "channel",
      "set",
      "attr",
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rules-dimension";
      button.dataset.dimension = dimension;
      button.textContent = dimension;
      button.classList.toggle("active", state.color_by === dimension);
      button.addEventListener("click", () => {
        this.callbacks.onSetColorBy(this.id, dimension);
        this.closeRulesPopover();
      });
      dimensions.append(button);
    }
    const channelShortcut = document.createElement("button");
    channelShortcut.type = "button";
    channelShortcut.className = "rules-channel-shortcut";
    channelShortcut.textContent = "color ← channel";
    channelShortcut.addEventListener("click", () => {
      this.callbacks.onSetColorBy(this.id, "channel");
      this.closeRulesPopover();
    });
    colorDimension.addEventListener("click", () => {
      dimensions.hidden = !dimensions.hidden;
      colorDimension.setAttribute("aria-expanded", String(!dimensions.hidden));
    });
    colorRow.append(colorDimension, channelShortcut, palette, dimensions);
    rules.append(colorRow);
    for (const text of ["dash ← — flat", "width ← — flat"]) {
      const row = document.createElement("div");
      row.className = "rules-rule-row rules-rule-static";
      row.textContent = text;
      rules.append(row);
    }
    const overridesTitle = document.createElement("div");
    overridesTitle.className = "rules-overrides-title";
    const input = this.lastInputState;
    const overrides =
      input === null
        ? []
        : appliedOverrides(
            this.callbacks.catalog(),
            input,
            this.callbacks.namedSets(),
          );
    overridesTitle.textContent = `OVERRIDES · ${String(overrides.length)}`;
    const rows = document.createElement("div");
    rows.className = "rules-overrides";
    const renderOverrides = (): void => {
      const slice = virtualSlice(overrides.length, rows.scrollTop, 224, 28);
      rows.replaceChildren();
      rows.style.height = `${String(slice.totalHeight)}px`;
      rows.style.paddingTop = `${String(slice.topPadding)}px`;
      for (const item of overrides.slice(slice.start, slice.end)) {
        const row = document.createElement("div");
        row.className = "rules-override-row";
        const key = document.createElement("span");
        key.className = "rules-override-key";
        key.textContent = overrideKey(item.override);
        const target = document.createElement("span");
        target.className = "rules-override-target";
        target.textContent = overrideTarget(item.override, this.callbacks);
        target.title = target.textContent;
        const fields = document.createElement("span");
        fields.className = "rules-override-fields";
        fields.textContent = overrideFields(item.override);
        const revert = document.createElement("button");
        revert.type = "button";
        revert.textContent = "revert";
        revert.title = `Revert ${target.textContent}`;
        revert.addEventListener("click", () => {
          this.callbacks.onRemoveOverride(this.id, item.index);
          this.closeRulesPopover();
        });
        row.append(key, target, fields, revert);
        rows.append(row);
      }
    };
    rows.addEventListener("scroll", renderOverrides);
    const footer = document.createElement("button");
    footer.type = "button";
    footer.className = "rules-revert-all";
    footer.textContent = "revert all";
    footer.disabled = overrides.length === 0;
    footer.addEventListener("click", () => {
      this.callbacks.onClearOverrides(this.id);
      this.closeRulesPopover();
    });
    popover.append(heading, rules, overridesTitle, rows, footer);
    this.element.append(popover);
    const panelRect = this.element.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    popover.style.left = `${String(
      clamp(
        anchorRect.left - panelRect.left,
        4,
        Math.max(4, panelRect.width - 280),
      ),
    )}px`;
    popover.style.top = `${String(
      clamp(
        anchorRect.bottom - panelRect.top + 4,
        4,
        Math.max(4, panelRect.height - 340),
      ),
    )}px`;
    renderOverrides();
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && popover.contains(event.target))
        return;
      this.closeRulesPopover();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") this.closeRulesPopover();
    };
    document.addEventListener("pointerdown", onPointer, { capture: true });
    document.addEventListener("keydown", onKey);
    this.rulesCleanup = () => {
      document.removeEventListener("pointerdown", onPointer, { capture: true });
      document.removeEventListener("keydown", onKey);
      popover.remove();
    };
  }

  private closeRulesPopover(): void {
    this.rulesCleanup?.();
    this.rulesCleanup = null;
  }

  openInspector(path: string, clientX: number, clientY: number): void {
    this.closeInspector();
    const series = this.lastState?.series.find((entry) => entry.path === path);
    if (series === undefined) return;
    this.inspectorPath = path;
    const popover = document.createElement("div");
    popover.className = "series-inspector";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", `${path} series inspector`);
    const pathRow = document.createElement("div");
    pathRow.className = "inspector-path";
    pathRow.textContent = path;
    const slots = document.createElement("div");
    slots.className = "inspector-slots";
    for (let slot = 1; slot <= COLOR_SLOTS; slot += 1) {
      const swatch = document.createElement("button");
      swatch.className = "inspector-slot";
      swatch.style.background = `var(--series-${String(slot)})`;
      swatch.setAttribute("aria-label", `Colour slot ${String(slot)}`);
      swatch.classList.toggle(
        "active",
        colorIndexForHue(series.hue) + 1 === slot,
      );
      swatch.addEventListener("click", () => {
        this.callbacks.onSetSeriesStyle(this.id, series.ref, {
          color_slot: slot,
          dash: series.dash,
          width: series.width,
        });
        this.closeInspector();
      });
      slots.append(swatch);
    }
    const dashes = document.createElement("div");
    dashes.className = "inspector-dashes";
    for (const dash of ["solid", "dash", "dot"] as const) {
      const button = document.createElement("button");
      button.className = "inspector-dash";
      button.textContent = dash;
      button.classList.toggle("active", series.dash === dash);
      button.addEventListener("click", () => {
        this.callbacks.onSetSeriesStyle(this.id, series.ref, {
          color_slot: series.hue ?? 1,
          dash,
          width: series.width,
        });
        this.closeInspector();
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
    width.addEventListener("change", () => {
      this.callbacks.onSetSeriesStyle(this.id, series.ref, {
        color_slot: series.hue ?? 1,
        dash: series.dash,
        width: Number(width.value),
      });
    });
    dashes.append(width);
    const transforms = document.createElement("div");
    transforms.className = "inspector-transforms";
    for (const [label, kind] of [
      ["d/dt", "gradient"],
      ["∫dt", "cumtrapz"],
      ["smooth", "movmean"],
      ["|x|", "abs"],
    ] as const) {
      const button = document.createElement("button");
      button.className = "inspector-transform";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.closeInspector();
        this.callbacks.onQuickTransform(this.id, path, kind);
      });
      transforms.append(button);
    }
    const override =
      this.lastInputState === null
        ? undefined
        : overrideFor(this.lastInputState, series.ref);
    let overrideAction: HTMLDivElement | null = null;
    if (override !== undefined) {
      const selectedOverride = override;
      overrideAction = document.createElement("div");
      overrideAction.className = "inspector-override";
      overrideAction.textContent = `◆ override · ${overrideTarget(selectedOverride, this.callbacks)}`;
      const revert = document.createElement("button");
      revert.type = "button";
      revert.textContent = "revert";
      const overrideIndex =
        this.lastInputState?.overrides.indexOf(selectedOverride) ?? -1;
      revert.addEventListener("click", () => {
        if (overrideIndex !== -1)
          this.callbacks.onRemoveOverride(this.id, overrideIndex);
        this.closeInspector();
      });
      overrideAction.append(revert);
    }
    const remove = document.createElement("button");
    remove.className = "inspector-remove";
    remove.textContent = "remove";
    remove.addEventListener("click", () => {
      this.closeInspector();
      this.callbacks.onRemoveSeries(this.id, series.ref);
    });
    popover.append(
      pathRow,
      slots,
      dashes,
      transforms,
      ...(overrideAction === null ? [] : [overrideAction]),
      remove,
    );
    this.element.append(popover);
    const panelRect = this.element.getBoundingClientRect();
    popover.style.left = `${String(
      clamp(
        clientX - panelRect.left - 8,
        4,
        Math.max(4, panelRect.width - 204),
      ),
    )}px`;
    popover.style.top = `${String(
      clamp(clientY - panelRect.top + 8, 4, Math.max(4, panelRect.height - 40)),
    )}px`;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && popover.contains(event.target)) {
        return;
      }
      this.closeInspector();
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") this.closeInspector();
    };
    document.addEventListener("pointerdown", dismiss, { capture: true });
    document.addEventListener("keydown", onEscape);
    this.inspectorCleanup = () => {
      document.removeEventListener("pointerdown", dismiss, { capture: true });
      document.removeEventListener("keydown", onEscape);
    };
  }

  private closeInspector(): void {
    this.inspectorCleanup?.();
    this.inspectorCleanup = null;
    this.inspectorPath = null;
    this.element.querySelector(".series-inspector")?.remove();
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

function overrideKey(override: SeriesOverride): string {
  if (override.color_slot !== null) return "color";
  if (override.dash !== null) return "dash";
  if (override.width !== null) return "width";
  return "style";
}

function overrideFields(override: SeriesOverride): string {
  return [
    override.width === null ? null : `width ${String(override.width)}`,
    override.dash === null ? null : `dash ${override.dash}`,
    override.opacity === null ? null : `opacity ${String(override.opacity)}`,
    override.visible === null ? null : override.visible ? "visible" : "hidden",
    override.color_slot === null ? null : "highlight",
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

function statsName(text: string): HTMLElement {
  const name = document.createElement("span");
  name.className = "stats-name";
  name.textContent = text;
  return name;
}

function statsItem(
  label: string,
  value: number | null,
  unit: string | null = null,
): HTMLElement {
  const item = document.createElement("span");
  item.className = "stats-item";
  const key = document.createElement("span");
  key.textContent = label;
  const reading = document.createElement("b");
  reading.textContent =
    unit === null ? formatValue(value) : `${formatValue(value)} ${unit}`;
  item.append(key, reading);
  return item;
}

function panelMarkup(): string {
  return `<header class="panel-header">
      <span class="drag-handle" aria-hidden="true">⠿</span>
      <span class="panel-title"></span>
      <span class="panel-bindings"></span>
      <button class="panel-ghost-toggle" type="button" aria-pressed="false">all</button>
      <button class="panel-action panel-axis-toggle" title="Switch axis style">axes: gutter</button>
      <button class="panel-action panel-config-toggle" type="button" title="Panel configuration" aria-haspopup="dialog">▾</button>
      <span class="panel-actions">
        <button class="panel-action panel-stats-toggle" title="Toggle statistics (S)" aria-pressed="false">Σ</button>
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
    </div>
    <div class="panel-stats" hidden></div>
    <div class="panel-annotations" hidden></div>`;
}

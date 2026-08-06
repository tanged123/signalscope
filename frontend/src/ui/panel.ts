import { formatCombo } from "../app/commands";
import {
  columnsValueAtTime,
  type ColumnarTileResponse,
} from "../app/bin-columns";
import type { Catalog } from "../app/catalog";
import {
  appliedOverrides,
  dimensionCounts,
  overrideFor,
  type ResolvedSeries,
} from "../app/resolution";
import { virtualSlice } from "../app/outline-model";
import { evaluateSelector } from "../app/selector";
import type { SampleResponse, SampleSeries } from "../generated/protocol";
import type {
  AxisStyle,
  Binding,
  DashStyle,
  FocusEntry,
  NamedSet,
  PanelMode,
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
import { histogram } from "../app/histogram";
import { resolveRanges } from "../app/plot-gestures";
import {
  policyFor,
  prepareFftPlot,
  prepareHistogramPlot,
  prepareTimePlot,
  prepareXyPlot,
  type AnnotationAnchor,
  type PlotDelta,
  type PlotCursor,
  type PreparedPlot,
  type ResolvedAnnotation,
  type SeriesHitAdapter,
} from "../app/plot-capabilities";
import { spectrum } from "../app/spectrum";
import { lerpSample, pairSamples, type XyTrace } from "../app/xy";
import {
  CanvasRenderer,
  COLOR_SLOTS,
  type PathRenderOptions,
  type PlotPath,
  type RenderOptions,
} from "../render/canvas-renderer";
import {
  marker,
  OverlayRenderer,
  type CursorMode,
  type CursorPoint,
} from "../render/overlay-renderer";
import { YAxisPolicy } from "../render/y-axis";
import { required, signalLabel } from "./dom";
import {
  PlotInteractionController,
  type InteractionBox,
} from "./plot-interactions";

export const SIGNAL_DRAG_TYPE = "application/x-signalscope-signal";
export const SET_DRAG_TYPE = "application/x-signalscope-set";
export const PANEL_DRAG_TYPE = "application/x-signalscope-panel";
export const MAX_SERIES_PER_PANEL = 64;
export const MAXIMIZE_GLYPH = "↗";

export type PanelCursor = PlotCursor;

/** Inputs whose identity decides whether `renderData` can be skipped. */
export interface RenderInputs {
  revision: number | null;
  tiles: ColumnarTileResponse | null;
  samples: SampleResponse | null;
  window: { t0: number; t1: number } | null;
  missingEmpty: boolean;
}

/** Return true when a render can safely reuse the previous panel output. */
export function sameRenderInputs(
  last: RenderInputs,
  next: RenderInputs,
): boolean {
  return (
    next.revision !== null &&
    next.revision === last.revision &&
    next.tiles === last.tiles &&
    next.samples === last.samples &&
    last.window !== null &&
    next.window !== null &&
    next.window.t0 === last.window.t0 &&
    next.window.t1 === last.window.t1 &&
    next.missingEmpty &&
    last.missingEmpty
  );
}

interface ResolvedAnnotations {
  resolved: readonly ResolvedAnnotation[];
  delta: PlotDelta | null;
}

const MODES: readonly { mode: PanelMode; label: string }[] = [
  { mode: "time", label: "T" },
  { mode: "xy", label: "XY" },
  { mode: "fft", label: "FFT" },
  { mode: "histogram", label: "H" },
];

const XY_HOVER_RADIUS = 40;

function colorIndexForHue(hue: number | null): number {
  if (hue === null) return 0;
  return Math.max(0, Math.min(COLOR_SLOTS - 1, Math.trunc(hue) - 1));
}

export type QuickTransform = "gradient" | "cumtrapz" | "movmean" | "abs";

export interface PanelCallbacks {
  onFocus(id: string): void;
  onClose(id: string): void;
  onSplitRight(id: string): void;
  onSplitDown(id: string): void;
  onMaximize(id: string): void;
  onSelectMode(id: string, mode: PanelMode): void;
  onDropSignals(id: string, paths: string[]): void;
  onDropSet(id: string, setId: string): void;
  onFocusToggle(id: string, entry: FocusEntry): void;
  onClearFocus(id: string): void;
  onMuteSelector(id: string, selector: string): void;
  onMuteSeries(id: string, ref: SeriesRef): void;
  onRemoveBinding(id: string, index: number): void;
  onToggleGhostMode(id: string): void;
  localPathFor(path: string): string | null;
  sourceKeyFor(path: string): string | null;
  pathForRef(ref: { source_key: string; channel: string }): string | null;
  catalog(): Catalog;
  namedSets(): readonly NamedSet[];
  resolveSeries(state: PanelState): readonly ResolvedSeries[];
  onSetXSignal(id: string, path: string): void;
  onSetColorSignal(id: string, path: string | null): void;
  onClearXSignal(id: string): void;
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
  onToggleAxisEqual(id: string): void;
  onRenameTitle(id: string, title: string): void;
  onEditAxisLabel(
    id: string,
    axis: "x" | "y" | "c",
    label: string | null,
  ): void;
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

type XyPairingCallbacks = Pick<PanelCallbacks, "localPathFor" | "sourceKeyFor">;

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

export type RenderPanelState = Omit<PanelState, "x_ref" | "color_ref"> & {
  x_signal: string | null;
  color_signal: string | null;
  color_by_time: boolean;
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
  const evaluation =
    query.trim() === "" ? null : evaluateSelector(catalog, query);
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
  return [...rows.values()];
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

export function legendTokenLabel(
  catalog: Catalog,
  state: Pick<RenderPanelState, "series" | "focus">,
  dimension: LegendDimension,
  count: number,
): string {
  const focusedValues = new Set(
    state.series
      .filter((series) =>
        state.focus.some((entry) => focusMatches(entry, series.ref)),
      )
      .map((series) =>
        dimension === "source"
          ? (catalog.get(series.ref)?.sourceName ?? series.ref.source_key)
          : series.ref.channel,
      ),
  );
  const [focused] = focusedValues;
  return focused !== undefined && focusedValues.size === 1 && count > 1
    ? `${focused} +${String(count - 1)} ▾`
    : `${String(count)} ▾`;
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
  callbacks: Pick<
    PanelCallbacks,
    "resolveSeries" | "pathForRef" | "localPathFor"
  >,
): RenderPanelState {
  const resolved = callbacks.resolveSeries(state);
  const pathForRef = (
    ref: { source_key: string; channel: string } | null,
  ): string | null => (ref === null ? null : callbacks.pathForRef(ref));
  return {
    ...state,
    x_signal: pathForRef(state.x_ref),
    color_signal: pathForRef(state.color_ref),
    color_by_time: state.color_axis === "time",
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

function resolveXSeries(
  samples: SampleResponse,
  xSeries: SampleSeries,
  xSignal: string,
  yPath: string,
  callbacks: XyPairingCallbacks,
): SampleSeries | undefined {
  const xLocal = callbacks.localPathFor(xSignal);
  if (xLocal === null) return xSeries;
  const sourceKey = callbacks.sourceKeyFor(yPath);
  if (sourceKey === null) return xSeries;
  return samples.series.find(
    (candidate) =>
      callbacks.sourceKeyFor(candidate.signal_path) === sourceKey &&
      callbacks.localPathFor(candidate.signal_path) === xLocal,
  );
}

export function xChipLabel(
  xSignal: string,
  series: readonly RenderSeries[],
  callbacks: XyPairingCallbacks,
): string {
  const xLocal = callbacks.localPathFor(xSignal);
  const sources = visibleSources(series, callbacks);
  return xLocal !== null && sources.size > 1 ? xLocal : signalLabel(xSignal);
}

function visibleSources(
  series: readonly RenderSeries[],
  callbacks: XyPairingCallbacks,
): Set<string> {
  return new Set(
    series
      .filter((entry) => entry.visible)
      .map((entry) => callbacks.sourceKeyFor(entry.path))
      .filter((key): key is string => key !== null),
  );
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
  private readonly renderer: CanvasRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayRenderer: OverlayRenderer;
  private readonly interactions: PlotInteractionController;
  private readonly yAxis = new YAxisPolicy();
  private lastState: RenderPanelState | null = null;
  private lastInputState: PanelState | null = null;
  private lastRevision: number | null = null;
  private lastTiles: ColumnarTileResponse | null = null;
  private lastSamples: SampleResponse | null = null;
  private lastWindow: { t0: number; t1: number } | null = null;
  private lastMissingEmpty = true;
  private preparedPlot: PreparedPlot | null = null;
  private hitAdapter: SeriesHitAdapter | null = null;
  /** Traces from the last XY render, reused by hit-testing and overlays. */
  private xyTraces: {
    path: string;
    colorIndex: number;
    hue: number | null;
    dash: DashStyle;
    width: number;
    opacity: number;
    trace: XyTrace;
  }[] = [];
  private domainSeries: {
    path: string;
    colorIndex: number;
    hue: number | null;
    opacity: number;
    x: number[];
    y: number[];
  }[] = [];
  private cursorT: number | null = null;
  private cursorMode: CursorMode = "none";
  private box: InteractionBox | null = null;
  private emphasizePaths: ReadonlySet<string> | null = null;
  private hoverPoint: { x: number; y: number } | null = null;
  private hoverTag: HTMLElement | null = null;
  private inspectorPath: string | null = null;
  private inspectorCleanup: (() => void) | null = null;
  private rosterCleanup: (() => void) | null = null;
  private bindingCleanup: (() => void) | null = null;
  private rulesCleanup: (() => void) | null = null;
  private hasColorbar = false;

  constructor(
    private readonly id: string,
    private readonly callbacks: PanelCallbacks,
  ) {
    this.element = document.createElement("article");
    this.element.className = "panel";
    this.element.dataset.panelId = id;
    this.element.tabIndex = 0;
    this.element.innerHTML = panelMarkup();
    this.canvas = required<HTMLCanvasElement>(this.element, ".plot-canvas");
    this.overlay = required<HTMLCanvasElement>(this.element, ".overlay-canvas");
    this.renderer = new CanvasRenderer(this.canvas);
    this.overlayRenderer = new OverlayRenderer(this.overlay);
    this.bind();
    this.interactions = new PlotInteractionController(this.overlay, {
      layout: () => this.renderer.lastLayout(),
      applyXRange: (min, max) => {
        this.applyXRange(min, max);
      },
      applyYRange: (min, max) => {
        this.callbacks.onYRange(this.id, [min, max]);
      },
      fitView: () => {
        this.callbacks.onFitView(this.id);
      },
      plotClick: (x, y, modifiers) => {
        this.plotClick(x, y, modifiers);
      },
      setGesture: (hint) => {
        this.callbacks.onGesture(this.id, hint);
      },
      setBox: (box) => {
        this.box = box;
        this.drawOverlay();
      },
      axisEditZone: (x, y) => {
        const layout = this.renderer.lastLayout();
        const state = this.lastState;
        return layout === null || state === null
          ? null
          : axisEditZone(
              layout,
              state.axis_style,
              x,
              y,
              state.mode === "xy" && this.hasColorbar,
            );
      },
      beginAxisEdit: (axis) => {
        this.beginAxisEdit(axis);
      },
    });
    new ResizeObserver(() => {
      this.callbacks.onResized(this.id);
    }).observe(this.canvas);
  }

  private bind(): void {
    this.element.addEventListener("pointerdown", () => {
      this.callbacks.onFocus(this.id);
    });
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
    required(this.element, ".panel-aspect-toggle").addEventListener(
      "click",
      () => {
        this.callbacks.onToggleAxisEqual(this.id);
      },
    );
    required(this.element, ".panel-ghost-toggle").addEventListener(
      "click",
      () => {
        this.callbacks.onToggleGhostMode(this.id);
      },
    );
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (this.emphasizePaths !== null) this.clearHover();
        else this.callbacks.onClearFocus(this.id);
        this.closeRoster();
        this.closeBindingPopover();
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
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      ".mode-pill",
    )) {
      button.addEventListener("click", () => {
        this.callbacks.onSelectMode(this.id, button.dataset.mode as PanelMode);
      });
    }
    required(this.element, ".x-chip").addEventListener("click", () => {
      this.callbacks.onClearXSignal(this.id);
    });
    const cChip = required<HTMLButtonElement>(this.element, ".c-chip");
    cChip.addEventListener("click", () => {
      this.callbacks.onSetColorSignal(this.id, null);
    });
    cChip.addEventListener("dragover", (event) => {
      if (!hasDragType(event, SIGNAL_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      cChip.classList.add("drop-target");
    });
    cChip.addEventListener("dragleave", (event) => {
      event.stopPropagation();
      cChip.classList.remove("drop-target");
    });
    cChip.addEventListener("drop", (event) => {
      cChip.classList.remove("drop-target");
      const path = dragData(event, SIGNAL_DRAG_TYPE);
      if (path === null) return;
      event.preventDefault();
      event.stopPropagation();
      const first = parseSignalPayload(path)[0];
      if (first !== undefined) this.callbacks.onSetColorSignal(this.id, first);
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
      this.setDropStripVisible(signalDrag);
      this.element.classList.toggle(
        "drop-x",
        signalDrag && this.overStrip(event),
      );
    });
    this.element.addEventListener("dragleave", () => {
      this.element.classList.remove("drop-target", "drop-x");
      this.setDropStripVisible(false);
    });
    this.element.addEventListener("drop", (event) => {
      const asX = this.overStrip(event);
      this.element.classList.remove("drop-target", "drop-x");
      this.setDropStripVisible(false);
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
      if (asX) this.callbacks.onSetXSignal(this.id, paths[0] as string);
      else this.callbacks.onDropSignals(this.id, paths);
    });
    this.overlay.addEventListener("pointermove", (event) => {
      if (this.interactions.isDragging()) return;
      const layout = this.renderer.lastLayout();
      const inside =
        layout !== null && insidePlot(layout, event.offsetX, event.offsetY);
      const cursor =
        layout !== null && inside
          ? this.cursorAt(layout, event.offsetX, event.offsetY, XY_HOVER_RADIUS)
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
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      ".mode-pill",
    )) {
      button.classList.toggle("active", button.dataset.mode === rendered.mode);
    }
    const xChip = required<HTMLButtonElement>(this.element, ".x-chip");
    xChip.hidden = !(rendered.mode === "xy" && rendered.x_signal !== null);
    if (!xChip.hidden && rendered.x_signal !== null) {
      xChip.replaceChildren(
        chipPrefix("x:"),
        document.createTextNode(
          xChipLabel(rendered.x_signal, rendered.series, this.callbacks),
        ),
      );
      xChip.title = `X axis: ${rendered.x_signal} — click to remove`;
    }
    const cChip = required<HTMLButtonElement>(this.element, ".c-chip");
    cChip.hidden = rendered.mode !== "xy";
    if (!cChip.hidden) {
      cChip.replaceChildren(
        chipPrefix("c:"),
        document.createTextNode(
          rendered.color_by_time
            ? "time"
            : rendered.color_signal === null
              ? "none"
              : xChipLabel(
                  rendered.color_signal,
                  rendered.series,
                  this.callbacks,
                ),
        ),
      );
      cChip.title = rendered.color_by_time
        ? "Colour channel: time — click to clear"
        : rendered.color_signal === null
          ? `Drop a signal here to assign colour, or use ${formatCombo("mod+shift+p")} → set color signal`
          : `Colour channel: ${rendered.color_signal} — click to clear`;
    }
    const note = required<HTMLElement>(this.element, ".panel-mode-note");
    const windowNote = policyFor(rendered.mode).windowNote;
    note.hidden = windowNote === null;
    if (windowNote !== null) note.textContent = windowNote;
    required<HTMLButtonElement>(this.element, ".panel-maximize").title =
      maximized ? "Restore panel" : "Maximize panel";
    required<HTMLButtonElement>(
      this.element,
      ".panel-stats-toggle",
    ).setAttribute("aria-pressed", String(rendered.show_stats));
    const axisToggle = required<HTMLButtonElement>(
      this.element,
      ".panel-axis-toggle",
    );
    axisToggle.textContent = `axes: ${rendered.axis_style}`;
    axisToggle.title = `Switch to ${rendered.axis_style === "gutter" ? "inline" : "gutter"} axes`;
    const aspectToggle = required<HTMLButtonElement>(
      this.element,
      ".panel-aspect-toggle",
    );
    aspectToggle.hidden = rendered.mode !== "xy";
    aspectToggle.setAttribute("aria-pressed", String(rendered.axis_equal));
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
    } else if (rendered.mode === "xy" && rendered.x_signal === null) {
      empty.hidden = false;
      empty.textContent = "Drop a signal on the strip below to set the X axis.";
    } else {
      // In fft/histogram, renderSpectra/renderHistogram own the empty state.
      empty.hidden = true;
    }
  }

  renderData(
    state: PanelState,
    tiles: ColumnarTileResponse | null,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
    missing: readonly string[] = [],
    revision: number | null = null,
  ): number {
    if (
      sameRenderInputs(
        {
          revision: this.lastRevision,
          tiles: this.lastTiles,
          samples: this.lastSamples,
          window: this.lastWindow,
          missingEmpty: this.lastMissingEmpty,
        },
        {
          revision,
          tiles,
          samples,
          window,
          missingEmpty: missing.length === 0,
        },
      )
    ) {
      return 0;
    }
    const rendered = renderState(state, this.callbacks);
    this.lastInputState = state;
    this.lastRevision = revision;
    this.lastState = rendered;
    this.lastTiles = tiles;
    this.lastSamples = samples;
    this.lastWindow = { ...window };
    this.lastMissingEmpty = missing.length === 0;
    this.preparedPlot = null;
    this.hitAdapter = null;
    this.domainSeries = [];
    this.hasColorbar = false;
    const elapsed = this.renderForMode(rendered, tiles, samples, window);
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
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    if (state.mode === "xy") return this.renderXy(state, samples, window);
    if (state.mode === "fft") return this.renderSpectra(state, samples, window);
    if (state.mode === "histogram") {
      return this.renderHistogram(state, samples, window);
    }
    if (tiles === null || state.series.length === 0) return 0;
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
    const options: RenderOptions = {
      xLabel: state.x_label ?? "time (s)",
      yLabel: state.y_label ?? yLabel(response.series.map((tile) => tile.unit)),
      yRange: [ranges.y.min, ranges.y.max],
      axisStyle: state.axis_style,
      styles: shown.map((tile) => {
        const series = bySeries.get(tile.signalPath);
        return {
          hue: series?.hue ?? null,
          dash: series?.dash ?? "solid",
          width: series?.width ?? 1.4,
          alpha: series?.opacity ?? 1,
        };
      }),
      ...(this.emphasizePaths !== null
        ? {
            emphasisIndices: shown.flatMap((tile, index) =>
              this.emphasizePaths?.has(tile.signalPath) ? [index] : [],
            ),
          }
        : {}),
    };
    return this.renderer.render(response, ranges.x, options);
  }

  private renderXy(
    state: RenderPanelState,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    this.xyTraces = [];
    if (samples === null || state.x_signal === null) return 0;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const xSeries = byPath.get(state.x_signal);
    if (xSeries === undefined) return 0;
    const xLocal = this.callbacks.localPathFor(state.x_signal);
    for (const series of state.series) {
      if (!series.visible) continue;
      const ySeries = byPath.get(series.path);
      if (ySeries === undefined) continue;
      const resolved = resolveXSeries(
        samples,
        xSeries,
        state.x_signal,
        series.path,
        this.callbacks,
      );
      if (resolved === undefined) continue;
      this.xyTraces.push({
        path: series.path,
        colorIndex: colorIndexForHue(series.hue),
        hue: series.hue,
        dash: series.dash,
        width: series.width,
        opacity: series.opacity,
        trace: pairSamples(resolved, ySeries),
      });
    }
    if (this.xyTraces.length === 0) return 0;
    const colorSeries: "time" | SampleResponse["series"][number] | null =
      state.color_by_time
        ? "time"
        : state.color_signal === null
          ? null
          : (byPath.get(state.color_signal) ?? null);
    const cLocal =
      state.color_signal === null
        ? null
        : this.callbacks.localPathFor(state.color_signal);
    const resolveColor = (
      yPath: string,
    ): SampleResponse["series"][number] | null => {
      if (colorSeries === null || colorSeries === "time") return null;
      if (cLocal === null) return colorSeries;
      const sourceKey = this.callbacks.sourceKeyFor(yPath);
      if (sourceKey === null) return colorSeries;
      return (
        samples.series.find(
          (candidate) =>
            this.callbacks.sourceKeyFor(candidate.signal_path) === sourceKey &&
            this.callbacks.localPathFor(candidate.signal_path) === cLocal,
        ) ?? null
      );
    };
    const colorFor = (yPath: string, trace: XyTrace): number[] | null => {
      if (colorSeries === null) return null;
      if (colorSeries === "time") return [...trace.time];
      const resolved = resolveColor(yPath);
      if (resolved === null) return null;
      return trace.time.map((time) =>
        lerpSample(resolved.time, resolved.values, time),
      );
    };
    const colorColumns = this.xyTraces.map((entry) =>
      colorFor(entry.path, entry.trace),
    );
    let colorMin = Number.POSITIVE_INFINITY;
    let colorMax = Number.NEGATIVE_INFINITY;
    for (const column of colorColumns) {
      for (const value of column ?? []) {
        if (!Number.isFinite(value)) continue;
        colorMin = Math.min(colorMin, value);
        colorMax = Math.max(colorMax, value);
      }
    }
    const hasColor =
      colorSeries !== null &&
      Number.isFinite(colorMin) &&
      Number.isFinite(colorMax);
    this.hasColorbar = hasColor;
    const colorPadding =
      hasColor && colorMin === colorMax
        ? Math.max(1, Math.abs(colorMin) * 0.05)
        : 0;
    const colorDomainMin = colorMin - colorPadding;
    const colorDomainMax = colorMax + colorPadding;
    const colorSpan = colorDomainMax - colorDomainMin;
    this.preparedPlot = prepareXyPlot({
      x: { path: state.x_signal, values: xSeries.values },
      series: this.xyTraces.map((entry, index) => ({
        ...entry,
        colorValues: colorColumns[index] ?? null,
      })),
      color:
        colorSeries === null
          ? null
          : {
              path: state.color_by_time ? "time" : (state.color_signal ?? ""),
            },
      window,
    });
    const ranges = this.resolvePlotRanges(state, this.preparedPlot, window);
    if (ranges === null) return 0;
    const paths: PlotPath[] = [];
    for (const entry of this.xyTraces) {
      // Whole trajectory dimmed underneath, the windowed part lit on top.
      paths.push({
        points: flattenTrace(entry.trace, null),
        hue: entry.hue,
        dash: "solid",
        width: 1.2,
        alpha: entry.opacity,
        dimmed: true,
      });
    }
    this.xyTraces.forEach((entry, index) => {
      const colorValues = colorColumns[index];
      paths.push({
        points: flattenTrace(entry.trace, window),
        hue: entry.hue,
        dash: entry.dash,
        width: entry.width + 0.4,
        alpha: entry.opacity,
        markers: true,
        ...(hasColor && colorValues !== null && colorValues !== undefined
          ? {
              colorValues: colorValues.map(
                (value) => (value - colorDomainMin) / colorSpan,
              ),
            }
          : {}),
      });
    });
    const sources = visibleSources(state.series, this.callbacks);
    const localLabels = sources.size > 1;
    const options: PathRenderOptions = {
      xLabel:
        state.x_label ??
        axisName(
          localLabels && xLocal !== null ? xLocal : state.x_signal,
          xSeries.unit,
        ),
      yLabel:
        state.y_label ??
        yLabel(
          state.series
            .filter((series) => series.visible)
            .map((series) => byPath.get(series.path)?.unit ?? null),
        ),
      xRange: [ranges.x.min, ranges.x.max],
      yRange: [ranges.y.min, ranges.y.max],
      axisStyle: state.axis_style,
      ...(state.axis_equal ? { equalAspect: true } : {}),
      ...(hasColor
        ? {
            colorbar: {
              min: colorDomainMin,
              max: colorDomainMax,
              label:
                state.c_label ??
                (colorSeries === "time"
                  ? "t (s)"
                  : axisName(
                      localLabels && cLocal !== null
                        ? cLocal
                        : (state.color_signal ?? ""),
                      colorSeries.unit,
                    )),
            },
          }
        : {}),
    };
    return this.renderer.renderPaths(paths, options);
  }

  private renderSpectra(
    state: RenderPanelState,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    if (samples === null) return 0;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const paths: PlotPath[] = [];
    for (const series of state.series) {
      if (!series.visible) continue;
      const source = byPath.get(series.path);
      if (source === undefined) continue;
      const result = spectrum(source, window.t0, window.t1);
      if (result === null) continue;
      const points: number[] = [];
      result.frequency.forEach((frequency, index) => {
        points.push(frequency, result.amplitudeDb[index] ?? -120);
      });
      this.domainSeries.push({
        path: series.path,
        colorIndex: colorIndexForHue(series.hue),
        hue: series.hue,
        opacity: series.opacity,
        x: result.frequency,
        y: result.amplitudeDb,
      });
      paths.push({
        points,
        hue: series.hue,
        dash: series.dash,
        width: series.width,
        alpha: series.opacity,
      });
    }
    this.setModeEmpty(paths.length === 0, "Not enough samples in view.");
    this.preparedPlot = prepareFftPlot({
      series: this.domainSeries.map((series) => ({
        path: series.path,
        colorIndex: series.colorIndex,
        frequency: series.x,
        amplitudeDb: series.y,
      })),
    });
    if (paths.length === 0) return 0;
    const ranges = this.resolvePlotRanges(state, this.preparedPlot, window);
    if (ranges === null) return 0;
    return this.renderer.renderPaths(paths, {
      xLabel: state.x_label ?? "frequency (Hz), log",
      yLabel: state.y_label ?? "amplitude (dB)",
      xRange: [ranges.x.min, ranges.x.max],
      yRange: [ranges.y.min, ranges.y.max],
      axisStyle: state.axis_style,
      xScale: "log",
    });
  }

  private renderHistogram(
    state: RenderPanelState,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
  ): number {
    if (samples === null) return 0;
    const byPath = new Map(
      samples.series.map((series) => [series.signal_path, series]),
    );
    const visible = state.series.filter((series) => series.visible);
    const columns = visible.map((series) => {
      const source = byPath.get(series.path);
      if (source === undefined) return [];
      const values: number[] = [];
      source.time.forEach((time, index) => {
        if (time < window.t0 || time > window.t1) return;
        values.push(source.values[index] ?? Number.NaN);
      });
      return values;
    });
    const binned = histogram(columns);
    this.setModeEmpty(binned === null, "No values in view.");
    if (binned === null) return 0;
    const edges = binned.edges;
    const histogramSeries: {
      path: string;
      colorIndex: number;
      counts: number[];
      sourceValues: number[];
    }[] = [];
    const paths: PlotPath[] = binned.counts.map((counts, index) => {
      const points: number[] = [];
      // A staircase outline: rise at each edge, run across each bin, and
      // close down to zero at both ends so the shape reads as a
      // distribution rather than a line chart.
      points.push(edges[0] ?? 0, 0);
      counts.forEach((count, bin) => {
        points.push(edges[bin] ?? 0, count, edges[bin + 1] ?? 0, count);
      });
      points.push(edges[edges.length - 1] ?? 0, 0);
      const series = visible[index];
      if (series !== undefined) {
        histogramSeries.push({
          path: series.path,
          colorIndex: colorIndexForHue(series.hue),
          counts,
          sourceValues: columns[index] ?? [],
        });
      }
      return {
        points,
        hue: series?.hue ?? null,
        dash: series?.dash ?? "solid",
        width: series?.width ?? 1.4,
        alpha: series?.opacity ?? 1,
      };
    });
    this.preparedPlot = prepareHistogramPlot({
      edges,
      series: histogramSeries,
    });
    const ranges = this.resolvePlotRanges(state, this.preparedPlot, window);
    if (ranges === null) return 0;
    const units = visible.map(
      (series) => byPath.get(series.path)?.unit ?? null,
    );
    return this.renderer.renderPaths(paths, {
      xLabel: state.x_label ?? yLabel(units),
      yLabel: state.y_label ?? "sample count",
      xRange: [ranges.x.min, ranges.x.max],
      yRange: [ranges.y.min, ranges.y.max],
      axisStyle: state.axis_style,
    });
  }

  private resolvePlotRanges(
    state: RenderPanelState,
    plot: PreparedPlot,
    window: { t0: number; t1: number },
    seriesKey = "",
  ): { x: Range; y: Range } | null {
    const automatic = plot.autoRanges();
    const stickyY = plot.interaction.stickyAutoY
      ? this.yAxis.resolve(seriesKey, () => automatic.y, state.y_range)
      : automatic.y;
    return resolveRanges(
      plot.interaction,
      {
        x: state.x_range,
        y: plot.interaction.stickyAutoY ? null : state.y_range,
      },
      { x: automatic.x, y: stickyY },
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

  private setDropStripVisible(visible: boolean): void {
    required<HTMLElement>(this.element, ".xy-drop-strip").hidden = !visible;
  }

  /** True when the pointer is inside the 36px strip at the plot's foot. */
  private overStrip(event: DragEvent): boolean {
    const strip = required<HTMLElement>(this.element, ".xy-drop-strip");
    if (strip.hidden) return false;
    const rect = strip.getBoundingClientRect();
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  }

  invalidateTheme(): void {
    this.renderer.invalidateTheme();
    this.overlayRenderer.invalidateTheme();
  }

  setCursor(cursorT: number | null): void {
    if (this.preparedPlot?.interaction.cursorLink !== "time") return;
    this.cursorT = cursorT;
    this.drawOverlay();
  }

  setLocalCursor(cursorValue: number | null): void {
    this.cursorT = cursorValue;
    this.drawOverlay();
  }

  clearCursor(): void {
    this.cursorT = null;
    this.drawOverlay();
  }

  setCursorMode(cursorMode: CursorMode): void {
    this.cursorMode = cursorMode;
    this.drawOverlay();
  }

  resetYAxis(): void {
    this.yAxis.reset();
  }

  /** The canvas's rendered CSS width, for density-bounded tile queries. */
  plotWidth(): number {
    return this.canvas.clientWidth;
  }

  canvases(): { plot: HTMLCanvasElement; overlay: HTMLCanvasElement } {
    return { plot: this.canvas, overlay: this.overlay };
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
    const layout = this.renderer.lastLayout();
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
      const canvasRect = this.canvas.getBoundingClientRect();
      this.showHoverTag(
        wrapped.entry.path,
        canvasRect.left + this.hoverPoint.x,
        canvasRect.top + this.hoverPoint.y,
      );
    }
  }

  /** Removes the annotation under the pixel; true when one was removed. */
  private removeAt(offsetX: number, offsetY: number, radius: number): boolean {
    const layout = this.renderer.lastLayout();
    const state = this.lastState;
    const prepared = this.preparedPlot;
    if (layout === null || state === null || prepared === null) return false;
    const annotation = state.annotations
      .filter((entry) => entry.domain === prepared.domain)
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
    const layout = this.renderer.lastLayout();
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
    xyRadius: number,
  ): PanelCursor | null {
    return (
      this.preparedPlot?.cursorAt(
        layout,
        { x: offsetX, y: offsetY },
        xyRadius,
      ) ?? null
    );
  }

  private resolvedAnnotations(state: RenderPanelState): ResolvedAnnotations {
    const prepared = this.preparedPlot;
    if (prepared === null) return { resolved: [], delta: null };
    const resolved = state.annotations
      .filter((annotation) => annotation.domain === prepared.domain)
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
    const xyMarkers =
      state?.mode === "xy" && cursorT !== null && this.cursorMode !== "none"
        ? this.xyTraces.flatMap((entry) => {
            const point = markerAt(entry.trace, cursorT);
            return point === null
              ? []
              : [{ ...point, ghost: entry.hue === null }];
          })
        : [];
    this.overlayRenderer.draw(this.renderer.lastLayout(), {
      cursorT: state?.mode === "xy" ? null : cursorT,
      cursorMode: this.cursorMode,
      cursorPoints:
        this.cursorMode === "track" && cursorT !== null
          ? this.cursorPointsAt(state?.mode, cursorT, bySeries)
          : [],
      xyMarkers,
      box: this.box,
      annotations: resolved.map((annotation) => ({
        x: annotation.x,
        y: annotation.y,
        colorIndex: annotation.colorIndex,
        label: `${annotation.annotation.label === "" ? "" : `${annotation.annotation.label} `}${annotation.summary}`,
      })),
      delta,
    });
  }

  /** The dots the cursor puts on each series, in that mode's own domain. */
  private cursorPointsAt(
    mode: PanelMode | undefined,
    cursorT: number,
    bySeries: ReadonlyMap<string, RenderSeries>,
  ): CursorPoint[] {
    if (mode === "fft") {
      return this.domainSeries.map((series) => ({
        value: lerpSample(series.x, series.y, cursorT),
        colorIndex: series.hue === null ? null : series.colorIndex,
        alpha: series.opacity,
      }));
    }
    if (mode === "histogram") {
      const layout = this.renderer.lastLayout();
      if (layout === null) return [];
      const cursor = this.preparedPlot?.cursorAt(
        layout,
        {
          x: projectX(layout, cursorT),
          y: layout.plot.y + layout.plot.height / 2,
        },
        0,
      );
      const visible = [...bySeries.values()].filter((series) => series.visible);
      return (cursor?.markers ?? []).map((point, index) => {
        const series = visible[index];
        return {
          value: point.y,
          colorIndex: series?.hue === null ? null : point.colorIndex,
          alpha: series?.opacity ?? 1,
        };
      });
    }
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
    const annotations =
      prepared === null
        ? []
        : state.annotations.filter(
            (annotation) => annotation.domain === prepared.domain,
          );
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
      const domainLabel =
        annotation.domain === "time"
          ? "t"
          : annotation.domain === "frequency"
            ? "f"
            : "value";
      text.textContent =
        `${marker(index)} ${domainLabel} ${formatValue(annotation.anchor)} · ${current?.summary ?? "unavailable"}` +
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

  canEditAxis(axis: "x" | "y" | "c"): boolean {
    return axis !== "c" || (this.lastState?.mode === "xy" && this.hasColorbar);
  }

  beginAxisEdit(axis: "x" | "y" | "c"): void {
    if (!this.canEditAxis(axis)) return;
    const wrap = required<HTMLElement>(this.element, ".plot-wrap");
    if (wrap.querySelector(".axis-label-editor") !== null) return;
    const state = this.lastState;
    const input = document.createElement("input");
    input.className = `axis-label-editor axis-label-editor-${axis}`;
    input.setAttribute(
      "aria-label",
      axis === "x"
        ? "X axis name"
        : axis === "y"
          ? "Y axis name"
          : "Color axis name",
    );
    input.value =
      (axis === "x"
        ? state?.x_label
        : axis === "y"
          ? state?.y_label
          : state?.c_label) ?? "";
    input.placeholder =
      axis === "x" ? "time (s)" : axis === "y" ? "value" : "color";
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
    const legend = required(this.element, ".panel-legend");
    legend.replaceChildren();
    const counts = dimensionCounts(state.series as readonly ResolvedSeries[]);
    legend.append(
      this.legendCountToken("source", counts.sources, state),
      ...this.focusChipElements(state),
      this.legendCountToken("channel", counts.channels, state),
      ...(state.ghost_mode === "ghost" ? [this.ghostToken(state)] : []),
      this.colorRuleToken(state),
    );
    const lineStyle = state.overrides.some(
      (override) => override.dash !== null || override.width !== null,
    )
      ? "line style ◆ overridden"
      : "line style flat";
    required<HTMLElement>(this.element, ".panel-gesture-hint").textContent =
      `· ${lineStyle} · hover explore · ⇧click focus · ⌥ mute · esc clear`;
  }

  private ghostToken(state: RenderPanelState): HTMLButtonElement {
    const token = document.createElement("button");
    token.className = "legend-ghost-token";
    token.type = "button";
    const ghosts = state.series.filter((series) => series.display === "ghost");
    token.textContent = `${String(ghosts.length)} ghosts ▾`;
    token.title = "Browse ghost series";
    token.setAttribute("aria-haspopup", "dialog");
    token.addEventListener("click", (event) => {
      this.openRoster(
        "source",
        state,
        event.currentTarget as HTMLElement,
        false,
        true,
      );
    });
    return token;
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

  private legendCountToken(
    dimension: LegendDimension,
    count: number,
    state: RenderPanelState,
  ): HTMLButtonElement {
    const token = document.createElement("button");
    token.className = "legend-count-token";
    token.textContent = legendTokenLabel(
      this.callbacks.catalog(),
      state,
      dimension,
      count,
    );
    token.title = `Browse ${dimension} roster`;
    token.setAttribute("aria-haspopup", "dialog");
    token.addEventListener("click", (event) => {
      this.openRoster(dimension, state, event.currentTarget as HTMLElement);
    });
    return token;
  }

  private focusChipElements(state: RenderPanelState): HTMLElement[] {
    const result = focusChips(this.callbacks.catalog(), state);
    const chips = result.chips.map((focus) => {
      const chip = document.createElement("span");
      chip.className = "matrix-focus-chip";
      const matching = state.series.filter(
        (series) => focusMatches(focus.entry, series.ref) && series.visible,
      );
      const keys = new Map<string, number | null>();
      for (const series of matching) {
        if (!keys.has(series.ref.channel))
          keys.set(series.ref.channel, series.hue);
      }
      if (keys.size === 0) keys.set("focus", focus.hue);
      const markers = [...keys.values()].map((hue) => {
        const marker = document.createElement("span");
        marker.className = "matrix-focus-key";
        marker.style.color =
          hue === null
            ? "var(--fg-4)"
            : `var(--series-${String(colorIndexForHue(hue) + 1)})`;
        marker.textContent = "—";
        return marker;
      });
      const name = document.createElement("span");
      name.textContent = `${focus.overridden ? "◆ " : ""}${focus.label}`;
      const remove = document.createElement("button");
      remove.className = "matrix-focus-remove";
      remove.type = "button";
      remove.textContent = "✕";
      remove.title = `Remove focus: ${focus.label}`;
      remove.addEventListener("click", () => {
        this.callbacks.onFocusToggle(this.id, focus.entry);
      });
      chip.append(...markers, name, remove);
      return chip;
    });
    if (result.overflow > 0) {
      const more = document.createElement("button");
      more.className = "matrix-focus-overflow";
      more.textContent = `+${String(result.overflow)}`;
      more.title = "Browse additional focused entries";
      more.addEventListener("click", (event) => {
        this.openRoster(
          "source",
          state,
          event.currentTarget as HTMLElement,
          true,
        );
      });
      chips.push(more);
    }
    return chips;
  }

  private setEmphasis(paths: readonly string[] | string | null): void {
    const next =
      paths === null
        ? null
        : new Set(typeof paths === "string" ? [paths] : paths);
    if (setsEqual(this.emphasizePaths, next)) return;
    this.emphasizePaths = next;
    if (this.lastState !== null && this.lastWindow !== null) {
      this.renderForMode(
        this.lastState,
        this.lastTiles,
        this.lastSamples,
        this.lastWindow,
      );
      this.drawOverlay(this.resolvedAnnotations(this.lastState));
    }
  }

  private openRoster(
    dimension: LegendDimension,
    state: RenderPanelState,
    anchor: HTMLElement,
    focusedOnly = false,
    ghostOnly = false,
  ): void {
    this.closeRoster();
    const roster = document.createElement("div");
    roster.className = "matrix-roster";
    if (ghostOnly) roster.dataset.filter = "ghost";
    roster.setAttribute("role", "dialog");
    roster.setAttribute("aria-label", `${dimension} roster`);
    const search = document.createElement("input");
    search.type = "search";
    search.className = "matrix-roster-search";
    search.placeholder = dimension === "source" ? "* @ source" : "channel @ *";
    search.setAttribute("aria-label", `Filter ${dimension} roster`);
    const rows = document.createElement("div");
    rows.className = "matrix-roster-rows";
    const renderRows = (): void => {
      const all = matrixLegendRows(
        this.callbacks.catalog(),
        state,
        dimension,
        search.value,
      ).filter(
        (row) => (!focusedOnly || row.focused) && (!ghostOnly || row.ghosted),
      );
      const slice = virtualSlice(all.length, rows.scrollTop, 224, 24);
      rows.replaceChildren();
      rows.style.height = `${String(slice.totalHeight)}px`;
      rows.style.paddingTop = `${String(slice.topPadding)}px`;
      for (const row of all.slice(slice.start, slice.end)) {
        const button = document.createElement("button");
        button.className = "matrix-roster-row";
        button.type = "button";
        button.innerHTML = `<span class="matrix-roster-key"></span><span class="matrix-roster-label"></span><span class="matrix-roster-count"></span>`;
        const key = required<HTMLElement>(button, ".matrix-roster-key");
        key.style.color =
          row.hue === null
            ? "var(--fg-4)"
            : `var(--series-${String(colorIndexForHue(row.hue) + 1)})`;
        key.textContent = row.focused ? "✓" : "—";
        required(button, ".matrix-roster-label").textContent =
          `${row.overridden ? "◆ " : ""}${row.label}`;
        required(button, ".matrix-roster-count").textContent =
          `×${String(row.count)}`;
        const matching = state.series.filter((series) =>
          dimension === "source"
            ? (this.callbacks.catalog().get(series.ref)?.sourceName ??
                series.ref.source_key) === row.value
            : series.ref.channel === row.value,
        );
        const paths = matching.map((series) => series.path);
        button.addEventListener("mouseenter", () => this.setEmphasis(paths));
        button.addEventListener("mouseleave", () => this.setEmphasis(null));
        button.addEventListener("click", (event) => {
          const entry = this.focusEntryForRow(dimension, row, state);
          if (event.altKey)
            this.callbacks.onMuteSelector(this.id, row.selector);
          else this.callbacks.onFocusToggle(this.id, entry);
        });
        rows.append(button);
      }
    };
    search.addEventListener("input", renderRows);
    rows.addEventListener("scroll", renderRows);
    roster.append(search, rows);
    this.element.append(roster);
    const rect = this.element.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    roster.style.left = `${String(
      clamp(anchorRect.left - rect.left, 4, Math.max(4, rect.width - 220)),
    )}px`;
    roster.style.top = `${String(
      clamp(
        anchorRect.bottom - rect.top + 4,
        4,
        Math.max(4, rect.height - 260),
      ),
    )}px`;
    renderRows();
    search.focus();
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && roster.contains(event.target)) return;
      this.closeRoster();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") this.closeRoster();
    };
    document.addEventListener("pointerdown", onPointer, { capture: true });
    document.addEventListener("keydown", onKey);
    this.rosterCleanup = () => {
      document.removeEventListener("pointerdown", onPointer, { capture: true });
      document.removeEventListener("keydown", onKey);
      roster.remove();
    };
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

  private closeRoster(): void {
    this.rosterCleanup?.();
    this.rosterCleanup = null;
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
    const useAsX = document.createElement("button");
    useAsX.className = "inspector-action";
    useAsX.textContent = "use as X";
    useAsX.addEventListener("click", () => {
      this.closeInspector();
      this.callbacks.onSetXSignal(this.id, path);
    });
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
      useAsX,
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

/** `path/leaf (unit)` for an axis name, matching the spec's XY gutters. */
function axisName(path: string, unit: string | null): string {
  const leaf = signalLabel(path);
  return unit === null ? leaf : `${leaf} (${unit})`;
}

function chipPrefix(text: string): HTMLElement {
  const prefix = document.createElement("span");
  prefix.className = "axis-chip-prefix";
  prefix.textContent = text;
  return prefix;
}

/**
 * Flattens a trace to renderer vertices. A `window` restricts output to that
 * time span; vertices outside become NaN so the pen lifts rather than
 * bridging the gap.
 */
function flattenTrace(
  trace: XyTrace,
  window: { t0: number; t1: number } | null,
): number[] {
  const points: number[] = [];
  for (let index = 0; index < trace.time.length; index += 1) {
    const time = trace.time[index] ?? Number.NaN;
    const inside = window === null || (time >= window.t0 && time <= window.t1);
    points.push(
      inside ? (trace.x[index] ?? Number.NaN) : Number.NaN,
      inside ? (trace.y[index] ?? Number.NaN) : Number.NaN,
    );
  }
  return points;
}

/** The trajectory point at a cursor time, or null outside its coverage. */
function markerAt(
  trace: XyTrace,
  cursorT: number,
): { x: number; y: number } | null {
  const x = lerpSample(trace.time, trace.x, cursorT);
  const y = lerpSample(trace.time, trace.y, cursorT);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function axisEditZone(
  layout: PlotLayout,
  axisStyle: AxisStyle,
  px: number,
  py: number,
  hasColorbar: boolean,
): "x" | "y" | "c" | null {
  const { plot } = layout;
  if (
    hasColorbar &&
    px > plot.x + plot.width &&
    py >= plot.y &&
    py <= plot.y + plot.height
  ) {
    return "c";
  }
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
      <span class="mode-pills" aria-label="Panel mode">${MODES.map(
        ({ mode, label }) =>
          `<button class="mode-pill" data-mode="${mode}">${label}</button>`,
      ).join("")}</span>
      <button class="axis-chip x-chip" hidden></button>
      <span class="panel-bindings"></span>
      <button class="panel-ghost-toggle" type="button" aria-pressed="false">all</button>
      <button class="axis-chip c-chip" hidden></button>
      <button class="panel-action panel-axis-toggle" title="Switch axis style">axes: gutter</button>
      <button
        class="panel-action panel-aspect-toggle"
        type="button"
        aria-pressed="false"
        hidden
        title="Equal axis scaling (XY only)"
      >
        1:1
      </button>
      <span class="panel-mode-note" hidden></span>
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
    <div class="panel-legend-strip">
      <span class="panel-legend"></span>
      <span class="panel-gesture-hint">color ← source · hover explore · ⇧click focus · ⌥ mute · esc clear</span>
    </div>
    <div class="plot-wrap">
      <canvas class="plot-canvas" aria-label="Time-series plot"></canvas>
      <canvas class="overlay-canvas" aria-hidden="true"></canvas>
      <div class="panel-empty" hidden></div>
      <div class="xy-drop-strip" hidden>
        ⇄ <span>drop here — use as X axis (switches panel to XY)</span>
      </div>
    </div>
    <div class="panel-stats" hidden></div>
    <div class="panel-annotations" hidden></div>`;
}

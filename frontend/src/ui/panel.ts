import { formatCombo } from "../app/commands";
import type {
  SampleResponse,
  SampleSeries,
  TileResponse,
} from "../generated/protocol";
import type {
  AxisStyle,
  DashStyle,
  PanelMode,
  PanelState,
} from "../generated/session";
import {
  clamp,
  formatValue,
  insidePlot,
  projectX,
  projectY,
  valueAtTime,
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
} from "../app/plot-capabilities";
import { spectrum } from "../app/spectrum";
import { lerpSample, pairSamples, type XyTrace } from "../app/xy";
import {
  CanvasRenderer,
  COLOR_SLOTS,
  resolveSeriesStyle,
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
export const BUNDLE_DRAG_TYPE = "application/x-signalscope-bundle";
export const PANEL_DRAG_TYPE = "application/x-signalscope-panel";
export const MAX_SERIES_PER_PANEL = 64;

export type PanelCursor = PlotCursor;

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

export type QuickTransform = "gradient" | "cumtrapz" | "movmean" | "abs";

export interface PanelCallbacks {
  onFocus(id: string): void;
  onClose(id: string): void;
  onSplitRight(id: string): void;
  onSplitDown(id: string): void;
  onMaximize(id: string): void;
  onSelectMode(id: string, mode: PanelMode): void;
  onDropSignal(id: string, path: string): void;
  onDropBundle(id: string, memberPaths: string[]): void;
  onToggleHighlight(id: string, path: string): void;
  localPathFor(path: string): string | null;
  sourceKeyFor(path: string): string | null;
  onSetXSignal(id: string, path: string): void;
  onSetColorSignal(id: string, path: string | null): void;
  onClearXSignal(id: string): void;
  onToggleSeries(id: string, path: string): void;
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
  onEditAxisLabel(
    id: string,
    axis: "x" | "y" | "c",
    label: string | null,
  ): void;
  onSetSeriesStyle(
    id: string,
    path: string,
    style: { color_slot: number; dash: DashStyle; width: number },
  ): void;
  onRemoveSeries(id: string, path: string): void;
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

export function resolveXSeries(
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
  series: readonly PanelState["series"][number][],
  callbacks: XyPairingCallbacks,
): string {
  const xLocal = callbacks.localPathFor(xSignal);
  const sources = visibleSources(series, callbacks);
  return xLocal !== null && sources.size > 1 ? xLocal : signalLabel(xSignal);
}

function visibleSources(
  series: readonly PanelState["series"][number][],
  callbacks: XyPairingCallbacks,
): Set<string> {
  return new Set(
    series
      .filter((entry) => entry.visible)
      .map((entry) => callbacks.sourceKeyFor(entry.path))
      .filter((key): key is string => key !== null),
  );
}

export function bundleXSignal(
  memberPaths: readonly string[],
  asX: boolean,
): string | undefined {
  return asX ? [...memberPaths].sort()[0] : undefined;
}

export function parseBundlePayload(
  data: string,
): { member_paths: string[] } | null {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "member_paths" in payload &&
      Array.isArray(payload.member_paths) &&
      payload.member_paths.every((path) => typeof path === "string")
    ) {
      return { member_paths: payload.member_paths };
    }
  } catch {
    // Malformed external drag payloads are not bundles.
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
  private legendChips: HTMLElement[] = [];
  private lastState: PanelState | null = null;
  private lastTiles: TileResponse | null = null;
  private lastSamples: SampleResponse | null = null;
  private lastWindow: { t0: number; t1: number } | null = null;
  private preparedPlot: PreparedPlot | null = null;
  /** Traces from the last XY render, reused by hit-testing and overlays. */
  private xyTraces: {
    path: string;
    colorIndex: number;
    dash: DashStyle;
    width: number;
    trace: XyTrace;
  }[] = [];
  private domainSeries: {
    path: string;
    colorIndex: number;
    x: number[];
    y: number[];
  }[] = [];
  private cursorT: number | null = null;
  private cursorMode: CursorMode = "none";
  private box: InteractionBox | null = null;
  private emphasizePath: string | null = null;
  private inspectorPath: string | null = null;
  private inspectorCleanup: (() => void) | null = null;
  private hasColorbar = false;

  constructor(
    private readonly id: string,
    private readonly callbacks: PanelCallbacks,
  ) {
    this.element = document.createElement("article");
    this.element.className = "panel";
    this.element.dataset.panelId = id;
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
      plotClick: (x, y) => {
        this.plotClick(x, y);
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
      this.layoutLegend();
    }).observe(required(this.element, ".panel-header"));
    new ResizeObserver(() => {
      this.callbacks.onResized(this.id);
    }).observe(this.canvas);
  }

  private bind(): void {
    this.element.addEventListener("pointerdown", (event) => {
      this.callbacks.onFocus(this.id);
      const target = event.target;
      if (
        target instanceof Node &&
        !required(this.element, ".legend-overflow-menu").contains(target) &&
        !required(this.element, ".legend-overflow").contains(target)
      ) {
        this.closeLegendOverflow();
      }
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
    required<HTMLButtonElement>(
      this.element,
      ".legend-overflow",
    ).addEventListener("click", () => {
      const menu = required<HTMLElement>(this.element, ".legend-overflow-menu");
      this.setLegendOverflowOpen(menu.hidden);
    });
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeLegendOverflow();
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
      if (
        !hasDragType(event, SIGNAL_DRAG_TYPE) &&
        !hasDragType(event, BUNDLE_DRAG_TYPE)
      )
        return;
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
      const bundle = dragData(event, BUNDLE_DRAG_TYPE);
      if (bundle !== null) {
        event.preventDefault();
        event.stopPropagation();
        const payload = parseBundlePayload(bundle);
        const first =
          payload === null ? undefined : [...payload.member_paths].sort()[0];
        if (first === undefined) return;
        this.callbacks.onSetColorSignal(this.id, first);
        return;
      }
      const path = dragData(event, SIGNAL_DRAG_TYPE);
      if (path === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onSetColorSignal(this.id, path);
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
      if (
        !hasDragType(event, SIGNAL_DRAG_TYPE) &&
        !hasDragType(event, BUNDLE_DRAG_TYPE)
      )
        return;
      event.preventDefault();
      this.element.classList.add("drop-target");
      this.setDropStripVisible(true);
      this.element.classList.toggle("drop-x", this.overStrip(event));
    });
    this.element.addEventListener("dragleave", () => {
      this.element.classList.remove("drop-target", "drop-x");
      this.setDropStripVisible(false);
    });
    this.element.addEventListener("drop", (event) => {
      const asX = this.overStrip(event);
      this.element.classList.remove("drop-target", "drop-x");
      this.setDropStripVisible(false);
      const bundle = dragData(event, BUNDLE_DRAG_TYPE);
      if (bundle !== null) {
        const payload = parseBundlePayload(bundle);
        if (payload !== null) {
          event.preventDefault();
          event.stopPropagation();
          const first = bundleXSignal(payload.member_paths, asX);
          if (first !== undefined) {
            this.callbacks.onSetXSignal(this.id, first);
          } else {
            this.callbacks.onDropBundle(this.id, payload.member_paths);
          }
        }
        return;
      }
      const path = dragData(event, SIGNAL_DRAG_TYPE);
      if (path === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (asX) this.callbacks.onSetXSignal(this.id, path);
      else this.callbacks.onDropSignal(this.id, path);
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
      this.callbacks.onCursor(
        this.id,
        cursor,
        cursor === null ? null : { x: event.clientX, y: event.clientY },
      );
    });
    this.overlay.addEventListener("pointerleave", () => {
      if (!this.interactions.isDragging()) {
        this.callbacks.onCursor(this.id, null, null);
      }
    });
    this.overlay.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  }

  update(state: PanelState, maximized: boolean): void {
    this.lastState = state;
    this.element.classList.toggle("maximized", maximized);
    this.element.setAttribute("aria-label", `${state.title} panel`);
    required(this.element, ".panel-title").textContent = state.title;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      ".mode-pill",
    )) {
      button.classList.toggle("active", button.dataset.mode === state.mode);
    }
    const xChip = required<HTMLButtonElement>(this.element, ".x-chip");
    xChip.hidden = !(state.mode === "xy" && state.x_signal !== null);
    if (!xChip.hidden && state.x_signal !== null) {
      xChip.replaceChildren(
        chipPrefix("x:"),
        document.createTextNode(
          xChipLabel(state.x_signal, state.series, this.callbacks),
        ),
      );
      xChip.title = `X axis: ${state.x_signal} — click to remove`;
    }
    const cChip = required<HTMLButtonElement>(this.element, ".c-chip");
    cChip.hidden = state.mode !== "xy";
    if (!cChip.hidden) {
      cChip.replaceChildren(
        chipPrefix("c:"),
        document.createTextNode(
          state.color_by_time
            ? "time"
            : state.color_signal === null
              ? "none"
              : xChipLabel(state.color_signal, state.series, this.callbacks),
        ),
      );
      cChip.title = state.color_by_time
        ? "Colour channel: time — click to clear"
        : state.color_signal === null
          ? `Drop a signal here to assign colour, or use ${formatCombo("mod+shift+p")} → set color signal`
          : `Colour channel: ${state.color_signal} — click to clear`;
    }
    const note = required<HTMLElement>(this.element, ".panel-mode-note");
    const windowNote = policyFor(state.mode).windowNote;
    note.hidden = windowNote === null;
    if (windowNote !== null) note.textContent = windowNote;
    required<HTMLButtonElement>(this.element, ".panel-maximize").title =
      maximized ? "Restore panel" : "Maximize panel";
    required<HTMLButtonElement>(
      this.element,
      ".panel-stats-toggle",
    ).setAttribute("aria-pressed", String(state.show_stats));
    const axisToggle = required<HTMLButtonElement>(
      this.element,
      ".panel-axis-toggle",
    );
    axisToggle.textContent = `axes: ${state.axis_style}`;
    axisToggle.title = `Switch to ${state.axis_style === "gutter" ? "inline" : "gutter"} axes`;
    this.updateLegend(state);
    const annotations = this.resolvedAnnotations(state);
    this.renderAnnotationList(state, annotations);
    this.renderStats();
    this.drawOverlay(annotations);
    if (
      this.inspectorPath !== null &&
      !state.series.some((series) => series.path === this.inspectorPath)
    ) {
      this.closeInspector();
    }
    const empty = required<HTMLElement>(this.element, ".panel-empty");
    if (state.series.length === 0) {
      empty.hidden = false;
      empty.textContent = "Empty panel — drag a signal here.";
    } else if (state.mode === "xy" && state.x_signal === null) {
      empty.hidden = false;
      empty.textContent = "Drop a signal on the strip below to set the X axis.";
    } else {
      // In fft/histogram, renderSpectra/renderHistogram own the empty state.
      empty.hidden = true;
    }
  }

  renderData(
    state: PanelState,
    tiles: TileResponse | null,
    samples: SampleResponse | null,
    window: { t0: number; t1: number },
    missing: readonly string[] = [],
  ): number {
    this.lastState = state;
    this.lastTiles = tiles;
    this.lastSamples = samples;
    this.lastWindow = { ...window };
    this.preparedPlot = null;
    this.domainSeries = [];
    this.hasColorbar = false;
    const elapsed = this.renderForMode(state, tiles, samples, window);
    this.interactions.setPolicy(
      (this.preparedPlot as PreparedPlot | null)?.interaction ?? null,
    );
    this.renderStats();
    const annotations = this.resolvedAnnotations(state);
    this.renderAnnotationList(state, annotations);
    this.drawOverlay(annotations);
    if (missing.length > 0) {
      this.setModeEmpty(true, `unknown signals: ${missing.join(", ")}`);
    }
    return elapsed;
  }

  private renderForMode(
    state: PanelState,
    tiles: TileResponse | null,
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
      (tile) => bySeries.get(tile.signal_path)?.visible ?? true,
    );
    const response = { request_id: tiles.request_id, series: shown };
    this.preparedPlot = prepareTimePlot({
      series: shown.map((tile) => {
        const series = bySeries.get(tile.signal_path);
        return {
          path: tile.signal_path,
          colorIndex: resolveSeriesStyle(
            series?.color_slot ?? 1,
            series?.dash ?? "solid",
          ).colorIndex,
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
      colorSlots: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.color_slot ?? 1,
      ),
      dashes: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.dash ?? "solid",
      ),
      yRange: [ranges.y.min, ranges.y.max],
      axisStyle: state.axis_style,
      widths: shown.map((tile) => bySeries.get(tile.signal_path)?.width ?? 1.4),
      dimmed: shown.map((tile) => {
        const localPath = this.callbacks.localPathFor(tile.signal_path);
        const highlighted =
          localPath === null
            ? undefined
            : state.highlighted_sources.find(
                (entry) => entry.local_path === localPath,
              );
        return (
          highlighted !== undefined && highlighted.path !== tile.signal_path
        );
      }),
      ...(this.emphasizePath !== null &&
      shown.some((tile) => tile.signal_path === this.emphasizePath)
        ? {
            emphasisIndex: shown.findIndex(
              (tile) => tile.signal_path === this.emphasizePath,
            ),
          }
        : {}),
    };
    return this.renderer.render(response, ranges.x, options);
  }

  private renderXy(
    state: PanelState,
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
      const style = resolveSeriesStyle(series.color_slot, series.dash);
      this.xyTraces.push({
        path: series.path,
        colorIndex: style.colorIndex,
        dash: style.dash,
        width: series.width,
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
        colorIndex: entry.colorIndex,
        dash: "solid",
        width: 1.2,
        dimmed: true,
      });
    }
    this.xyTraces.forEach((entry, index) => {
      const colorValues = colorColumns[index];
      paths.push({
        points: flattenTrace(entry.trace, window),
        colorIndex: entry.colorIndex,
        dash: entry.dash,
        width: entry.width + 0.4,
        markers: true,
        ...(hasColor && colorValues !== null
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
    state: PanelState,
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
      const style = resolveSeriesStyle(series.color_slot, series.dash);
      this.domainSeries.push({
        path: series.path,
        colorIndex: style.colorIndex,
        x: result.frequency,
        y: result.amplitudeDb,
      });
      paths.push({
        points,
        colorIndex: style.colorIndex,
        dash: style.dash,
        width: series.width,
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
    state: PanelState,
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
      const style = resolveSeriesStyle(
        series?.color_slot ?? 1,
        series?.dash ?? "solid",
      );
      if (series !== undefined) {
        histogramSeries.push({
          path: series.path,
          colorIndex: style.colorIndex,
          counts,
          sourceValues: columns[index] ?? [],
        });
      }
      return {
        points,
        colorIndex: style.colorIndex,
        dash: style.dash,
        width: series?.width ?? 1.4,
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
    state: PanelState,
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

  plotClick(offsetX: number, offsetY: number): void {
    // 2A's asymmetry: the remove radius is smaller than the pin radius so a
    // double-click cancels its own accidental pin before fitting.
    if (this.removeAt(offsetX, offsetY, 9)) return;
    this.pinAt(offsetX, offsetY, 14);
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
  private pinAt(offsetX: number, offsetY: number, radius: number): void {
    const layout = this.renderer.lastLayout();
    if (layout === null) return;
    const hit = this.preparedPlot?.annotationAt(
      layout,
      { x: offsetX, y: offsetY },
      radius,
    );
    if (hit !== null && hit !== undefined) {
      this.callbacks.onPinAnnotation(this.id, hit);
    }
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

  private resolvedAnnotations(state: PanelState): ResolvedAnnotations {
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
            return point === null ? [] : [point];
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
    bySeries: ReadonlyMap<string, PanelState["series"][number]>,
  ): CursorPoint[] {
    if (mode === "fft") {
      return this.domainSeries.map((series) => ({
        value: lerpSample(series.x, series.y, cursorT),
        colorIndex: series.colorIndex,
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
      return (cursor?.markers ?? []).map((point) => ({
        value: point.y,
        colorIndex: point.colorIndex,
      }));
    }
    return (this.lastTiles?.series ?? []).flatMap((tile) => {
      const series = bySeries.get(tile.signal_path);
      if (series?.visible !== true) return [];
      const value = valueAtTime(tile.bins, cursorT);
      if (value === null) return [];
      return [
        {
          value,
          colorIndex: resolveSeriesStyle(series.color_slot, series.dash)
            .colorIndex,
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
    const groups = this.preparedPlot?.stats() ?? [];
    const show = state !== null && state.show_stats && groups.length > 0;
    strip.hidden = !show;
    if (!show) {
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
    state: PanelState,
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

  private updateLegend(state: PanelState): void {
    this.legendChips = state.series.map((series) => this.legendChip(series));
    this.layoutLegend();
  }

  private layoutLegend(): void {
    const legend = required(this.element, ".panel-legend");
    const menu = required<HTMLElement>(this.element, ".legend-overflow-menu");
    const overflow = required<HTMLButtonElement>(
      this.element,
      ".legend-overflow",
    );
    const menuWasOpen = !menu.hidden;
    const chips = this.legendChips;
    legend.replaceChildren(...chips);
    overflow.hidden = true;

    let visibleCount = chips.length;
    if (legend.scrollWidth > legend.clientWidth) {
      overflow.hidden = false;
      overflow.textContent = `+${String(chips.length)}`;
      const gap = Number.parseFloat(getComputedStyle(legend).columnGap) || 0;
      let used = 0;
      visibleCount = 0;
      for (const chip of chips) {
        const next = used + (visibleCount === 0 ? 0 : gap) + chip.offsetWidth;
        if (next > legend.clientWidth) break;
        used = next;
        visibleCount += 1;
      }
    }

    const overflowCount = chips.length - visibleCount;
    legend.replaceChildren(...chips.slice(0, visibleCount));
    menu.replaceChildren(...chips.slice(visibleCount));

    overflow.hidden = overflowCount === 0;
    overflow.textContent = `+${String(overflowCount)}`;
    overflow.setAttribute(
      "aria-label",
      `${String(overflowCount)} additional series`,
    );
    menu.hidden = overflowCount === 0 || !menuWasOpen;
    this.syncLegendOverflowButton();
  }

  private legendChip(series: PanelState["series"][number]): HTMLElement {
    const chip = document.createElement("span");
    chip.className = `legend-chip ${series.visible ? "" : "muted"}`;
    chip.classList.toggle(
      "highlighted",
      this.lastState?.highlighted_sources.some(
        (entry) => entry.path === series.path,
      ) ?? false,
    );
    const body = document.createElement("button");
    body.className = "legend-chip-body";
    body.title = `${series.path} — click to toggle visibility`;
    const line = document.createElement("span");
    const style = resolveSeriesStyle(series.color_slot, series.dash);
    line.className = `legend-line dash-${style.dash}`;
    line.setAttribute("aria-hidden", "true");
    line.style.color = `var(--series-${String(style.colorIndex + 1)})`;
    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = signalLabel(series.path);
    body.append(line, name);
    body.addEventListener("click", () => {
      this.callbacks.onToggleSeries(this.id, series.path);
    });
    body.addEventListener("mouseenter", () => {
      this.setEmphasis(series.path);
    });
    body.addEventListener("mouseleave", () => {
      this.setEmphasis(null);
    });
    const caret = document.createElement("button");
    caret.className = "legend-chip-caret";
    caret.textContent = "▾";
    caret.title = `${series.path} — series inspector`;
    caret.setAttribute("aria-haspopup", "true");
    caret.addEventListener("click", (event) => {
      this.openInspector(series.path, event.clientX, event.clientY);
    });
    chip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openInspector(series.path, event.clientX, event.clientY);
    });
    chip.append(body, caret);
    return chip;
  }

  private setEmphasis(path: string | null): void {
    if (this.emphasizePath === path) return;
    this.emphasizePath = path;
    if (this.lastState !== null && this.lastWindow !== null) {
      this.renderData(
        this.lastState,
        this.lastTiles,
        this.lastSamples,
        this.lastWindow,
      );
    }
  }

  private openInspector(path: string, clientX: number, clientY: number): void {
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
        resolveSeriesStyle(series.color_slot, "solid").colorIndex + 1 === slot,
      );
      swatch.addEventListener("click", () => {
        this.callbacks.onSetSeriesStyle(this.id, path, {
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
        this.callbacks.onSetSeriesStyle(this.id, path, {
          color_slot: series.color_slot,
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
      this.callbacks.onSetSeriesStyle(this.id, path, {
        color_slot: series.color_slot,
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
    const localPath = this.callbacks.localPathFor(path);
    const highlight =
      localPath === null ? null : document.createElement("button");
    if (highlight !== null) {
      const active =
        this.lastState?.highlighted_sources.some(
          (entry) => entry.path === path,
        ) ?? false;
      highlight.className = "inspector-action";
      highlight.textContent = active ? "Clear highlight" : "Highlight";
      highlight.addEventListener("click", () => {
        this.closeInspector();
        this.callbacks.onToggleHighlight(this.id, path);
      });
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
      this.callbacks.onRemoveSeries(this.id, path);
    });
    popover.append(
      pathRow,
      slots,
      dashes,
      transforms,
      ...(highlight === null ? [] : [highlight]),
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

  private setLegendOverflowOpen(open: boolean): void {
    const menu = required<HTMLElement>(this.element, ".legend-overflow-menu");
    if (required<HTMLButtonElement>(this.element, ".legend-overflow").hidden) {
      return;
    }
    menu.hidden = !open;
    this.syncLegendOverflowButton();
  }

  private closeLegendOverflow(): void {
    this.setLegendOverflowOpen(false);
  }

  private syncLegendOverflowButton(): void {
    const menu = required<HTMLElement>(this.element, ".legend-overflow-menu");
    const overflow = required<HTMLButtonElement>(
      this.element,
      ".legend-overflow",
    );
    const open = !menu.hidden;
    overflow.setAttribute("aria-expanded", String(open));
    overflow.title = open ? "Hide additional series" : "Show additional series";
  }
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
      <span class="panel-legend"></span>
      <button class="legend-overflow" aria-haspopup="true" aria-expanded="false" hidden></button>
      <button class="axis-chip c-chip" hidden></button>
      <button class="panel-action panel-axis-toggle" title="Switch axis style">axes: gutter</button>
      <span class="panel-mode-note" hidden></span>
      <span class="panel-actions">
        <button class="panel-action panel-stats-toggle" title="Toggle statistics (S)" aria-pressed="false">Σ</button>
        <span class="panel-split-actions" aria-label="Split panel" role="group">
          <span class="panel-split-label" aria-hidden="true">split</span>
          <button class="panel-action panel-split-right" aria-label="Split panel right" title="Split panel right">→</button>
          <button class="panel-action panel-split-down" aria-label="Split panel down" title="Split panel down (N)">↓</button>
        </span>
        <button class="panel-action panel-maximize" title="Maximize panel">⤢</button>
        <button class="panel-action panel-close" title="Close panel">✕</button>
      </span>
    </header>
    <div class="legend-overflow-menu" role="group" aria-label="Additional plotted series" hidden></div>
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

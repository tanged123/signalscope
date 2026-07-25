import type { TileResponse } from "../generated/protocol";
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
  invertX,
  invertY,
  valueAtTime,
  wheelZoomFactor,
  zoomDragMode,
  zoomRange,
  type PlotLayout,
} from "../app/plot-math";
import {
  nearestAnnotation,
  nearestVertex,
  type VertexHit,
} from "../app/plot-hit";
import { visibleStats } from "../app/stats";
import {
  CanvasRenderer,
  COLOR_SLOTS,
  resolveSeriesStyle,
  type RenderOptions,
} from "../render/canvas-renderer";
import { OverlayRenderer, type CursorStyle } from "../render/overlay-renderer";
import { YAxisPolicy } from "../render/y-axis";
import { required } from "./dom";

export const SIGNAL_DRAG_TYPE = "application/x-signalscope-signal";
export const PANEL_DRAG_TYPE = "application/x-signalscope-panel";

const MODES: readonly { mode: PanelMode; label: string }[] = [
  { mode: "time", label: "T" },
  { mode: "xy", label: "XY" },
  { mode: "fft", label: "FFT" },
  { mode: "histogram", label: "H" },
];

const MODE_NAMES: Record<PanelMode, string> = {
  time: "Time",
  xy: "XY",
  fft: "FFT",
  histogram: "Histogram",
};

export interface PanelCallbacks {
  onFocus(id: string): void;
  onClose(id: string): void;
  onSplitRight(id: string): void;
  onSplitDown(id: string): void;
  onMaximize(id: string): void;
  onSelectMode(id: string, mode: PanelMode): void;
  onDropSignal(id: string, path: string): void;
  onToggleSeries(id: string, path: string): void;
  onResized(id: string): void;
  onCursor(
    id: string,
    cursorT: number | null,
    client: { x: number; y: number } | null,
  ): void;
  onTimeWindow(id: string, t0: number, t1: number): void;
  onYRange(id: string, range: readonly [number, number]): void;
  onPinAnnotation(id: string, hit: VertexHit): void;
  onRemoveAnnotation(id: string, annotationId: string): void;
  onEditAnnotationLabel(id: string, annotationId: string, label: string): void;
  onFitView(id: string): void;
  onToggleStats(id: string): void;
  onToggleAxisStyle(id: string): void;
  onRenameTitle(id: string, title: string): void;
  onEditAxisLabel(id: string, axis: "x" | "y", label: string | null): void;
  onSetSeriesStyle(
    id: string,
    path: string,
    style: { color_slot: number; dash: DashStyle; width: number },
  ): void;
  onRemoveSeries(id: string, path: string): void;
}

export function hasDragType(event: DragEvent, type: string): boolean {
  return event.dataTransfer?.types.includes(type) ?? false;
}

/** The non-empty payload carried for `type` on a drop event, or null. */
export function dragData(event: DragEvent, type: string): string | null {
  const value = event.dataTransfer?.getData(type);
  return value !== undefined && value !== "" ? value : null;
}

export class PanelView {
  readonly element: HTMLElement;
  private readonly renderer: CanvasRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayRenderer: OverlayRenderer;
  private readonly yAxis = new YAxisPolicy();
  private legendChips: HTMLElement[] = [];
  private lastState: PanelState | null = null;
  private lastTiles: TileResponse | null = null;
  private lastWindow: { t0: number; t1: number } | null = null;
  private cursorT: number | null = null;
  private cursorStyle: CursorStyle = "none";
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private dragging = false;
  private emphasizePath: string | null = null;
  private inspectorCleanup: (() => void) | null = null;

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
      if (hasDragType(event, SIGNAL_DRAG_TYPE)) {
        event.preventDefault();
        this.element.classList.add("drop-target");
      }
    });
    this.element.addEventListener("dragleave", () => {
      this.element.classList.remove("drop-target");
    });
    this.element.addEventListener("drop", (event) => {
      this.element.classList.remove("drop-target");
      const path = dragData(event, SIGNAL_DRAG_TYPE);
      if (path !== null) {
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.onDropSignal(this.id, path);
      }
    });
    this.overlay.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch" || this.dragging) return;
      const layout = this.renderer.lastLayout();
      const cursorT =
        layout !== null && insidePlot(layout, event.offsetX, event.offsetY)
          ? invertX(layout, event.offsetX)
          : null;
      this.callbacks.onCursor(
        this.id,
        cursorT,
        cursorT === null ? null : { x: event.clientX, y: event.clientY },
      );
    });
    this.overlay.addEventListener("pointerleave", () => {
      if (!this.dragging) this.callbacks.onCursor(this.id, null, null);
    });
    this.overlay.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
    this.overlay.addEventListener(
      "wheel",
      (event) => {
        const layout = this.renderer.lastLayout();
        if (layout === null || this.lastState?.mode !== "time") return;
        event.preventDefault();
        const factor = wheelZoomFactor(event.deltaY);
        const pivotY = invertY(
          layout,
          clamp(
            event.offsetY,
            layout.plot.y,
            layout.plot.y + layout.plot.height,
          ),
        );
        const nextY = zoomRange(layout.yRange, factor, pivotY);
        const pivotX = invertX(
          layout,
          clamp(
            event.offsetX,
            layout.plot.x,
            layout.plot.x + layout.plot.width,
          ),
        );
        const nextX = zoomRange(layout.xRange, factor, pivotX);
        if (event.shiftKey) {
          this.callbacks.onYRange(this.id, [nextY.min, nextY.max]);
        } else if (event.altKey) {
          this.callbacks.onTimeWindow(this.id, nextX.min, nextX.max);
        } else {
          this.callbacks.onYRange(this.id, [nextY.min, nextY.max]);
          this.callbacks.onTimeWindow(this.id, nextX.min, nextX.max);
        }
      },
      { passive: false },
    );
    this.overlay.addEventListener("pointerdown", (event) => {
      const layout = this.renderer.lastLayout();
      if (layout === null || this.lastState?.mode !== "time") return;
      const isPan =
        event.button === 1 ||
        event.button === 2 ||
        (event.button === 0 && (event.ctrlKey || event.metaKey));
      if (isPan) {
        event.preventDefault();
        this.beginPan(event, layout);
      } else if (event.button === 0) {
        this.beginBoxOrClick(event, layout);
      }
    });
    this.overlay.addEventListener("dblclick", (event) => {
      const layout = this.renderer.lastLayout();
      const state = this.lastState;
      if (layout === null || state === null || state.mode !== "time") return;
      const zone = axisEditZone(
        layout,
        state.axis_style,
        event.offsetX,
        event.offsetY,
      );
      if (zone !== null) {
        this.beginAxisEdit(zone);
      } else if (insidePlot(layout, event.offsetX, event.offsetY)) {
        this.callbacks.onFitView(this.id);
      }
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
    this.renderAnnotationList(state);
    this.renderStats();
    this.drawOverlay();
    if (!state.series.some((series) => series.path === this.emphasizePath)) {
      this.closeInspector();
    }
    const empty = required<HTMLElement>(this.element, ".panel-empty");
    if (state.mode !== "time") {
      empty.hidden = false;
      empty.textContent = `${MODE_NAMES[state.mode]} mode is not implemented yet.`;
    } else if (state.series.length === 0) {
      empty.hidden = false;
      empty.textContent = "Empty panel — drag a signal here.";
    } else {
      empty.hidden = true;
    }
  }

  renderTiles(
    state: PanelState,
    tiles: TileResponse | null,
    window: { t0: number; t1: number },
  ): number {
    this.lastState = state;
    this.lastTiles = tiles;
    this.lastWindow = { ...window };
    if (tiles === null || state.mode !== "time" || state.series.length === 0) {
      this.renderStats();
      this.drawOverlay();
      return 0;
    }
    const bySeries = new Map(
      state.series.map((series) => [series.path, series]),
    );
    const shown = tiles.series.filter(
      (tile) => bySeries.get(tile.signal_path)?.visible ?? true,
    );
    const response = { request_id: tiles.request_id, series: shown };
    const seriesKey = state.series.map((series) => series.path).join("\u0000");
    const yRange = this.yAxis.resolve(
      seriesKey,
      () => tiles.series.flatMap((tile) => tile.bins),
      state.y_range,
    );
    const options: RenderOptions = {
      xLabel: state.x_label ?? "time (s)",
      yLabel: state.y_label ?? yLabel(response.series.map((tile) => tile.unit)),
      colorSlots: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.color_slot ?? 1,
      ),
      dashes: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.dash ?? "solid",
      ),
      yRange,
      axisStyle: state.axis_style,
      widths: shown.map((tile) => bySeries.get(tile.signal_path)?.width ?? 1.4),
      ...(this.emphasizePath !== null &&
      shown.some((tile) => tile.signal_path === this.emphasizePath)
        ? {
            emphasisIndex: shown.findIndex(
              (tile) => tile.signal_path === this.emphasizePath,
            ),
          }
        : {}),
    };
    const elapsed = this.renderer.render(
      response,
      { min: window.t0, max: window.t1 },
      options,
    );
    this.renderStats();
    this.drawOverlay();
    return elapsed;
  }

  invalidateTheme(): void {
    this.renderer.invalidateTheme();
    this.overlayRenderer.invalidateTheme();
  }

  setCursor(cursorT: number | null): void {
    this.cursorT = cursorT;
    this.drawOverlay();
  }

  setCursorStyle(cursorStyle: CursorStyle): void {
    this.cursorStyle = cursorStyle;
    this.drawOverlay();
  }

  resetYAxis(): void {
    this.yAxis.reset();
  }

  /** The canvas's rendered CSS width, for density-bounded tile queries. */
  plotWidth(): number {
    return this.canvas.clientWidth;
  }

  plotClick(offsetX: number, offsetY: number): void {
    const layout = this.renderer.lastLayout();
    const state = this.lastState;
    const tiles = this.lastTiles;
    if (layout === null || state === null || state.mode !== "time") return;
    const existing = nearestAnnotation(
      state.annotations,
      layout,
      offsetX,
      offsetY,
      9,
    );
    if (existing !== null) {
      this.callbacks.onRemoveAnnotation(this.id, existing);
      return;
    }
    if (tiles === null) return;
    const visible = new Set(
      state.series
        .filter((series) => series.visible)
        .map((series) => series.path),
    );
    const hit = nearestVertex(
      tiles.series
        .filter((tile) => visible.has(tile.signal_path))
        .map((tile) => ({ path: tile.signal_path, bins: tile.bins })),
      layout,
      offsetX,
      offsetY,
      14,
    );
    if (hit !== null) this.callbacks.onPinAnnotation(this.id, hit);
  }

  private drawOverlay(): void {
    const state = this.lastState;
    const annotations = state?.mode === "time" ? state.annotations : [];
    const bySeries = new Map(
      (state?.series ?? []).map((series) => [series.path, series]),
    );
    const cursorT = this.cursorT;
    const cursorPoints =
      this.cursorStyle === "dot" && cursorT !== null
        ? (this.lastTiles?.series ?? []).flatMap((tile) => {
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
          })
        : [];
    this.overlayRenderer.draw(this.renderer.lastLayout(), {
      cursorT: state?.mode === "time" ? this.cursorT : null,
      cursorStyle: this.cursorStyle,
      cursorPoints,
      box: this.box,
      annotations,
      annotationColorIndices: annotations.map((annotation) => {
        const series = bySeries.get(annotation.series_path);
        return resolveSeriesStyle(
          series?.color_slot ?? 1,
          series?.dash ?? "solid",
        ).colorIndex;
      }),
      showDelta: annotations.length >= 2,
    });
  }

  private beginPan(down: PointerEvent, layout: PlotLayout): void {
    this.dragging = true;
    this.overlay.setPointerCapture(down.pointerId);
    const startX = { ...layout.xRange };
    const startY = { ...layout.yRange };
    const move = (event: PointerEvent): void => {
      const dt =
        ((down.offsetX - event.offsetX) / layout.plot.width) *
        (startX.max - startX.min);
      const dv =
        ((event.offsetY - down.offsetY) / layout.plot.height) *
        (startY.max - startY.min);
      this.callbacks.onTimeWindow(this.id, startX.min + dt, startX.max + dt);
      this.callbacks.onYRange(this.id, [startY.min + dv, startY.max + dv]);
    };
    const finish = (): void => {
      this.overlay.removeEventListener("pointermove", move);
      this.overlay.removeEventListener("pointerup", finish);
      this.overlay.removeEventListener("pointercancel", finish);
      this.dragging = false;
    };
    this.overlay.addEventListener("pointermove", move);
    this.overlay.addEventListener("pointerup", finish);
    this.overlay.addEventListener("pointercancel", finish);
  }

  private beginBoxOrClick(down: PointerEvent, layout: PlotLayout): void {
    const start = { x: down.offsetX, y: down.offsetY };
    let promoted = false;
    const clampX = (value: number): number =>
      clamp(value, layout.plot.x, layout.plot.x + layout.plot.width);
    const clampY = (value: number): number =>
      clamp(value, layout.plot.y, layout.plot.y + layout.plot.height);
    const move = (event: PointerEvent): void => {
      if (
        !promoted &&
        Math.hypot(event.offsetX - start.x, event.offsetY - start.y) <= 4
      ) {
        return;
      }
      if (!promoted) {
        promoted = true;
        this.dragging = true;
        this.overlay.setPointerCapture(down.pointerId);
      }
      const mode = zoomDragMode(
        event.offsetX - start.x,
        event.offsetY - start.y,
      );
      this.box =
        mode === "x"
          ? {
              x0: clampX(start.x),
              y0: layout.plot.y,
              x1: clampX(event.offsetX),
              y1: layout.plot.y + layout.plot.height,
            }
          : mode === "y"
            ? {
                x0: layout.plot.x,
                y0: clampY(start.y),
                x1: layout.plot.x + layout.plot.width,
                y1: clampY(event.offsetY),
              }
            : {
                x0: clampX(start.x),
                y0: clampY(start.y),
                x1: clampX(event.offsetX),
                y1: clampY(event.offsetY),
              };
      this.drawOverlay();
    };
    const finish = (event: PointerEvent): void => {
      cleanup();
      const box = this.box;
      this.box = null;
      this.drawOverlay();
      if (!promoted) {
        this.plotClick(event.offsetX, event.offsetY);
        return;
      }
      if (box === null) return;
      const horizontal =
        box.y0 === layout.plot.y &&
        box.y1 === layout.plot.y + layout.plot.height;
      const vertical =
        box.x0 === layout.plot.x &&
        box.x1 === layout.plot.x + layout.plot.width;
      if (horizontal) {
        if (Math.abs(box.x1 - box.x0) <= 6) return;
        const t0 = invertX(layout, Math.min(box.x0, box.x1));
        const t1 = invertX(layout, Math.max(box.x0, box.x1));
        this.callbacks.onTimeWindow(this.id, t0, t1);
      } else if (vertical) {
        if (Math.abs(box.y1 - box.y0) <= 6) return;
        const yLow = invertY(layout, Math.max(box.y0, box.y1));
        const yHigh = invertY(layout, Math.min(box.y0, box.y1));
        this.callbacks.onYRange(this.id, [yLow, yHigh]);
      } else {
        if (Math.abs(box.x1 - box.x0) <= 6 || Math.abs(box.y1 - box.y0) <= 6) {
          return;
        }
        const t0 = invertX(layout, Math.min(box.x0, box.x1));
        const t1 = invertX(layout, Math.max(box.x0, box.x1));
        const yLow = invertY(layout, Math.max(box.y0, box.y1));
        const yHigh = invertY(layout, Math.min(box.y0, box.y1));
        this.callbacks.onYRange(this.id, [yLow, yHigh]);
        this.callbacks.onTimeWindow(this.id, t0, t1);
      }
    };
    const cancel = (): void => {
      cleanup();
      this.box = null;
      this.drawOverlay();
    };
    const cleanup = (): void => {
      this.overlay.removeEventListener("pointermove", move);
      this.overlay.removeEventListener("pointerup", finish);
      this.overlay.removeEventListener("pointercancel", cancel);
      this.dragging = false;
    };
    this.overlay.addEventListener("pointermove", move);
    this.overlay.addEventListener("pointerup", finish);
    this.overlay.addEventListener("pointercancel", cancel);
  }

  private renderStats(): void {
    const strip = required<HTMLElement>(this.element, ".panel-stats");
    const state = this.lastState;
    const tiles = this.lastTiles;
    const window = this.lastWindow;
    const show =
      state !== null &&
      state.mode === "time" &&
      state.show_stats &&
      tiles !== null &&
      window !== null;
    strip.hidden = !show;
    if (!show) {
      strip.replaceChildren();
      return;
    }
    const visible = new Set(
      state.series
        .filter((series) => series.visible)
        .map((series) => series.path),
    );
    const rows = tiles.series
      .filter((tile) => visible.has(tile.signal_path))
      .map((tile) => {
        const stats = visibleStats(tile.bins, window.t0, window.t1);
        const row = document.createElement("span");
        row.className = "stats-series";
        row.append(
          statsName(tile.signal_path.split("/").slice(-2).join("/")),
          statsItem("min", stats.min),
          statsItem("max", stats.max),
          statsItem("μ", stats.mean),
          statsItem("rms", stats.rms),
        );
        return row;
      });
    const hint = document.createElement("span");
    hint.className = "stats-hint";
    hint.textContent = "visible region · S toggles";
    strip.replaceChildren(...rows, hint);
  }

  private renderAnnotationList(state: PanelState): void {
    const list = required<HTMLElement>(this.element, ".panel-annotations");
    const annotations = state.mode === "time" ? state.annotations : [];
    list.hidden = annotations.length === 0;
    if (annotations.length === 0) {
      list.replaceChildren();
      return;
    }
    const heading = document.createElement("div");
    heading.className = "annotations-heading";
    heading.textContent = `ANNOTATIONS — ${state.title.toUpperCase()}`;
    const rows = annotations.map((annotation, index) => {
      const row = document.createElement("div");
      row.className = "annotation-row";
      const text = document.createElement("span");
      text.className = "annotation-text";
      text.textContent =
        `${marker(index)} t ${annotation.time.toFixed(3)} · v ${formatValue(annotation.value)}` +
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
    list.replaceChildren(heading, ...rows);
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

  private beginAxisEdit(axis: "x" | "y"): void {
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
    name.textContent = series.path.split("/").slice(-2).join("/");
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
      this.renderTiles(this.lastState, this.lastTiles, this.lastWindow);
    }
  }

  private openInspector(path: string, clientX: number, clientY: number): void {
    this.closeInspector();
    const series = this.lastState?.series.find((entry) => entry.path === path);
    if (series === undefined) return;
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
    const remove = document.createElement("button");
    remove.className = "inspector-remove";
    remove.textContent = "remove";
    remove.addEventListener("click", () => {
      this.closeInspector();
      this.callbacks.onRemoveSeries(this.id, path);
    });
    popover.append(pathRow, slots, dashes, remove);
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

export function axisEditZone(
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

function marker(index: number): string {
  return index < 20
    ? String.fromCodePoint(0x2460 + index)
    : `(${String(index + 1)})`;
}

function statsName(text: string): HTMLElement {
  const name = document.createElement("span");
  name.className = "stats-name";
  name.textContent = text;
  return name;
}

function statsItem(label: string, value: number | null): HTMLElement {
  const item = document.createElement("span");
  item.className = "stats-item";
  const key = document.createElement("span");
  key.textContent = label;
  const reading = document.createElement("b");
  reading.textContent = formatValue(value);
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
      <span class="panel-legend"></span>
      <button class="legend-overflow" aria-haspopup="true" aria-expanded="false" hidden></button>
      <button class="panel-action panel-axis-toggle" title="Switch axis style">axes: gutter</button>
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
    </div>
    <div class="panel-stats" hidden></div>
    <div class="panel-annotations" hidden></div>`;
}

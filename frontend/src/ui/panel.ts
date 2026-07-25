import type { TileResponse } from "../generated/protocol";
import type { PanelMode, PanelState } from "../generated/session";
import {
  CanvasRenderer,
  resolveSeriesStyle,
  type RenderOptions,
} from "../render/canvas-renderer";
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

export const HEADER_LEGEND_LIMIT = 3;

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
}

export function hasDragType(event: DragEvent, type: string): boolean {
  return event.dataTransfer?.types.includes(type) ?? false;
}

export class PanelView {
  readonly element: HTMLElement;
  private readonly renderer: CanvasRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly yAxis = new YAxisPolicy();

  constructor(
    private readonly id: string,
    private readonly callbacks: PanelCallbacks,
  ) {
    this.element = document.createElement("article");
    this.element.className = "panel";
    this.element.dataset.panelId = id;
    this.element.innerHTML = panelMarkup();
    this.canvas = required<HTMLCanvasElement>(this.element, ".plot-canvas");
    this.renderer = new CanvasRenderer(this.canvas);
    this.bind();
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
      const path = event.dataTransfer?.getData(SIGNAL_DRAG_TYPE);
      if (path !== undefined && path !== "") {
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.onDropSignal(this.id, path);
      }
    });
  }

  update(state: PanelState, maximized: boolean): void {
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
    this.updateLegend(state);
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
    if (tiles === null || state.mode !== "time" || state.series.length === 0) {
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
      tiles.series.flatMap((tile) => tile.bins),
      state.y_range,
    );
    const options: RenderOptions = {
      xLabel: "time (s)",
      yLabel: yLabel(response.series.map((tile) => tile.unit)),
      colorSlots: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.color_slot ?? 1,
      ),
      dashes: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.dash ?? "solid",
      ),
      yRange,
    };
    return this.renderer.render(
      response,
      { min: window.t0, max: window.t1 },
      options,
    );
  }

  invalidateTheme(): void {
    this.renderer.invalidateTheme();
  }

  private updateLegend(state: PanelState): void {
    const legend = required(this.element, ".panel-legend");
    const menu = required<HTMLElement>(this.element, ".legend-overflow-menu");
    const overflow = required<HTMLButtonElement>(
      this.element,
      ".legend-overflow",
    );
    const menuWasOpen = !menu.hidden;
    const headerSeries = state.series.slice(0, HEADER_LEGEND_LIMIT);
    const overflowSeries = state.series.slice(HEADER_LEGEND_LIMIT);
    legend.replaceChildren(
      ...headerSeries.map((series) => this.legendChip(series)),
    );
    menu.replaceChildren(
      ...overflowSeries.map((series) => this.legendChip(series)),
    );

    overflow.hidden = overflowSeries.length === 0;
    overflow.textContent = `+${String(overflowSeries.length)}`;
    overflow.setAttribute(
      "aria-label",
      `${String(overflowSeries.length)} additional series`,
    );
    menu.hidden = overflowSeries.length === 0 || !menuWasOpen;
    this.syncLegendOverflowButton();
  }

  private legendChip(series: PanelState["series"][number]): HTMLButtonElement {
    const chip = document.createElement("button");
    chip.className = `legend-chip ${series.visible ? "" : "muted"}`;
    chip.title = `${series.path} — click to toggle visibility`;
    const line = document.createElement("span");
    const style = resolveSeriesStyle(series.color_slot, series.dash);
    line.className = `legend-line dash-${style.dash}`;
    line.style.color = `var(--series-${String(style.colorIndex + 1)})`;
    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = series.path.split("/").slice(-2).join("/");
    chip.append(line, name);
    chip.addEventListener("click", () => {
      this.callbacks.onToggleSeries(this.id, series.path);
    });
    return chip;
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
      <span class="panel-actions">
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
      <div class="panel-empty" hidden></div>
    </div>`;
}

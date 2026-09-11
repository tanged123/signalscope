import { axisControlsMarkup } from "./panel-axes";
import { required } from "./dom";
import { formatToolbarNumber } from "./series-inspector";
import { showPanelMenu, type MenuOption } from "./panel-menu";
import {
  PanelToolbar,
  panelToolbarAnchor,
  type PanelToolbarGroups,
} from "./panel-toolbar";
import type {
  AnnotationDisplay,
  LegendState,
  PanelState,
} from "../generated/session";
import { SIGNAL_DRAG_TYPE, SET_DRAG_TYPE, hasDragType } from "./panel-shell";

export interface LineToolbarActions {
  toggleStats(): void;
  toggleAxes(): void;
  setWidth(width: number): void;
  toggleGhost(): void;
  setGhostOpacity(opacity: number): void;
  setLegend(state: LegendState): void;
  setTips(display: AnnotationDisplay): void;
  clearTips(): void;
  beforeOpen(): void;
}

export class LineToolbar {
  private readonly toolbar: PanelToolbar;
  private readonly abort = new AbortController();
  private state: PanelState | null = null;
  private menuCleanup: (() => void) | null = null;

  constructor(
    private readonly host: HTMLElement,
    slot: HTMLElement,
    private readonly actions: LineToolbarActions,
  ) {
    const content = (markup: string): HTMLElement => {
      const node = document.createElement("div");
      node.className = "panel-toolbar-controls";
      node.innerHTML = markup;
      return node;
    };
    const groups: PanelToolbarGroups = {
      data: {
        summary: "",
        controls: content(
          `<button class="panel-action panel-axis-toggle" type="button" title="Switch axis presentation">axes: gutter</button>${axisControlsMarkup()}`,
        ),
      },
      appearance: {
        summary: "",
        controls:
          content(`<button class="panel-toolbar-control panel-line-width" type="button" title="Default line width for this panel" aria-label="Line width"><span class="line-width-sample" aria-hidden="true"></span>width <span class="panel-line-width-value"></span> <span class="toolbar-caret">▾</span></button>
          <button class="panel-toolbar-control panel-ghost-opacity" type="button" title="Dim non-focused traces; keep them visible">dim others <b class="panel-ghost-value"></b> <span class="toolbar-caret">▾</span></button>
          <button class="panel-toolbar-control panel-legend-state" type="button" title="Legend type">legend <b class="panel-legend-value"></b> <span class="toolbar-caret">▾</span></button>`),
      },
      analysis: {
        summary: "",
        controls:
          content(`<button class="panel-action panel-stats-toggle" type="button" title="Toggle statistics columns (S)" aria-pressed="false">Σ <span>stats</span></button>
          <button class="panel-toolbar-control panel-tips" type="button" title="Data tips: labels, markers, visibility, and actions">tips <b class="panel-tips-value"></b> <span class="toolbar-caret">▾</span></button>`),
      },
    };
    this.toolbar = new PanelToolbar(host, slot, groups, () => {
      this.closeMenu();
      actions.beforeOpen();
    });
    const bind = (
      selector: string,
      run: (anchor: HTMLElement) => void,
    ): void => {
      const control = required<HTMLElement>(host, selector);
      control.addEventListener(
        "click",
        () => {
          if (this.state !== null) run(control);
        },
        { signal: this.abort.signal },
      );
    };
    bind(".panel-stats-toggle", () => actions.toggleStats());
    bind(".panel-axis-toggle", () => actions.toggleAxes());
    bind(".panel-line-width", (anchor) => this.openWidth(anchor));
    bind(".panel-ghost-opacity", (anchor) => this.openGhost(anchor));
    bind(".panel-legend-state", (anchor) => this.openLegend(anchor));
    bind(".panel-tips", (anchor) => this.openTips(anchor));
    required(host, '[data-toolbar-trigger="data"]').addEventListener(
      "dragenter",
      (event) => {
        const drag = event as DragEvent;
        if (
          hasDragType(drag, SIGNAL_DRAG_TYPE) ||
          hasDragType(drag, SET_DRAG_TYPE)
        )
          this.toolbar.open("data", false, false);
      },
      { signal: this.abort.signal },
    );
  }

  update(
    state: PanelState,
    count: number,
    labels: { x: string; color: string },
  ): void {
    this.state = state;
    const axis = required<HTMLElement>(this.host, ".panel-axis-toggle");
    axis.textContent = `axes: ${state.axis_style}`;
    axis.title = `Switch to ${state.axis_style === "gutter" ? "inline" : "gutter"} axes`;
    const width = formatToolbarNumber(state.line_width);
    const dim =
      state.ghost_mode === "all"
        ? "none"
        : `${String(Math.round(state.ghost_opacity * 100))}%`;
    required(this.host, ".panel-line-width-value").textContent = width;
    required(this.host, ".panel-ghost-value").textContent = dim;
    required(this.host, ".panel-legend-value").textContent = state.legend_state;
    required(this.host, ".panel-tips-value").textContent = String(
      state.annotations.length,
    );
    required(this.host, ".panel-stats-toggle").setAttribute(
      "aria-pressed",
      String(state.show_stats),
    );
    const limits =
      state.x_range !== null ||
      state.y_range !== null ||
      state.x_scale === "log" ||
      state.y_scale === "log" ||
      state.x_reversed === true ||
      state.y_reversed === true ||
      state.axis_equal;
    this.toolbar.setSummary(
      "data",
      `${labels.x} · ${String(count)} Y · ${state.axis_style}${labels.color === "none" ? "" : ` · C: ${labels.color}`}${limits ? " · custom limits" : ""}`,
    );
    this.toolbar.setSummary(
      "appearance",
      `${String(state.line_width)}px · others ${dim === "none" ? "off" : dim} · ${state.legend_state}`,
    );
    this.toolbar.setSummary(
      "analysis",
      `stats ${state.show_stats ? "on" : "off"} · ${String(state.annotations.length)} tips${state.annotation_display === "labels" ? "" : ` · ${state.annotation_display}`}`,
    );
  }

  closeMenu(): void {
    this.menuCleanup?.();
    this.menuCleanup = null;
  }

  dispose(): void {
    this.closeMenu();
    this.toolbar.dispose();
    this.abort.abort();
  }

  private open(
    anchor: HTMLElement,
    label: string,
    options: readonly MenuOption[],
  ): void {
    this.closeMenu();
    this.actions.beforeOpen();
    this.menuCleanup = showPanelMenu(
      this.host,
      panelToolbarAnchor(anchor),
      label,
      options,
    );
  }

  private openWidth(anchor: HTMLElement): void {
    const state = this.state;
    if (state === null) return;
    this.open(
      anchor,
      "LINE WIDTH · PANEL DEFAULT",
      [1, 1.4, 1.5, 2, 3].map((width) => ({
        label: `${formatToolbarNumber(width)} px`,
        active: Math.abs(state.line_width - width) < 0.001,
        run: () => this.actions.setWidth(width),
      })),
    );
  }

  private openGhost(anchor: HTMLElement): void {
    const state = this.state;
    if (state === null) return;
    this.open(anchor, "DIM OTHER SERIES", [
      {
        label: "none · show full color",
        active: state.ghost_mode === "all",
        run: () => {
          if (state.ghost_mode !== "all") this.actions.toggleGhost();
        },
      },
      ...[0.2, 0.35, 0.5].map((opacity) => ({
        label: `to ${String(Math.round(opacity * 100))}% opacity`,
        active:
          state.ghost_mode === "ghost" &&
          Math.abs(state.ghost_opacity - opacity) < 0.001,
        run: () => {
          this.actions.setGhostOpacity(opacity);
          if (state.ghost_mode !== "ghost") this.actions.toggleGhost();
        },
      })),
    ]);
  }

  private openLegend(anchor: HTMLElement): void {
    const state = this.state;
    if (state === null) return;
    this.open(
      anchor,
      "LEGEND TYPE",
      (["badge", "keys", "roster", "rail"] as const).map((legend) => ({
        label: legend,
        active: state.legend_state === legend,
        run: () => this.actions.setLegend(legend),
      })),
    );
  }

  private openTips(anchor: HTMLElement): void {
    const state = this.state;
    if (state === null) return;
    this.open(anchor, `TIPS · ${String(state.annotations.length)}`, [
      ...(["labels", "markers", "hidden"] as const).map((mode) => ({
        label: mode === "markers" ? "markers only" : mode,
        active: state.annotation_display === mode,
        run: () => this.actions.setTips(mode),
      })),
      {
        label: "clear all",
        active: false,
        action: true,
        run: () => this.actions.clearTips(),
      },
    ]);
  }
}

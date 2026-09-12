import { required } from "./dom";
import { formatToolbarNumber } from "./series-inspector";
import {
  showPanelMenu,
  positionPanelPopover,
  type MenuOption,
} from "./panel-menu";
import { SIGNAL_DRAG_TYPE, SET_DRAG_TYPE, hasDragType } from "./panel-shell";
import type {
  AnnotationDisplay,
  LegendState,
  PanelState,
} from "../generated/session";

const LEGEND_LABELS: Record<LegendState, string> = {
  badge: "collapsed",
  keys: "simple",
  roster: "expanded",
  rail: "docked",
};

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
  private readonly abort = new AbortController();
  private state: PanelState | null = null;
  private menuCleanup: (() => void) | null = null;
  private readonly axes: HTMLDetailsElement;

  constructor(
    private readonly host: HTMLElement,
    slot: HTMLElement,
    private readonly actions: LineToolbarActions,
  ) {
    slot.innerHTML = `<details class="panel-axes-dropdown">
      <summary class="panel-toolbar-control panel-axes-summary" aria-label="Plot settings">plot: <b class="panel-axes-value"></b> <span class="toolbar-caret">▾</span></summary>
      <div class="panel-axis-menu" role="group" aria-label="Plot settings">
        <button class="panel-action panel-axis-toggle" title="Switch axis presentation">axes: gutter</button>
        <button class="panel-toolbar-control panel-y-axis" type="button" title="Add Y signals or bundles" aria-label="Add Y signals or bundles">y: + add ▾</button>
        <button class="panel-toolbar-control panel-x-axis" type="button" title="Choose X axis">x: time ▾</button>
        <button class="panel-toolbar-control panel-c-axis" type="button" title="Choose color axis">color: none ▾</button>
        <button class="panel-toolbar-control panel-axis-limits" type="button" title="Axis limits, scales, direction, and equal units" aria-label="Axis settings">limits ▾</button>
      </div></details>
      <button class="panel-toolbar-control panel-line-width" type="button" aria-label="Style">style: <b class="panel-line-width-value"></b><span class="panel-ghost-value"></span> <span class="toolbar-caret">▾</span></button>
      <button class="panel-toolbar-control panel-legend-state" type="button" aria-label="Readouts">readouts: <b class="panel-legend-value"></b><span class="panel-readout-value"></span> <span class="toolbar-caret">▾</span></button>`;
    this.axes = required<HTMLDetailsElement>(slot, "details");
    const summary = required<HTMLElement>(this.axes, "summary");
    const options = { signal: this.abort.signal };
    slot.addEventListener(
      "dragstart",
      (event) => event.preventDefault(),
      options,
    );
    const openAxes = (): void => {
      this.closeMenu();
      actions.beforeOpen();
      summary.removeAttribute("aria-expanded");
      this.axes.open = true;
      this.positionAxes();
    };
    summary.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        if (this.axes.open) this.axes.open = false;
        else {
          openAxes();
          required<HTMLElement>(this.axes, "button").focus();
        }
      },
      options,
    );
    summary.addEventListener(
      "dragenter",
      (event) => {
        if (
          hasDragType(event, SIGNAL_DRAG_TYPE) ||
          hasDragType(event, SET_DRAG_TYPE)
        )
          openAxes();
      },
      options,
    );
    this.axes.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && this.axes.open) {
          event.preventDefault();
          event.stopPropagation();
          this.axes.open = false;
          summary.focus();
        }
      },
      options,
    );
    this.axes.addEventListener(
      "focusout",
      (event) => {
        if (
          event.relatedTarget instanceof Node &&
          !this.axes.contains(event.relatedTarget)
        )
          this.axes.open = false;
      },
      options,
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target instanceof Node && !this.axes.contains(event.target))
          this.axes.open = false;
      },
      { ...options, capture: true },
    );
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
    bind(".panel-axis-toggle", () => actions.toggleAxes());
    bind(".panel-line-width", (anchor) => this.openWidth(anchor));
    bind(".panel-legend-state", (anchor) => this.openLegend(anchor));
  }

  update(state: PanelState): void {
    this.state = state;
    const axis = required<HTMLElement>(this.host, ".panel-axis-toggle");
    axis.textContent = `axes: ${state.axis_style}`;
    axis.title = `Switch to ${state.axis_style === "gutter" ? "inline" : "gutter"} axes`;
    required(this.host, ".panel-axes-value").textContent = state.axis_style;
    required<HTMLElement>(this.host, ".panel-axes-summary").title = [
      `Axes: ${state.axis_style}`,
      required<HTMLElement>(this.host, ".panel-x-axis").title,
      required<HTMLElement>(this.host, ".panel-c-axis").title,
      "Signal assignment, limits, scales, direction, and equal units",
    ].join(" · ");
    const width = formatToolbarNumber(state.line_width);
    const dim =
      state.ghost_mode === "all"
        ? "none"
        : `${String(Math.round(state.ghost_opacity * 100))}%`;
    required(this.host, ".panel-line-width-value").textContent = width;
    required(this.host, ".panel-ghost-value").textContent =
      dim === "none" ? "" : ` · ${dim}`;
    required<HTMLElement>(this.host, ".panel-line-width").title =
      `Line width: ${width}px · dim others: ${dim}`;
    required(this.host, ".panel-legend-value").textContent =
      LEGEND_LABELS[state.legend_state];
    required(this.host, ".panel-readout-value").textContent =
      `${state.show_stats ? " · Σ" : ""}${state.annotations.length > 0 ? ` · ${String(state.annotations.length)}` : ""}`;
    required<HTMLElement>(this.host, ".panel-legend-state").title =
      `Legend: ${LEGEND_LABELS[state.legend_state]} · statistics ${state.show_stats ? "on" : "off"} · ${String(state.annotations.length)} tips (${state.annotation_display})`;
    this.positionAxes();
  }

  private positionAxes(): void {
    if (this.axes.open)
      positionPanelPopover(
        this.host,
        required(this.axes, "summary"),
        required(this.axes, ".panel-axis-menu"),
      );
  }

  closeMenu(): void {
    this.axes.open = false;
    this.menuCleanup?.();
    this.menuCleanup = null;
  }

  dispose(): void {
    this.closeMenu();
    this.abort.abort();
  }

  private open(
    anchor: HTMLElement,
    label: string,
    options: readonly MenuOption[],
  ): void {
    this.closeMenu();
    this.actions.beforeOpen();
    this.menuCleanup = showPanelMenu(this.host, anchor, label, options);
  }

  private openWidth(anchor: HTMLElement): void {
    const state = this.state;
    if (state === null) return;
    this.open(anchor, "STYLE", [
      ...[1, 1.4, 1.5, 2, 3].map((width) => ({
        section: "Line width",
        label: `${formatToolbarNumber(width)} px`,
        active: Math.abs(state.line_width - width) < 0.001,
        run: () => this.actions.setWidth(width),
      })),
      ...this.ghostOptions(state),
    ]);
  }

  private ghostOptions(state: PanelState): MenuOption[] {
    return [
      {
        section: "Dim others",
        label: "none · show full color",
        active: state.ghost_mode === "all",
        run: () => {
          if (state.ghost_mode !== "all") this.actions.toggleGhost();
        },
      },
      ...[0.2, 0.35, 0.5].map((opacity) => ({
        section: "Dim others",
        label: `to ${String(Math.round(opacity * 100))}% opacity`,
        active:
          state.ghost_mode === "ghost" &&
          Math.abs(state.ghost_opacity - opacity) < 0.001,
        run: () => {
          this.actions.setGhostOpacity(opacity);
          if (state.ghost_mode !== "ghost") this.actions.toggleGhost();
        },
      })),
    ];
  }

  private openLegend(anchor: HTMLElement): void {
    const state = this.state;
    if (state === null) return;
    this.open(anchor, "READOUTS", [
      ...(["badge", "keys", "roster", "rail"] as const).map((legend) => ({
        section: "Legend",
        label: LEGEND_LABELS[legend],
        active: state.legend_state === legend,
        run: () => this.actions.setLegend(legend),
      })),
      {
        section: "Statistics",
        label: "visible-region statistics",
        active: state.show_stats,
        run: () => this.actions.toggleStats(),
      },
      ...this.tipOptions(state),
    ]);
  }

  private tipOptions(state: PanelState): MenuOption[] {
    return [
      ...(["labels", "markers", "hidden"] as const).map((mode) => ({
        section: `Tips · ${String(state.annotations.length)}`,
        label: mode === "markers" ? "markers only" : mode,
        active: state.annotation_display === mode,
        run: () => this.actions.setTips(mode),
      })),
      {
        section: `Tips · ${String(state.annotations.length)}`,
        label: "clear all",
        active: false,
        action: true,
        run: () => this.actions.clearTips(),
      },
    ];
  }
}

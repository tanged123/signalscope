import type { Catalog } from "../app/catalog";
import type {
  NamedSet,
  PanelState,
  SampleAxisSource,
} from "../generated/session";
import { bindAxisDrop } from "./axis-drop";
import { showAxisPicker, xAxisLabel } from "./axis-picker";
import { required } from "./dom";
import { showAxisLimits, type AxisLimits } from "./axis-limits";

export interface PanelAxisActions {
  catalog(): Catalog;
  namedSets(): readonly NamedSet[];
  selectX(axis: SampleAxisSource): void;
  selectColor(axis: PanelState["color_axis"]): void;
  addY(paths: string[]): void;
  limits(values: AxisLimits): void;
  visibleRanges(): { x: [number, number] | null; y: [number, number] | null };
  beforeOpen(): void;
}

/** Owns axis controls, drag bindings and all axis-menu listeners. */
export class PanelAxes {
  private state: PanelState | null = null;
  private closeMenu: (() => void) | null = null;
  private readonly abort = new AbortController();
  private readonly dropCleanup: () => void;

  constructor(
    private readonly element: HTMLElement,
    private readonly actions: PanelAxisActions,
  ) {
    for (const axis of ["x", "y", "c"] as const) {
      required(element, `.panel-${axis}-axis`).addEventListener(
        "click",
        () => this.open(axis),
        { signal: this.abort.signal },
      );
    }
    required(element, ".panel-axis-limits").addEventListener(
      "click",
      () => this.openLimits(),
      { signal: this.abort.signal },
    );
    this.dropCleanup = bindAxisDrop(
      element,
      () => actions.catalog(),
      () => actions.namedSets(),
      (source) => actions.selectX(source),
      (source) => actions.selectColor({ source, range: null, label: null }),
    );
  }

  update(state: PanelState): void {
    this.state = state;
    const xLabel = xAxisLabel(state.x_axis, this.actions.catalog());
    const x = required<HTMLButtonElement>(this.element, ".panel-x-axis");
    x.textContent = `x: ${xLabel} ▾`;
    x.title = `X axis: ${xLabel}`;
    x.setAttribute("aria-label", `X axis: ${xLabel}`);
    x.hidden = false;
    const cLabel =
      state.color_axis == null
        ? "none"
        : xAxisLabel(state.color_axis.source, this.actions.catalog());
    const c = required<HTMLButtonElement>(this.element, ".panel-c-axis");
    c.textContent = `c: ${cLabel} ▾`;
    c.title = `Color axis: ${cLabel}`;
    c.setAttribute("aria-label", `Color axis: ${cLabel}`);
  }

  close(): void {
    this.closeMenu?.();
    this.closeMenu = null;
  }
  openColor(): void {
    this.open("c");
  }
  dispose(): void {
    this.close();
    this.abort.abort();
    this.dropCleanup();
  }

  private open(axis: "x" | "y" | "c"): void {
    const state = this.state;
    if (state === null) return;
    this.close();
    this.actions.beforeOpen();
    this.closeMenu = showAxisPicker(
      this.element,
      required(this.element, `.panel-${axis}-axis`),
      axis,
      axis === "c"
        ? (state.color_axis?.source ?? { kind: "time" })
        : state.x_axis,
      this.actions.catalog(),
      this.actions.namedSets(),
      (source) =>
        axis === "c"
          ? this.actions.selectColor({ source, range: null, label: null })
          : this.actions.selectX(source),
      (paths) => this.actions.addY(paths),
      () => this.actions.selectColor(null),
      state.color_axis != null,
    );
  }

  private openLimits(): void {
    if (this.state === null) return;
    this.close();
    this.actions.beforeOpen();
    this.closeMenu = showAxisLimits(
      this.element,
      required(this.element, ".panel-axis-limits"),
      this.state,
      this.actions.visibleRanges(),
      (values) => this.actions.limits(values),
    );
  }
}

export function axisControlsMarkup(): string {
  return `<button class="panel-toolbar-control panel-y-axis" type="button" title="Add Y signals or bundles" aria-label="Add Y signals or bundles">y: + add ▾</button>
    <button class="panel-toolbar-control panel-x-axis" type="button" title="Choose X axis">x: time ▾</button>
    <button class="panel-toolbar-control panel-c-axis" type="button" title="Choose color axis">c: none ▾</button>
    <button class="panel-toolbar-control panel-axis-limits" type="button" aria-label="Axis limits">limits ▾</button>`;
}

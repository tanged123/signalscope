import type { Catalog } from "../app/catalog";
import type {
  NamedSet,
  PanelState,
  SampleAxisSource,
} from "../generated/session";
import { bindAxisDrop } from "./axis-drop";
import { showAxisPicker, xAxisLabel } from "./axis-picker";
import { required } from "./dom";

export interface PanelAxisActions {
  catalog(): Catalog;
  namedSets(): readonly NamedSet[];
  selectX(axis: SampleAxisSource): void;
  selectColor(axis: PanelState["color_axis"]): void;
  addY(paths: string[]): void;
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
    required(element, ".panel-color-limits").addEventListener(
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
    const limits = required<HTMLButtonElement>(
      this.element,
      ".panel-color-limits",
    );
    limits.hidden = state.color_axis == null;
    limits.textContent =
      state.color_axis?.range == null
        ? "c limits: auto ▾"
        : "c limits: fixed ▾";
  }

  close(): void {
    this.closeMenu?.();
    this.closeMenu = null;
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
    const axis = this.state?.color_axis;
    if (axis == null) return;
    this.close();
    this.actions.beforeOpen();
    const form = document.createElement("form");
    form.className = "color-axis-editor";
    form.setAttribute("aria-label", "Color axis limits");
    const title = document.createElement("strong");
    title.textContent = "COLOR AXIS";
    form.append(title);
    const input = (
      name: string,
      value: string,
      type: string,
    ): HTMLInputElement => {
      const label = document.createElement("label");
      label.textContent = name;
      const field = document.createElement("input");
      field.type = type;
      field.value = value;
      if (type === "number") field.step = "any";
      label.append(field);
      form.append(label);
      return field;
    };
    const min = input("Minimum", axis.range?.[0].toString() ?? "", "number");
    const max = input("Maximum", axis.range?.[1].toString() ?? "", "number");
    const label = input(
      "Label (blank = signal name)",
      axis.label ?? "",
      "text",
    );
    const error = document.createElement("span");
    error.setAttribute("role", "alert");
    form.append(error);
    const button = (text: string, run?: () => void): void => {
      const button = document.createElement("button");
      button.textContent = text;
      button.type = run === undefined ? "submit" : "button";
      if (run !== undefined) button.addEventListener("click", run);
      form.append(button);
    };
    const save = (range: [number, number] | null): void => {
      this.actions.selectColor({
        ...axis,
        range,
        label: label.value.trim() || null,
      });
      this.close();
    };
    button("Apply fixed limits");
    button("Use automatic limits", () => save(null));
    button("Cancel", () => this.close());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const lo = min.valueAsNumber;
      const hi = max.valueAsNumber;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        error.textContent =
          "Enter finite limits with minimum less than maximum.";
        return;
      }
      save([lo, hi]);
    });
    const abort = new AbortController();
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target instanceof Node && !form.contains(event.target))
          this.close();
      },
      { capture: true, signal: abort.signal },
    );
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.close();
      }
    });
    this.closeMenu = () => {
      abort.abort();
      form.remove();
      required<HTMLElement>(this.element, ".panel-color-limits").focus();
    };
    this.element.append(form);
    min.focus();
  }
}

export function axisControlsMarkup(): string {
  return `<button class="panel-toolbar-control panel-y-axis" type="button" title="Add Y signals or bundles" aria-label="Add Y signals or bundles">y: + add ▾</button>
    <button class="panel-toolbar-control panel-x-axis" type="button" title="Choose X axis">x: time ▾</button>
    <button class="panel-toolbar-control panel-c-axis" type="button" title="Choose color axis">c: none ▾</button>
    <button class="panel-toolbar-control panel-color-limits" type="button" aria-label="Color axis limits" hidden>c limits: auto ▾</button>`;
}

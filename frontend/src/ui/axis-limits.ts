import type { PanelState } from "../generated/session";
import { positionPanelPopover } from "./panel-menu";

type Limits = [number, number] | null;
export interface AxisLimits {
  x: Limits;
  y: Limits;
  c: Limits;
  xLabel: string | null;
  yLabel: string | null;
  cLabel: string | null;
}

/** A single draft: validate every axis before publishing any changes. */
export function showAxisLimits(
  container: HTMLElement,
  anchor: HTMLElement,
  state: PanelState,
  visible: { x: Limits; y: Limits },
  apply: (limits: AxisLimits) => void,
): () => void {
  const form = document.createElement("form");
  form.className = "panel-config-popover axis-limits-editor";
  form.setAttribute("role", "dialog");
  form.setAttribute("aria-label", "Axis limits");
  const title = document.createElement("div");
  title.className = "panel-config-title";
  title.textContent = "AXIS LIMITS";
  form.append(title);
  const labels = document.createElement("details");
  labels.className = "axis-limits-labels";
  const summary = document.createElement("summary");
  summary.textContent = "Axis labels";
  labels.append(summary);
  const controls = new Map<
    string,
    {
      mode: HTMLSelectElement;
      min: HTMLInputElement;
      max: HTMLInputElement;
      label: HTMLInputElement;
    }
  >();
  for (const dimension of ["x", "y", "c"] as const) {
    if (dimension === "c" && state.color_axis == null) continue;
    const time = dimension === "x" && state.x_axis.kind === "time";
    const fixed =
      dimension === "c"
        ? (state.color_axis?.range ?? null)
        : time
          ? visible.x
          : state[`${dimension}_range`];
    const range = fixed ?? (dimension === "c" ? null : visible[dimension]);
    const fieldset = document.createElement("fieldset");
    const name = dimension.toUpperCase();
    const legend = document.createElement("legend");
    legend.textContent = name;
    fieldset.append(legend);
    const mode = document.createElement("select");
    mode.setAttribute("aria-label", `${name} limits mode`);
    for (const [value, text] of [
      ["auto", time ? "Fit data" : "Automatic"],
      ["fixed", "Fixed"],
    ]) {
      const option = document.createElement("option");
      option.value = value ?? "";
      option.textContent = text ?? "";
      mode.append(option);
    }
    mode.value = fixed === null ? "auto" : "fixed";
    fieldset.append(mode);
    const fields = document.createElement("div");
    fields.className = "axis-limits-fields";
    const input = (
      text: string,
      value: string,
      type: string,
    ): HTMLInputElement => {
      const label = document.createElement("label");
      label.textContent = text;
      const field = document.createElement("input");
      field.type = type;
      field.value = value;
      field.setAttribute("aria-label", `${name} ${text.toLowerCase()}`);
      if (type === "number") field.step = "any";
      label.append(field);
      fields.append(label);
      return field;
    };
    const min = input("Minimum", range?.[0].toString() ?? "", "number");
    const max = input("Maximum", range?.[1].toString() ?? "", "number");
    const label = input(
      "Label",
      (dimension === "c"
        ? state.color_axis?.label
        : state[`${dimension}_label`]) ?? "",
      "text",
    );
    label.placeholder = "Signal name";
    const labelRow = label.closest("label");
    if (labelRow !== null) {
      labelRow.replaceChildren(name, label);
      labels.append(labelRow);
    }
    const update = (): void => {
      min.disabled = max.disabled = mode.value === "auto";
    };
    mode.addEventListener("change", update);
    update();
    controls.set(dimension, { mode, min, max, label });
    fieldset.append(fields);
    form.append(fieldset);
  }
  form.append(labels);
  if (state.x_axis.kind === "time") {
    const note = document.createElement("div");
    note.className = "axis-limits-note";
    note.textContent = "Time limits follow the panel’s link setting.";
    form.append(note);
  }
  const error = document.createElement("div");
  error.setAttribute("role", "alert");
  form.append(error);
  const abort = new AbortController();
  const close = (returnFocus = false): void => {
    abort.abort();
    form.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (returnFocus) anchor.focus();
  };
  const actions = document.createElement("div");
  actions.className = "axis-limits-actions";
  for (const text of ["Apply limits", "Cancel"]) {
    const button = document.createElement("button");
    button.type = text === "Cancel" ? "button" : "submit";
    button.textContent = text;
    if (text === "Cancel") button.addEventListener("click", () => close(true));
    actions.append(button);
  }
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft: AxisLimits = {
      x: null,
      y: null,
      c: null,
      xLabel: null,
      yLabel: null,
      cLabel: null,
    };
    for (const dimension of ["x", "y", "c"] as const) {
      const fields = controls.get(dimension);
      if (fields === undefined) continue;
      if (fields.mode.value === "fixed") {
        const lo = fields.min.valueAsNumber;
        const hi = fields.max.valueAsNumber;
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
          error.textContent = `${dimension.toUpperCase()}: enter finite limits with minimum less than maximum.`;
          fields.min.focus();
          return;
        }
        draft[dimension] = [lo, hi];
      }
      draft[`${dimension}Label`] = fields.label.value.trim() || null;
    }
    apply(draft);
    close(true);
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target instanceof Node && !form.contains(event.target)) close();
    },
    { capture: true, signal: abort.signal },
  );
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  form.addEventListener("focusout", (event) => {
    if (
      event.relatedTarget instanceof Node &&
      !form.contains(event.relatedTarget)
    )
      close();
  });
  container.append(form);
  positionPanelPopover(container, anchor, form);
  anchor.setAttribute("aria-haspopup", "dialog");
  anchor.setAttribute("aria-expanded", "true");
  controls.get("x")?.mode.focus();
  return close;
}

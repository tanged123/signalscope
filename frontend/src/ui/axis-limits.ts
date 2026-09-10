import type { AxisScale, PanelState } from "../generated/session";
import { positionPanelPopover } from "./panel-menu";

type Limits = [number, number] | null;
export interface AxisLimits {
  axisEqual: boolean;
  xScale?: AxisScale;
  yScale?: AxisScale;
  cScale?: AxisScale;
  xReversed?: boolean;
  yReversed?: boolean;
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
  const labels = document.createElement("details");
  labels.className = "axis-limits-labels";
  const summary = document.createElement("summary");
  summary.textContent = "Labels";
  labels.append(summary);
  const controls = new Map<
    string,
    {
      mode: HTMLSelectElement;
      scale: HTMLSelectElement;
      min: HTMLInputElement;
      max: HTMLInputElement;
      label: HTMLInputElement;
      reversed: HTMLInputElement | null;
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
    const scale = document.createElement("select");
    scale.setAttribute("aria-label", `${name} scale`);
    for (const [value, text] of [
      ["linear", "Linear"],
      ["log", "Logarithmic"],
    ]) {
      const option = document.createElement("option");
      option.value = value ?? "";
      option.textContent = text ?? "";
      scale.append(option);
    }
    scale.value =
      (dimension === "c"
        ? state.color_axis?.scale
        : state[`${dimension}_scale`]) ?? "linear";
    fieldset.append(scale);
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
    scale.addEventListener("change", () => {
      if (scale.value === "log" && min.valueAsNumber <= 0) mode.value = "auto";
      update();
    });
    update();
    fieldset.append(fields);
    let reversed: HTMLInputElement | null = null;
    if (dimension !== "c") {
      const toggle = document.createElement("label");
      toggle.className = "axis-limits-reverse";
      reversed = document.createElement("input");
      reversed.type = "checkbox";
      reversed.checked = state[`${dimension}_reversed`] === true;
      toggle.append(
        reversed,
        dimension === "x" ? "Flip horizontal" : "Flip vertical",
      );
      fieldset.append(toggle);
    }
    controls.set(dimension, { mode, scale, min, max, label, reversed });
    form.append(fieldset);
  }
  const equalLabel = document.createElement("label");
  equalLabel.className = "axis-limits-equal";
  const equal = document.createElement("input");
  equal.type = "checkbox";
  equal.checked = state.axis_equal === true;
  equalLabel.append(equal, "Axis equal");
  form.append(equalLabel);
  const equalNote = document.createElement("div");
  equalNote.className = "axis-limits-note";
  equalNote.textContent = "Linear X/Y only.";
  const updateEqual = (): void => {
    equal.disabled =
      controls.get("x")?.scale.value === "log" ||
      controls.get("y")?.scale.value === "log";
    if (equal.disabled) equal.checked = false;
    equalNote.hidden = !equal.disabled;
  };
  form.addEventListener("change", updateEqual);
  updateEqual();
  form.append(equalNote, labels);
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
  for (const text of ["Apply", "Cancel"]) {
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
      axisEqual: equal.checked,
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
      if (dimension !== "c")
        draft[`${dimension}Reversed`] = fields.reversed?.checked === true;
      draft[`${dimension}Scale`] =
        fields.scale.value === "log" ? "log" : "linear";
      if (fields.mode.value === "fixed") {
        const lo = fields.min.valueAsNumber;
        const hi = fields.max.valueAsNumber;
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
          error.textContent = `${dimension.toUpperCase()}: enter finite limits with minimum less than maximum.`;
          fields.min.focus();
          return;
        }
        if (fields.scale.value === "log" && lo <= 0) {
          error.textContent = `${dimension.toUpperCase()}: logarithmic limits must be positive.`;
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

import type { ResolvedSeries } from "../app/resolution";
import type { PanelState, SeriesOverride } from "../generated/session";
import { COLOR_SLOTS, hueIndex } from "../render/plot-theme";

interface InspectorActions {
  close(): void;
  mute(): void;
  patch(
    style: Partial<Pick<SeriesOverride, "color_slot" | "dash" | "width">>,
  ): void;
}

export function seriesInspector(
  state: Pick<PanelState, "color_by" | "dash_by" | "width_by">,
  series: Pick<
    ResolvedSeries,
    "path" | "hue" | "width" | "dash" | "visible" | "overrideFields"
  >,
  swatchColor: string,
  actions: InspectorActions,
): HTMLElement {
  const inspector = document.createElement("div");
  inspector.className = "plot-row-inspector";
  inspector.setAttribute("role", "group");
  inspector.setAttribute("aria-label", `${series.path} line properties`);
  const heading = document.createElement("div");
  heading.className = "plot-row-inspector-heading";
  const sample = document.createElement("span");
  sample.className = "plot-legend-swatch";
  sample.style.background = swatchColor;
  sample.style.height = `${String(Math.max(1, series.width))}px`;
  const path = document.createElement("span");
  path.textContent = series.path;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.title = "Close line inspector";
  close.addEventListener("click", () => actions.close());
  heading.append(sample, path, close);

  const color = document.createElement("div");
  color.className = "plot-row-inspector-field";
  color.classList.toggle("overridden", series.overrideFields.color);
  const colorLabel = document.createElement("span");
  colorLabel.textContent = "color";
  const slots = document.createElement("span");
  slots.className = "plot-row-color-slots";
  for (let slot = 1; slot <= COLOR_SLOTS; slot += 1) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.style.background = `var(--series-${String(slot)})`;
    swatch.classList.toggle(
      "active",
      (series.hue === null ? 0 : hueIndex(series.hue)) + 1 === slot,
    );
    swatch.setAttribute("aria-label", `Color slot ${String(slot)}`);
    swatch.addEventListener("click", () => {
      actions.patch({
        color_slot: slot,
      });
    });
    slots.append(swatch);
  }
  color.append(
    colorLabel,
    slots,
    inspectorProvenance(
      series.overrideFields.color,
      `← ${state.color_by ?? "flat"}`,
      () =>
        actions.patch({
          color_slot: null,
        }),
    ),
  );

  const line = document.createElement("div");
  line.className = "plot-row-inspector-field";
  line.classList.toggle(
    "overridden",
    series.overrideFields.dash || series.overrideFields.width,
  );
  const lineLabel = document.createElement("span");
  lineLabel.textContent = "line";
  const dashes = document.createElement("span");
  dashes.className = "plot-row-dashes";
  for (const dash of ["solid", "dash", "dot"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = dash;
    button.classList.toggle("active", series.dash === dash);
    button.addEventListener("click", () => {
      actions.patch({ dash });
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
  const widthValue = document.createElement("span");
  widthValue.textContent = formatToolbarNumber(series.width);
  width.addEventListener("input", () => {
    widthValue.textContent = formatToolbarNumber(Number(width.value));
  });
  width.addEventListener("change", () => {
    actions.patch({
      width: Number(width.value),
    });
  });
  line.append(
    lineLabel,
    dashes,
    width,
    widthValue,
    inspectorProvenance(
      series.overrideFields.dash || series.overrideFields.width,
      `← ${state.dash_by ?? "flat"} · ${state.width_by ?? "flat"}`,
      () =>
        actions.patch({
          dash: null,
          width: null,
        }),
    ),
  );

  const footer = document.createElement("div");
  footer.className = "plot-row-inspector-footer";
  const count = Object.values(series.overrideFields).filter(Boolean).length;
  const summary = document.createElement("span");
  summary.textContent =
    count === 0 ? "no overrides" : `${String(count)} overrides`;
  summary.classList.toggle("active", count > 0);
  const mute = document.createElement("button");
  mute.type = "button";
  mute.textContent = series.visible ? "⌫ mute" : "restore";
  mute.addEventListener("click", () => actions.mute());
  footer.append(summary, mute);
  inspector.append(heading, color, line, footer);
  return inspector;
}

function inspectorProvenance(
  overridden: boolean,
  inherited: string,
  revert: () => void,
): HTMLElement {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "plot-row-provenance";
  control.textContent = overridden ? "⟲" : inherited;
  control.disabled = !overridden;
  control.title = overridden ? "Revert field to its encoding rule" : inherited;
  if (overridden) control.addEventListener("click", revert);
  return control;
}

export function formatToolbarNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

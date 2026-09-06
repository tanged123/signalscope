import type { PanelState } from "../generated/session";

/** The scale replaces categorical color controls while C is assigned. */
export function legendColorControls(
  state: PanelState,
  encoding: HTMLElement,
  chooseColor: () => void,
): HTMLElement {
  if (state.color_axis == null) return encoding;
  const controls = document.createElement("div");
  controls.className = "legend-color-controls";
  const scale = document.createElement("button");
  scale.type = "button";
  scale.className = "legend-color-scale";
  scale.setAttribute("aria-label", "Change color axis signal");
  scale.title = "Change color axis signal";
  scale.addEventListener("click", chooseColor);
  controls.append(scale, encoding);
  return controls;
}

export function legendColorTarget(root: HTMLElement): HTMLElement | null {
  const legend = root.querySelector<HTMLElement>(".plot-series-legend");
  if (
    legend === null ||
    legend.hidden ||
    legend.dataset.state === "badge" ||
    legend.dataset.collapsed === "true"
  )
    return null;
  return legend.querySelector<HTMLElement>(".legend-color-scale");
}

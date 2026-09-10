import type { PanelSeriesAction } from "../app/panel-series-actions";
import type { ResolvedSeries } from "../app/resolution";

export function legendBulkActions(
  series: readonly Pick<ResolvedSeries, "focused" | "visible" | "opacity">[],
  run: (action: PanelSeriesAction) => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "plot-legend-bulk-actions";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "All plot signals");
  const selected = series.length > 0 && series.every((item) => item.focused);
  const hidden = series.length > 0 && series.every((item) => !item.visible);
  const dimmed = series.length > 0 && series.every((item) => item.opacity < 1);
  const controls: [string, PanelSeriesAction, string][] = [
    [
      selected ? "Clear selection" : "Select all",
      selected ? "clear" : "select",
      "Select or clear focus for every signal in this plot, including filtered rows; preserve visibility",
    ],
    [
      dimmed ? "Undim all" : "Dim all",
      dimmed ? "undim" : "dim",
      dimmed
        ? "Restore full opacity for every plot signal and turn off dim-other-traces; preserve selection and visibility"
        : "Dim every plot signal at the configured dim opacity; preserve selection and visibility",
    ],
    [
      hidden ? "Show all" : "Hide all",
      hidden ? "show" : "hide",
      "Show or hide every signal in this plot, including filtered rows; preserve selection and dimming",
    ],
  ];
  for (const [index, [label, action, title]] of controls.entries()) {
    const button = document.createElement("button");
    button.className = `plot-legend-bulk-${String(index)}`;
    button.type = "button";
    button.textContent = label;
    button.dataset.action = action;
    button.title = title;
    button.disabled = series.length === 0;
    button.addEventListener("click", () => run(action));
    bar.append(button);
  }
  return bar;
}

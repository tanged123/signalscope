import type {
  PanelSeriesAction,
  PanelSeriesScope,
} from "../app/panel-series-actions";
import type { ResolvedSeries } from "../app/resolution";

export function legendBulkActions(
  series: readonly Pick<ResolvedSeries, "focused" | "visible" | "opacity">[],
  run: (action: PanelSeriesAction, scope: PanelSeriesScope) => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "plot-legend-bulk-actions";
  bar.setAttribute("role", "group");
  const focused = series.filter((item) => item.focused);
  const selected = focused.length > 0;
  const targets = selected ? focused : series;
  const scope = selected ? "selected" : "all";
  bar.setAttribute(
    "aria-label",
    selected ? "Selected plot signals" : "All plot signals",
  );
  const hidden = targets.length > 0 && targets.every((item) => !item.visible);
  const dimmed =
    targets.length > 0 && targets.every((item) => item.opacity < 1);
  const targetLabel = selected ? "selected signals" : "all plot signals";
  const controls: [string, PanelSeriesAction, string][] = [
    [
      selected ? "Clear selection" : "Select all",
      selected ? "clear" : "select",
      "Select or clear focus for every signal in this plot, including filtered rows; preserve visibility",
    ],
    [
      `${dimmed ? "Undim" : "Dim"} ${scope}`,
      dimmed ? "undim" : "dim",
      dimmed
        ? `Restore full opacity for ${targetLabel}${selected ? "" : " and turn off dim-other-traces"}; preserve selection and visibility`
        : `Dim ${targetLabel} at the configured dim opacity; preserve selection and visibility`,
    ],
    [
      `${hidden ? "Show" : "Hide"} ${scope}`,
      hidden ? "show" : "hide",
      `Show or hide ${targetLabel}, including filtered rows; preserve selection and dimming`,
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
    button.addEventListener("click", () =>
      run(action, index === 0 ? "all" : scope),
    );
    bar.append(button);
  }
  return bar;
}

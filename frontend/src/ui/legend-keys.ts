import type { SeriesLegendRow } from "./panel";
import { applySeriesRowState, seriesStateLabel } from "./series-row-state";

/** The simple legend identifies traces; editing belongs to the expanded legend. */
export function legendKeys(
  rows: readonly SeriesLegendRow[],
  color: (row: SeriesLegendRow) => string,
  select: (event: MouseEvent, row: SeriesLegendRow) => void,
  emphasize: (path: string | null) => void,
): HTMLElement {
  const content = document.createElement("div");
  content.className = "plot-legend-content plot-legend-keys";
  for (const item of rows) {
    const series = item.series;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "plot-legend-roster-row plot-legend-simple-row";
    row.dataset.paths = JSON.stringify([series.path]);
    row.setAttribute("aria-pressed", String(item.focused));
    applySeriesRowState(row, series);
    const sample = document.createElement("span");
    sample.className = "plot-legend-line-sample";
    sample.style.borderTopColor = color(item);
    sample.style.borderTopWidth = `${String(series.width)}px`;
    sample.style.borderTopStyle =
      series.dash === "solid"
        ? "solid"
        : series.dash === "dot"
          ? "dotted"
          : "dashed";
    sample.style.opacity = String(series.visible ? series.opacity : 0.25);
    sample.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "plot-legend-label";
    label.textContent = series.path;
    row.title = `${series.path} · ${series.dash}, ${String(series.width)}px; click to focus; Shift-click selects a range; Ctrl/Command-click toggles; Alt-click mutes`;
    row.append(sample, label, seriesStateLabel(series));
    row.addEventListener("click", (event) => select(event, item));
    row.addEventListener("mouseenter", () => emphasize(series.path));
    row.addEventListener("mouseleave", () => emphasize(null));
    content.append(row);
  }
  return content;
}

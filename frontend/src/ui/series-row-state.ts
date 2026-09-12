import type { ResolvedSeries } from "../app/resolution";

type RowState = Pick<ResolvedSeries, "visible" | "opacity" | "focused">;

/** Publish visibility and emphasis separately; focus never owns either flag. */
export function applySeriesRowState(row: HTMLElement, series: RowState): void {
  row.classList.toggle("focused", series.focused);
  row.dataset.hidden = String(!series.visible);
  row.dataset.dimmed = String(series.opacity < 1);
}

export function seriesStateLabel(series: RowState): HTMLElement {
  const label = document.createElement("span");
  label.className = "plot-series-state";
  label.textContent = !series.visible
    ? "hidden"
    : series.opacity < 1
      ? "dimmed"
      : "";
  label.dataset.symbol = !series.visible ? "○" : series.opacity < 1 ? "◐" : "";
  label.title = !series.visible
    ? "Hidden trace; restore in line properties"
    : series.opacity < 1
      ? `Dimmed trace (${String(Math.round(series.opacity * 100))}% opacity)`
      : "";
  label.setAttribute("aria-label", label.title);
  return label;
}

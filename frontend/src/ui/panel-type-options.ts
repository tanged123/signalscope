import type { PanelContent } from "../generated/session";
import { DEFAULT_HISTOGRAM_BIN_COUNT } from "../app/histogram-settings";

/** Shared type names, descriptions, and icons for creation and empty panels. */
export function panelTypeOptions(): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = `
  <button type="button" data-type="line2d">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4v16h18M5 14l4-5 4 7 4-9 4 4"/></svg>
    <span><strong>2D line</strong><small>Signals against time or another signal</small></span>
  </button>
  <button type="button" data-type="scatter2d">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4v16h18"/><circle cx="8" cy="14" r="1"/><circle cx="12" cy="9" r="1"/><circle cx="15" cy="13" r="1"/><circle cx="19" cy="6" r="1"/></svg>
    <span><strong>Scatter</strong><small>One signal against another</small></span>
  </button>`;
  const histogram = document.createElement("button");
  histogram.type = "button";
  histogram.dataset.type = "histogram";
  histogram.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4v16h18"/><path d="M5 17h3v-5h3v-3h3v5h3v-7h3v10"/></svg>
    <span><strong>Histogram</strong><small>Distribution of signal values</small></span>`;
  template.content.append(histogram);
  return template.content;
}

export function panelContentForType(type: string): PanelContent | null {
  if (type === "line2d" || type === "scatter2d") return { kind: type };
  if (type === "histogram") {
    return { kind: "histogram", bin_count: DEFAULT_HISTOGRAM_BIN_COUNT };
  }
  return null;
}

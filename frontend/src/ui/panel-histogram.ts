import type { PanelLineResponse } from "../app/line-presentation-controller";
import type { PanelContent } from "../generated/session";
import type { RenderSeries } from "./panel-contracts";

/** Returns the exact source quality line shown below a histogram plot. */
export function histogramQualityText(
  content: PanelContent,
  series: readonly Pick<RenderSeries, "path" | "visible">[],
  data: PanelLineResponse | null,
): string | null {
  if (content.kind !== "histogram" || data?.kind !== "histogram") return null;
  const visible = new Set(
    series.filter((entry) => entry.visible).map((entry) => entry.path),
  );
  if (visible.size === 0) return null;
  const rows = data.response.series.filter((entry) =>
    visible.has(entry.signal_path),
  );
  return rows.length === 0
    ? null
    : rows
        .map(
          (entry) =>
            `${entry.signal_path}: finite ${entry.finite_count} · excluded ${entry.excluded_count}`,
        )
        .join("   ");
}

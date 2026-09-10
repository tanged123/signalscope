import type { PanelState } from "../generated/session";
import type { PreparedPlot } from "../app/plot-capabilities";
import { resolveRanges } from "../app/plot-gestures";
import type { YAxisPolicy } from "../render/y-axis";

/** Owns the boundary between saved limits, linked time, and sticky autoscale. */
export function resolvePanelRanges(
  state: Pick<PanelState, "x_range" | "y_range" | "x_scale" | "y_scale">,
  plot: PreparedPlot,
  window: { t0: number; t1: number },
  yAxis: YAxisPolicy,
  seriesKey = "",
) {
  let cached: ReturnType<PreparedPlot["autoRanges"]> | null = null;
  const automatic = () => (cached ??= plot.autoRanges());
  const stickyY = plot.interaction.stickyAutoY
    ? yAxis.resolve(
        `${seriesKey}/${state.x_scale ?? "linear"}/${state.y_scale ?? "linear"}`,
        () => automatic().y,
        state.y_range,
      )
    : automatic().y;
  return resolveRanges(
    plot.interaction,
    {
      x: state.x_range,
      y: plot.interaction.stickyAutoY ? null : state.y_range,
    },
    {
      x:
        plot.interaction.xAxis === "linked-time" && state.x_scale !== "log"
          ? null
          : automatic().x,
      y: stickyY,
    },
    window,
    { x: state.x_scale ?? "linear", y: state.y_scale ?? "linear" },
  );
}

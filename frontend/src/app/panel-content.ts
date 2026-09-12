import type { PanelState } from "../generated/session";

/** Scatter needs observations, never the synthetic coordinates of envelope bins. */
export function usesPairedSamples(
  panel: Pick<PanelState, "content" | "x_axis" | "color_axis">,
): boolean {
  return (
    panel.content.kind === "scatter2d" ||
    panel.x_axis.kind !== "time" ||
    panel.color_axis != null
  );
}

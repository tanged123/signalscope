import type { PanelContent, PanelState } from "../generated/session";

export function setEmptyPanelContent(
  panel: PanelState,
  content: PanelContent,
): boolean {
  if (panel.bindings.length > 0 || panel.content.kind === content.kind)
    return false;
  panel.content = { ...content };
  return true;
}

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

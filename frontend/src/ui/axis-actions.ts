import type { WorkspaceModel } from "../app/workspace";
import type { ColorAxis, SampleAxisSource } from "../generated/session";
import type { AxisLimits } from "./axis-limits";

interface AxisActionHost {
  workspace: Pick<
    WorkspaceModel,
    | "setPanelXAxis"
    | "setPanelColorAxis"
    | "panel"
    | "setPanelXRange"
    | "clearPanelXRange"
    | "setPanelYRange"
    | "clearPanelYRange"
    | "setAxisLabel"
  >;
  timeLimits(id: string, range: [number, number] | null): void;
  resetY(id: string): void;
  commit(): void;
  refreshStates(): void;
  resetCursor(): void;
  invalidate(id: string): void;
  render(): void;
  refresh(): void;
}

/** Binding edits refresh data; color limits and labels only republish style. */
export function axisActions(host: AxisActionHost) {
  const publish = (id: string, bindingChanged: boolean): void => {
    host.commit();
    host.refreshStates();
    if (bindingChanged) host.invalidate(id);
    host.render();
    if (bindingChanged) host.refresh();
  };
  return {
    onSetAxisLimits(id: string, limits: AxisLimits): void {
      const panel = host.workspace.panel(id);
      if (panel === undefined) return;
      for (const range of [limits.x, limits.y, limits.c]) {
        if (
          range !== null &&
          (!range.every(Number.isFinite) || range[0] >= range[1])
        )
          throw new Error("Axis limits must be finite and increasing.");
      }
      if (panel.x_axis.kind === "time") host.timeLimits(id, limits.x);
      else if (limits.x === null) host.workspace.clearPanelXRange(id);
      else host.workspace.setPanelXRange(id, limits.x);
      if (limits.y === null) {
        host.workspace.clearPanelYRange(id);
        host.resetY(id);
      } else host.workspace.setPanelYRange(id, limits.y);
      host.workspace.setAxisLabel(id, "x", limits.xLabel);
      host.workspace.setAxisLabel(id, "y", limits.yLabel);
      if (panel.color_axis != null)
        host.workspace.setPanelColorAxis(id, {
          ...panel.color_axis,
          range: limits.c,
          label: limits.cLabel,
        });
      publish(id, false);
    },
    onSetXAxis(id: string, axis: SampleAxisSource): void {
      host.workspace.setPanelXAxis(id, axis);
      host.resetCursor();
      publish(id, true);
    },
    onSetColorAxis(id: string, axis: ColorAxis | null): void {
      const change = host.workspace.setPanelColorAxis(id, axis);
      if (change !== false) publish(id, change === "binding");
    },
  };
}

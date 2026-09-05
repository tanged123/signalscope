import type { WorkspaceModel } from "../app/workspace";
import type { ColorAxis, SampleAxisSource } from "../generated/session";

interface AxisActionHost {
  workspace: Pick<WorkspaceModel, "setPanelXAxis" | "setPanelColorAxis">;
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

import type { WorkspaceModel } from "../app/workspace";
import type { PanelCallbacks } from "./panel-contracts";

export function panelLayoutCallbacks(
  workspace: WorkspaceModel,
  publish: () => void,
): Pick<
  PanelCallbacks,
  "onSplitLeft" | "onSplitRight" | "onSplitDown" | "onMaximize" | "onMinimize"
> {
  return {
    onSplitLeft: (id, content) => {
      workspace.splitPanelLeft(id, content);
      publish();
    },
    onMinimize: () => {
      workspace.restoreGrid();
      publish();
    },
    onSplitRight: (id, content) => {
      workspace.splitPanelRight(id, content);
      publish();
    },
    onSplitDown: (id, content) => {
      workspace.splitPanelDown(id, content);
      publish();
    },
    onMaximize: (id) => {
      workspace.toggleMaximize(id);
      publish();
    },
  };
}

import type { PanelState, WorkspaceTab } from "../generated/session";

/** Check admission before allocating a panel or changing focus/maximization. */
export function splitPanel(
  tab: WorkspaceTab,
  id: string,
  position: "left" | "right" | "below",
  create: () => PanelState,
): PanelState | null {
  const rowIndex = tab.layout.findIndex((row) =>
    row.panels.some((cell) => cell.panel_id === id),
  );
  const row = tab.layout[rowIndex];
  const cellIndex = row?.panels.findIndex((cell) => cell.panel_id === id) ?? -1;
  const cell = row?.panels[cellIndex];
  if (row === undefined || cell === undefined) return null;
  const fraction = position === "below" ? row.height : cell.width;
  if (fraction < 0.2) return null;
  const panel = create();
  const half = fraction / 2;
  if (position !== "below") {
    cell.width = half;
    row.panels.splice(cellIndex + (position === "right" ? 1 : 0), 0, {
      panel_id: panel.id,
      width: half,
    });
  } else {
    row.height = half;
    tab.layout.splice(rowIndex + 1, 0, {
      height: half,
      panels: [{ panel_id: panel.id, width: 1 }],
    });
  }
  tab.maximized_panel_id = null;
  tab.focused_panel_id = panel.id;
  return panel;
}

import type { PanelState, WorkspaceTab } from "../generated/session";

/** Check admission before allocating a panel or changing focus/maximization. */
export function splitPanel(
  tab: WorkspaceTab,
  id: string,
  position: "right" | "below",
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
    row.panels.splice(cellIndex + 1, 0, {
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

type Layout = WorkspaceTab["layout"];

/** No row or column shrinks below this share of its parent. */
const MIN_FRACTION = 0.1;

export interface CellLocation {
  rowIndex: number;
  cellIndex: number;
}

export function locatePanel(layout: Layout, id: string): CellLocation | null {
  for (const [rowIndex, row] of layout.entries()) {
    const cellIndex = row.panels.findIndex((cell) => cell.panel_id === id);
    if (cellIndex !== -1) return { rowIndex, cellIndex };
  }
  return null;
}

/** Adds a full-width row, shrinking existing rows to make room. */
export function appendRow(layout: Layout, panelId: string): void {
  const previous = layout.length;
  for (const row of layout) {
    row.height *= previous / (previous + 1);
  }
  layout.push({
    height: previous === 0 ? 1 : 1 / (previous + 1),
    panels: [{ panel_id: panelId, width: 1 }],
  });
}

/**
 * Removes a cell and renormalizes its row, or the rows when its row empties.
 * Returns true when the row was removed too.
 */
export function removeCell(layout: Layout, location: CellLocation): boolean {
  const row = layout[location.rowIndex];
  if (row === undefined) return false;
  row.panels.splice(location.cellIndex, 1);
  if (row.panels.length === 0) {
    layout.splice(location.rowIndex, 1);
    normalize(
      layout,
      (item) => item.height,
      (item, value) => (item.height = value),
    );
    return true;
  }
  normalize(
    row.panels,
    (item) => item.width,
    (item, value) => (item.width = value),
  );
  return false;
}

/** Inserts a cell into a row, or a new row past the last; shares stay summed to 1. */
export function insertCell(
  layout: Layout,
  panelId: string,
  rowIndex: number,
  cellIndex: number,
): void {
  const row = layout[rowIndex];
  if (row === undefined) {
    appendRow(layout, panelId);
    return;
  }
  const share = 1 / (row.panels.length + 1);
  for (const cell of row.panels) cell.width *= 1 - share;
  row.panels.splice(Math.min(cellIndex, row.panels.length), 0, {
    panel_id: panelId,
    width: share,
  });
}

/** Moves the seam below row `seamIndex`; returns false when there is none. */
export function resizeRows(
  layout: Layout,
  seamIndex: number,
  delta: number,
): boolean {
  const above = layout[seamIndex];
  const below = layout[seamIndex + 1];
  if (above === undefined || below === undefined) return false;
  const shift = clampShift(above.height, below.height, delta);
  above.height += shift;
  below.height -= shift;
  return true;
}

/** Moves a seam within a row; returns false when there is none. */
export function resizeColumns(
  layout: Layout,
  rowIndex: number,
  seamIndex: number,
  delta: number,
): boolean {
  const row = layout[rowIndex];
  const left = row?.panels[seamIndex];
  const right = row?.panels[seamIndex + 1];
  if (left === undefined || right === undefined) return false;
  const shift = clampShift(left.width, right.width, delta);
  left.width += shift;
  right.width -= shift;
  return true;
}

function clampShift(first: number, second: number, delta: number): number {
  return Math.min(Math.max(delta, MIN_FRACTION - first), second - MIN_FRACTION);
}

function normalize<T>(
  items: T[],
  get: (item: T) => number,
  set: (item: T, value: number) => void,
): void {
  const total = items.reduce((sum, item) => sum + get(item), 0);
  if (total <= 0) return;
  for (const item of items) set(item, get(item) / total);
}

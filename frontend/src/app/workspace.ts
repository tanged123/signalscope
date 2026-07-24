import type {
  LayoutRow,
  PanelMode,
  PanelState,
  Session,
  WorkspaceTab,
} from "../generated/session";
import { SESSION_SCHEMA_VERSION } from "../generated/session";

const MIN_FRACTION = 0.1;
const MAX_COLOR_SLOTS = 8;

export function emptySession(): Session {
  return {
    app: "signalscope",
    schema_version: SESSION_SCHEMA_VERSION,
    theme: "dark",
    linked_time: {
      t0: 0,
      t1: 60,
      linked: true,
      paused: false,
      cursorT: null,
      mode: "fixed",
    },
    active_tab_id: "workspace-1",
    tabs: [
      {
        id: "workspace-1",
        title: "Workspace 1",
        focused_panel_id: null,
        panels: [],
        layout: [],
      },
    ],
    favorites: [],
  };
}

export class WorkspaceModel {
  private readonly session: Session;
  private maximized: string | null = null;
  private nextPanelNumber: number;
  private nextTabNumber: number;

  constructor(session: Session = emptySession()) {
    this.session = session;
    if (session.tabs.length === 0) {
      session.tabs.push(createWorkspaceTab(1));
    }
    if (!session.tabs.some((tab) => tab.id === session.active_tab_id)) {
      session.active_tab_id = session.tabs[0]?.id ?? "workspace-1";
    }
    this.nextPanelNumber =
      session.tabs.reduce((total, tab) => total + tab.panels.length, 0) + 1;
    this.nextTabNumber = session.tabs.length + 1;
  }

  snapshot(): Readonly<Session> {
    return this.session;
  }

  panels(): readonly PanelState[] {
    return this.activeTab().panels;
  }

  layout(): readonly LayoutRow[] {
    return this.activeTab().layout;
  }

  tabs(): readonly WorkspaceTab[] {
    return this.session.tabs;
  }

  activeTabId(): string {
    return this.session.active_tab_id;
  }

  activeTab(): WorkspaceTab {
    const tab = this.session.tabs.find(
      (entry) => entry.id === this.session.active_tab_id,
    );
    if (tab === undefined) {
      throw new Error("Active workspace tab is unavailable");
    }
    return tab;
  }

  addTab(): WorkspaceTab {
    let tab = createWorkspaceTab(this.nextTabNumber);
    while (this.session.tabs.some((entry) => entry.id === tab.id)) {
      this.nextTabNumber += 1;
      tab = createWorkspaceTab(this.nextTabNumber);
    }
    this.nextTabNumber += 1;
    this.session.tabs.push(tab);
    this.session.active_tab_id = tab.id;
    this.maximized = null;
    return tab;
  }

  selectTab(id: string): boolean {
    if (!this.session.tabs.some((tab) => tab.id === id)) return false;
    this.session.active_tab_id = id;
    this.maximized = null;
    return true;
  }

  closeTab(id: string): void {
    if (this.session.tabs.length <= 1) return;
    const index = this.session.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    this.session.tabs.splice(index, 1);
    if (this.session.active_tab_id === id) {
      const replacement =
        this.session.tabs[Math.min(index, this.session.tabs.length - 1)];
      if (replacement !== undefined) {
        this.session.active_tab_id = replacement.id;
      }
    }
    this.maximized = null;
  }

  favorites(): readonly string[] {
    return this.session.favorites;
  }

  focusedPanelId(): string | null {
    return this.activeTab().focused_panel_id;
  }

  maximizedPanelId(): string | null {
    return this.maximized;
  }

  panel(id: string): PanelState | undefined {
    return this.activeTab().panels.find((panel) => panel.id === id);
  }

  locate(id: string): { rowIndex: number; cellIndex: number } | null {
    for (const [rowIndex, row] of this.activeTab().layout.entries()) {
      const cellIndex = row.panels.findIndex((cell) => cell.panel_id === id);
      if (cellIndex !== -1) return { rowIndex, cellIndex };
    }
    return null;
  }

  addPanelRow(): PanelState {
    this.maximized = null;
    const panel = this.createPanel();
    this.appendRow(panel.id);
    this.activeTab().focused_panel_id = panel.id;
    return panel;
  }

  splitPanel(id: string): PanelState | null {
    const location = this.locate(id);
    if (location === null) return null;
    const row = this.activeTab().layout[location.rowIndex];
    const cell = row?.panels[location.cellIndex];
    if (row === undefined || cell === undefined) return null;
    this.maximized = null;
    const panel = this.createPanel();
    const width = cell.width / 2;
    cell.width = width;
    row.panels.splice(location.cellIndex + 1, 0, {
      panel_id: panel.id,
      width,
    });
    this.activeTab().focused_panel_id = panel.id;
    return panel;
  }

  closePanel(id: string): void {
    const location = this.locate(id);
    if (location === null) return;
    this.detachCell(location);
    const tab = this.activeTab();
    tab.panels = tab.panels.filter((panel) => panel.id !== id);
    if (this.maximized === id) this.maximized = null;
    if (tab.focused_panel_id === id) {
      tab.focused_panel_id = tab.panels[0]?.id ?? null;
    }
  }

  focusPanel(id: string): void {
    if (this.panel(id) !== undefined) this.activeTab().focused_panel_id = id;
  }

  toggleMaximize(id: string): void {
    if (this.maximized === id) {
      this.maximized = null;
    } else {
      this.maximizePanel(id);
    }
  }

  maximizePanel(id: string): void {
    if (this.panel(id) === undefined) return;
    this.maximized = id;
    this.activeTab().focused_panel_id = id;
  }

  restoreGrid(): void {
    this.maximized = null;
  }

  setMode(id: string, mode: PanelMode): void {
    const panel = this.panel(id);
    if (panel !== undefined) panel.mode = mode;
  }

  addSeries(panelId: string, path: string): boolean {
    const panel = this.panel(panelId);
    if (
      panel === undefined ||
      panel.series.some((series) => series.path === path)
    ) {
      return false;
    }
    const used = new Set(panel.series.map((series) => series.color_slot));
    let slot = 1;
    while (used.has(slot) && slot < MAX_COLOR_SLOTS) slot += 1;
    if (used.has(slot)) slot = (panel.series.length % MAX_COLOR_SLOTS) + 1;
    panel.series.push({
      path,
      color_slot: slot,
      dash: "solid",
      width: 1.5,
      visible: true,
    });
    return true;
  }

  toggleSeriesVisible(panelId: string, path: string): void {
    const series = this.panel(panelId)?.series.find(
      (entry) => entry.path === path,
    );
    if (series !== undefined) series.visible = !series.visible;
  }

  resizeRows(seamIndex: number, delta: number): void {
    const above = this.activeTab().layout[seamIndex];
    const below = this.activeTab().layout[seamIndex + 1];
    if (above === undefined || below === undefined) return;
    const shift = clampShift(above.height, below.height, delta);
    above.height += shift;
    below.height -= shift;
  }

  resizeColumns(rowIndex: number, seamIndex: number, delta: number): void {
    const row = this.activeTab().layout[rowIndex];
    const left = row?.panels[seamIndex];
    const right = row?.panels[seamIndex + 1];
    if (left === undefined || right === undefined) return;
    const shift = clampShift(left.width, right.width, delta);
    left.width += shift;
    right.width -= shift;
  }

  movePanel(id: string, targetRowIndex: number, targetCellIndex: number): void {
    const location = this.locate(id);
    if (location === null) return;
    this.maximized = null;
    const removedRow = this.detachCell(location);
    let rowIndex = targetRowIndex;
    if (removedRow && location.rowIndex < rowIndex) rowIndex -= 1;
    const row = this.activeTab().layout[rowIndex];
    if (row === undefined) {
      this.appendRow(id);
    } else {
      const share = 1 / (row.panels.length + 1);
      for (const cell of row.panels) cell.width *= 1 - share;
      row.panels.splice(Math.min(targetCellIndex, row.panels.length), 0, {
        panel_id: id,
        width: share,
      });
    }
    this.activeTab().focused_panel_id = id;
  }

  toggleFavorite(path: string): void {
    const index = this.session.favorites.indexOf(path);
    if (index === -1) {
      this.session.favorites.push(path);
    } else {
      this.session.favorites.splice(index, 1);
    }
  }

  /** Removes a cell; returns true when its row was removed too. */
  private detachCell(location: {
    rowIndex: number;
    cellIndex: number;
  }): boolean {
    const layout = this.activeTab().layout;
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

  private appendRow(panelId: string): void {
    const layout = this.activeTab().layout;
    const previous = layout.length;
    for (const row of layout) {
      row.height *= previous / (previous + 1);
    }
    layout.push({
      height: previous === 0 ? 1 : 1 / (previous + 1),
      panels: [{ panel_id: panelId, width: 1 }],
    });
  }

  private createPanel(): PanelState {
    let id = `panel-${String(this.nextPanelNumber)}`;
    while (this.panelIdExists(id)) {
      this.nextPanelNumber += 1;
      id = `panel-${String(this.nextPanelNumber)}`;
    }
    const panel: PanelState = {
      id,
      title: `Panel ${String(this.nextPanelNumber)}`,
      mode: "time",
      axis_style: "gutter",
      x_signal: null,
      color_signal: null,
      series: [],
      y_range: null,
      annotations: [],
      show_stats: false,
    };
    this.nextPanelNumber += 1;
    this.activeTab().panels.push(panel);
    return panel;
  }

  private panelIdExists(id: string): boolean {
    return this.session.tabs.some((tab) =>
      tab.panels.some((panel) => panel.id === id),
    );
  }
}

function createWorkspaceTab(number: number): WorkspaceTab {
  return {
    id: `workspace-${String(number)}`,
    title: `Workspace ${String(number)}`,
    focused_panel_id: null,
    panels: [],
    layout: [],
  };
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

import type {
  Annotation,
  DashStyle,
  DerivedSignal,
  LayoutRow,
  LinkedTime,
  PanelMode,
  PanelState,
  Session,
  SourceSetState,
  SourceRecord,
  WorkspaceTab,
} from "../generated/session";
import { SESSION_SCHEMA_VERSION } from "../generated/session";

const MIN_FRACTION = 0.1;

export interface WorkspaceViewState {
  activeTabId: string;
  tabs: {
    id: string;
    focusedPanelId: string | null;
    maximizedPanelId: string | null;
  }[];
}

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
    tabs: [createWorkspaceTab(1)],
    favorites: [],
    derived: [],
    sources: [],
    source_sets: [],
  };
}

export class WorkspaceModel {
  private session: Session;
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

  setSourceSets(sets: SourceSetState[]): void {
    this.session.source_sets = structuredClone(sets);
  }

  /** Adopts a loaded session wholesale. Callers must re-render afterwards. */
  replace(session: Session): void {
    this.session = session;
  }

  theme(): Session["theme"] {
    return this.session.theme;
  }

  setTheme(theme: Session["theme"]): void {
    this.session.theme = theme;
  }

  linkedTime(): Readonly<LinkedTime> {
    return { ...this.session.linked_time };
  }

  setLinked(linked: boolean): void {
    this.session.linked_time.linked = linked;
  }

  setLinkedWindow(t0: number, t1: number): void {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {
      throw new Error("Time window must be finite and increasing");
    }
    this.session.linked_time.t0 = t0;
    this.session.linked_time.t1 = t1;
  }

  setCursorT(cursorT: number | null): void {
    this.session.linked_time.cursorT =
      cursorT !== null && Number.isFinite(cursorT) ? cursorT : null;
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

  captureViewState(): WorkspaceViewState {
    return {
      activeTabId: this.session.active_tab_id,
      tabs: this.session.tabs.map((tab) => ({
        id: tab.id,
        focusedPanelId: tab.focused_panel_id,
        maximizedPanelId: tab.maximized_panel_id,
      })),
    };
  }

  showTabForExport(id: string): boolean {
    const tab = this.session.tabs.find((entry) => entry.id === id);
    if (tab === undefined) return false;
    this.session.active_tab_id = id;
    tab.maximized_panel_id = null;
    return true;
  }

  restoreViewState(state: WorkspaceViewState): void {
    for (const saved of state.tabs) {
      const tab = this.session.tabs.find((entry) => entry.id === saved.id);
      if (tab === undefined) continue;
      tab.focused_panel_id = saved.focusedPanelId;
      tab.maximized_panel_id = saved.maximizedPanelId;
    }
    if (this.session.tabs.some((tab) => tab.id === state.activeTabId)) {
      this.session.active_tab_id = state.activeTabId;
    }
  }

  addTab(): WorkspaceTab {
    this.nextTabNumber = nextUnusedNumber(this.nextTabNumber, (number) =>
      this.session.tabs.some(
        (entry) => entry.id === `workspace-${String(number)}`,
      ),
    );
    const tab = createWorkspaceTab(this.nextTabNumber);
    this.nextTabNumber += 1;
    this.session.tabs.push(tab);
    this.session.active_tab_id = tab.id;
    return tab;
  }

  selectTab(id: string): boolean {
    if (!this.session.tabs.some((tab) => tab.id === id)) return false;
    this.session.active_tab_id = id;
    this.activeTab().maximized_panel_id = null;
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
      this.activeTab().maximized_panel_id = null;
    }
  }

  favorites(): readonly string[] {
    return this.session.favorites;
  }

  derived(): readonly DerivedSignal[] {
    return this.session.derived;
  }

  /** Records a definition, replacing any existing one for the same path. */
  addDerived(path: string, expr: string): void {
    const existing = this.session.derived.findIndex(
      (entry) => entry.path === path,
    );
    if (existing === -1) {
      this.session.derived.push({ path, expr });
    } else {
      this.session.derived[existing] = { path, expr };
    }
  }

  removeSignal(path: string): void {
    this.session.derived = this.session.derived.filter(
      (entry) => entry.path !== path,
    );
    this.session.favorites = this.session.favorites.filter(
      (favorite) => favorite !== path,
    );
    for (const tab of this.session.tabs) {
      for (const panel of tab.panels) {
        panel.series = panel.series.filter((series) => series.path !== path);
        panel.annotations = panel.annotations.filter(
          (annotation) => annotation.series_path !== path,
        );
        if (panel.x_signal === path) {
          panel.x_signal = null;
          panel.x_range = null;
        }
        if (panel.color_signal === path) {
          panel.color_signal = null;
          panel.color_by_time = false;
        }
      }
    }
  }

  sources(): readonly SourceRecord[] {
    return this.session.sources;
  }

  addSource(record: SourceRecord): void {
    const index = this.session.sources.findIndex(
      (source) => source.key === record.key,
    );
    if (index === -1) this.session.sources.push(record);
    else this.session.sources[index] = record;
  }

  removeSource(key: string): void {
    this.session.sources = this.session.sources.filter(
      (source) => source.key !== key,
    );
  }

  cursorMode(): WorkspaceTab["cursor_mode"] {
    return this.activeTab().cursor_mode;
  }

  setCursorMode(mode: WorkspaceTab["cursor_mode"]): void {
    this.activeTab().cursor_mode = mode;
  }

  focusedPanelId(): string | null {
    return this.activeTab().focused_panel_id;
  }

  maximizedPanelId(): string | null {
    return this.activeTab().maximized_panel_id;
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
    this.activeTab().maximized_panel_id = null;
    const panel = this.createPanel();
    this.appendRow(panel.id);
    this.activeTab().focused_panel_id = panel.id;
    return panel;
  }

  splitPanelRight(id: string): PanelState | null {
    const location = this.locate(id);
    if (location === null) return null;
    const row = this.activeTab().layout[location.rowIndex];
    const cell = row?.panels[location.cellIndex];
    if (row === undefined || cell === undefined) return null;
    if (cell.width < MIN_FRACTION * 2) return null;
    this.activeTab().maximized_panel_id = null;
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

  splitPanelDown(id: string): PanelState | null {
    const location = this.locate(id);
    if (location === null) return null;
    const row = this.activeTab().layout[location.rowIndex];
    if (row === undefined) return null;
    if (row.height < MIN_FRACTION * 2) return null;
    this.activeTab().maximized_panel_id = null;
    const panel = this.createPanel();
    const height = row.height / 2;
    row.height = height;
    this.activeTab().layout.splice(location.rowIndex + 1, 0, {
      height,
      panels: [{ panel_id: panel.id, width: 1 }],
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
    if (tab.maximized_panel_id === id) tab.maximized_panel_id = null;
    if (tab.focused_panel_id === id) {
      tab.focused_panel_id = tab.panels[0]?.id ?? null;
    }
  }

  focusPanel(id: string): void {
    if (this.panel(id) !== undefined) this.activeTab().focused_panel_id = id;
  }

  toggleMaximize(id: string): void {
    if (this.activeTab().maximized_panel_id === id) {
      this.activeTab().maximized_panel_id = null;
    } else {
      this.maximizePanel(id);
    }
  }

  maximizePanel(id: string): void {
    if (this.panel(id) === undefined) return;
    this.activeTab().maximized_panel_id = id;
    this.activeTab().focused_panel_id = id;
  }

  restoreGrid(): void {
    this.activeTab().maximized_panel_id = null;
  }

  setMode(id: string, mode: PanelMode): void {
    const panel = this.panel(id);
    if (panel !== undefined) panel.mode = mode;
  }

  setXSignal(id: string, path: string | null): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    // The outgoing x signal returns to the plotted series, and the incoming
    // one leaves them: an axis is never also a series.
    if (panel.x_signal !== null && panel.x_signal !== path) {
      const restored = panel.x_signal;
      if (!panel.series.some((series) => series.path === restored)) {
        this.addSeries(id, restored);
      }
    }
    if (path !== null) this.removeSeries(id, path);
    panel.x_signal = path;
    panel.x_range = null;
    panel.y_range = null;
    panel.annotations = [];
  }

  /** Enters XY mode, adopting the first plotted series as the x axis. */
  promoteSeriesToX(id: string): void {
    const panel = this.panel(id);
    if (panel === undefined || panel.x_signal !== null) return;
    const first = panel.series[0];
    if (first !== undefined) this.setXSignal(id, first.path);
  }

  setColorSignal(id: string, path: string | null): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    panel.color_signal = path;
    panel.color_by_time = false;
  }

  setColorByTime(id: string): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    panel.color_signal = null;
    panel.color_by_time = true;
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
    while (used.has(slot)) slot += 1;
    panel.series.push({
      path,
      color_slot: slot,
      dash: "solid",
      width: 1.4,
      visible: true,
    });
    return true;
  }

  addSeriesBatch(panelId: string, paths: readonly string[]): boolean {
    let added = false;
    for (const path of paths) {
      if (this.addSeries(panelId, path)) added = true;
    }
    return added;
  }

  toggleSeriesVisible(panelId: string, path: string): void {
    const series = this.panel(panelId)?.series.find(
      (entry) => entry.path === path,
    );
    if (series !== undefined) series.visible = !series.visible;
  }

  setPanelYRange(panelId: string, range: [number, number]): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.y_range = range;
  }

  clearPanelYRange(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.y_range = null;
  }

  setPanelXRange(panelId: string, range: readonly [number, number]): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.x_range = [range[0], range[1]];
  }

  clearPanelXRange(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.x_range = null;
  }

  renamePanel(id: string, title: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) panel.title = title;
  }

  setAxisLabel(id: string, axis: "x" | "y" | "c", label: string | null): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    if (axis === "x") panel.x_label = label;
    else if (axis === "y") panel.y_label = label;
    else panel.c_label = label;
  }

  setPanelTimeWindow(
    id: string,
    window: readonly [number, number] | null,
  ): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    panel.time_window = window === null ? null : [window[0], window[1]];
  }

  addAnnotation(panelId: string, annotation: Annotation): void {
    this.panel(panelId)?.annotations.push({ ...annotation });
  }

  removeAnnotation(panelId: string, annotationId: string): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.annotations = panel.annotations.filter(
      (annotation) => annotation.id !== annotationId,
    );
  }

  setAnnotationLabel(
    panelId: string,
    annotationId: string,
    label: string,
  ): void {
    const annotation = this.panel(panelId)?.annotations.find(
      (entry) => entry.id === annotationId,
    );
    if (annotation !== undefined) annotation.label = label;
  }

  toggleStats(id: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) panel.show_stats = !panel.show_stats;
  }

  toggleAxisStyle(id: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) {
      panel.axis_style = panel.axis_style === "gutter" ? "inline" : "gutter";
    }
  }

  setSeriesStyle(
    panelId: string,
    path: string,
    style: { color_slot: number; dash: DashStyle; width: number },
  ): void {
    const series = this.panel(panelId)?.series.find(
      (entry) => entry.path === path,
    );
    if (series === undefined) return;
    series.color_slot = style.color_slot;
    series.dash = style.dash;
    series.width = style.width;
  }

  removeSeries(panelId: string, path: string): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.series = panel.series.filter((series) => series.path !== path);
    panel.annotations = panel.annotations.filter(
      (annotation) => annotation.series_path !== path,
    );
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
    this.activeTab().maximized_panel_id = null;
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
    this.nextPanelNumber = nextUnusedNumber(this.nextPanelNumber, (number) =>
      this.panelIdExists(`panel-${String(number)}`),
    );
    const panel: PanelState = {
      id: `panel-${String(this.nextPanelNumber)}`,
      title: `Panel ${String(this.nextPanelNumber)}`,
      mode: "time",
      axis_style: "gutter",
      x_signal: null,
      color_signal: null,
      color_by_time: false,
      series: [],
      ensemble: null,
      y_range: null,
      x_range: null,
      x_label: null,
      y_label: null,
      c_label: null,
      time_window: null,
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

function nextUnusedNumber(
  start: number,
  taken: (number: number) => boolean,
): number {
  let number = start;
  while (taken(number)) number += 1;
  return number;
}

function createWorkspaceTab(number: number): WorkspaceTab {
  return {
    id: `workspace-${String(number)}`,
    title: `Workspace ${String(number)}`,
    cursor_mode: "none",
    focused_panel_id: null,
    maximized_panel_id: null,
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

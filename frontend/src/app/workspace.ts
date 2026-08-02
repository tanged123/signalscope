import type {
  Annotation,
  Binding,
  DashStyle,
  DerivedBundleState,
  DerivedSignal,
  GhostMode,
  LayoutRow,
  LinkedTime,
  PanelMode,
  PanelState,
  Session,
  SeriesOverride,
  SeriesRef,
  StyleDimension,
  FocusEntry,
  TimeDomainState,
  NamedSet,
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
    named_sets: [],
    channel_map: [],
    derived: [],
    derived_bundles: [],
    sources: [],
  };
}

function clearFacetSplits(session: Session): void {
  for (const tab of session.tabs) {
    for (const panel of tab.panels) panel.split_by = "none";
  }
}

export class WorkspaceModel {
  private session: Session;
  private nextPanelNumber: number;
  private nextTabNumber: number;

  constructor(session: Session = emptySession()) {
    this.session = session;
    clearFacetSplits(this.session);
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

  /** Adopts a loaded session wholesale. Callers must re-render afterwards. */
  replace(session: Session): void {
    this.session = session;
    clearFacetSplits(this.session);
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

  derived(): readonly DerivedSignal[] {
    return this.session.derived;
  }

  derivedBundles(): readonly DerivedBundleState[] {
    return this.session.derived_bundles;
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

  addDerivedBundle(name: string, expr: string): void {
    const normalized = name.startsWith("derived/") ? name.slice(8) : name;
    const existing = this.session.derived_bundles.findIndex(
      (entry) => entry.name === normalized,
    );
    const definition = { name: normalized, expr };
    if (existing === -1) this.session.derived_bundles.push(definition);
    else this.session.derived_bundles[existing] = definition;
  }

  removeDerivedBundle(name: string): void {
    const normalized = name.startsWith("derived/") ? name.slice(8) : name;
    this.session.derived_bundles = this.session.derived_bundles.filter(
      (entry) => entry.name !== normalized,
    );
  }

  removeSignalRef(ref: SeriesRef, path?: string): void {
    this.session.derived = this.session.derived.filter(
      (entry) => entry.path !== path,
    );
    this.session.named_sets = this.session.named_sets
      .map((set) => ({
        ...set,
        refs: set.refs.filter((entry) => !sameRef(entry, ref)),
      }))
      .filter((set) => set.kind !== "pick" || set.refs.length > 0);
    for (const tab of this.session.tabs) {
      for (const panel of tab.panels) {
        this.removeSeriesRef(panel.id, ref, path);
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

  /** Enters XY mode, adopting the first plotted series as the x axis. */
  promoteSeriesToX(id: string): void {
    const panel = this.panel(id);
    if (panel === undefined || panel.x_ref !== null) return;
    const first = panel.bindings.flatMap((binding) => binding.refs)[0];
    if (first !== undefined) this.setXRef(id, first);
  }

  setColorByTime(id: string): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    panel.color_ref = null;
    panel.color_axis = "time";
  }

  toggleSeriesVisible(panelId: string, ref: SeriesRef): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const override = this.ensureSeriesOverride(panel, ref);
    override.visible = !(override.visible ?? true);
  }

  addSeriesRef(panelId: string, ref: SeriesRef): boolean {
    const panel = this.panel(panelId);
    if (panel === undefined) return false;
    const binding =
      panel.bindings.find((entry) => entry.kind === "pick") ??
      this.createPickBinding(panel);
    if (binding.refs.some((entry) => sameRef(entry, ref))) return false;
    binding.refs.push({ ...ref });
    return true;
  }

  addSeriesRefs(panelId: string, refs: readonly SeriesRef[]): boolean {
    return refs.reduce(
      (added, ref) => this.addSeriesRef(panelId, ref) || added,
      false,
    );
  }

  removeSeriesRef(panelId: string, ref: SeriesRef, path?: string): void {
    const panel = this.session.tabs
      .flatMap((tab) => tab.panels)
      .find((entry) => entry.id === panelId);
    if (panel === undefined) return;
    panel.bindings = panel.bindings
      .map((binding) =>
        binding.kind === "pick"
          ? {
              ...binding,
              refs: binding.refs.filter((entry) => !sameRef(entry, ref)),
            }
          : binding,
      )
      .filter((binding) => binding.kind !== "pick" || binding.refs.length > 0);
    panel.overrides = panel.overrides.filter(
      (entry) => entry.target_ref === null || !sameRef(entry.target_ref, ref),
    );
    panel.focus = panel.focus.filter(
      (entry) => entry.ref === null || !sameRef(entry.ref, ref),
    );
    if (sameRef(panel.x_ref, ref)) panel.x_ref = null;
    if (sameRef(panel.color_ref, ref)) {
      panel.color_ref = null;
      panel.color_axis = "none";
    }
    if (path !== undefined) {
      panel.annotations = panel.annotations.filter(
        (annotation) => annotation.series_path !== path,
      );
    }
  }

  setSeriesOverride(
    panelId: string,
    ref: SeriesRef,
    style: { color_slot: number; dash: DashStyle; width: number },
  ): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const override = this.ensureSeriesOverride(panel, ref);
    override.color_slot = style.color_slot;
    override.dash = style.dash;
    override.width = style.width;
  }

  setSeriesVisible(panelId: string, ref: SeriesRef, visible: boolean): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const override = this.ensureSeriesOverride(panel, ref);
    override.visible = visible;
  }

  setColorBy(panelId: string, dimension: StyleDimension): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.color_by = dimension;
  }

  setGhostMode(panelId: string, mode: GhostMode): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.ghost_mode = mode;
  }

  toggleGhostMode(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) {
      panel.ghost_mode = panel.ghost_mode === "ghost" ? "all" : "ghost";
    }
  }

  addSelectorOverride(
    panelId: string,
    selector: string,
    style: Partial<
      Pick<
        SeriesOverride,
        "color_slot" | "dash" | "width" | "opacity" | "visible"
      >
    >,
  ): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.overrides.push({
      target_ref: null,
      target_selector: selector,
      color_slot: style.color_slot ?? null,
      dash: style.dash ?? null,
      width: style.width ?? null,
      opacity: style.opacity ?? null,
      visible: style.visible ?? null,
    });
  }

  removeOverride(panelId: string, index: number): void {
    const panel = this.panel(panelId);
    if (panel === undefined || index < 0 || index >= panel.overrides.length) {
      return;
    }
    panel.overrides.splice(index, 1);
  }

  clearOverrides(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.overrides = [];
  }

  toggleFocus(panelId: string, entry: FocusEntry): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const index = panel.focus.findIndex((current) => sameFocus(current, entry));
    if (index === -1) panel.focus.push(structuredClone(entry));
    else panel.focus.splice(index, 1);
  }

  clearFocus(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) panel.focus = [];
  }

  focusEntries(panelId: string): readonly FocusEntry[] {
    return this.panel(panelId)?.focus ?? [];
  }

  setXRef(panelId: string, ref: SeriesRef | null): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    if (panel.x_ref !== null && !sameRef(panel.x_ref, ref)) {
      this.addSeriesRef(panelId, panel.x_ref);
    }
    if (ref !== null) this.removeSeriesRef(panelId, ref);
    panel.x_ref = ref === null ? null : { ...ref };
    panel.x_range = null;
    panel.y_range = null;
    panel.annotations = [];
  }

  setColorRef(panelId: string, ref: SeriesRef | null): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.color_ref = ref === null ? null : { ...ref };
    panel.color_axis = ref === null ? "none" : "signal";
  }

  namedSets(): readonly NamedSet[] {
    return this.session.named_sets;
  }

  addNamedSet(set: NamedSet): void {
    const index = this.session.named_sets.findIndex(
      (entry) => entry.id === set.id,
    );
    if (index === -1) this.session.named_sets.push(structuredClone(set));
    else this.session.named_sets[index] = structuredClone(set);
  }

  addQueryBinding(panelId: string, selector: string): boolean {
    const panel = this.panel(panelId);
    if (
      panel === undefined ||
      panel.bindings.some(
        (binding) => binding.kind === "query" && binding.selector === selector,
      )
    ) {
      return false;
    }
    panel.bindings.push({
      kind: "query",
      selector,
      refs: [],
      set_id: null,
    });
    return true;
  }

  addSetBinding(panelId: string, setId: string): boolean {
    const panel = this.panel(panelId);
    if (
      panel === undefined ||
      panel.bindings.some(
        (binding) => binding.kind === "set" && binding.set_id === setId,
      )
    ) {
      return false;
    }
    panel.bindings.push({
      kind: "set",
      selector: null,
      refs: [],
      set_id: setId,
    });
    return true;
  }

  removeBinding(panelId: string, index: number): void {
    const panel = this.panel(panelId);
    if (panel === undefined || index < 0 || index >= panel.bindings.length) {
      return;
    }
    panel.bindings.splice(index, 1);
  }

  nextSetId(): string {
    let maximum = 0;
    for (const set of this.session.named_sets) {
      const match = /^set(?:-fav)?-(\d+)$/.exec(set.id);
      if (match !== null) maximum = Math.max(maximum, Number(match[1]));
    }
    return `set-${String(maximum + 1)}`;
  }

  removeNamedSet(id: string): void {
    this.session.named_sets = this.session.named_sets.filter(
      (set) => set.id !== id,
    );
    for (const tab of this.session.tabs) {
      for (const panel of tab.panels) {
        panel.bindings = panel.bindings.filter(
          (binding) => binding.kind !== "set" || binding.set_id !== id,
        );
      }
    }
  }

  setSourceAlignment(
    key: string,
    domain: TimeDomainState,
    scale: number,
    offset: number,
  ): void {
    const source = this.session.sources.find((entry) => entry.key === key);
    if (source !== undefined) {
      source.time_domain = structuredClone(domain);
      source.scale = scale;
      source.offset = offset;
    }
  }

  private createPickBinding(panel: PanelState): Binding {
    const binding: Binding = {
      kind: "pick",
      selector: null,
      refs: [],
      set_id: null,
    };
    panel.bindings.push(binding);
    return binding;
  }

  private overrideFor(
    panel: PanelState | undefined,
    ref: SeriesRef,
  ): SeriesOverride | undefined {
    return panel?.overrides.find(
      (entry) => entry.target_ref !== null && sameRef(entry.target_ref, ref),
    );
  }

  private ensureSeriesOverride(
    panel: PanelState,
    ref: SeriesRef,
  ): SeriesOverride {
    const existing = this.overrideFor(panel, ref);
    if (existing !== undefined) return existing;
    const created: SeriesOverride = {
      target_ref: { ...ref },
      target_selector: null,
      color_slot: null,
      dash: null,
      width: null,
      opacity: null,
      visible: null,
    };
    panel.overrides.push(created);
    return created;
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
      x_ref: null,
      color_axis: "none",
      color_ref: null,
      bindings: [],
      color_by: "source",
      overrides: [],
      focus: [],
      ghost_mode: "all",
      split_by: "none",
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

function sameRef(
  left: SeriesRef | null | undefined,
  right: SeriesRef | null | undefined,
): boolean {
  return (
    left != null &&
    right != null &&
    left.source_key === right.source_key &&
    left.channel === right.channel
  );
}

function sameFocus(left: FocusEntry, right: FocusEntry): boolean {
  return (
    left.kind === right.kind &&
    sameRef(left.ref, right.ref) &&
    left.source_key === right.source_key &&
    left.channel === right.channel
  );
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

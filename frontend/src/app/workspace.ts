import type {
  Annotation,
  Binding,
  DashStyle,
  DerivedBundleState,
  DerivedSignal,
  GhostMode,
  LegendAnchor,
  LegendDock,
  LegendState,
  LayoutRow,
  LinkedTime,
  PanelState,
  Session,
  StatColumn,
  SeriesOverride,
  SeriesRef,
  StyleDimension,
  FocusEntry,
  NamedSet,
  SourceRecord,
  WorkspaceTab,
  XAxisSource,
} from "../generated/session";
import { SESSION_SCHEMA_VERSION } from "../generated/session";
import { DEFAULT_PANEL_LINE_WIDTH } from "./style-defaults";

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
    derived: [],
    derived_bundles: [],
    sources: [],
  };
}

export class WorkspaceModel {
  private session: Session;
  private nextPanelNumber: number;
  private nextTabNumber: number;
  private revisionValue = 0;
  private resolutionRevisionValue = 0;

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

  revision(): number {
    return this.revisionValue;
  }

  resolutionRevision(): number {
    return this.resolutionRevisionValue;
  }

  private touch(resolution = false): void {
    this.revisionValue += 1;
    if (resolution) this.resolutionRevisionValue += 1;
  }

  /** Adopts a loaded session wholesale. Callers must re-render afterwards. */
  replace(session: Session): void {
    this.session = session;
    this.touch(true);
  }

  theme(): Session["theme"] {
    return this.session.theme;
  }

  setTheme(theme: Session["theme"]): void {
    this.session.theme = theme;
    this.touch();
  }

  linkedTime(): Readonly<LinkedTime> {
    return { ...this.session.linked_time };
  }

  setLinked(linked: boolean): void {
    this.session.linked_time.linked = linked;
    this.touch();
  }

  setLinkedWindow(t0: number, t1: number): void {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {
      throw new Error("Time window must be finite and increasing");
    }
    this.session.linked_time.t0 = t0;
    this.session.linked_time.t1 = t1;
    this.touch();
  }

  setCursorT(cursorT: number | null): void {
    this.session.linked_time.cursorT =
      cursorT !== null && Number.isFinite(cursorT) ? cursorT : null;
    this.touch();
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
    this.touch();
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
    this.touch();
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
    this.touch(true);
    return tab;
  }

  selectTab(id: string): boolean {
    if (!this.session.tabs.some((tab) => tab.id === id)) return false;
    this.session.active_tab_id = id;
    this.activeTab().maximized_panel_id = null;
    this.touch();
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
    this.touch();
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
    this.touch(true);
  }

  addDerivedBundle(name: string, expr: string): void {
    const normalized = name.startsWith("derived/") ? name.slice(8) : name;
    const existing = this.session.derived_bundles.findIndex(
      (entry) => entry.name === normalized,
    );
    const definition = { name: normalized, expr };
    if (existing === -1) this.session.derived_bundles.push(definition);
    else this.session.derived_bundles[existing] = definition;
    this.touch(true);
  }

  removeDerivedBundle(name: string): void {
    const normalized = name.startsWith("derived/") ? name.slice(8) : name;
    this.session.derived_bundles = this.session.derived_bundles.filter(
      (entry) => entry.name !== normalized,
    );
    this.touch(true);
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
    this.touch(true);
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
    this.touch();
  }

  removeSource(key: string): void {
    this.session.sources = this.session.sources.filter(
      (source) => source.key !== key,
    );
    this.touch();
  }

  cursorMode(): WorkspaceTab["cursor_mode"] {
    return this.activeTab().cursor_mode;
  }

  setCursorMode(mode: WorkspaceTab["cursor_mode"]): void {
    this.activeTab().cursor_mode = mode;
    this.touch();
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
    this.touch(true);
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
    this.touch(true);
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
    this.touch(true);
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
    this.touch(true);
  }

  focusPanel(id: string): void {
    if (this.panel(id) !== undefined) {
      this.activeTab().focused_panel_id = id;
      this.touch();
    }
  }

  toggleMaximize(id: string): void {
    if (this.activeTab().maximized_panel_id === id) {
      this.activeTab().maximized_panel_id = null;
    } else {
      this.maximizePanel(id);
    }
    this.touch();
  }

  maximizePanel(id: string): void {
    if (this.panel(id) === undefined) return;
    this.activeTab().maximized_panel_id = id;
    this.activeTab().focused_panel_id = id;
    this.touch();
  }

  restoreGrid(): void {
    this.activeTab().maximized_panel_id = null;
    this.touch();
  }

  toggleSeriesVisible(panelId: string, ref: SeriesRef): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const override = this.ensureSeriesOverride(panel, ref);
    override.visible = !(override.visible ?? true);
    this.touch(true);
  }

  addSeriesRef(panelId: string, ref: SeriesRef): boolean {
    const panel = this.panel(panelId);
    if (panel === undefined) return false;
    const binding =
      panel.bindings.find((entry) => entry.kind === "pick") ??
      this.createPickBinding(panel);
    if (binding.refs.some((entry) => sameRef(entry, ref))) return false;
    binding.refs.push({ ...ref });
    this.touch(true);
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
    if (path !== undefined) {
      panel.annotations = panel.annotations.filter(
        (annotation) => annotation.series_path !== path,
      );
    }
    this.touch(true);
  }

  setPanelXAxis(panelId: string, xAxis: XAxisSource): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    let next: XAxisSource;
    if (xAxis.kind === "time") {
      next = { kind: "time", ref: null };
    } else {
      if (xAxis.ref === null) return;
      next = { kind: "signal", ref: { ...xAxis.ref } };
    }
    if (
      next.kind === panel.x_axis.kind &&
      (next.ref === null
        ? panel.x_axis.ref === null
        : panel.x_axis.ref !== null && sameRef(next.ref, panel.x_axis.ref))
    ) {
      return;
    }
    panel.x_axis = next;
    panel.x_range = null;
    panel.x_label = null;
    panel.annotations = panel.annotations.map((annotation) => ({
      ...annotation,
      pinned_x: null,
    }));
    this.touch(true);
  }

  setSeriesOverride(
    panelId: string,
    ref: SeriesRef,
    style: { color_slot: number; dash: DashStyle; width: number },
  ): void {
    this.patchSeriesOverride(panelId, ref, style);
  }

  patchSeriesOverride(
    panelId: string,
    ref: SeriesRef,
    patch: Partial<Pick<SeriesOverride, "color_slot" | "dash" | "width">>,
  ): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const override = this.ensureSeriesOverride(panel, ref);
    if (patch.color_slot !== undefined) override.color_slot = patch.color_slot;
    if (patch.dash !== undefined) override.dash = patch.dash;
    if (patch.width !== undefined) override.width = patch.width;
    this.pruneEmptySeriesOverride(panel, override);
    this.touch(true);
  }

  revertSeriesOverrideField(
    panelId: string,
    ref: SeriesRef,
    field: "color_slot" | "dash" | "width",
  ): void {
    this.patchSeriesOverride(panelId, ref, { [field]: null });
  }

  revertSeriesOverride(panelId: string, ref: SeriesRef): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const override = panel.overrides.find(
      (entry) => entry.target_ref !== null && sameRef(entry.target_ref, ref),
    );
    if (override === undefined) return;
    override.color_slot = null;
    override.dash = null;
    override.width = null;
    this.pruneEmptySeriesOverride(panel, override);
    this.touch(true);
  }

  setSeriesVisible(panelId: string, ref: SeriesRef, visible: boolean): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const override = this.ensureSeriesOverride(panel, ref);
    override.visible = visible;
    this.touch(true);
  }

  setEncoding(
    panelId: string,
    property: "color" | "dash" | "width",
    dimension: StyleDimension | null,
  ): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const keys = {
      color: "color_by",
      dash: "dash_by",
      width: "width_by",
    } as const;
    const key = keys[property];
    const previous = panel[key];
    if (previous === dimension) return;
    if (dimension !== null) {
      const other = (Object.keys(keys) as (keyof typeof keys)[]).find(
        (candidate) =>
          candidate !== property && panel[keys[candidate]] === dimension,
      );
      if (other !== undefined) panel[keys[other]] = previous;
    }
    panel[key] = dimension;
    this.touch(true);
  }

  setColorBy(panelId: string, dimension: StyleDimension | null): void {
    this.setEncoding(panelId, "color", dimension);
  }

  setPanelLineWidth(panelId: string, width: number): void {
    const panel = this.panel(panelId);
    if (panel === undefined || !Number.isFinite(width) || width <= 0) return;
    panel.line_width = width;
    this.touch(true);
  }

  setGhostOpacity(panelId: string, opacity: number): void {
    const panel = this.panel(panelId);
    if (panel === undefined || !Number.isFinite(opacity)) return;
    panel.ghost_opacity = Math.min(1, Math.max(0, opacity));
    this.touch(true);
  }

  setStatColumns(panelId: string, columns: StatColumn[]): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.stat_columns = [...new Set(columns)];
    if (
      panel.stats_sort !== null &&
      !panel.stat_columns.includes(panel.stats_sort)
    ) {
      panel.stats_sort = null;
      panel.stats_sort_descending = false;
    }
    this.touch();
  }

  setStatsSort(
    panelId: string,
    column: StatColumn | null,
    descending: boolean,
  ): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.stats_sort = column;
    panel.stats_sort_descending = column === null ? false : descending;
    this.touch();
  }

  setGhostMode(panelId: string, mode: GhostMode): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) {
      panel.ghost_mode = mode;
      this.touch(true);
    }
  }

  toggleGhostMode(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) {
      panel.ghost_mode = panel.ghost_mode === "ghost" ? "all" : "ghost";
      this.touch(true);
    }
  }

  setLegendLayout(
    panelId: string,
    layout: {
      state?: LegendState;
      position?: [number, number] | null;
      size?: [number, number] | null;
      anchor?: LegendAnchor | null;
      dock?: LegendDock | null;
      hintDismissed?: boolean;
    },
  ): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    if (layout.state !== undefined) panel.legend_state = layout.state;
    if (layout.position !== undefined) panel.legend_position = layout.position;
    if (layout.size !== undefined) panel.legend_size = layout.size;
    if (layout.anchor !== undefined) panel.legend_anchor = layout.anchor;
    if (layout.dock !== undefined) panel.legend_dock = layout.dock;
    if (layout.hintDismissed !== undefined)
      panel.legend_hint_dismissed = layout.hintDismissed;
    this.touch(true);
  }

  setAllLegendStates(state: LegendState): void {
    for (const panel of this.activeTab().panels) panel.legend_state = state;
    this.touch(true);
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
    this.touch(true);
  }

  removeOverride(panelId: string, index: number): void {
    const panel = this.panel(panelId);
    if (panel === undefined || index < 0 || index >= panel.overrides.length) {
      return;
    }
    panel.overrides.splice(index, 1);
    this.touch(true);
  }

  clearOverrides(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) {
      panel.overrides = [];
      this.touch(true);
    }
  }

  clearStyleOverrides(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    for (const override of panel.overrides) {
      override.color_slot = null;
      override.dash = null;
      override.width = null;
    }
    panel.overrides = panel.overrides.filter(
      (override) => override.opacity !== null || override.visible !== null,
    );
    this.touch(true);
  }

  clearStyleOverride(panelId: string, index: number): void {
    const panel = this.panel(panelId);
    const override = panel?.overrides[index];
    if (panel === undefined || override === undefined) return;
    override.color_slot = null;
    override.dash = null;
    override.width = null;
    this.pruneEmptySeriesOverride(panel, override);
    this.touch(true);
  }

  toggleFocus(panelId: string, entry: FocusEntry): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    const index = panel.focus.findIndex((current) => sameFocus(current, entry));
    if (index === -1) panel.focus.push(structuredClone(entry));
    else panel.focus.splice(index, 1);
    if (panel.focus.length > 0) panel.legend_hint_dismissed = true;
    this.touch(true);
  }

  clearFocus(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) {
      panel.focus = [];
      this.touch(true);
    }
  }

  addFocus(panelId: string, entry: FocusEntry): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    if (panel.focus.some((current) => sameFocus(current, entry))) return;
    panel.focus.push(structuredClone(entry));
    panel.legend_hint_dismissed = true;
    this.touch(true);
  }

  setFocusRange(panelId: string, entries: readonly FocusEntry[]): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.focus = entries.map((entry) => structuredClone(entry));
    if (panel.focus.length > 0) panel.legend_hint_dismissed = true;
    this.touch(true);
  }

  focusEntries(panelId: string): readonly FocusEntry[] {
    return this.panel(panelId)?.focus ?? [];
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
    this.touch(true);
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
    this.touch(true);
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
    this.touch(true);
    return true;
  }

  removeBinding(panelId: string, index: number): void {
    const panel = this.panel(panelId);
    if (panel === undefined || index < 0 || index >= panel.bindings.length) {
      return;
    }
    panel.bindings.splice(index, 1);
    this.touch(true);
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
    this.touch(true);
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

  private pruneEmptySeriesOverride(
    panel: PanelState,
    override: SeriesOverride,
  ): void {
    if (
      override.color_slot !== null ||
      override.dash !== null ||
      override.width !== null ||
      override.opacity !== null ||
      override.visible !== null
    ) {
      return;
    }
    const index = panel.overrides.indexOf(override);
    if (index !== -1) panel.overrides.splice(index, 1);
  }

  setPanelYRange(panelId: string, range: [number, number]): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) {
      panel.y_range = range;
      this.touch();
    }
  }

  clearPanelYRange(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) {
      panel.y_range = null;
      this.touch();
    }
  }

  setPanelXRange(panelId: string, range: readonly [number, number]): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) {
      panel.x_range = [range[0], range[1]];
      this.touch();
    }
  }

  clearPanelXRange(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel !== undefined) {
      panel.x_range = null;
      this.touch();
    }
  }

  renamePanel(id: string, title: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) {
      panel.title = title;
      this.touch();
    }
  }

  setAxisLabel(id: string, axis: "x" | "y", label: string | null): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    if (axis === "x") panel.x_label = label;
    else panel.y_label = label;
    this.touch();
  }

  setPanelTimeWindow(
    id: string,
    window: readonly [number, number] | null,
  ): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    panel.time_window = window === null ? null : [window[0], window[1]];
    this.touch();
  }

  addAnnotation(panelId: string, annotation: Annotation): void {
    const panel = this.panel(panelId);
    if (
      panel !== undefined &&
      !panel.annotations.some(
        (entry) =>
          entry.series_path === annotation.series_path &&
          entry.anchor === annotation.anchor,
      )
    ) {
      panel.annotations.push({ ...annotation });
      this.touch();
    }
  }

  removeAnnotation(panelId: string, annotationId: string): void {
    const panel = this.panel(panelId);
    if (panel === undefined) return;
    panel.annotations = panel.annotations.filter(
      (annotation) => annotation.id !== annotationId,
    );
    this.touch();
  }

  clearAnnotations(panelId: string): void {
    const panel = this.panel(panelId);
    if (panel === undefined || panel.annotations.length === 0) return;
    panel.annotations = [];
    this.touch();
  }

  setAnnotationDisplay(
    panelId: string,
    display: PanelState["annotation_display"],
  ): void {
    const panel = this.panel(panelId);
    if (panel === undefined || panel.annotation_display === display) return;
    panel.annotation_display = display;
    this.touch();
  }

  setAnnotationOffset(
    panelId: string,
    annotationId: string,
    offset: readonly [number, number],
  ): void {
    const annotation = this.panel(panelId)?.annotations.find(
      (entry) => entry.id === annotationId,
    );
    if (annotation === undefined) return;
    annotation.offset = [offset[0], offset[1]];
    this.touch();
  }

  setAnnotationLabel(
    panelId: string,
    annotationId: string,
    label: string,
  ): void {
    const annotation = this.panel(panelId)?.annotations.find(
      (entry) => entry.id === annotationId,
    );
    if (annotation !== undefined) {
      annotation.label = label;
      this.touch();
    }
  }

  toggleStats(id: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) {
      panel.show_stats = !panel.show_stats;
      this.touch();
    }
  }

  toggleAxisStyle(id: string): void {
    const panel = this.panel(id);
    if (panel !== undefined) {
      panel.axis_style = panel.axis_style === "gutter" ? "inline" : "gutter";
      this.touch();
    }
  }

  resizeRows(seamIndex: number, delta: number): void {
    const above = this.activeTab().layout[seamIndex];
    const below = this.activeTab().layout[seamIndex + 1];
    if (above === undefined || below === undefined) return;
    const shift = clampShift(above.height, below.height, delta);
    above.height += shift;
    below.height -= shift;
    this.touch();
  }

  resizeColumns(rowIndex: number, seamIndex: number, delta: number): void {
    const row = this.activeTab().layout[rowIndex];
    const left = row?.panels[seamIndex];
    const right = row?.panels[seamIndex + 1];
    if (left === undefined || right === undefined) return;
    const shift = clampShift(left.width, right.width, delta);
    left.width += shift;
    right.width -= shift;
    this.touch();
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
    this.touch();
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
      axis_style: "inline",
      bindings: [],
      color_by: "source",
      dash_by: null,
      width_by: null,
      line_width: DEFAULT_PANEL_LINE_WIDTH,
      ghost_opacity: 0.5,
      overrides: [],
      focus: [],
      ghost_mode: "all",
      legend_state: "keys",
      legend_position: null,
      legend_size: null,
      legend_anchor: null,
      legend_dock: null,
      legend_hint_dismissed: false,
      x_axis: { kind: "time", ref: null },
      y_range: null,
      x_range: null,
      x_label: null,
      y_label: null,
      time_window: null,
      annotations: [],
      annotation_display: "labels",
      show_stats: false,
      stat_columns: ["min", "max", "mean", "rms", "cursor"],
      stats_sort: null,
      stats_sort_descending: false,
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
  if (left.kind !== right.kind) return false;
  if (left.kind === "series") return sameRef(left.ref, right.ref);
  if (left.kind === "source") return left.source_key === right.source_key;
  return left.channel === right.channel;
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

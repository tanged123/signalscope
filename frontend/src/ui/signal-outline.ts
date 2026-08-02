import type { ChannelAlias, SeriesRef } from "../generated/session";
import type { Catalog } from "../app/catalog";
import { Catalog as CatalogClass } from "../app/catalog";
import {
  filterCatalogSeries,
  formatTableValue,
  buildOutlineRows,
  virtualSlice,
  type GroupBy,
  type OutlineColumn,
  type OutlineGroupRow,
  type OutlineRow,
  type OutlineSeriesRow,
  type OutlineSort,
} from "../app/outline-model";
import type { SelectionModel } from "../app/selection";
import { SIGNAL_DRAG_TYPE } from "./panel";

const FALLBACK_ROW_HEIGHT = 22;
const BASE_COLUMNS: readonly OutlineColumn[] = [
  "channel",
  "source",
  "unit",
  "value",
];

export interface SignalOutlineCallbacks {
  onSelectionChange(): void;
  onAddToPanel(refs: readonly SeriesRef[]): void;
  onRemoveDerived(path: string): void;
  onAlignSource?(sourceKey: string, anchor: HTMLElement): void;
  onMergeChannels?(
    aliases: readonly ChannelAlias[],
    clientX: number,
    clientY: number,
  ): void;
  onUnmerge?(canonical: string): void;
}

export class SignalOutlineView {
  private catalog: Catalog = CatalogClass.empty();
  private filter = "";
  private groupBy: GroupBy = "channel";
  private sort: OutlineSort | null = null;
  private readonly collapsed = new Set<string>();
  private readonly optInColumns = new Set<OutlineColumn>();
  private readonly nonIdentitySources = new Set<string>();
  private visibleColumns: OutlineColumn[] = [...BASE_COLUMNS];
  private rows: OutlineRow[] = [];
  private activeIndex = 0;
  private liveValues: ReadonlyMap<string, string> = new Map();
  private outlineWidth = 0;
  private popover: HTMLElement | null = null;
  private readonly rowHeight: number;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly listElement: HTMLElement,
    private readonly selection: SelectionModel,
    private readonly callbacks: SignalOutlineCallbacks,
    private readonly bulkBarElement: HTMLElement,
  ) {
    const tokenHeight = Number.parseFloat(
      getComputedStyle(listElement).getPropertyValue("--tree-row-height"),
    );
    this.rowHeight =
      Number.isFinite(tokenHeight) && tokenHeight > 0
        ? tokenHeight
        : FALLBACK_ROW_HEIGHT;
    listElement.classList.add("outline-scroll");
    listElement.tabIndex = 0;
    listElement.setAttribute("role", "grid");
    listElement.setAttribute("aria-multiselectable", "true");
    this.bulkBarElement.classList.add("outline-bulk-footer");
    listElement.addEventListener("scroll", () => this.render());
    listElement.addEventListener("keydown", (event) => this.keydown(event));
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver((entries) => {
        const width =
          entries[0]?.contentRect.width ?? this.listElement.clientWidth;
        this.applyWidth(width);
      }).observe(listElement);
    }
    this.unsubscribe = selection.onChange(() => {
      this.render();
      this.callbacks.onSelectionChange();
    });
  }

  setCatalog(catalog: Catalog): void {
    this.catalog = catalog;
    this.refresh();
  }

  setFilter(filter: string): void {
    this.filter = filter;
    this.refresh();
  }

  setGroupBy(groupBy: GroupBy): void {
    if (this.groupBy === groupBy) return;
    this.groupBy = groupBy;
    this.applyWidth(this.listElement.clientWidth || Number.POSITIVE_INFINITY);
    this.refresh();
  }

  getGroupBy(): GroupBy {
    return this.groupBy;
  }

  cycleGroupBy(): void {
    const next: Record<GroupBy, GroupBy> = {
      channel: "source",
      source: "none",
      none: "channel",
    };
    this.setGroupBy(next[this.groupBy]);
  }

  setOptInColumns(columns: readonly OutlineColumn[]): void {
    this.optInColumns.clear();
    for (const column of columns) {
      if (!BASE_COLUMNS.includes(column)) this.optInColumns.add(column);
    }
    this.applyWidth(this.listElement.clientWidth || Number.POSITIVE_INFINITY);
  }

  setLiveValues(values: ReadonlyMap<string, string>): void {
    this.liveValues = values;
    this.render();
  }

  setNonIdentitySources(keys: ReadonlySet<string>): void {
    this.nonIdentitySources.clear();
    for (const key of keys) this.nonIdentitySources.add(key);
    this.render();
  }

  filteredKeys(): readonly string[] {
    return filterCatalogSeries(this.catalog, this.filter).map((series) =>
      this.catalog.refKey({
        source_key: series.sourceKey,
        channel: series.channel,
      }),
    );
  }

  destroy(): void {
    this.closePopover();
    this.unsubscribe();
  }

  /** Used by tests and by ResizeObserver to apply the pane's width budget. */
  applyWidth(width: number): void {
    const fixedWidths: Record<OutlineColumn, number> = {
      channel: 40,
      source: 40,
      unit: 32,
      value: 60,
      pts: 56,
    };
    this.outlineWidth = width;
    const primary: OutlineColumn =
      this.groupBy === "source" ? "source" : "channel";
    const secondary: OutlineColumn =
      primary === "channel" ? "source" : "channel";
    const requested = [
      primary,
      secondary,
      "unit",
      "value",
      ...this.optInColumns,
    ].filter(
      (column, index, columns) => columns.indexOf(column) === index,
    ) as OutlineColumn[];
    const dropped = new Set<OutlineColumn>();
    const availableWidth = Number.isFinite(width)
      ? Math.max(0, width - (this.optInColumns.size > 0 ? 12 : 0))
      : Number.POSITIVE_INFINITY;
    let total = 18 + 88;
    for (const column of requested) {
      if (column !== primary) total += fixedWidths[column];
    }
    for (const column of ["pts", "value", "unit", secondary] as const) {
      if (
        total <= availableWidth ||
        column === primary ||
        !requested.includes(column) ||
        dropped.has(column)
      )
        continue;
      dropped.add(column);
      total -= fixedWidths[column];
    }
    this.visibleColumns = [...BASE_COLUMNS, ...this.optInColumns].filter(
      (column, index, columns) =>
        columns.indexOf(column) === index && !dropped.has(column),
    );
    this.listElement.dataset.cols = this.visibleColumns.join(",");
    this.listElement.style.setProperty(
      "--outline-columns",
      `18px minmax(88px, 1fr) ${this.displayColumns()
        .slice(1)
        .map((column) => this.columnTrack(column, fixedWidths[column]))
        .join(" ")}`,
    );
    this.render();
  }

  private refresh(): void {
    this.rows = buildOutlineRows(this.catalog, {
      filter: this.filter,
      groupBy: this.groupBy,
      sort: this.sort,
      collapsed: this.collapsed,
    });
    this.activeIndex = Math.min(
      this.activeIndex,
      Math.max(0, this.rows.length - 1),
    );
    this.render();
  }

  private render(): void {
    this.closePopover();
    const header = this.headerElement();
    const spacer = document.createElement("div");
    spacer.className = "signal-outline-spacer";
    if (this.rows.length === 0) {
      spacer.appendChild(this.emptyElement());
    } else {
      const slice = virtualSlice(
        this.rows.length,
        this.listElement.scrollTop,
        this.listElement.clientHeight > 0 ? this.listElement.clientHeight : 400,
        this.rowHeight,
      );
      spacer.style.height = `${String(slice.totalHeight)}px`;
      const windowElement = document.createElement("div");
      windowElement.className = "signal-outline-window";
      windowElement.style.transform = `translateY(${String(slice.topPadding)}px)`;
      windowElement.append(
        ...this.rows
          .slice(slice.start, slice.end)
          .map((row) => this.rowElement(row)),
      );
      spacer.appendChild(windowElement);
    }
    this.listElement.replaceChildren(header, spacer, this.bulkBarElement);
  }

  private headerElement(): HTMLElement {
    const header = document.createElement("div");
    header.className = "signal-outline-header";
    header.setAttribute("role", "row");
    header.style.gridTemplateColumns = "var(--outline-columns)";

    const selectCell = document.createElement("div");
    selectCell.className = "signal-outline-header-cell outline-check-cell";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "outline-select";
    select.textContent = "▢";
    select.title = "Select all filtered signals";
    select.setAttribute("aria-label", "Select all filtered signals");
    select.addEventListener("click", () =>
      this.selection.setAll(this.filteredKeys()),
    );
    selectCell.appendChild(select);
    header.appendChild(selectCell);

    const first = this.groupBy === "none" ? "channel" : this.groupBy;
    const second = first === "channel" ? "source" : "channel";
    for (const column of this.displayColumns()) {
      const cell = document.createElement("div");
      cell.className = "signal-outline-header-cell";
      cell.dataset.column = column;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.column = column;
      button.textContent = this.headerLabel(column, first, second);
      button.setAttribute("aria-sort", this.ariaSort(column));
      button.addEventListener("click", () => this.cycleSort(column));
      cell.appendChild(button);
      header.appendChild(cell);
    }
    return header;
  }

  private headerLabel(
    column: OutlineColumn,
    first: OutlineColumn,
    second: OutlineColumn,
  ): string {
    if (column === first) return column.toUpperCase();
    if (column === second) {
      if (this.currentWidth() > 0 && this.currentWidth() < 320) {
        return second === "source" ? "SRCS" : "CHS";
      }
      return second.toUpperCase();
    }
    return column.toUpperCase();
  }

  private rowElement(row: OutlineRow): HTMLElement {
    const element = document.createElement("div");
    element.className = "signal-outline-row";
    element.dataset.rowKind = row.kind;
    element.setAttribute("role", "row");
    element.style.gridTemplateColumns = "var(--outline-columns)";
    if (row.kind === "group") return this.groupElement(element, row);
    return this.seriesElement(element, row);
  }

  private groupElement(
    element: HTMLElement,
    row: OutlineGroupRow,
  ): HTMLElement {
    element.classList.add("outline-group-row");
    element.dataset.key = row.key;
    element.setAttribute(
      "aria-selected",
      String(row.childKeys.every((key) => this.selection.has(key))),
    );
    if (row.childKeys.some((key) => this.selection.has(key)))
      element.classList.add("selected");
    element.draggable = true;
    element.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button") !== null) return;
      this.toggleGroup(row);
    });
    element.addEventListener("dblclick", () =>
      this.callbacks.onAddToPanel(row.refs),
    );
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.callbacks.onMergeChannels?.(
        this.aliasesForRefs(row.refs),
        event.clientX,
        event.clientY,
      );
    });
    element.addEventListener("dragstart", (event) =>
      this.setDragPayload(event, row.childKeys),
    );

    const checkCell = this.checkCell();
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "outline-caret";
    caret.textContent = row.expanded ? "▾" : "▸";
    caret.setAttribute(
      "aria-label",
      `${row.expanded ? "Collapse" : "Expand"} ${row.label}`,
    );
    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleGroup(row);
    });
    const check = document.createElement("button");
    check.type = "button";
    check.className = "outline-select";
    const selected = row.childKeys.every((key) => this.selection.has(key));
    check.textContent = selected ? "▣" : "▢";
    check.setAttribute(
      "aria-label",
      `Select ${String(row.childKeys.length)} signals in ${row.label}`,
    );
    check.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleKeys(row.childKeys);
    });
    const label = document.createElement("span");
    label.className = "signal-outline-label signal-path";
    label.textContent = row.label;
    checkCell.appendChild(check);
    const first = this.outlineCell();
    first.append(caret, label);
    if (row.names.length > 1) {
      const names = document.createElement("button");
      names.type = "button";
      names.className = "channel-names-badge";
      names.textContent = `${String(row.names.length)} names`;
      names.title = row.aliases.join(", ");
      names.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openUnmergePopover(row);
      });
      first.appendChild(names);
      const aliases = document.createElement("span");
      aliases.className = "channel-alias-line";
      aliases.textContent = row.aliases.join(" · ");
      first.appendChild(aliases);
    }
    if (row.unitConflict) first.appendChild(this.unitConflictMarker());
    if (row.groupBy === "source") {
      const sourceKey = row.refs[0]?.source_key;
      if (sourceKey !== undefined) {
        if (this.nonIdentitySources.has(sourceKey))
          first.appendChild(this.sourceAlignmentMarker());
        const align = document.createElement("button");
        align.type = "button";
        align.className = "source-align";
        align.textContent = "align ▾";
        align.setAttribute("aria-label", `Align ${row.label}`);
        align.addEventListener("click", (event) => {
          event.stopPropagation();
          this.callbacks.onAlignSource?.(sourceKey, align);
        });
        first.appendChild(align);
      }
    }
    element.append(checkCell, first);
    for (const column of this.displayColumns().slice(1)) {
      element.append(
        this.dataCell(
          this.groupValue(row, column),
          column,
          column !== row.groupBy &&
            (column === "channel" || column === "source"),
        ),
      );
    }
    return element;
  }

  private seriesElement(
    element: HTMLElement,
    row: OutlineSeriesRow,
  ): HTMLElement {
    element.classList.add("outline-series-row");
    element.dataset.key = row.key;
    element.dataset.path = row.path;
    element.dataset.signalPath = row.path;
    const selected = this.selection.has(row.key);
    element.setAttribute("aria-selected", String(selected));
    if (selected) element.classList.add("selected");
    element.tabIndex = 0;
    element.addEventListener("focus", () => {
      this.activeIndex = this.rows.indexOf(row);
    });
    element.draggable = true;
    element.addEventListener("click", (event) => {
      this.activeIndex = this.rows.indexOf(row);
      this.handleSelectionClick(event, [row.key]);
    });
    element.addEventListener("dblclick", () =>
      this.callbacks.onAddToPanel([row.ref]),
    );
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.callbacks.onMergeChannels?.(
        this.aliasesForRefs([row.ref]),
        event.clientX,
        event.clientY,
      );
    });
    element.addEventListener("dragstart", (event) =>
      this.setDragPayload(event, [row.key]),
    );
    const checkCell = this.checkCell();
    const check = document.createElement("span");
    check.className = "outline-select";
    check.textContent = selected ? "▣" : "▢";
    check.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "signal-outline-label signal-path";
    label.style.paddingLeft = `${String(row.depth * 12)}px`;
    label.textContent =
      row.depth === 1
        ? `· ${this.otherDimension(row)}`
        : this.firstDimension(row);
    checkCell.appendChild(check);
    const first = this.outlineCell();
    if (row.path.startsWith("derived/")) {
      const mark = document.createElement("span");
      mark.className = "outline-caret tree-derived-mark";
      mark.textContent = "ƒx";
      mark.title = "Derived signal";
      first.appendChild(mark);
    }
    first.append(label);
    if (row.path.startsWith("derived/")) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "outline-derived-remove";
      remove.textContent = "✕";
      remove.title = `Remove ${row.path}`;
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        this.callbacks.onRemoveDerived(row.path);
      });
      first.appendChild(remove);
    }
    element.append(checkCell, first);
    for (const column of this.displayColumns().slice(1)) {
      const cell = this.dataCell(
        this.seriesValue(row, column),
        column,
        column === "value" || column === "pts",
      );
      if (column === "value" && (selected || this.liveValues.has(row.path)))
        cell.classList.add("outline-live-value");
      element.append(cell);
    }
    return element;
  }

  private outlineCell(): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "signal-outline-cell signal-outline-outline-cell";
    return cell;
  }

  private checkCell(): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "signal-outline-cell outline-check-cell";
    return cell;
  }

  private dataCell(
    value: string,
    column: OutlineColumn,
    numeric = false,
  ): HTMLElement {
    const cell = document.createElement("span");
    cell.className = "signal-outline-cell";
    cell.dataset.column = column;
    if (numeric) cell.classList.add("outline-numeric-cell");
    cell.textContent = value;
    return cell;
  }

  private columnTrack(column: OutlineColumn, minimum: number): string {
    if (this.outlineWidth >= 480) {
      const maximum: Record<OutlineColumn, number> = {
        channel: 90,
        source: 90,
        unit: 50,
        value: 70,
        pts: 60,
      };
      return `minmax(${String(minimum)}px, ${String(maximum[column])}px)`;
    }
    return `${String(minimum)}px`;
  }

  private firstDimension(row: OutlineSeriesRow): string {
    return this.groupBy === "source" ? row.source : row.channel;
  }

  private otherDimension(row: OutlineSeriesRow): string {
    return this.groupBy === "source" ? row.channel : row.source;
  }

  private displayColumns(): OutlineColumn[] {
    const primary: OutlineColumn =
      this.groupBy === "source" ? "source" : "channel";
    const secondary: OutlineColumn =
      primary === "channel" ? "source" : "channel";
    const remaining = this.visibleColumns.filter(
      (column) => column !== primary && column !== secondary,
    );
    return [
      primary,
      ...(this.visibleColumns.includes(secondary) ? [secondary] : []),
      ...remaining,
    ];
  }

  private groupValue(row: OutlineGroupRow, column: OutlineColumn): string {
    if (column === row.groupBy) return row.label;
    if (column === "channel" || column === "source") {
      return this.currentWidth() > 0 && this.currentWidth() < 320
        ? (row.aggregate.split(" ", 1)[0] ?? row.aggregate)
        : row.aggregate;
    }
    if (column === "unit") return row.unit ?? "—";
    if (column === "pts") return String(row.pts);
    return "—";
  }

  private seriesValue(row: OutlineSeriesRow, column: OutlineColumn): string {
    if (column === "channel") return row.channel;
    if (column === "source") return row.source;
    if (column === "unit") return row.unit ?? "—";
    if (column === "pts") return String(row.pts);
    return this.liveValues.get(row.path) ?? formatTableValue(row.value);
  }

  private unitConflictMarker(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "unit-conflict-marker";
    marker.textContent = "unit?";
    marker.title = "Source units disagree";
    return marker;
  }

  private sourceAlignmentMarker(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "source-alignment-marker";
    marker.textContent = "≠";
    marker.title = "Source time alignment differs from identity";
    return marker;
  }

  private currentWidth(): number {
    return this.outlineWidth || this.listElement.clientWidth;
  }

  private emptyElement(): HTMLElement {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent =
      this.catalog.allSeries().length === 0
        ? "No signals loaded."
        : "No matching signals.";
    return empty;
  }

  private toggleGroup(row: OutlineGroupRow): void {
    if (this.collapsed.has(row.key)) this.collapsed.delete(row.key);
    else this.collapsed.add(row.key);
    this.refresh();
  }

  private toggleKeys(keys: readonly string[]): void {
    this.selection.toggleMany(keys);
  }

  private handleSelectionClick(
    event: MouseEvent,
    keys: readonly string[],
  ): void {
    if (event.shiftKey) {
      const target = keys.at(-1);
      if (target !== undefined)
        this.selection.selectRange(this.filteredKeys(), target);
      return;
    }
    this.toggleKeys(keys);
  }

  private keydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selection.setAll(this.filteredKeys());
      return;
    }
    if (event.key === "Escape") {
      if (this.popover !== null) this.closePopover();
      else this.selection.clear();
      return;
    }
    if (this.rows.length === 0) return;
    const previous = this.activeIndex;
    let next: number | null = null;
    if (event.key === "ArrowDown")
      next = Math.min(previous + 1, this.rows.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(previous - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = this.rows.length - 1;
    else if (event.key === "Enter") {
      event.preventDefault();
      const row = this.rows[previous];
      if (row !== undefined)
        this.callbacks.onAddToPanel(
          row.kind === "group" ? row.refs : [row.ref],
        );
      return;
    } else if (event.key === " ") {
      event.preventDefault();
      const row = this.rows[previous];
      if (row !== undefined)
        this.toggleKeys(row.kind === "group" ? row.childKeys : [row.key]);
      return;
    }
    if (next === null || next === previous) return;
    event.preventDefault();
    this.activeIndex = next;
    const row = this.rows[next];
    if (event.shiftKey && row !== undefined) {
      const target = row.kind === "group" ? row.childKeys.at(-1) : row.key;
      if (target !== undefined)
        this.selection.selectRange(this.filteredKeys(), target);
    }
  }

  private cycleSort(column: OutlineColumn): void {
    this.sort =
      this.sort?.column !== column
        ? { column, direction: "asc" }
        : this.sort.direction === "asc"
          ? { column, direction: "desc" }
          : null;
    this.refresh();
  }

  private ariaSort(column: OutlineColumn): string {
    if (this.sort?.column !== column) return "none";
    return this.sort.direction === "asc" ? "ascending" : "descending";
  }

  private setDragPayload(
    event: DragEvent | Event,
    keys: readonly string[],
  ): void {
    const selected = keys.some((key) => this.selection.has(key))
      ? this.selection.keys()
      : keys;
    const entries = selected
      .map((key) =>
        this.catalog.allSeries().find(
          (series) =>
            this.catalog.refKey({
              source_key: series.sourceKey,
              channel: series.channel,
            }) === key,
        ),
      )
      .filter(
        (series): series is NonNullable<typeof series> => series !== undefined,
      );
    const payload = JSON.stringify({
      refs: entries.map((series) => ({
        source_key: series.sourceKey,
        channel: series.channel,
      })),
      paths: entries.map((series) => series.path),
    });
    (event as DragEvent).dataTransfer?.setData(SIGNAL_DRAG_TYPE, payload);
  }

  private aliasesForRefs(refs: readonly SeriesRef[]): ChannelAlias[] {
    const aliases: ChannelAlias[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const series = this.catalog.get(ref);
      if (series === undefined) continue;
      const key = `${series.sourceKey}\u0000${series.sourceChannel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push({
        source_key: series.sourceKey,
        name: series.sourceChannel,
      });
    }
    return aliases;
  }

  private openUnmergePopover(row: OutlineGroupRow): void {
    this.closePopover();
    const popover = document.createElement("div");
    popover.className = "outline-unmerge-popover";
    popover.setAttribute("role", "dialog");
    const title = document.createElement("h3");
    title.textContent = row.label;
    popover.appendChild(title);
    for (const alias of row.aliases) {
      const entry = document.createElement("div");
      entry.textContent = alias;
      popover.appendChild(entry);
    }
    const unmerge = document.createElement("button");
    unmerge.type = "button";
    unmerge.dataset.action = "unmerge";
    unmerge.textContent = "unmerge";
    unmerge.addEventListener("click", () => {
      this.callbacks.onUnmerge?.(row.label);
      this.closePopover();
    });
    popover.appendChild(unmerge);
    this.listElement.appendChild(popover);
    this.popover = popover;
  }

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }
}

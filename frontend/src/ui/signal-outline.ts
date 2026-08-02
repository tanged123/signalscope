import {
  buildOutlineRows,
  filterCatalogSeries,
  virtualSlice,
  type OutlineGroupRow,
  type OutlineRow,
  type OutlineSeriesRow,
} from "../app/outline-model";
import type { Catalog } from "../app/catalog";
import { Catalog as CatalogClass } from "../app/catalog";
import type { SelectionModel } from "../app/selection";
import type { SeriesRef } from "../generated/session";
import { SIGNAL_DRAG_TYPE } from "./panel";

const FALLBACK_ROW_HEIGHT = 22;

export interface SignalOutlineCallbacks {
  onSelectionChange(): void;
  onAddToPanel(refs: readonly SeriesRef[]): void;
  onRemoveDerived(path: string): void;
}

export class SignalOutlineView {
  private catalog: Catalog = CatalogClass.empty();
  private filter = "";
  private readonly expanded = new Set<string>();
  private rows: OutlineRow[] = [];
  private activeIndex = 0;
  private liveValues: ReadonlyMap<string, string> = new Map();
  private readonly rowHeight: number;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly listElement: HTMLElement,
    private readonly selection: SelectionModel,
    private readonly callbacks: SignalOutlineCallbacks,
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
    listElement.dataset.cols = "channel,value";
    listElement.style.setProperty(
      "--outline-columns",
      "18px minmax(88px, 1fr) 60px",
    );
    listElement.setAttribute("role", "grid");
    listElement.setAttribute("aria-multiselectable", "true");
    listElement.addEventListener("scroll", () => this.render());
    listElement.addEventListener("keydown", (event) => this.keydown(event));
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

  setLiveValues(values: ReadonlyMap<string, string>): void {
    this.liveValues = values;
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
    this.unsubscribe();
  }

  private refresh(): void {
    this.rows = buildOutlineRows(this.catalog, {
      filter: this.filter,
      expanded: this.expanded,
    });
    this.activeIndex = Math.min(
      this.activeIndex,
      Math.max(0, this.rows.length - 1),
    );
    this.render();
  }

  private render(): void {
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
    this.listElement.replaceChildren(header, spacer);
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

    const channel = document.createElement("div");
    channel.className = "signal-outline-header-cell";
    channel.dataset.column = "channel";
    channel.textContent = "CHANNEL";

    const value = document.createElement("div");
    value.className = "signal-outline-header-cell outline-numeric-cell";
    value.dataset.column = "value";
    value.textContent = "VALUE";
    header.append(selectCell, channel, value);
    return header;
  }

  private rowElement(row: OutlineRow): HTMLElement {
    const element = document.createElement("div");
    element.className = "signal-outline-row";
    element.dataset.rowKind = row.kind;
    element.setAttribute("role", "row");
    element.style.gridTemplateColumns = "var(--outline-columns)";
    return row.kind === "group"
      ? this.groupElement(element, row)
      : this.seriesElement(element, row);
  }

  private groupElement(
    element: HTMLElement,
    row: OutlineGroupRow,
  ): HTMLElement {
    element.classList.add("outline-group-row");
    element.dataset.key = row.key;
    element.tabIndex = 0;
    element.addEventListener("focus", () => {
      this.activeIndex = this.rows.indexOf(row);
    });
    const selected = row.childKeys.every((key) => this.selection.has(key));
    element.setAttribute("aria-selected", String(selected));
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
    element.addEventListener("dragstart", (event) =>
      this.setDragPayload(event, row.childKeys),
    );

    const checkCell = this.checkCell();
    const check = document.createElement("button");
    check.type = "button";
    check.className = "outline-select";
    check.textContent = selected ? "▣" : "▢";
    check.setAttribute(
      "aria-label",
      `Select ${String(row.childKeys.length)} signals in ${row.label}`,
    );
    check.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleKeys(row.childKeys);
    });
    checkCell.appendChild(check);

    const first = this.outlineCell();
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
    const label = document.createElement("span");
    label.className = "signal-outline-label signal-path";
    label.textContent = `${row.label} — ${row.aggregate}`;
    first.append(caret, label);

    element.append(checkCell, first, this.valueCell(""));
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
    element.addEventListener("dragstart", (event) =>
      this.setDragPayload(event, [row.key]),
    );

    const checkCell = this.checkCell();
    const check = document.createElement("span");
    check.className = "outline-select";
    check.textContent = selected ? "▣" : "▢";
    check.setAttribute("aria-hidden", "true");
    checkCell.appendChild(check);

    const first = this.outlineCell();
    const derived = row.path.startsWith("derived/");
    if (derived) {
      const mark = document.createElement("span");
      mark.className = "outline-caret tree-derived-mark";
      mark.textContent = "ƒx";
      mark.title = "Derived signal";
      first.appendChild(mark);
    }
    const label = document.createElement("span");
    label.className = "signal-outline-label signal-path";
    label.style.paddingLeft = `${String(row.depth * 12)}px`;
    label.textContent = row.depth === 1 ? `· ${row.source}` : row.channel;
    first.appendChild(label);

    if (derived) {
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

    const value = this.liveValues.get(row.path) ?? "";
    const valueCell = this.valueCell(value);
    if (value !== "") valueCell.classList.add("outline-live-value");
    element.append(checkCell, first, valueCell);
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

  private valueCell(value: string): HTMLElement {
    const cell = document.createElement("span");
    cell.className = "signal-outline-cell outline-numeric-cell";
    cell.dataset.column = "value";
    cell.textContent = value;
    return cell;
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
    if (this.expanded.has(row.key)) this.expanded.delete(row.key);
    else this.expanded.add(row.key);
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
      this.selection.clear();
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
}

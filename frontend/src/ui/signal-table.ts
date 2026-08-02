import type { SeriesRef } from "../generated/session";
import type { ChannelAlias } from "../generated/session";
import type { Catalog } from "../app/catalog";
import type { SelectionModel } from "../app/selection";
import {
  buildTableRows,
  type TableColumn,
  type TableGranularity,
  type TableRow,
  type TableSort,
} from "../app/table-model";
import { virtualSlice } from "../app/tree-model";
import { SIGNAL_DRAG_TYPE } from "./panel";

const FALLBACK_ROW_HEIGHT = 22;
const TABLE_COLUMNS: readonly TableColumn[] = [
  "channel",
  "source",
  "unit",
  "pts",
  "value",
];

export interface SignalTableCallbacks {
  onSelectionChange(): void;
  onPlotRow?(refs: readonly SeriesRef[]): void;
  onMergeChannels?(
    aliases: readonly ChannelAlias[],
    clientX: number,
    clientY: number,
  ): void;
}

export class SignalTableView {
  private catalog!: Catalog;
  private filter = "";
  private granularity: TableGranularity = "series";
  private sort: TableSort | null = null;
  private rows: TableRow[] = [];
  private activeIndex = 0;
  private readonly footerElement: HTMLElement | null;
  private footerInTable = false;
  private catalogReady = false;
  private readonly rowHeight: number;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly listElement: HTMLElement,
    private readonly selection: SelectionModel,
    private readonly callbacks: SignalTableCallbacks,
    footerElement: HTMLElement | null = null,
  ) {
    this.footerElement = footerElement;
    const tokenHeight = Number.parseFloat(
      getComputedStyle(listElement).getPropertyValue("--tree-row-height"),
    );
    this.rowHeight =
      Number.isFinite(tokenHeight) && tokenHeight > 0
        ? tokenHeight
        : FALLBACK_ROW_HEIGHT;
    listElement.classList.add("signal-table-scroll");
    listElement.tabIndex = 0;
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
    this.catalogReady = true;
    this.refresh();
  }

  setFilter(filter: string): void {
    this.filter = filter;
    this.refresh();
  }

  setGranularity(granularity: TableGranularity): void {
    if (this.granularity === granularity) return;
    this.granularity = granularity;
    this.refresh();
  }

  filteredKeys(): readonly string[] {
    return this.rows.flatMap((row) => this.rowKeys(row));
  }

  setFooterInTable(inTable: boolean): void {
    this.footerInTable = inTable;
    if (!inTable && this.footerElement?.parentElement === this.listElement) {
      this.footerElement.remove();
    }
    if (this.catalogReady) this.render();
  }

  destroy(): void {
    this.unsubscribe();
  }

  private refresh(): void {
    this.rows = buildTableRows(
      this.catalog,
      this.filter,
      this.sort,
      this.granularity,
    );
    this.activeIndex = Math.min(
      this.activeIndex,
      Math.max(0, this.rows.length - 1),
    );
    this.render();
  }

  private render(): void {
    const header = this.headerElement();
    const spacer = document.createElement("div");
    spacer.className = "signal-table-spacer";
    if (this.rows.length === 0) {
      spacer.appendChild(this.emptyElement());
      this.listElement.replaceChildren(header, spacer);
      this.appendFooter();
      return;
    }

    const slice = virtualSlice(
      this.rows.length,
      this.listElement.scrollTop,
      this.listElement.clientHeight > 0 ? this.listElement.clientHeight : 400,
      this.rowHeight,
    );
    spacer.style.height = `${String(slice.totalHeight)}px`;
    const windowElement = document.createElement("div");
    windowElement.className = "signal-table-window";
    windowElement.style.transform = `translateY(${String(slice.topPadding)}px)`;
    for (const row of this.rows.slice(slice.start, slice.end)) {
      windowElement.appendChild(this.rowElement(row));
    }
    spacer.appendChild(windowElement);
    this.listElement.replaceChildren(header, spacer);
    this.appendFooter();
  }

  private appendFooter(): void {
    if (this.footerInTable && this.footerElement !== null) {
      this.listElement.append(this.footerElement);
    }
  }

  private headerElement(): HTMLElement {
    const header = document.createElement("div");
    header.className = "signal-table-header";
    header.setAttribute("role", "row");

    const first = document.createElement("div");
    first.className = "signal-table-header-cell signal-table-micro-label";
    const select = document.createElement("button");
    select.className = "signal-table-check";
    select.type = "button";
    select.textContent = "▢";
    select.title = "Select all filtered signals";
    select.setAttribute("aria-label", "Select all filtered signals");
    select.addEventListener("click", () =>
      this.selection.setAll(this.filteredKeys()),
    );
    first.appendChild(select);
    header.appendChild(first);

    const channel = document.createElement("div");
    channel.className =
      "signal-table-header-cell signal-table-granularity signal-table-micro-label";
    for (const granularity of ["series", "channels"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.granularity = granularity;
      button.textContent = granularity === "series" ? "SERIES" : "CHANNELS";
      button.className = this.granularity === granularity ? "active" : "";
      button.setAttribute(
        "aria-pressed",
        String(this.granularity === granularity),
      );
      button.addEventListener("click", () => this.setGranularity(granularity));
      channel.appendChild(button);
    }
    const channelSort = document.createElement("button");
    channelSort.type = "button";
    channelSort.dataset.column = "channel";
    channelSort.textContent = "CHANNEL";
    channelSort.setAttribute("aria-sort", this.ariaSort("channel"));
    channelSort.addEventListener("click", () => this.cycleSort("channel"));
    channel.appendChild(channelSort);
    header.appendChild(channel);

    for (const column of TABLE_COLUMNS.slice(1)) {
      const cell = document.createElement("div");
      cell.className = "signal-table-header-cell signal-table-micro-label";
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.column = column;
      button.textContent = column.toUpperCase();
      button.setAttribute("aria-sort", this.ariaSort(column));
      button.addEventListener("click", () => this.cycleSort(column));
      cell.appendChild(button);
      header.appendChild(cell);
    }
    return header;
  }

  private rowElement(row: TableRow): HTMLElement {
    const element = document.createElement("div");
    element.className = "signal-table-row";
    element.setAttribute("role", "row");
    element.dataset.key = row.key;
    const selected = row.refs.some((ref) =>
      this.selection.has(this.catalog.refKey(ref)),
    );
    element.setAttribute("aria-selected", String(selected));
    if (selected) element.classList.add("selected");
    element.draggable = true;
    element.addEventListener("click", (event) => {
      this.activeIndex = this.rows.indexOf(row);
      if (event.shiftKey) {
        const target = this.rowKeys(row).at(-1);
        if (target !== undefined) {
          this.selection.selectRange(this.filteredKeys(), target);
        }
      } else {
        this.toggleRow(row);
      }
    });
    element.addEventListener("dblclick", () => {
      this.callbacks.onPlotRow?.(row.refs);
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.callbacks.onMergeChannels?.(
        this.aliasesForRefs(row.refs),
        event.clientX,
        event.clientY,
      );
    });
    element.addEventListener("dragstart", (event) => {
      const rowKeys = this.rowKeys(row);
      const keys = rowKeys.some((key) => this.selection.has(key))
        ? this.selection.keys()
        : rowKeys;
      const refs = keys
        .map((key) => this.refForKey(key))
        .filter((ref): ref is SeriesRef => ref !== undefined);
      event.dataTransfer?.setData(
        SIGNAL_DRAG_TYPE,
        JSON.stringify({
          refs,
          paths: refs
            .map((ref) => this.catalog.get(ref)?.path)
            .filter((path): path is string => path !== undefined),
        }),
      );
    });

    const checkbox = document.createElement("span");
    checkbox.className = "signal-table-check";
    checkbox.textContent = selected ? "▣" : "▢";
    checkbox.setAttribute("aria-hidden", "true");
    element.appendChild(checkbox);
    for (const [index, value] of [
      row.channel,
      row.source,
      row.unit ?? "—",
      String(row.pts),
      row.value === null ? "—" : formatTableValue(row.value),
    ].entries()) {
      const cell = document.createElement("span");
      cell.textContent = value;
      if (index === 0 && row.unitConflict) {
        const marker = document.createElement("span");
        marker.className = "unit-conflict-marker";
        marker.textContent = " unit?";
        marker.title = "Source units disagree";
        cell.appendChild(marker);
      }
      element.appendChild(cell);
    }
    return element;
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
      this.callbacks.onPlotRow?.(this.rows[previous]?.refs ?? []);
      return;
    } else if (event.key === " ") {
      event.preventDefault();
      this.toggleRow(this.rows[previous] as TableRow);
      return;
    }
    if (next === null || next === previous) return;
    event.preventDefault();
    this.activeIndex = next;
    if (event.shiftKey) {
      const target = this.rowKeys(this.rows[next] as TableRow).at(-1);
      if (target !== undefined)
        this.selection.selectRange(this.filteredKeys(), target);
    }
    this.render();
  }

  private toggleRow(row: TableRow): void {
    const keys = this.rowKeys(row);
    const allSelected = keys.every((key) => this.selection.has(key));
    for (const key of keys) {
      if (allSelected ? this.selection.has(key) : !this.selection.has(key)) {
        this.selection.toggle(key);
      }
    }
  }

  private rowKeys(row: TableRow): string[] {
    return row.refs.map((ref) => this.catalog.refKey(ref));
  }

  private refForKey(key: string): SeriesRef | undefined {
    const series = this.catalog.allSeries().find(
      (series) =>
        this.catalog.refKey({
          source_key: series.sourceKey,
          channel: series.channel,
        }) === key,
    );
    return series === undefined
      ? undefined
      : { source_key: series.sourceKey, channel: series.channel };
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

  private cycleSort(column: TableColumn): void {
    this.sort =
      this.sort?.column !== column
        ? { column, direction: "asc" }
        : this.sort.direction === "asc"
          ? { column, direction: "desc" }
          : null;
    this.refresh();
  }

  private ariaSort(column: TableColumn): string {
    if (this.sort?.column !== column) return "none";
    return this.sort.direction === "asc" ? "ascending" : "descending";
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
}

export function formatTableValue(value: number | null): string {
  return value === null ? "—" : value.toFixed(4);
}

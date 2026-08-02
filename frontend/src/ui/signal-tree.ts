import type { NamedSet } from "../generated/session";
import { Catalog } from "../app/catalog";
import { buildTreeRows, virtualSlice, type TreeRow } from "../app/tree-model";
import { evaluateSelector } from "../app/selector";
import { SET_DRAG_TYPE, SIGNAL_DRAG_TYPE } from "./panel";

const FALLBACK_ROW_HEIGHT = 22;

export interface SignalTreeCallbacks {
  onPlotSignal(path: string): void;
  onPlotSignals?(paths: readonly string[]): void;
  onSetBind?(setId: string): void;
  onSetRemove?(setId: string): void;
  onRemoveDerived(path: string): void;
}

export class SignalTreeView {
  private catalog = Catalog.empty();
  private namedSets: readonly NamedSet[] = [];
  private readonly collapsed = new Set<string>();
  private filter = "";
  private rows: TreeRow[] = [];
  private readonly rowHeight: number;
  private liveValues: ReadonlyMap<string, string> = new Map();

  constructor(
    private readonly listElement: HTMLElement,
    private readonly setsElement: HTMLElement,
    private readonly callbacks: SignalTreeCallbacks,
  ) {
    const tokenHeight = Number.parseFloat(
      getComputedStyle(listElement).getPropertyValue("--tree-row-height"),
    );
    this.rowHeight =
      Number.isFinite(tokenHeight) && tokenHeight > 0
        ? tokenHeight
        : FALLBACK_ROW_HEIGHT;
    listElement.addEventListener("scroll", () => this.renderRows());
  }

  setCatalog(catalog: Catalog): void {
    this.catalog = catalog;
    this.refresh();
    this.renderSets();
  }

  setSignals(paths: readonly string[]): void {
    const summaries = paths.map((path) => {
      const separator = path.indexOf("/");
      const sourceKey = separator === -1 ? "unknown" : path.slice(0, separator);
      const channel = separator === -1 ? path : path.slice(separator + 1);
      return {
        signal_id: path,
        source_id: sourceKey,
        source_key: sourceKey,
        local_path: channel,
        path,
        unit: null,
        point_count: "0",
        t_min: 0,
        t_max: 0,
        last_value: null,
      };
    });
    this.setCatalog(Catalog.build(summaries));
  }

  setNamedSets(sets: readonly NamedSet[]): void {
    this.namedSets = sets.map((set) => structuredClone(set));
    this.renderSets();
  }

  setFilter(filter: string): void {
    this.filter = filter;
    this.refresh();
  }

  setLiveValues(values: ReadonlyMap<string, string>): void {
    this.liveValues = values;
    this.renderRows();
  }

  private refresh(): void {
    this.rows = buildTreeRows(this.catalog, this.collapsed, this.filter);
    this.renderRows();
  }

  private renderRows(): void {
    if (this.rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent =
        this.catalog.allSeries().length === 0
          ? "No signals loaded."
          : "No matching signals.";
      this.listElement.replaceChildren(empty);
      return;
    }
    const slice = virtualSlice(
      this.rows.length,
      this.listElement.scrollTop,
      this.listElement.clientHeight > 0 ? this.listElement.clientHeight : 400,
      this.rowHeight,
    );
    const spacer = document.createElement("div");
    spacer.className = "tree-spacer";
    spacer.style.height = `${String(slice.totalHeight)}px`;
    const windowElement = document.createElement("div");
    windowElement.className = "tree-window";
    windowElement.style.transform = `translateY(${String(slice.topPadding)}px)`;
    for (const row of this.rows.slice(slice.start, slice.end)) {
      windowElement.appendChild(this.rowElement(row));
    }
    spacer.appendChild(windowElement);
    this.listElement.replaceChildren(spacer);
  }

  private rowElement(row: TreeRow): HTMLElement {
    if (row.kind === "channel") {
      const element = document.createElement("div");
      element.className = "tree-row tree-channel";
      element.style.paddingLeft = `${String(8 + row.depth * 12)}px`;
      element.dataset.channel = row.path;
      const toggle = document.createElement("button");
      toggle.className = "tree-channel-caret";
      toggle.textContent = row.expanded ? "▾" : "▸";
      toggle.setAttribute(
        "aria-label",
        `${row.expanded ? "Collapse" : "Expand"} ${row.label}`,
      );
      toggle.addEventListener("click", () => {
        if (this.collapsed.has(row.path)) this.collapsed.delete(row.path);
        else this.collapsed.add(row.path);
        this.refresh();
      });
      const name = document.createElement("span");
      name.className = "signal-path";
      name.textContent = row.label;
      element.draggable = true;
      element.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData(
          SIGNAL_DRAG_TYPE,
          this.dragPayload(row.members),
        );
      });
      element.addEventListener("dblclick", () => {
        this.callbacks.onPlotSignals?.(row.members);
      });
      element.append(toggle, name);
      return element;
    }
    return this.leafElement(row.path, row.label, row.depth);
  }

  private leafElement(path: string, label: string, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row tree-leaf";
    row.style.paddingLeft = `${String(8 + depth * 12)}px`;
    row.dataset.signalPath = path;
    row.draggable = true;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Plot ${path}`);
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(SIGNAL_DRAG_TYPE, this.dragPayload([path]));
    });
    row.addEventListener("dblclick", () => this.callbacks.onPlotSignal(path));
    row.addEventListener("keydown", (event) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        event.target === row
      ) {
        event.preventDefault();
        this.callbacks.onPlotSignal(path);
      }
    });
    const name = document.createElement("span");
    name.className = "signal-path";
    name.textContent = label;
    const value = document.createElement("span");
    value.className = "signal-value";
    value.textContent = this.liveValues.get(path) ?? "—";
    row.append(name, value);
    if (path.startsWith("derived/")) {
      const remove = document.createElement("button");
      remove.className = "tree-derived-remove";
      remove.textContent = "✕";
      remove.title = `Remove ${path}`;
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        this.callbacks.onRemoveDerived(path);
      });
      row.append(remove);
    }
    return row;
  }

  private renderSets(): void {
    if (this.namedSets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "Saved sets appear here";
      this.setsElement.replaceChildren(empty);
      return;
    }
    this.setsElement.replaceChildren(
      ...this.namedSets.map((set) => {
        const row = document.createElement("div");
        row.className = "tree-row tree-set";
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        const name = document.createElement("span");
        name.className = "tree-set-name";
        name.textContent = `★ ${set.name}`;
        const detail = document.createElement("span");
        detail.className = "tree-set-detail";
        const live =
          set.kind === "query" && set.selector !== null
            ? evaluateSelector(this.catalog, set.selector)
            : null;
        detail.textContent = `· ${String(live?.signalCount ?? set.refs.length)}`;
        const badge = document.createElement("span");
        badge.className = "tree-set-badge";
        if (set.kind === "query") {
          badge.textContent = "live";
          badge.title = `${String(live?.signalCount ?? 0)} matching signals`;
        } else {
          badge.textContent = `▣ ${String(set.refs.length)}`;
          badge.title = "Manual pick set";
        }
        const remove = document.createElement("button");
        remove.className = "tree-set-remove";
        remove.type = "button";
        remove.textContent = "✕";
        remove.title = `Delete ${set.name}`;
        remove.setAttribute("aria-label", `Delete ${set.name}`);
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          this.callbacks.onSetRemove?.(set.id);
        });
        row.addEventListener("click", () => {
          this.callbacks.onSetBind?.(set.id);
        });
        row.addEventListener("keydown", (event) => {
          if (event.key === "Delete") {
            event.preventDefault();
            this.callbacks.onSetRemove?.(set.id);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.callbacks.onSetBind?.(set.id);
          }
        });
        row.draggable = true;
        row.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData(
            SET_DRAG_TYPE,
            JSON.stringify({ set_id: set.id }),
          );
        });
        row.append(name, detail, badge, remove);
        return row;
      }),
    );
  }

  private dragPayload(paths: readonly string[]): string {
    return JSON.stringify({
      refs: paths
        .map((path) => this.catalog.refFromPath(path))
        .filter(
          (ref): ref is { source_key: string; channel: string } =>
            ref !== undefined,
        ),
      paths,
    });
  }
}

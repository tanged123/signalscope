import { buildTreeRows, virtualSlice, type TreeRow } from "../app/tree-model";
import { SIGNAL_DRAG_TYPE } from "./panel";

const FALLBACK_ROW_HEIGHT = 22;

export interface SignalTreeCallbacks {
  onPlotSignal(path: string): void;
  onToggleFavorite(path: string): void;
  onRemoveDerived(path: string): void;
}

export class SignalTreeView {
  private paths: string[] = [];
  private favorites: readonly string[] = [];
  private readonly collapsed = new Set<string>();
  private filter = "";
  private rows: TreeRow[] = [];
  private readonly rowHeight: number;
  private liveValues: ReadonlyMap<string, string> = new Map();

  constructor(
    private readonly listElement: HTMLElement,
    private readonly favoritesElement: HTMLElement,
    private readonly callbacks: SignalTreeCallbacks,
  ) {
    // Virtual-scroll math follows the `--tree-row-height` design token so a
    // CSS restyle cannot silently desynchronize row offsets.
    const tokenHeight = Number.parseFloat(
      getComputedStyle(listElement).getPropertyValue("--tree-row-height"),
    );
    this.rowHeight =
      Number.isFinite(tokenHeight) && tokenHeight > 0
        ? tokenHeight
        : FALLBACK_ROW_HEIGHT;
    listElement.addEventListener("scroll", () => {
      this.renderRows();
    });
    favoritesElement.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes(SIGNAL_DRAG_TYPE) === true) {
        event.preventDefault();
        favoritesElement.classList.add("drop-target");
      }
    });
    favoritesElement.addEventListener("dragleave", () => {
      favoritesElement.classList.remove("drop-target");
    });
    favoritesElement.addEventListener("drop", (event) => {
      favoritesElement.classList.remove("drop-target");
      const path = event.dataTransfer?.getData(SIGNAL_DRAG_TYPE);
      if (path !== undefined && path !== "" && !this.favorites.includes(path)) {
        event.preventDefault();
        this.callbacks.onToggleFavorite(path);
      }
    });
  }

  setSignals(paths: readonly string[]): void {
    this.paths = [...paths];
    this.refresh();
  }

  setFavorites(favorites: readonly string[]): void {
    this.favorites = favorites;
    this.renderFavorites();
    this.renderRows();
  }

  setFilter(filter: string): void {
    this.filter = filter;
    this.refresh();
  }

  setLiveValues(values: ReadonlyMap<string, string>): void {
    this.liveValues = values;
    this.renderRows();
    this.renderFavorites();
  }

  private refresh(): void {
    this.rows = buildTreeRows(this.paths, this.collapsed, this.filter);
    this.renderRows();
  }

  private renderRows(): void {
    if (this.rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent =
        this.paths.length === 0 ? "No signals loaded." : "No matching signals.";
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
    if (row.kind === "group") {
      const button = document.createElement("button");
      button.className = "tree-row tree-group";
      button.style.paddingLeft = `${String(8 + row.depth * 12)}px`;
      button.textContent = `${row.expanded ? "▾" : "▸"} ${row.label}`;
      button.addEventListener("click", () => {
        if (this.collapsed.has(row.path)) {
          this.collapsed.delete(row.path);
        } else {
          this.collapsed.add(row.path);
        }
        this.refresh();
      });
      return button;
    }
    return this.leafElement(row.path, row.label, row.depth);
  }

  private leafElement(path: string, label: string, depth: number): HTMLElement {
    const rowElement = document.createElement("div");
    rowElement.className = "tree-row tree-leaf";
    rowElement.style.paddingLeft = `${String(8 + depth * 12)}px`;
    rowElement.dataset.signalPath = path;
    rowElement.draggable = true;
    rowElement.tabIndex = 0;
    rowElement.setAttribute("role", "button");
    rowElement.setAttribute("aria-label", `Plot ${path}`);
    rowElement.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(SIGNAL_DRAG_TYPE, path);
    });
    rowElement.addEventListener("dblclick", () => {
      this.callbacks.onPlotSignal(path);
    });
    rowElement.addEventListener("keydown", (event) => {
      if (
        event.target === rowElement &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        this.callbacks.onPlotSignal(path);
      }
    });
    const star = document.createElement("button");
    star.className = `tree-star ${this.favorites.includes(path) ? "active" : ""}`;
    star.textContent = "★";
    star.title = "Toggle favorite";
    star.setAttribute(
      "aria-label",
      `${this.favorites.includes(path) ? "Remove" : "Add"} ${path} ${this.favorites.includes(path) ? "from" : "to"} favorites`,
    );
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      this.callbacks.onToggleFavorite(path);
    });
    const name = document.createElement("span");
    name.className = "signal-path";
    name.textContent = label;
    const value = document.createElement("span");
    value.className = "signal-value";
    value.textContent = this.liveValues.get(path) ?? "—";
    rowElement.append(star, name);
    if (path.startsWith("derived/")) {
      const mark = document.createElement("span");
      mark.className = "tree-derived-mark";
      mark.textContent = "ƒx";
      mark.title = "derived signal";
      rowElement.append(mark);
    }
    rowElement.append(value);
    if (path.startsWith("derived/")) {
      const remove = document.createElement("button");
      remove.className = "tree-derived-remove";
      remove.textContent = "✕";
      remove.title = `Remove ${path}`;
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        this.callbacks.onRemoveDerived(path);
      });
      rowElement.append(remove);
    }
    return rowElement;
  }

  private renderFavorites(): void {
    if (this.favorites.length === 0) {
      const none = document.createElement("div");
      none.className = "tree-empty";
      none.textContent = "Star a signal or drop it here";
      this.favoritesElement.replaceChildren(none);
      return;
    }
    this.favoritesElement.replaceChildren(
      ...this.favorites.map((path) => this.leafElement(path, path, 0)),
    );
  }
}

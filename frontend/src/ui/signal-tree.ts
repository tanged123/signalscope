import {
  buildTreeRows,
  virtualSlice,
  type TreeRow,
  type TreeSet,
} from "../app/tree-model";
import {
  BUNDLE_DRAG_TYPE,
  parseBundleLocalPath,
  parseBundlePayload,
  SIGNAL_DRAG_TYPE,
} from "./panel";

const FALLBACK_ROW_HEIGHT = 22;

export interface SignalTreeCallbacks {
  onPlotSignal(path: string): void;
  onPlotBundle?(localPath: string, memberPaths: readonly string[]): void;
  onToggleFavorite(path: string): void;
  onToggleFavoriteBundle?(localPath: string): void;
  onRemoveDerived(path: string): void;
  onRemoveDerivedBundle?(localPath: string): void;
}

export class SignalTreeView {
  private paths: string[] = [];
  private favorites: readonly string[] = [];
  private readonly collapsed = new Set<string>();
  private readonly expandedBundles = new Set<string>();
  private filter = "";
  private rows: TreeRow[] = [];
  private readonly rowHeight: number;
  private liveValues: ReadonlyMap<string, string> = new Map();
  private sets: TreeSet[] = [];
  private favoriteBundles: readonly string[] = [];
  private bundleMembers = new Map<string, string[]>();

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
      if (
        event.dataTransfer?.types.includes(SIGNAL_DRAG_TYPE) === true ||
        event.dataTransfer?.types.includes(BUNDLE_DRAG_TYPE) === true
      ) {
        event.preventDefault();
        favoritesElement.classList.add("drop-target");
      }
    });
    favoritesElement.addEventListener("dragleave", () => {
      favoritesElement.classList.remove("drop-target");
    });
    favoritesElement.addEventListener("drop", (event) => {
      favoritesElement.classList.remove("drop-target");
      const bundleData = event.dataTransfer?.getData(BUNDLE_DRAG_TYPE) ?? "";
      const bundle = parseBundlePayload(bundleData);
      const localPath =
        bundle === null ? null : parseBundleLocalPath(bundleData);
      if (localPath !== null && !this.favoriteBundles.includes(localPath)) {
        event.preventDefault();
        this.callbacks.onToggleFavoriteBundle?.(localPath);
        return;
      }
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

  setSets(sets: readonly TreeSet[]): void {
    this.sets = sets.map((set) => ({ ...set, prefixes: [...set.prefixes] }));
    this.refresh();
  }

  setFavorites(favorites: readonly string[]): void {
    this.favorites = favorites;
    this.renderFavorites();
    this.renderRows();
  }

  setFavoriteBundles(favorites: readonly string[]): void {
    this.favoriteBundles = favorites;
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
    this.bundleMembers = this.collectBundleMembers();
    this.rows = buildTreeRows(
      this.paths,
      this.collapsed,
      this.filter,
      this.sets.length > 0
        ? {
            sets: this.sets,
            expandedBundles: this.expandedBundles,
          }
        : undefined,
    );
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
    if (row.kind === "bundle") {
      const element = document.createElement("div");
      element.className = "tree-row tree-bundle";
      element.style.paddingLeft = `${String(8 + row.depth * 12)}px`;
      element.dataset.bundlePath = row.path;
      element.draggable = true;
      element.tabIndex = 0;
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", `Plot bundle ${row.path}`);
      const caret = document.createElement("button");
      caret.className = "tree-bundle-caret";
      caret.textContent = row.expanded ? "▾" : "▸";
      caret.setAttribute(
        "aria-label",
        `${row.expanded ? "Collapse" : "Expand"} ${row.path}`,
      );
      caret.addEventListener("click", (event) => {
        event.stopPropagation();
        if (this.expandedBundles.has(row.bundleKey)) {
          this.expandedBundles.delete(row.bundleKey);
        } else {
          this.expandedBundles.add(row.bundleKey);
        }
        this.refresh();
      });
      element.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData(
          BUNDLE_DRAG_TYPE,
          JSON.stringify({
            local_path: row.path,
            member_paths: row.memberPaths,
          }),
        );
      });
      const plot = () =>
        this.callbacks.onPlotBundle?.(row.path, row.memberPaths);
      element.addEventListener("dblclick", plot);
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          plot();
        }
      });
      const name = document.createElement("span");
      name.className = "signal-path";
      name.textContent = row.label;
      const badge = document.createElement("span");
      badge.className = "tree-run-count";
      badge.textContent = `${String(row.runCount)} runs`;
      const star = document.createElement("button");
      const favorite = this.favoriteBundles.includes(row.path);
      star.className = `tree-star ${favorite ? "active" : ""}`;
      star.textContent = "★";
      star.title = "Toggle bundle favorite";
      star.setAttribute(
        "aria-label",
        `${favorite ? "Remove" : "Add"} ${row.path} ${favorite ? "from" : "to"} favorites`,
      );
      star.addEventListener("click", (event) => {
        event.stopPropagation();
        this.callbacks.onToggleFavoriteBundle?.(row.path);
      });
      element.append(caret, star, name, badge);
      if (row.path.startsWith("derived/")) {
        const mark = document.createElement("span");
        mark.className = "tree-derived-mark";
        mark.textContent = "ƒx";
        mark.title = "derived bundle";
        const remove = document.createElement("button");
        remove.className = "tree-derived-remove";
        remove.textContent = "✕";
        remove.title = "Remove " + row.path;
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          this.callbacks.onRemoveDerivedBundle?.(row.path);
        });
        element.append(mark, remove);
      }
      return element;
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
    const isDerivedMember =
      path.startsWith("derived/") || path.includes("/derived/");
    if (isDerivedMember) {
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
    const bundleRows = this.favoriteBundles.map((path) =>
      this.favoriteBundleElement(path, this.bundleMembers.get(path) ?? []),
    );
    if (bundleRows.length === 0 && this.favorites.length === 0) {
      const none = document.createElement("div");
      none.className = "tree-empty";
      none.textContent = "Star a signal or drop it here";
      this.favoritesElement.replaceChildren(none);
      return;
    }
    this.favoritesElement.replaceChildren(
      ...bundleRows,
      ...this.favorites.map((path) => this.leafElement(path, path, 0)),
    );
  }

  private favoriteBundleElement(
    path: string,
    memberPaths: readonly string[],
  ): HTMLElement {
    const element = document.createElement("div");
    element.className = "tree-row tree-bundle favorite-bundle";
    element.dataset.bundlePath = path;
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", `Plot bundle ${path}`);
    const name = document.createElement("span");
    name.className = "signal-path";
    name.textContent = path;
    const badge = document.createElement("span");
    badge.className = "tree-run-count";
    badge.textContent = `${String(memberPaths.length)} runs`;
    element.append(name, badge);
    if (memberPaths.length === 0) {
      element.classList.add("muted");
      return element;
    }
    element.draggable = true;
    element.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(
        BUNDLE_DRAG_TYPE,
        JSON.stringify({ local_path: path, member_paths: memberPaths }),
      );
    });
    const plot = () => this.callbacks.onPlotBundle?.(path, memberPaths);
    element.addEventListener("dblclick", plot);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        plot();
      }
    });
    return element;
  }

  private collectBundleMembers(): Map<string, string[]> {
    const byPath = new Map<string, string[]>();
    const prefixes = new Set(this.sets.flatMap((set) => set.prefixes));
    for (const path of this.paths) {
      const prefix = [...prefixes].find((item) => path.startsWith(`${item}/`));
      if (prefix === undefined) continue;
      const localPath = path.slice(prefix.length + 1);
      const members = byPath.get(localPath) ?? [];
      members.push(path);
      byPath.set(localPath, members);
    }
    for (const [path, members] of byPath) {
      if (members.length < 2) byPath.delete(path);
      else byPath.set(path, members.sort());
    }
    return byPath;
  }
}

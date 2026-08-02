import type { NamedSet } from "../generated/session";
import { Catalog } from "../app/catalog";
import { evaluateSelector } from "../app/selector";
import { SET_DRAG_TYPE } from "./panel";

export interface SetsListCallbacks {
  onSetBind(setId: string): void;
  onSetRemove(setId: string): void;
}

export class SetsListView {
  private catalog = Catalog.empty();
  private namedSets: readonly NamedSet[] = [];

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: SetsListCallbacks,
  ) {}

  setCatalog(catalog: Catalog): void {
    this.catalog = catalog;
    this.render();
  }

  setNamedSets(sets: readonly NamedSet[]): void {
    this.namedSets = sets.map((set) => structuredClone(set));
    this.render();
  }

  private render(): void {
    if (this.namedSets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "Saved sets appear here";
      this.element.replaceChildren(empty);
      return;
    }
    this.element.replaceChildren(
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
          this.callbacks.onSetRemove(set.id);
        });
        row.addEventListener("click", () => {
          this.callbacks.onSetBind(set.id);
        });
        row.addEventListener("keydown", (event) => {
          if (event.key === "Delete") {
            event.preventDefault();
            this.callbacks.onSetRemove(set.id);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.callbacks.onSetBind(set.id);
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
}

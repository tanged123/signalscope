import type { NamedSet } from "../generated/session";
import type { SeriesRef } from "../generated/session";
import { Catalog } from "../app/catalog";
import { evaluateSelector } from "../app/selector";
import {
  dragData,
  hasDragType,
  parseSignalRefsPayload,
  SET_DRAG_TYPE,
  SIGNAL_DRAG_TYPE,
} from "./panel";

export interface SetsListCallbacks {
  onSetBind(setId: string): void;
  onSetRemove(setId: string): void;
  onSignalDrop(refs: readonly SeriesRef[]): void;
}

export class SetsListView {
  private catalog = Catalog.empty();
  private readonly expandedSets = new Set<string>();
  private namedSets: readonly NamedSet[] = [];

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: SetsListCallbacks,
  ) {
    this.element.addEventListener("dragover", (event) => {
      if (!hasDragType(event, SIGNAL_DRAG_TYPE)) return;
      event.preventDefault();
      this.element.classList.add("drop-target");
    });
    this.element.addEventListener("dragleave", () => {
      this.element.classList.remove("drop-target");
    });
    this.element.addEventListener("drop", (event) => {
      this.element.classList.remove("drop-target");
      if (!hasDragType(event, SIGNAL_DRAG_TYPE)) return;
      event.preventDefault();
      const payload = dragData(event, SIGNAL_DRAG_TYPE);
      if (payload === null) return;
      const refs = parseSignalRefsPayload(payload);
      if (refs.length > 0) this.callbacks.onSignalDrop(refs);
    });
  }

  setCatalog(catalog: Catalog): void {
    this.catalog = catalog;
    this.render();
  }

  setNamedSets(sets: readonly NamedSet[]): void {
    this.namedSets = sets.map((set) => structuredClone(set));
    const ids = new Set(this.namedSets.map((set) => set.id));
    for (const id of this.expandedSets) {
      if (!ids.has(id)) this.expandedSets.delete(id);
    }
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
    const rows: HTMLElement[] = [];
    for (const set of this.namedSets) {
      const expanded = this.expandedSets.has(set.id);
      const live =
        set.kind === "query" && set.selector !== null
          ? evaluateSelector(this.catalog, set.selector)
          : null;
      const row = document.createElement("div");
      row.className = "tree-row tree-set";
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.ariaExpanded = String(expanded);
      const caret = document.createElement("button");
      caret.className = "tree-set-caret";
      caret.type = "button";
      caret.textContent = expanded ? "▾" : "▸";
      caret.title = `${expanded ? "Collapse" : "Expand"} ${set.name}`;
      caret.setAttribute("aria-label", caret.title);
      caret.addEventListener("click", (event) => {
        event.stopPropagation();
        if (expanded) this.expandedSets.delete(set.id);
        else this.expandedSets.add(set.id);
        this.render();
      });
      const name = document.createElement("span");
      name.className = "tree-set-name";
      name.textContent = `★ ${set.name}`;
      const detail = document.createElement("span");
      detail.className = "tree-set-detail";
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
        if (event.dataTransfer !== null)
          event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer?.setData(
          SET_DRAG_TYPE,
          JSON.stringify({ set_id: set.id }),
        );
      });
      row.append(caret, name, detail, badge, remove);
      rows.push(row);
      if (expanded) {
        const members =
          live?.series ??
          set.refs.flatMap((ref) => {
            const series = this.catalog.get(ref);
            return series === undefined ? [] : [series];
          });
        for (const series of members) {
          const member = document.createElement("div");
          member.className = "tree-row tree-set-member";
          member.textContent = series.path;
          member.title = series.path;
          rows.push(member);
        }
      }
    }
    this.element.replaceChildren(...rows);
  }
}

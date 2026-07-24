import type { WorkspaceModel } from "../app/workspace";
import type { TileResponse } from "../generated/protocol";
import {
  PANEL_DRAG_TYPE,
  PanelView,
  SIGNAL_DRAG_TYPE,
  hasDragType,
  type PanelCallbacks,
} from "./panel";

export interface WorkspaceCallbacks extends PanelCallbacks {
  onLayoutChanged(): void;
  onDropSignalNewPanel(path: string): void;
  onMovePanel(
    id: string,
    targetRowIndex: number,
    targetCellIndex: number,
  ): void;
}

export class WorkspaceView {
  private readonly views = new Map<string, PanelView>();

  constructor(
    private readonly root: HTMLElement,
    private readonly model: WorkspaceModel,
    private readonly callbacks: WorkspaceCallbacks,
  ) {
    this.bindWorkspaceDrop();
  }

  sync(hasSignals: boolean): void {
    const alive = new Set(this.model.panels().map((panel) => panel.id));
    for (const [id, view] of this.views) {
      if (!alive.has(id)) {
        view.element.remove();
        this.views.delete(id);
      }
    }
    this.root.replaceChildren();
    if (this.model.panels().length === 0) {
      this.root.appendChild(emptyState(hasSignals));
      return;
    }
    const maximized = this.model.maximizedPanelId();
    if (maximized !== null) {
      const rowElement = document.createElement("div");
      rowElement.className = "workspace-row";
      rowElement.style.flex = "1 1 0";
      rowElement.appendChild(this.view(maximized).element);
      this.root.appendChild(rowElement);
      this.refreshPanelStates();
      return;
    }
    this.model.layout().forEach((row, rowIndex) => {
      if (rowIndex > 0) this.root.appendChild(this.rowSeam(rowIndex - 1));
      const rowElement = document.createElement("div");
      rowElement.className = "workspace-row";
      rowElement.style.flex = `${String(row.height)} 1 0`;
      row.panels.forEach((cell, cellIndex) => {
        if (cellIndex > 0) {
          rowElement.appendChild(this.columnSeam(rowIndex, cellIndex - 1));
        }
        const view = this.view(cell.panel_id);
        view.element.style.flex = `${String(cell.width)} 1 0`;
        rowElement.appendChild(view.element);
      });
      this.root.appendChild(rowElement);
    });
    this.refreshPanelStates();
  }

  refreshPanelStates(): void {
    const focused = this.model.focusedPanelId();
    const maximized = this.model.maximizedPanelId();
    for (const panel of this.model.panels()) {
      this.views
        .get(panel.id)
        ?.update(panel, panel.id === focused, panel.id === maximized);
    }
  }

  renderTiles(
    tilesByPanel: ReadonlyMap<string, TileResponse>,
    window: { t0: number; t1: number },
  ): number {
    const maximized = this.model.maximizedPanelId();
    let total = 0;
    for (const panel of this.model.panels()) {
      if (maximized !== null && panel.id !== maximized) continue;
      total +=
        this.views
          .get(panel.id)
          ?.renderTiles(panel, tilesByPanel.get(panel.id) ?? null, window) ?? 0;
    }
    return total;
  }

  invalidateTheme(): void {
    for (const view of this.views.values()) view.invalidateTheme();
  }

  private view(id: string): PanelView {
    let view = this.views.get(id);
    if (view === undefined) {
      view = new PanelView(id, this.callbacks);
      this.bindPanelRearrange(view.element, id);
      this.views.set(id, view);
    }
    return view;
  }

  private bindPanelRearrange(element: HTMLElement, id: string): void {
    element.addEventListener("dragover", (event) => {
      if (hasDragType(event, PANEL_DRAG_TYPE)) event.preventDefault();
    });
    element.addEventListener("drop", (event) => {
      const dragged = event.dataTransfer?.getData(PANEL_DRAG_TYPE);
      if (dragged === undefined || dragged === "" || dragged === id) return;
      event.preventDefault();
      event.stopPropagation();
      const location = this.model.locate(id);
      if (location !== null) {
        this.callbacks.onMovePanel(
          dragged,
          location.rowIndex,
          location.cellIndex,
        );
      }
    });
  }

  private bindWorkspaceDrop(): void {
    this.root.addEventListener("dragover", (event) => {
      if (hasDragType(event, SIGNAL_DRAG_TYPE)) {
        event.preventDefault();
        this.root.classList.add("drop-target");
      }
    });
    this.root.addEventListener("dragleave", () => {
      this.root.classList.remove("drop-target");
    });
    this.root.addEventListener("drop", (event) => {
      this.root.classList.remove("drop-target");
      const target = event.target;
      const onBackground =
        target === this.root ||
        (target instanceof HTMLElement &&
          target.classList.contains("workspace-empty"));
      if (!onBackground) return;
      const path = event.dataTransfer?.getData(SIGNAL_DRAG_TYPE);
      if (path !== undefined && path !== "") {
        event.preventDefault();
        this.callbacks.onDropSignalNewPanel(path);
      }
    });
  }

  private rowSeam(seamIndex: number): HTMLElement {
    return this.seam("seam seam-row", (_dx, dy) => {
      const height = this.root.clientHeight;
      if (height > 0) this.model.resizeRows(seamIndex, dy / height);
    });
  }

  private columnSeam(rowIndex: number, seamIndex: number): HTMLElement {
    return this.seam("seam seam-col", (dx, _dy, seamElement) => {
      const width = seamElement.parentElement?.clientWidth ?? 0;
      if (width > 0) this.model.resizeColumns(rowIndex, seamIndex, dx / width);
    });
  }

  private seam(
    className: string,
    apply: (dx: number, dy: number, seamElement: HTMLElement) => void,
  ): HTMLElement {
    const seamElement = document.createElement("div");
    seamElement.className = className;
    seamElement.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      seamElement.setPointerCapture(event.pointerId);
      let last = { x: event.clientX, y: event.clientY };
      const move = (moveEvent: PointerEvent): void => {
        apply(
          moveEvent.clientX - last.x,
          moveEvent.clientY - last.y,
          seamElement,
        );
        last = { x: moveEvent.clientX, y: moveEvent.clientY };
        this.applySizes();
      };
      const up = (): void => {
        seamElement.removeEventListener("pointermove", move);
        seamElement.removeEventListener("pointerup", up);
        this.callbacks.onLayoutChanged();
      };
      seamElement.addEventListener("pointermove", move);
      seamElement.addEventListener("pointerup", up);
    });
    return seamElement;
  }

  private applySizes(): void {
    const rows = this.root.querySelectorAll<HTMLElement>(".workspace-row");
    this.model.layout().forEach((row, rowIndex) => {
      const rowElement = rows[rowIndex];
      if (rowElement === undefined) return;
      rowElement.style.flex = `${String(row.height)} 1 0`;
      for (const cell of row.panels) {
        const view = this.views.get(cell.panel_id);
        if (view !== undefined) {
          view.element.style.flex = `${String(cell.width)} 1 0`;
        }
      }
    });
  }
}

function emptyState(hasSignals: boolean): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "workspace-empty";
  const headline = document.createElement("div");
  headline.className = "empty-headline";
  const hint = document.createElement("div");
  hint.className = "empty-hint";
  if (hasSignals) {
    headline.textContent = "No panels open.";
    hint.textContent = "New panel row (N) · drag a signal here · ⌘K commands";
  } else {
    headline.textContent = "No data loaded.";
    hint.textContent = "Open CSV / MCAP (O) · ⌘K commands";
  }
  empty.append(headline, hint);
  return empty;
}

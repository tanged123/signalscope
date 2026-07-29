import { formatCombo } from "../app/commands";
import type { WorkspaceModel } from "../app/workspace";
import type { SampleResponse, TileResponse } from "../generated/protocol";
import { bindPointerDrag } from "./dom";
import {
  PANEL_DRAG_TYPE,
  PanelView,
  SIGNAL_DRAG_TYPE,
  dragData,
  hasDragType,
  type PanelCallbacks,
} from "./panel";
import type { CursorMode } from "../render/overlay-renderer";

export interface WorkspaceCallbacks extends PanelCallbacks {
  onLayoutChanged(): void;
  onDropSignalNewPanel(path: string): void;
  onMovePanel(
    id: string,
    targetRowIndex: number,
    targetCellIndex: number,
  ): void;
  onShowPanel(id: string): void;
  onRestoreGrid(): void;
}

export class WorkspaceView {
  private readonly views = new Map<string, PanelView>();
  private mountedKey = "";
  private cursorMode: CursorMode = "none";

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
    const key = this.structureKey(hasSignals);
    if (key === this.mountedKey) {
      // Same rows/cells/maximization: refresh sizes and state in place
      // instead of tearing down and re-observing every panel.
      if (this.model.maximizedPanelId() === null) this.applySizes();
      this.refreshPanelStates();
      return;
    }
    this.mountedKey = key;
    this.root.replaceChildren();
    if (this.model.panels().length === 0) {
      this.root.appendChild(emptyState(hasSignals));
      return;
    }
    const maximized = this.model.maximizedPanelId();
    if (maximized !== null) {
      const rowElement = document.createElement("div");
      rowElement.className = "workspace-row maximized-row";
      const view = this.view(maximized);
      view.element.style.removeProperty("flex");
      rowElement.appendChild(view.element);
      this.root.append(this.maximizedPanelBar(maximized), rowElement);
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

  /** Identity of the mounted DOM: rows, cell order, maximization, empty. */
  private structureKey(hasSignals: boolean): string {
    if (this.model.panels().length === 0) return `empty:${String(hasSignals)}`;
    const maximized = this.model.maximizedPanelId();
    if (maximized !== null) return `max:${maximized}`;
    return this.model
      .layout()
      .map((row) => row.panels.map((cell) => cell.panel_id).join(","))
      .join(";");
  }

  refreshPanelStates(): void {
    const maximized = this.model.maximizedPanelId();
    for (const panel of this.model.panels()) {
      this.views.get(panel.id)?.update(panel, panel.id === maximized);
    }
  }

  renderData(
    tilesByPanel: ReadonlyMap<string, TileResponse>,
    samplesByPanel: ReadonlyMap<string, SampleResponse>,
    windowFor: (panelId: string) => { t0: number; t1: number },
    missingFor: (panelId: string) => readonly string[],
  ): number {
    const maximized = this.model.maximizedPanelId();
    let total = 0;
    for (const panel of this.model.panels()) {
      if (maximized !== null && panel.id !== maximized) continue;
      total +=
        this.views
          .get(panel.id)
          ?.renderData(
            panel,
            tilesByPanel.get(panel.id) ?? null,
            samplesByPanel.get(panel.id) ?? null,
            windowFor(panel.id),
            missingFor(panel.id),
          ) ?? 0;
    }
    return total;
  }

  invalidateTheme(): void {
    for (const view of this.views.values()) view.invalidateTheme();
  }

  setCursor(cursorT: number | null): void {
    for (const view of this.views.values()) view.setCursor(cursorT);
  }

  setLocalCursor(id: string, cursorValue: number | null): void {
    this.views.get(id)?.setLocalCursor(cursorValue);
  }

  clearCursors(): void {
    for (const view of this.views.values()) view.clearCursor();
  }

  setCursorMode(cursorMode: CursorMode): void {
    this.cursorMode = cursorMode;
    for (const view of this.views.values()) view.setCursorMode(cursorMode);
  }

  resetYAxis(id: string): void {
    this.views.get(id)?.resetYAxis();
  }

  canEditAxis(id: string, axis: "x" | "y" | "c"): boolean {
    return this.views.get(id)?.canEditAxis(axis) ?? false;
  }

  beginAxisEdit(id: string, axis: "x" | "y" | "c"): void {
    this.views.get(id)?.beginAxisEdit(axis);
  }

  /** The rendered plot width of a panel in CSS pixels, 0 when unmounted. */
  panelWidth(id: string): number {
    return this.views.get(id)?.plotWidth() ?? 0;
  }

  panelCanvases(
    id: string,
  ): { plot: HTMLCanvasElement; overlay: HTMLCanvasElement } | null {
    return this.views.get(id)?.canvases() ?? null;
  }

  panelRect(id: string): DOMRect | null {
    return this.views.get(id)?.panelRect() ?? null;
  }

  private view(id: string): PanelView {
    let view = this.views.get(id);
    if (view === undefined) {
      view = new PanelView(id, this.callbacks);
      view.setCursorMode(this.cursorMode);
      this.bindPanelRearrange(view.element, id);
      this.views.set(id, view);
    }
    return view;
  }

  private maximizedPanelBar(maximizedId: string): HTMLElement {
    const bar = document.createElement("nav");
    bar.className = "maximized-panel-bar";
    bar.ariaLabel = "Panels in this workspace";

    const label = document.createElement("span");
    label.className = "maximized-panel-label";
    label.textContent = "MAXIMIZED";
    bar.appendChild(label);

    for (const panel of this.model.panels()) {
      const button = document.createElement("button");
      button.className = `maximized-panel-tab ${panel.id === maximizedId ? "active" : ""}`;
      button.textContent = panel.title;
      button.title =
        panel.id === maximizedId
          ? `${panel.title} is maximized`
          : `Show ${panel.title}`;
      button.addEventListener("click", () => {
        this.callbacks.onShowPanel(panel.id);
      });
      bar.appendChild(button);
    }

    const restore = document.createElement("button");
    restore.className = "restore-grid";
    restore.textContent = "Restore grid";
    restore.title = "Show every panel in this workspace";
    restore.addEventListener("click", () => {
      this.callbacks.onRestoreGrid();
    });
    bar.appendChild(restore);
    return bar;
  }

  private bindPanelRearrange(element: HTMLElement, id: string): void {
    element.addEventListener("dragover", (event) => {
      if (hasDragType(event, PANEL_DRAG_TYPE)) event.preventDefault();
    });
    element.addEventListener("drop", (event) => {
      const dragged = dragData(event, PANEL_DRAG_TYPE);
      if (dragged === null || dragged === id) return;
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
      if (
        hasDragType(event, SIGNAL_DRAG_TYPE) &&
        this.isWorkspaceBackground(event.target)
      ) {
        event.preventDefault();
        this.root.classList.add("drop-target");
      } else {
        this.root.classList.remove("drop-target");
      }
    });
    this.root.addEventListener("dragleave", () => {
      this.root.classList.remove("drop-target");
    });
    this.root.addEventListener("drop", (event) => {
      this.root.classList.remove("drop-target");
      if (!this.isWorkspaceBackground(event.target)) return;
      const path = dragData(event, SIGNAL_DRAG_TYPE);
      if (path !== null) {
        event.preventDefault();
        this.callbacks.onDropSignalNewPanel(path);
      }
    });
  }

  private isWorkspaceBackground(target: EventTarget | null): boolean {
    return (
      target === this.root ||
      (target instanceof Element && target.closest(".workspace-empty") !== null)
    );
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
    bindPointerDrag(seamElement, (down) => {
      let last = { x: down.clientX, y: down.clientY };
      return {
        onMove: (moveEvent) => {
          apply(
            moveEvent.clientX - last.x,
            moveEvent.clientY - last.y,
            seamElement,
          );
          last = { x: moveEvent.clientX, y: moveEvent.clientY };
          this.applySizes();
        },
        onEnd: () => {
          this.callbacks.onLayoutChanged();
        },
      };
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
  const commands = `${formatCombo("mod+shift+p")} commands`;
  if (hasSignals) {
    headline.textContent = "No panels open.";
    hint.textContent = `New panel (N) · drag a signal here · ${commands}`;
  } else {
    headline.textContent = "No data loaded.";
    hint.textContent = `Open CSV / MCAP (O) · ${commands}`;
  }
  empty.append(headline, hint);
  return empty;
}

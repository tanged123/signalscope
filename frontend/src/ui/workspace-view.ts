import { formatCombo } from "../app/commands";
import type { ColumnarTileResponse } from "../app/bin-columns";
import { MAX_RESIDENT_SERIES } from "../app/render-limits";
import type { WorkspaceModel } from "../app/workspace";
import { bindPointerDrag } from "./dom";
import {
  PANEL_DRAG_TYPE,
  PanelView,
  SET_DRAG_TYPE,
  SIGNAL_DRAG_TYPE,
  dragData,
  hasDragType,
  parseSetPayload,
  parseSignalPayload,
  type PanelCallbacks,
} from "./panel";
import type { CursorMode } from "../render/overlay-renderer";
import type { GpuContext } from "../render/gpu-context";
import { panelsToEvict } from "./panel-residency";

export interface WorkspaceCallbacks extends PanelCallbacks {
  onEvictPanel(id: string): void;
  onLayoutChanged(): void;
  onDropSignalNewPanel(path: string): void;
  onDropSignalsNewPanel?(paths: readonly string[]): void;
  onDropSetNewPanel(setId: string): void;
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
  private seriesCounts: ReadonlyMap<string, number> = new Map();
  private useCounter = 0;
  private readonly lastUsed = new Map<string, number>();

  constructor(
    private readonly root: HTMLElement,
    private readonly model: WorkspaceModel,
    private readonly callbacks: WorkspaceCallbacks,
    private gpu: GpuContext | null = null,
  ) {
    this.bindWorkspaceDrop();
  }

  setGpu(gpu: GpuContext, hasSignals: boolean): void {
    if (this.gpu === gpu) return;
    this.gpu = gpu;
    for (const view of this.views.values()) view.setGpu(gpu);
    if (this.views.size === 0) this.sync(hasSignals, this.seriesCounts);
  }

  releaseGpu(): void {
    for (const view of this.views.values()) view.releaseGpu();
    this.gpu = null;
  }

  sync(hasSignals: boolean, seriesCounts: ReadonlyMap<string, number>): void {
    this.seriesCounts = seriesCounts;
    const allPanels = this.model.tabs().flatMap((tab) => tab.panels);
    const alive = new Set(allPanels.map((panel) => panel.id));
    for (const [id, view] of this.views) {
      if (!alive.has(id)) {
        view.dispose();
        view.element.remove();
        this.views.delete(id);
        this.lastUsed.delete(id);
      }
    }
    const key = this.structureKey(hasSignals);
    if (key === this.mountedKey) {
      // Same rows/cells/maximization: refresh sizes and state in place
      // instead of tearing down and re-observing every panel.
      if (this.model.maximizedPanelId() === null) this.applySizes();
      this.refreshPanelStates();
      this.touchActivePanels();
      this.applyResidency();
      return;
    }
    this.mountedKey = key;
    for (const view of this.views.values()) {
      if (view.element.isConnected) view.releaseGpu();
    }
    this.root.replaceChildren();
    if (this.model.panels().length === 0) {
      this.root.appendChild(emptyState(hasSignals));
      this.applyResidency();
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
      view.mount();
      this.refreshPanelStates();
      this.touchActivePanels();
      this.applyResidency();
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
      for (const cell of row.panels) this.views.get(cell.panel_id)?.mount();
    });
    this.refreshPanelStates();
    this.touchActivePanels();
    this.applyResidency();
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
    tilesByPanel: ReadonlyMap<string, ColumnarTileResponse>,
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

  canEditAxis(id: string, axis: "x" | "y"): boolean {
    return this.views.get(id)?.canEditAxis(axis) ?? false;
  }

  beginAxisEdit(id: string, axis: "x" | "y"): void {
    this.views.get(id)?.beginAxisEdit(axis);
  }

  /** The rendered plot width of a panel in CSS pixels, 0 when unmounted. */
  panelWidth(id: string): number {
    return this.views.get(id)?.plotWidth() ?? 0;
  }

  async capturePanel(
    id: string,
  ): Promise<{ plot: HTMLCanvasElement; overlay: HTMLCanvasElement } | null> {
    return (await this.views.get(id)?.capturePlot()) ?? null;
  }

  panelRect(id: string): DOMRect | null {
    return this.views.get(id)?.panelRect() ?? null;
  }

  private view(id: string): PanelView {
    let view = this.views.get(id);
    if (view === undefined) {
      view = new PanelView(id, this.callbacks, this.gpu);
      view.setCursorMode(this.cursorMode);
      this.bindPanelRearrange(view.element, id);
      this.views.set(id, view);
    } else if (this.gpu !== null) {
      view.setGpu(this.gpu);
    }
    return view;
  }

  private touchActivePanels(): void {
    for (const panel of this.model.panels()) {
      this.useCounter += 1;
      this.lastUsed.set(panel.id, this.useCounter);
    }
  }

  private applyResidency(): void {
    const active = new Set(this.model.panels().map((panel) => panel.id));
    const residents = Array.from(this.views, ([id]) => ({
      id,
      seriesCount: this.seriesCounts.get(id) ?? 0,
      lastUsed: this.lastUsed.get(id) ?? 0,
      active: active.has(id),
    }));
    for (const id of panelsToEvict(residents, MAX_RESIDENT_SERIES)) {
      const view = this.views.get(id);
      if (view === undefined || active.has(id)) continue;
      view.dispose();
      view.element.remove();
      this.views.delete(id);
      this.lastUsed.delete(id);
      this.callbacks.onEvictPanel(id);
    }
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
        (hasDragType(event, SIGNAL_DRAG_TYPE) ||
          hasDragType(event, SET_DRAG_TYPE)) &&
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
      const setPayload = dragData(event, SET_DRAG_TYPE);
      if (setPayload !== null) {
        event.preventDefault();
        const setId = parseSetPayload(setPayload);
        if (setId !== null) this.callbacks.onDropSetNewPanel(setId);
        return;
      }
      const path = dragData(event, SIGNAL_DRAG_TYPE);
      if (path !== null) {
        event.preventDefault();
        const paths = parseSignalPayload(path);
        if (paths.length > 1) {
          if (this.callbacks.onDropSignalsNewPanel === undefined) {
            const first = paths[0];
            if (first !== undefined) this.callbacks.onDropSignalNewPanel(first);
          } else {
            this.callbacks.onDropSignalsNewPanel(paths);
          }
        } else if (paths[0] !== undefined)
          this.callbacks.onDropSignalNewPanel(paths[0]);
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
    hint.textContent = `Open… (O) · ${commands}`;
  }
  empty.append(headline, hint);
  return empty;
}

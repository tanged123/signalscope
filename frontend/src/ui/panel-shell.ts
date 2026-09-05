export const SIGNAL_DRAG_TYPE = "application/x-signalscope-signal";
export const SET_DRAG_TYPE = "application/x-signalscope-set";
export const PANEL_DRAG_TYPE = "application/x-signalscope-panel";
export const MAXIMIZE_GLYPH = "↗";

export interface PanelShellSlots {
  readonly binding: HTMLElement;
  readonly controls: HTMLElement;
  readonly content: HTMLElement;
  readonly legend: HTMLElement;
  readonly status: HTMLElement;
  readonly actions: HTMLElement;
}

export type PanelShellStatus =
  | { kind: "ready" }
  | { kind: "loading"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

export interface PanelShellCallbacks {
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onSplitRight: (id: string) => void;
  onSplitDown: (id: string) => void;
  onMaximize: (id: string) => void;
  onDropSignals: (id: string, paths: string[]) => void;
  onDropSet: (id: string, setId: string) => void;
  onRenameTitle: (id: string, title: string) => void;
}

export function hasDragType(event: DragEvent, type: string): boolean {
  return event.dataTransfer?.types.includes(type) ?? false;
}

/** The non-empty payload carried for `type` on a drop event, or null. */
export function dragData(event: DragEvent, type: string): string | null {
  const value = event.dataTransfer?.getData(type);
  return value !== undefined && value !== "" ? value : null;
}

export function parseSignalPayload(data: string): string[] {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "paths" in payload &&
      Array.isArray(payload.paths) &&
      payload.paths.every((path) => typeof path === "string")
    ) {
      return payload.paths;
    }
    return [];
  } catch {
    // Malformed external drag payloads are treated as a single path for the
    // legacy drag format.
  }
  return data === "" ? [] : [data];
}

export function parseSignalRefsPayload(data: string): {
  source_key: string;
  channel: string;
}[] {
  try {
    const payload: unknown = JSON.parse(data);
    if (typeof payload !== "object" || payload === null) return [];
    const refs = (payload as { refs?: unknown }).refs;
    if (!Array.isArray(refs)) return [];
    if (
      refs.every((ref: unknown) => {
        if (typeof ref !== "object" || ref === null) return false;
        const candidate = ref as {
          source_key?: unknown;
          channel?: unknown;
        };
        return (
          typeof candidate.source_key === "string" &&
          typeof candidate.channel === "string"
        );
      })
    ) {
      return refs as { source_key: string; channel: string }[];
    }
  } catch {
    return [];
  }
  return [];
}

export function parseSetPayload(data: string): string | null {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "set_id" in payload &&
      typeof payload.set_id === "string"
    ) {
      return payload.set_id;
    }
  } catch {
    // Malformed external drag payloads are ignored.
  }
  return null;
}

export class PanelShell {
  readonly element: HTMLElement;
  readonly slots: PanelShellSlots;
  private disposed = false;

  constructor(
    private readonly id: string,
    private readonly callbacks: PanelShellCallbacks,
  ) {
    const element = document.createElement("article");
    element.className = "panel";
    element.dataset.panelId = id;
    element.tabIndex = 0;
    element.innerHTML = panelShellMarkup();
    this.element = element;
    this.slots = {
      binding: requiredSlot(element, "bindings"),
      controls: requiredSlot(element, "controls"),
      content: requiredSlot(element, "content"),
      legend: requiredSlot(element, "legend"),
      status: requiredSlot(element, "status"),
      actions: requiredSlot(element, "actions"),
    };
    this.bind();
  }

  setTitle(title: string, maximized: boolean): void {
    this.element.setAttribute("aria-label", `${title} panel`);
    requiredSlot(this.element, "title").textContent = title;
    requiredSlot<HTMLButtonElement>(this.element, "maximize").title = maximized
      ? "Restore panel"
      : "Maximize panel";
    this.element.classList.toggle("maximized", maximized);
  }

  setStatus(status: PanelShellStatus): void {
    const slot = this.slots.status;
    slot.hidden = status.kind === "ready";
    if (status.kind === "ready") {
      delete slot.dataset.state;
      slot.textContent = "";
      return;
    }
    slot.dataset.state = status.kind;
    slot.textContent = status.message;
  }

  /** Insert a concrete renderer node before shell-owned legend/status slots. */
  appendContent(element: HTMLElement): void {
    this.slots.content.insertBefore(element, this.slots.legend);
  }

  dispose(): void {
    this.disposed = true;
  }

  private bind(): void {
    this.element.addEventListener("pointerdown", () => {
      if (!this.disposed) this.callbacks.onFocus(this.id);
    });
    this.slots.legend.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    requiredSlot<HTMLButtonElement>(this.element, "close").addEventListener(
      "click",
      () => this.callbacks.onClose(this.id),
    );
    requiredSlot<HTMLButtonElement>(
      this.element,
      "split-right",
    ).addEventListener("click", () => this.callbacks.onSplitRight(this.id));
    requiredSlot<HTMLButtonElement>(
      this.element,
      "split-down",
    ).addEventListener("click", () => this.callbacks.onSplitDown(this.id));
    requiredSlot<HTMLButtonElement>(this.element, "maximize").addEventListener(
      "click",
      () => this.callbacks.onMaximize(this.id),
    );

    const header = requiredSlot(this.element, "header");
    const title = requiredSlot(this.element, "title");
    title.addEventListener("dblclick", () => this.beginTitleEdit());
    header.draggable = true;
    header.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(PANEL_DRAG_TYPE, this.id);
    });
    this.element.addEventListener("dragover", (event) => {
      const signalDrag = hasDragType(event, SIGNAL_DRAG_TYPE);
      const setDrag = hasDragType(event, SET_DRAG_TYPE);
      if (!signalDrag && !setDrag) return;
      event.preventDefault();
      this.element.classList.add("drop-target");
    });
    this.element.addEventListener("dragleave", () => {
      this.element.classList.remove("drop-target", "drop-x");
    });
    this.element.addEventListener("drop", (event) => {
      this.element.classList.remove("drop-target", "drop-x");
      const setPayload = dragData(event, SET_DRAG_TYPE);
      if (setPayload !== null) {
        event.preventDefault();
        event.stopPropagation();
        const setId = parseSetPayload(setPayload);
        if (setId !== null) this.callbacks.onDropSet(this.id, setId);
        return;
      }
      const path = dragData(event, SIGNAL_DRAG_TYPE);
      if (path === null) return;
      event.preventDefault();
      event.stopPropagation();
      const paths = parseSignalPayload(path);
      if (paths.length > 0) this.callbacks.onDropSignals(this.id, paths);
    });
  }

  private beginTitleEdit(): void {
    const header = requiredSlot(this.element, "header");
    const title = requiredSlot(this.element, "title");
    const previous = title.textContent;
    header.draggable = false;
    try {
      title.contentEditable = "plaintext-only";
    } catch {
      title.contentEditable = "true";
    }
    const finish = (commit: boolean): void => {
      title.removeEventListener("keydown", onKey);
      title.removeEventListener("blur", onBlur);
      title.contentEditable = "false";
      header.draggable = true;
      if (commit)
        this.callbacks.onRenameTitle(this.id, title.textContent.trim());
      else title.textContent = previous;
    };
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };
    const onBlur = (): void => finish(true);
    title.addEventListener("keydown", onKey);
    title.addEventListener("blur", onBlur);
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

function requiredSlot<T extends Element = HTMLElement>(
  root: ParentNode,
  slot: string,
): T {
  const element = root.querySelector<T>(`[data-panel-slot="${slot}"]`);
  if (element === null) throw new Error(`Missing panel shell slot: ${slot}`);
  return element;
}

function panelShellMarkup(): string {
  return `<header class="panel-header" data-panel-slot="header">
      <span class="panel-toolbar-group panel-toolbar-binding">
        <span class="drag-handle" aria-hidden="true">⠿</span>
        <span class="panel-title" data-panel-slot="title"></span>
        <span class="panel-bindings" data-panel-slot="bindings"></span>
      </span>
      <span class="panel-toolbar-separator" aria-hidden="true"></span>
      <span class="panel-toolbar-slot" data-panel-slot="controls"></span>
      <span class="panel-actions" data-panel-slot="actions">
        <span class="panel-split-actions" aria-label="Split panel" role="group">
          <button class="panel-action panel-split-right" data-panel-slot="split-right" aria-label="Split panel right" title="Split panel right — new panel">→</button>
          <button class="panel-action panel-split-down" data-panel-slot="split-down" aria-label="Split panel down" title="Split panel down — new panel">↓</button>
        </span>
        <button class="panel-action panel-maximize" data-panel-slot="maximize" title="Maximize panel">${MAXIMIZE_GLYPH}</button>
        <button class="panel-action panel-close" data-panel-slot="close" title="Close panel">✕</button>
      </span>
    </header>
    <div class="plot-wrap" data-panel-slot="content">
      <div class="plot-series-legend" data-panel-slot="legend" aria-label="Plot legend"></div>
      <div class="panel-empty" data-panel-slot="status" hidden></div>
    </div>`;
}

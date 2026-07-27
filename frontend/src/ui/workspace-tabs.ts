import type { WorkspaceTab } from "../generated/session";

export interface WorkspaceTabCallbacks {
  onSelect(id: string): void;
  onAdd(): void;
  onClose(id: string): void;
}

export class WorkspaceTabsView {
  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: WorkspaceTabCallbacks,
  ) {}

  sync(tabs: readonly WorkspaceTab[], activeId: string): void {
    const canClose = tabs.length > 1;
    const tabElements = tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = `workspace-tab ${tab.id === activeId ? "active" : ""}`;

      const select = document.createElement("button");
      select.className = "workspace-tab-select";
      select.type = "button";
      select.role = "tab";
      select.ariaSelected = String(tab.id === activeId);
      select.textContent = tab.title;
      select.addEventListener("click", () => {
        this.callbacks.onSelect(tab.id);
      });

      const close = document.createElement("button");
      close.className = "workspace-tab-close";
      close.type = "button";
      close.title = `Close ${tab.title}`;
      close.ariaLabel = `Close ${tab.title}`;
      close.textContent = "✕";
      close.disabled = !canClose;
      close.addEventListener("click", () => {
        this.callbacks.onClose(tab.id);
      });

      item.append(select, close);
      return item;
    });

    const add = document.createElement("button");
    add.className = "workspace-tab-add";
    add.type = "button";
    add.title = "New workspace tab";
    add.ariaLabel = "New workspace tab";
    add.textContent = "+";
    add.addEventListener("click", () => {
      this.callbacks.onAdd();
    });
    this.root.replaceChildren(...tabElements, add);
  }
}
